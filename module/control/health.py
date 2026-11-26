"""
Health checks and bounded recovery of Alas instances, running in the web server process.

Signals (per instance), from the worker process the server owns and its log:
- crashed        the worker exited on its own with an error
- human_takeover the worker stopped on RequestHumanTakeover: it needs a person, never restarted
- stalled        a task is running but the worker has logged nothing for `stallMinutes`
- idle           the worker runs and waits for its next task (healthy)
- ok / stopped   healthy

Recovery per instance (policy in config/control.yaml):
- autoRestart     restart a crashed worker (on by default)
- restartOnStall  restart a stalled worker (off by default)
Restarts back off (30s, 2min, 5min) and stop after `maxRestartsPerHour`; the instance is then
marked gaveUp until someone starts it again. Deliberate stops, natural finishes and updates are
never treated as failures. Recovery that Alas already does inside the worker (game restart on
GameStuckError, emulator restart) is left to Alas.
"""
import collections
import os
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

from module.exception import HUMAN_TAKEOVER_EXIT_CODE
from module.logger import logger

POLICY_FILE = "./config/control.yaml"
DEFAULT_INSTANCE_POLICY = {"autoRestart": True, "restartOnStall": False, "stallMinutes": 30}
DEFAULT_POLICY = {
    "maxRestartsPerHour": 3,
    "backoffSeconds": [30, 120, 300],
    "instances": {},
}
HUMAN_TAKEOVER_MARKERS = ("Request human takeover", "RequestHumanTakeover")
HISTORY_LENGTH = 200
# Restart counters reset after the worker ran this long without needing recovery
HEALTHY_RESET_SECONDS = 600


def _iso(ts: Optional[float]) -> Optional[str]:
    return None if ts is None else datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _parse_iso(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


class PolicyStore:
    """Recovery policy persisted as YAML, read once and written on change"""

    def __init__(self, path: str = POLICY_FILE):
        self.path = path
        self._lock = threading.Lock()
        self._policy = None

    def _load(self) -> dict:
        policy = {k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v)
                  for k, v in DEFAULT_POLICY.items()}
        if os.path.exists(self.path):
            try:
                import yaml
                with open(self.path, encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                if isinstance(data, dict):
                    policy.update({k: v for k, v in data.items() if k in DEFAULT_POLICY})
            except Exception as e:
                logger.warning(f"Cannot read {self.path}: {e}, using the default recovery policy")
        return policy

    def get(self) -> dict:
        with self._lock:
            if self._policy is None:
                self._policy = self._load()
            return self._policy

    def instance(self, instance_id: str) -> dict:
        merged = dict(DEFAULT_INSTANCE_POLICY)
        merged.update(self.get().get("instances", {}).get(instance_id, {}) or {})
        return merged

    def update(self, changes: dict) -> dict:
        """
        Args:
            changes: {"maxRestartsPerHour": int, "backoffSeconds": [int], "instances": {id: {...}}}
                instance entries are merged key by key.

        Raises:
            ValueError: invalid values; nothing is changed.
        """
        if not isinstance(changes, dict):
            raise ValueError("Policy must be an object")
        with self._lock:
            policy = self._policy if self._policy is not None else self._load()
            new = dict(policy)
            new["instances"] = {k: dict(v) for k, v in policy.get("instances", {}).items()}
            for key, value in changes.items():
                if key == "maxRestartsPerHour":
                    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 60:
                        raise ValueError("maxRestartsPerHour must be an integer from 0 to 60")
                    new[key] = value
                elif key == "backoffSeconds":
                    if (not isinstance(value, list) or not value
                            or not all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 86400 for v in value)):
                        raise ValueError("backoffSeconds must be a list of seconds")
                    new[key] = value
                elif key == "instances":
                    if not isinstance(value, dict):
                        raise ValueError("instances must be an object")
                    for iid, entry in value.items():
                        if not isinstance(entry, dict):
                            raise ValueError(f"instances.{iid} must be an object")
                        merged = dict(new["instances"].get(iid, {}))
                        for k, v in entry.items():
                            if k in ("autoRestart", "restartOnStall"):
                                if not isinstance(v, bool):
                                    raise ValueError(f"instances.{iid}.{k} must be true or false")
                            elif k == "stallMinutes":
                                if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 1440:
                                    raise ValueError(f"instances.{iid}.stallMinutes must be 0 to 1440")
                            else:
                                raise ValueError(f"Unknown setting instances.{iid}.{k}")
                            merged[k] = v
                        new["instances"][iid] = merged
                else:
                    raise ValueError(f"Unknown setting {key}")
            self._write(new)
            self._policy = new
            return new

    def _write(self, policy: dict) -> None:
        import yaml
        from deploy.atomic import atomic_write
        folder = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(folder, exist_ok=True)
        atomic_write(self.path, yaml.safe_dump(policy, allow_unicode=True, sort_keys=False))


class _Recovery:
    def __init__(self):
        self.restarts: List[float] = []  # times of restarts by the monitor, last hour
        self.consecutive = 0
        self.next_attempt_at: Optional[float] = None
        self.pending_reason: Optional[str] = None
        self.gave_up_at: Optional[float] = None
        self.last_restart_at: Optional[float] = None


class HealthMonitor:
    def __init__(
            self,
            service,
            policy: PolicyStore,
            log_queue_alive: Callable[[], Optional[bool]] = lambda: None,
            interval: float = 5.0,
            clock: Callable[[], float] = time.time,
    ):
        """
        Args:
            service: InstanceService.
            policy: Recovery policy.
            log_queue_alive: If the SyncManager process carrying worker logs is alive.
            interval: Seconds between checks.
        """
        self.service = service
        self.policy = policy
        self.log_queue_alive = log_queue_alive
        self.interval = interval
        self.clock = clock
        self.history = collections.deque(maxlen=HISTORY_LENGTH)
        self._recovery: Dict[str, _Recovery] = {}
        self._health: Dict[str, dict] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.last_tick_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self.restart_count = 0

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="HealthMonitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop checking and recovering. Called before the server stops its workers."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval + 5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
                self.last_error = None
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"
                logger.exception(e)
            self._stop.wait(self.interval)

    # ------------------------------------------------------------ checks

    def _record(self, instance_id: str, action: str, reason: str, detail: str = "") -> None:
        entry = {"time": _iso(self.clock()), "instanceId": instance_id, "action": action, "reason": reason,
                 "detail": detail}
        with self._lock:
            self.history.append(entry)
        logger.info(f"[{instance_id}] recovery {action}: {reason} {detail}".rstrip())

    def _classify(self, status: dict, policy: dict, now: float) -> dict:
        state = status["state"]
        if status.get("unmanaged"):
            return {"state": "unmanaged", "detail": status["lastError"]}
        if state in ("starting", "stopping"):
            return {"state": "ok", "detail": state}
        if state == "failed":
            if status.get("exitCode") == HUMAN_TAKEOVER_EXIT_CODE:
                return {"state": "human_takeover", "detail": "Alas requested human takeover, see the log"}
            if status.get("logDraining"):
                return {"state": "ok", "detail": "Reading the worker's final log messages"}
            # Only this run's last lines: an earlier run may have asked for a human
            tail = self.service.logs(status["id"], status.get("runLogStartSeq") or 0, 30)["lines"]
            if any(marker in line["text"] for line in tail for marker in HUMAN_TAKEOVER_MARKERS):
                return {"state": "human_takeover", "detail": "Alas requested human takeover, see the log"}
            return {"state": "crashed", "detail": status.get("lastError") or "Worker exited with an error"}
        if state == "stopped":
            return {"state": "stopped", "detail": ""}
        # running
        stall_minutes = policy["stallMinutes"]
        last = _parse_iso(status.get("lastActivityAt")) or _parse_iso(status.get("startedAt"))
        if status.get("currentTask") and stall_minutes and last is not None and now - last > stall_minutes * 60:
            return {"state": "stalled",
                    "detail": f"Task {status['currentTask']} logged nothing for {int((now - last) // 60)} min"}
        if not status.get("currentTask"):
            return {"state": "idle", "detail": "Waiting for the next task"}
        return {"state": "ok", "detail": f"Running {status['currentTask']}"}

    def tick(self) -> None:
        now = self.clock()
        policy = self.policy.get()
        max_restarts = policy["maxRestartsPerHour"]
        backoff = policy["backoffSeconds"] or [30]
        for status in self.service.list_instances():
            iid = status["id"]
            instance_policy = self.policy.instance(iid)
            health = self._classify(status, instance_policy, now)
            with self._lock:
                rec = self._recovery.setdefault(iid, _Recovery())
                rec.restarts = [t for t in rec.restarts if now - t < 3600]

                # Someone started it again after we gave up, or it ran healthy long enough
                started = _parse_iso(status.get("startedAt"))
                if rec.gave_up_at is not None and status["state"] == "running" and started and started > rec.gave_up_at:
                    rec.gave_up_at = None
                    rec.consecutive = 0
                if (health["state"] in ("ok", "idle") and rec.last_restart_at is not None
                        and now - rec.last_restart_at > HEALTHY_RESET_SECONDS):
                    rec.consecutive = 0
                    rec.last_restart_at = None

                wants = None
                if health["state"] == "crashed" and instance_policy["autoRestart"]:
                    wants = "crashed"
                elif health["state"] == "stalled" and instance_policy["restartOnStall"]:
                    wants = "stalled"
                if wants is None:
                    rec.next_attempt_at = None
                    rec.pending_reason = None

            if wants is not None and rec.gave_up_at is None and self.log_queue_alive() is not False:
                restarted = self._maybe_restart(status, wants, health, rec, now, max_restarts, backoff)
                if restarted is not None:
                    health = self._classify(restarted, instance_policy, now)

            with self._lock:
                self._health[iid] = dict(health, recovery=self._recovery_view(rec, instance_policy))
        self.last_tick_at = now

    def _maybe_restart(self, status, reason, health, rec, now, max_restarts, backoff) -> Optional[dict]:
        """Returns: the new status if a restart was attempted"""
        iid = status["id"]
        with self._lock:
            if len(rec.restarts) >= max_restarts:
                rec.gave_up_at = now
                rec.next_attempt_at = None
                give_up = True
            else:
                give_up = False
                if rec.next_attempt_at is None or rec.pending_reason != reason:
                    delay = backoff[min(rec.consecutive, len(backoff) - 1)]
                    rec.next_attempt_at = now + delay
                    rec.pending_reason = reason
                    self._record(iid, "scheduled", reason, f"restart in {delay}s ({health['detail']})")
                due = rec.next_attempt_at <= now
        if give_up:
            self._record(iid, "gave_up", reason, f"{max_restarts} restarts within an hour, start it manually")
            return None
        if not due or self._stop.is_set():
            return None
        try:
            result = self.service.recover(status, reason)
            if result is None:
                return None
            ok = result.get("state") in ("starting", "running") and not result.get("unmanaged")
        except Exception as e:
            ok = False
            result = None
            error = str(e)
        with self._lock:
            if ok:
                self.restart_count += 1
            rec.restarts.append(now)
            rec.consecutive += 1
            rec.last_restart_at = now
            rec.next_attempt_at = None
            rec.pending_reason = None
        if result is not None and not ok:
            error = result.get("lastError")
        self._record(iid, "restarted" if ok else "restart_failed", reason,
                     f"attempt {len(rec.restarts)}/{max_restarts}" + ("" if ok else f": {error}"))
        return result

    @staticmethod
    def _recovery_view(rec: _Recovery, instance_policy: dict) -> dict:
        return {
            "policy": instance_policy,
            "restartsLastHour": len(rec.restarts),
            "nextAttemptAt": _iso(rec.next_attempt_at),
            "pendingReason": rec.pending_reason,
            "gaveUp": rec.gave_up_at is not None,
        }

    # ------------------------------------------------------------ views

    def instance_health(self, instance_id: str) -> Optional[dict]:
        with self._lock:
            health = self._health.get(instance_id)
            return dict(health) if health else None

    def checks(self) -> dict:
        now = self.clock()
        checks = [{"name": "server", "status": "ok", "detail": f"pid {os.getpid()}"}]
        alive = self.log_queue_alive()
        checks.append({
            "name": "logQueueManager",
            "status": "ok" if alive or alive is None else "fail",
            "detail": "SyncManager process carrying worker logs" + ("" if alive or alive is None
                                                                     else " is dead: logs stop reaching the UI"),
        })
        stale = self.last_tick_at is None or now - self.last_tick_at > self.interval * 3 + 5
        checks.append({
            "name": "healthMonitor",
            "status": "fail" if self.last_error else "warn" if stale else "ok",
            "detail": self.last_error or ("not checked yet" if self.last_tick_at is None
                                          else f"last check {int(now - self.last_tick_at)}s ago"),
        })
        with self._lock:
            for iid, health in sorted(self._health.items()):
                state = health["state"]
                status = ("fail" if state in ("crashed", "human_takeover") or health["recovery"]["gaveUp"]
                          else "warn" if state in ("stalled", "unmanaged") else "ok")
                checks.append({"name": f"instance:{iid}", "status": status,
                               "detail": f"{state}{': ' + health['detail'] if health['detail'] else ''}"})
        overall = ("fail" if any(c["status"] == "fail" for c in checks)
                   else "warn" if any(c["status"] == "warn" for c in checks) else "ok")
        return {"status": overall, "checks": checks}

    def snapshot(self) -> dict:
        policy = self.policy.get()
        with self._lock:
            return {"policy": policy, "history": list(self.history)[::-1]}
