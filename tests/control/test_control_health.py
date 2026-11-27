import multiprocessing
import time
from datetime import datetime, timezone

import pytest

from module.control.health import HealthMonitor, PolicyStore


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


class Clock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class FakeService:
    """Statuses set by the test; start/restart record calls and mark the instance running"""

    def __init__(self, clock):
        self.clock = clock
        self.statuses = {}
        self.log_lines = {}
        self.calls = []

    def set(self, iid, state, current_task=None, last_activity=None, started=None, last_error=None):
        self.statuses[iid] = {
            "id": iid, "state": state, "currentTask": current_task,
            "lastActivityAt": iso(last_activity) if last_activity else None,
            "startedAt": iso(started) if started else None, "lastError": last_error,
        }

    def list_instances(self):
        return [dict(s) for s in self.statuses.values()]

    def logs(self, iid, after=0, limit=500):
        return {"lines": [{"seq": i, "text": t} for i, t in enumerate(self.log_lines.get(iid, []))], "lastSeq": 0}

    def start(self, iid):
        self.calls.append(("start", iid))
        self.set(iid, "running", started=self.clock())
        return self.statuses[iid]

    def restart(self, iid):
        self.calls.append(("restart", iid))
        self.set(iid, "running", started=self.clock())
        return self.statuses[iid]

    def recover(self, expected, reason):
        iid = expected["id"]
        if self.statuses[iid] != expected:
            return None
        return self.restart(iid) if reason == "stalled" else self.start(iid)


@pytest.fixture
def env(tmp_path):
    clock = Clock()
    service = FakeService(clock)
    policy = PolicyStore(str(tmp_path / "control.yaml"))
    monitor = HealthMonitor(service, policy, clock=clock)
    return clock, service, policy, monitor


def health(monitor, iid="alas"):
    return monitor.instance_health(iid)


def test_classification(env):
    clock, service, policy, monitor = env
    now = clock()
    service.set("ok", "running", current_task="Commission", last_activity=now - 10, started=now - 100)
    service.set("idle", "running", last_activity=now - 7200, started=now - 9000)
    service.set("stall", "running", current_task="Research", last_activity=now - 3600, started=now - 9000)
    service.set("crash", "failed", last_error="Worker exited with code 1")
    service.set("human", "failed", last_error="Worker exited with code 1")
    service.log_lines["human"] = ["CRITICAL │ Request human takeover"]
    service.set("off", "stopped")
    monitor.tick()
    states = {iid: health(monitor, iid)["state"] for iid in service.statuses}
    assert states == {"ok": "ok", "idle": "idle", "stall": "stalled", "crash": "crashed",
                      "human": "human_takeover", "off": "stopped"}
    assert "Research" in health(monitor, "stall")["detail"]


def test_takeover_of_an_earlier_run_does_not_count(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0]})
    service.set("alas", "failed")
    service.log_lines["alas"] = ["CRITICAL │ Request human takeover", "INFO │ new run", "INFO │ killed"]
    # Lines with seq > 0 belong to the current run (seq 0 is the earlier run's takeover)
    service.statuses["alas"]["runLogStartSeq"] = 0
    original = service.logs
    service.logs = lambda iid, after=0, limit=500: {
        "lines": [l for l in original(iid)["lines"] if l["seq"] > after], "lastSeq": 2}
    monitor.tick()
    assert service.calls == [("start", "alas")]
    assert {e["reason"] for e in monitor.snapshot()["history"]} == {"crashed"}


def test_no_recovery_when_disabled(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": False}}})
    service.set("alas", "failed")
    for _ in range(5):
        monitor.tick()
        clock.now += 600
    assert service.calls == []
    assert health(monitor)["recovery"]["nextAttemptAt"] is None


def test_takeover_exit_code_blocks_recovery_without_log(env):
    from module.exception import HUMAN_TAKEOVER_EXIT_CODE

    _, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0]})
    service.set("alas", "failed")
    service.statuses["alas"]["exitCode"] = HUMAN_TAKEOVER_EXIT_CODE
    monitor.tick()
    assert health(monitor)["state"] == "human_takeover"
    assert service.calls == []


def test_crash_restart_with_backoff(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [30, 120]})
    service.set("alas", "failed")
    monitor.tick()
    assert service.calls == []
    assert health(monitor)["recovery"]["pendingReason"] == "crashed"
    clock.now += 29
    monitor.tick()
    assert service.calls == []
    clock.now += 1
    monitor.tick()
    assert service.calls == [("start", "alas")]
    assert health(monitor)["state"] == "ok" or health(monitor)["state"] == "idle"

    # Crashes again: the next wait is longer
    clock.now += 5
    service.set("alas", "failed")
    monitor.tick()
    assert health(monitor)["recovery"]["nextAttemptAt"] == iso(clock.now + 120)
    actions = [h["action"] for h in monitor.snapshot()["history"]]
    assert actions[::-1] == ["scheduled", "restarted", "scheduled"]


def test_gives_up_then_manual_start_resets(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0], "maxRestartsPerHour": 2})
    for _ in range(2):
        service.set("alas", "failed")
        monitor.tick()
        clock.now += 1
    assert service.calls == [("start", "alas")] * 2
    service.set("alas", "failed")
    monitor.tick()
    assert health(monitor)["recovery"]["gaveUp"] is True
    clock.now += 60
    monitor.tick()
    assert len(service.calls) == 2
    assert monitor.checks()["status"] == "fail"

    # A person starts it again
    clock.now += 60
    service.set("alas", "running", started=clock.now, last_activity=clock.now)
    monitor.tick()
    assert health(monitor)["recovery"]["gaveUp"] is False


def test_human_takeover_never_restarted(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0]})
    service.set("alas", "failed")
    service.log_lines["alas"] = ["CRITICAL │ Request human takeover"]
    for _ in range(3):
        monitor.tick()
        clock.now += 60
    assert service.calls == []
    assert health(monitor)["state"] == "human_takeover"


def test_stall_restart_only_when_enabled(env):
    clock, service, policy, monitor = env
    now = clock()
    service.set("alas", "running", current_task="Commission", last_activity=now - 40 * 60, started=now - 3600)
    monitor.tick()
    assert health(monitor)["state"] == "stalled"
    assert service.calls == []
    policy.update({"instances": {"alas": {"restartOnStall": True, "stallMinutes": 30}}, "backoffSeconds": [0]})
    monitor.tick()
    assert service.calls == [("restart", "alas")]


def test_stall_detection_can_be_disabled(env):
    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"stallMinutes": 0}}})
    service.set("alas", "running", current_task="Commission", last_activity=clock() - 86000, started=clock() - 90000)
    monitor.tick()
    assert health(monitor)["state"] == "ok"


def test_policy_validation_and_persistence(env, tmp_path):
    clock, service, policy, monitor = env
    with pytest.raises(ValueError):
        policy.update({"maxRestartsPerHour": -1})
    with pytest.raises(ValueError):
        policy.update({"instances": {"alas": {"autoRestart": "yes"}}})
    with pytest.raises(ValueError):
        policy.update({"instances": {"alas": {"nope": True}}})
    with pytest.raises(ValueError):
        policy.update({"nope": 1})
    policy.update({"instances": {"alas": {"autoRestart": True}}})
    policy.update({"instances": {"alas": {"stallMinutes": 45}}})
    again = PolicyStore(policy.path)
    assert again.instance("alas") == {"autoRestart": True, "restartOnStall": False, "stallMinutes": 45}
    assert again.instance("other")["autoRestart"] is True


def test_checks(env):
    clock, service, policy, monitor = env
    assert monitor.checks()["status"] == "warn"  # monitor has not run yet
    service.set("alas", "running", started=clock(), last_activity=clock())
    monitor.tick()
    assert monitor.checks()["status"] == "ok"
    monitor.log_queue_alive = lambda: False
    result = monitor.checks()
    assert result["status"] == "fail"
    assert any(c["name"] == "logQueueManager" and c["status"] == "fail" for c in result["checks"])


def test_background_thread_runs_and_stops(env):
    clock, service, policy, monitor = env
    monitor.interval = 0.05
    service.set("alas", "stopped")
    monitor.start()
    deadline = time.time() + 5
    while monitor.last_tick_at is None and time.time() < deadline:
        time.sleep(0.02)
    monitor.stop()
    assert monitor.last_tick_at is not None
    assert not monitor._thread.is_alive()


# ---------------------------------------------------------------- real workers


class _QueueOnlyManager:
    @staticmethod
    def Queue(maxsize=0):
        return multiprocessing.Queue(maxsize)


def test_restarts_a_real_crashed_worker(tmp_path, monkeypatch):
    import control_fakes as fakes
    from module.control.instances import InstanceService
    from module.webui.process_manager import ProcessManager
    from module.webui.setting import State

    monkeypatch.setattr("module.webui.process_manager.WORKER_LOCK_DIR", str(tmp_path / "workers"))
    monkeypatch.setattr(State, "manager", _QueueOnlyManager())
    monkeypatch.setattr(ProcessManager, "_processes", {})
    monkeypatch.setattr(ProcessManager, "run_process", staticmethod(fakes.worker_crashes))
    spawns = str(tmp_path / "spawns.txt")
    service = InstanceService(list_instances=lambda: ["alas"], get_manager=ProcessManager.get_manager,
                              default_func=lambda name: spawns)
    policy = PolicyStore(str(tmp_path / "control.yaml"))
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0], "maxRestartsPerHour": 2})
    monitor = HealthMonitor(service, policy)
    service.health = monitor.instance_health

    manager = ProcessManager.get_manager("alas")
    manager.start(spawns)
    for _ in range(3):
        deadline = time.time() + 10
        while (manager.alive or manager.status()["logDraining"]) and time.time() < deadline:
            time.sleep(0.05)
        monitor.tick()
    assert fakes.spawn_count(spawns) == 3  # first start + 2 restarts
    deadline = time.time() + 10
    while manager.alive and time.time() < deadline:
        time.sleep(0.05)
    monitor.tick()
    status = service.get_status("alas")
    assert status["state"] == "failed"
    assert status["health"]["state"] == "crashed"
    assert status["health"]["recovery"]["gaveUp"] is True


def test_deliberate_stop_is_not_recovered(tmp_path, monkeypatch):
    import control_fakes as fakes
    from module.control.instances import InstanceService
    from module.webui.process_manager import ProcessManager
    from module.webui.setting import State

    monkeypatch.setattr("module.webui.process_manager.WORKER_LOCK_DIR", str(tmp_path / "workers"))
    monkeypatch.setattr(State, "manager", _QueueOnlyManager())
    monkeypatch.setattr(ProcessManager, "_processes", {})
    monkeypatch.setattr(ProcessManager, "run_process", staticmethod(fakes.worker_runs))
    spawns = str(tmp_path / "spawns.txt")
    service = InstanceService(list_instances=lambda: ["alas"], get_manager=ProcessManager.get_manager,
                              default_func=lambda name: spawns)
    policy = PolicyStore(str(tmp_path / "control.yaml"))
    policy.update({"instances": {"alas": {"autoRestart": True}}, "backoffSeconds": [0]})
    monitor = HealthMonitor(service, policy)
    service.start("alas")
    service.stop("alas")
    monitor.tick()
    monitor.tick()
    assert not ProcessManager.get_manager("alas").alive
    assert monitor.instance_health("alas")["state"] == "stopped"
    assert monitor.snapshot()["history"] == []


# ---------------------------------------------------------------- HTTP


def test_http_recovery_endpoints(env):
    from starlette.applications import Starlette
    from starlette.testclient import TestClient

    from module.control.api import ControlApi, mount_control_api
    from module.control.instances import InstanceService

    clock, service, policy, monitor = env
    instances = InstanceService(list_instances=lambda: ["alas"], get_manager=lambda name: None,
                                default_func=lambda name: "alas")
    app = Starlette()
    mount_control_api(app, ControlApi(instances, monitor=monitor))

    class AsLoopback:
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope = dict(scope, client=("127.0.0.1", 50000))
            await app(scope, receive, send)

    client = TestClient(AsLoopback(), base_url="http://127.0.0.1:22267")
    assert client.get("/api/v1/recovery").json()["history"] == []
    ok = client.patch("/api/v1/recovery/policy", json={"instances": {"alas": {"autoRestart": True}}})
    assert ok.status_code == 200
    assert ok.json()["policy"]["instances"]["alas"]["autoRestart"] is True
    bad = client.patch("/api/v1/recovery/policy", json={"maxRestartsPerHour": "many"})
    assert bad.status_code == 400
    assert client.patch("/api/v1/recovery/policy", content="{}").status_code == 415


def fail_login(service, clock):
    from module.exception import RETRY_LATER_EXIT_CODE

    service.set("alas", "failed")
    service.statuses["alas"]["exitCode"] = RETRY_LATER_EXIT_CODE
    service.statuses["alas"]["stoppedAt"] = iso(clock())


def test_login_failure_wakes_the_worker_hourly(env):
    from module.control.health import WAKE_MINUTES

    clock, service, policy, monitor = env
    fail_login(service, clock)
    monitor.tick()
    assert health(monitor)["state"] == "waiting_retry"
    assert health(monitor)["recovery"]["pendingReason"] == "waiting_retry"
    clock.now += WAKE_MINUTES * 60 - 10
    monitor.tick()
    assert service.calls == []
    clock.now += 20
    monitor.tick()
    assert service.calls == [("start", "alas")]
    # Hourly wakes never use the crash restart budget
    assert health(monitor)["recovery"]["restartsLastHour"] == 0


def test_login_failure_gives_up_after_a_day(env):
    from module.control.health import WAKE_FOR_HOURS, WAKE_MINUTES

    clock, service, policy, monitor = env
    for _ in range(WAKE_FOR_HOURS + 2):
        fail_login(service, clock)
        monitor.tick()
        clock.now += WAKE_MINUTES * 60 + 1
        monitor.tick()
        clock.now += 120  # the woken worker fails its login again a few minutes later
        monitor.tick()
    assert health(monitor)["recovery"]["gaveUp"] is True
    assert len(service.calls) == WAKE_FOR_HOURS - 1 or len(service.calls) == WAKE_FOR_HOURS


def test_healthy_run_ends_the_wait(env):
    from module.control.health import WAKE_MINUTES, WAKE_RESET_SECONDS

    clock, service, policy, monitor = env
    fail_login(service, clock)
    monitor.tick()
    clock.now += WAKE_MINUTES * 60 + 1
    monitor.tick()
    clock.now += WAKE_RESET_SECONDS + 1
    monitor.tick()
    assert monitor._recovery["alas"].waiting_since is None


def test_no_wake_when_auto_restart_is_off(env):
    from module.control.health import WAKE_MINUTES

    clock, service, policy, monitor = env
    policy.update({"instances": {"alas": {"autoRestart": False}}})
    fail_login(service, clock)
    monitor.tick()
    clock.now += WAKE_MINUTES * 60 * 3
    monitor.tick()
    assert service.calls == []
