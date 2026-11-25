# ALAS lifecycle ownership map (P1.1)

Status: v1 (2026-11-25). Slice P1.1 of `doc/modernization/PLAN.md`.
References were taken at upstream `a868d2abe` (fork `modernize/main` `358f882e4`).
Every `path:line` below is quoted together with the symbol on that line, so the reference
can be found again by symbol after an upstream sync moves the lines.

This document describes what the code does **today** and specifies what P1.2 (state machine),
P1.3 (tests) and P1.4 (orphan safety) must preserve or fix. It changes no code.

---

## 1. Ownership today

| Piece | Where | What it is |
|-------|-------|------------|
| Registry | `module/webui/process_manager.py:26` `_processes: Dict[str, "ProcessManager"] = {}` | Class-level dict, one `ProcessManager` per config name, living in the uvicorn process. Filled lazily by `get_manager()` (`process_manager.py:125`). Entries are never removed. |
| Worker | `process_manager.py:42` `self._process = Process(target=ProcessManager.run_process, ...)` | A non-daemon `multiprocessing.Process`. One at a time per `ProcessManager`, guarded only by `if not self.alive` (`process_manager.py:39`). |
| Log transport | `process_manager.py:30` `State.manager.Queue()` | A proxy queue served by the `SyncManager` process created by `State.init()` (`module/webui/setting.py:65` `cls.manager = multiprocessing.Manager()`), which is called from `startup()` (`module/webui/app.py:1448` `State.init()`). |
| Log buffer | `process_manager.py:31-33` `renderables`, `renderables_max_length = 400`, `renderables_reduce_length = 80` | A plain list in the uvicorn process, appended by the log-queue thread; when it exceeds 400 items the first 80 are cut (`process_manager.py:93-94`). |
| Log-queue thread | `process_manager.py:54` `def start_log_queue_handler` / `:86` `def _thread_log_queue_handler` | One non-daemon thread per instance. Loops `while self.alive` (`process_manager.py:87`). |
| Stop signal | `module/webui/app.py:1450` `updater.event = State.manager.Event()` | A **single** manager `Event` shared by every instance that was started with `ev=updater.event`. Set by the updater only. |
| Server lifetime | `gui.py:83-85` `uvicorn.run("module.webui.app:app", ..., factory=True)` | One uvicorn worker. `app()` (`app.py:1482`) wires `on_startup=[startup, restart_processes]` (`app.py:1547`) and `on_shutdown=[clearup]` (`app.py:1553`). |
| Reload supervisor | `gui.py:89-109` `if State.deploy_config.EnableReload:` | When reload is enabled, `gui.py` runs the uvicorn server in a child `Process(target=func, args=(event,))` and `process.kill()`s it when `State.restart_event` fires (`gui.py:101-102`). Workers are children of that child. |
| Electron | `webapp/packages/main/src/pyshell.ts:25` `treeKill(this.childProcess.pid, 'SIGTERM', callback)` | On window close / tray Exit (`webapp/packages/main/src/index.ts:105`, `:128` `alas.kill(...)`) Electron tree-kills `gui.py` and everything under it, workers included. No `clearup()` runs. |

Ownership is therefore **in memory, in one process** (the uvicorn worker). Nothing on disk
records which worker PIDs exist, except `config/reloadalas` during an update (§2.4).

---

## 2. Caller map

### 2.1 PyWebIO session (`module/webui/app.py`, class `AlasGUI`)

Each browser session has its own `AlasGUI` and its own `TaskHandler` (`module/webui/utils.py:117`)
that runs generators on the session thread. All callers below run there unless noted.

| Caller | file:line | Call | Polling | Notes |
|--------|-----------|------|---------|-------|
| Aside instance icons | `app.py:163` `rendered_state = ProcessManager.get_manager(inst).state` | `.state` | every 2 s (`app.py:1279` `self.task_handler.add(self.set_aside_status, 2)`) | Calls `get_manager()` for **every** instance in `config/*.json` (`alas_instance()`, `module/config/utils.py:163`), so every session creates registry entries. |
| Aside change detection | `app.py:181` `state = ProcessManager.get_manager(inst).state` | `.state` | every 2 s | Compares with `rendered_cache`; redraws on change. |
| Header status | `app.py:1133-1137` `self.state_switch = Switch(... get_state=lambda: getattr(getattr(self, "alas", -1), "state", 0) ...)` | `.state` | every 2 s (`app.py:1278` `self.state_switch.g(), 2`) | Feeds `set_status()` (`app.py:199`), which defines the int contract (§3). |
| Select instance | `app.py:1053` `self.alas = ProcessManager.get_manager(config_name)` | `get_manager` | on click (`ui_alas`, `app.py:1045`) | `app.py:1042`, `app.py:1144` `del self.alas` only drop the session's reference; the registry entry stays. |
| Overview scheduler button | `app.py:456-458` `onclick_on=lambda: self.alas.stop()`, `onclick_off=lambda: self.alas.start(None, updater.event)`, `get_state=lambda: self.alas.alive` | `stop()`, `start(None, ev)`, `.alive` | switch polled every 1 s (`app.py:496`) | The only start path that passes the update event. `func=None` → `get_config_mod()`. |
| Overview task list | `app.py:592` `if self.alas.alive:` | `.alive` | every 10 s (`app.py:498`) | Decides whether the first pending task is shown as "running". |
| Overview log | `app.py:499` `self.task_handler.add(log.put_log(self.alas), 0.25, True)` | `RichLog.put_log(pm)` | every 0.25 s | See §2.2. |
| Daemon/tool scheduler button | `app.py:688-690` `onclick_on=lambda: self.alas.stop()`, `onclick_off=lambda: self.alas.start(task)`, `get_state=lambda: self.alas.alive` | `stop()`, `start(task)`, `.alive` | 1 s (`app.py:741`) | **No stop event passed**: the updater cannot stop a daemon/tool run gracefully; it waits up to 10 min and then kills it (§2.4). |
| Daemon/tool log | `app.py:743` `self.task_handler.add(log.put_log(self.alas), 0.25, True)` | `RichLog.put_log(pm)` | 0.25 s | |
| Dev → Force restart | `app.py:961-964` `clearup()` then `State.restart_event.set()` | `clearup()` → `stop()` on all | on click | Only when reload is enabled. |

### 2.2 Log widget (`module/webui/widgets.py`)

`widgets.py:189` `def put_log(self, pm: ProcessManager) -> Generator:` reads, without a lock:

- `pm.renderables` (length and slices),
- `pm.renderables_max_length` (resync after `2 × 400` lines),
- `pm.renderables_reduce_length` (to correct `last_idx` after the 80-item cut).

It relies on the list being **trimmed by exactly `renderables_reduce_length` from the front**.
Any change to the buffer must keep these three attributes and that trimming rule, or give
`put_log` an equivalent API in the same change.

### 2.3 Server lifetime (`module/webui/app.py`, `gui.py`)

| Caller | file:line | Call | When |
|--------|-----------|------|------|
| `startup()` | `app.py:1447-1450` `State.init()`, `updater.event = State.manager.Event()` | creates the SyncManager and the shared event | uvicorn on_startup |
| Auto-run on startup | `app.py:1549` `lambda: ProcessManager.restart_processes(instances=instances, ev=updater.event)` | `restart_processes` | uvicorn on_startup, after `startup()`. `instances` = `--run` or deploy `Run`; plus names from `config/reloadalas`. |
| `clearup()` | `app.py:1475-1476` `for alas in ProcessManager._processes.values(): alas.stop()` | `stop()` on every entry, then `State.clearup()` (`setting.py:70` `cls.manager.shutdown()`) | uvicorn on_shutdown; updater before reload (`updater.py:257`); Force restart (`app.py:963`) |
| Reload supervisor | `gui.py:101-102` `if b: process.kill()` | kills the uvicorn child ≤ 1 s after `restart_event` | reload only. Callers run `clearup()` first, so workers are normally gone; anything else that sets `restart_event` would orphan them. |
| Electron exit | `webapp/packages/main/src/index.ts:105`, `:128` `alas.kill(...)` | tree-kill of `gui.py` | window close / tray Exit. No `clearup()`; relies on the tree kill reaching the workers. |

### 2.4 Updater (`module/webui/updater.py`)

| Step | file:line | Call | Notes |
|------|-----------|------|-------|
| Collect running | `updater.py:211` `instances = ProcessManager.running_instances()` | `running_instances()` (`process_manager.py:186`) | Filters `_processes` by `.alive`. |
| Ask to stop | `updater.py:223` `self.event.set()` | shared event | Every instance started with `ev` sees it at its next check (§2.5). |
| Wait | `updater.py:228` `if not alas.alive:` | `.alive` | Polls every 0.25 s. |
| Cancel | `updater.py:234-235` `self.event.clear()`, `ProcessManager.restart_processes(instances, self.event)` | `restart_processes` | Restarts **all** previously running instances, including ones that already stopped by themselves. |
| Timeout | `updater.py:239-241` `for alas in _instances: alas.stop()` | `stop()` | After 10 min. Today `stop()` = `kill()`. |
| Persist list | `updater.py:252-253` `open("./config/reloadalas", mode="w")` / `f.writelines(names)` | file | One config name per line. Read and deleted by `restart_processes` (`process_manager.py:218`, `:230`). Ignored by git (`.gitignore:20`). |
| Reload | `updater.py:254-257` `from module.webui.app import clearup`, `self._trigger_reload(2)`, `clearup()` | `clearup()` + `restart_event` after 2 s | Reload only. |
| Update failed | `updater.py:263-264` `self.event.clear()`, `ProcessManager.restart_processes(instances, self.event)` | `restart_processes` | |

### 2.5 Worker side (runs in the child process)

| Code | file:line | Behaviour |
|------|-----------|-----------|
| Entry | `process_manager.py:134` `def run_process(config_name, func, q, e)` | Sets up file logger, `set_func_logger(func=q.put)` (every log line goes through the manager queue), `AzurLaneConfig.stop_event = e`. |
| Dispatch | `process_manager.py:161-180` | `alas` → `AzurLaneAutoScript(...).loop()`; tool funcs → `.run(...)`; mods → `mod.loop()` / mod funcs. |
| Normal end | `process_manager.py:181` `logger.info(f"[{config_name}] exited. Reason: Finish\n")` | Only reached when the function returns. |
| Exception | `process_manager.py:182-183` `except Exception as e: logger.exception(e)` | Process then exits with code 0. Exit code does **not** tell failure from success. |
| Update stop while waiting | `alas.py:485-489` `if self.stop_event.is_set(): ... logger.info(f"[{self.config_name}] exited. Reason: Update")`, `exit(0)` | Checked every 5 s while waiting for the next task. |
| Update stop in loop | `alas.py:559-563` `if self.stop_event.is_set(): ... break` | Then falls through to `Reason: Finish`. |
| Task switch | `module/config/config.py:611-613` `if self.stop_event.is_set(): return True` | Makes the running task yield at its next `task_switched()` check. |
| In-worker recovery | `alas.py` `GameStuckError` / `GameTooManyClickError` → game restart; 3 failures → `RequestHumanTakeover` (PLAN F11) | Out of P1 scope; P6 audits it. |

### 2.6 References that are only comments

- `module/device/device.py:33` `process_manager.py L149 run_process()` (comment on stdout handling).
- `submodule/AlasFpyBridge/module/utils/orphanSlayer.py:24-36`: explains that `ProcessManager.stop()`
  uses `kill()` and "cannot be changed to terminate(), see #883", and that sub-subprocesses
  on *nix survive the parent. That is why orphanSlayer exists (§4 j).

Outside `module/webui/` (`app.py`, `widgets.py`, `updater.py`) no code imports `ProcessManager` (`grep -rn ProcessManager --include=*.py .`).

---

## 3. Who reads state, and what the ints mean

`ProcessManager.state` (`process_manager.py:105`) is computed on every read:

| Int | Meaning in `set_status` (`app.py:199`) | How it is derived today |
|-----|----------------------------------------|-------------------------|
| 1 | Running | `self.alive` |
| 2 | Inactive | not alive and (`renderables` empty, or last line ends with `Reason: Manual stop` or `Reason: Finish`) |
| 3 | Warning (stopped unexpectedly) | not alive and the last line is **anything else** |
| 4 | Updating | not alive and the last line ends with `Reason: Update` |
| 0 | Hide (no instance selected) | `state_switch` default when the session has no `self.alas` |
| -1 | State unchanged | `set_status` no-op |

Readers: aside icons (2 s), header status (2 s), switch buttons via `.alive` (1 s),
the overview task list via `.alive` (10 s), the updater via `.alive` (0.25 s), `running_instances()`.
Each open session polls independently. No reader writes state.

The last-line check renders the last renderable with a `rich.Console` on every read, once per
session per poll.

---

## 4. Defects observed in the code

Mapped to the findings in PLAN §1, plus new ones (N1–N8).

| # | Defect | Evidence | Consequence |
|---|--------|----------|-------------|
| F3 | `start()` has no lock: check `alive` then spawn | `process_manager.py:39-51` | Two concurrent clicks (two sessions, or session + updater cancel) can spawn two workers; the first `Process` object is overwritten and becomes unmanaged. |
| F4 | `stop()` calls `kill()` and never joins | `process_manager.py:74` `self._process.kill()` | `stop()` returns before the process is confirmed gone; `alive` may still be `True` right after. |
| F4 | The stop lock dict is per instance and created lazily | `process_manager.py:35`, `:66-70` | Two concurrent `stop()` calls can create two different locks. The lock never covers `start()`. |
| F5 | State inferred from the last log line | `process_manager.py:105-122` | §3. |
| F7 | In-memory ownership only; reload kills the server | `process_manager.py:26`, `gui.py:102` | A server that dies without `clearup()` loses its workers (still running, unmanaged); the next server can start duplicates. |
| N1 | `get_manager()` checks then inserts without a lock | `process_manager.py:129-130` | Two sessions can create two `ProcessManager` for one name; one of them is lost from the registry with its worker. |
| N2 | The log thread stops as soon as the worker is dead | `process_manager.py:87` `while self.alive:` | Lines still in the queue when the worker exits are never read. That includes the worker's final `Reason: Finish` / `Reason: Update`, so state can read 3 after a clean finish or update. Then the next `start()` reads these stale lines into the new run's log. |
| N3 | State depends on which text happens to be last | `process_manager.py:115-122` | Any last line other than the three `Reason:` texts reads as 3 (warning). An update stop from the main loop (`alas.py:559-563` `break`) ends with `Reason: Finish`, so it reads as 2, not 4. A worker killed from outside (Task Manager, OOM) reads as 3 only because its last line happens not to be a `Reason:` line. Exit code is never consulted, and an exception exits with code 0 anyway (`process_manager.py:182-183`). |
| N4 | `start()` does not reset `renderables` | `process_manager.py:38-52` | Until the new worker logs, `state` is computed from the previous run's last line (only matters if `alive` races `is_alive()` at spawn). |
| N5 | Daemon/tool runs get no stop event | `app.py:689` `self.alas.start(task)` | Updater cannot stop them gracefully; it kills them after 10 min (`updater.py:239-241`). |
| N6 | One stop event for all instances | `app.py:1450`, `updater.py:223` | No instance can be stopped gracefully on its own: the event only means "stop everything for update". Setting or clearing it (`updater.py:223`, `:234`, `:263`) affects every instance started with it. |
| N7 | `Process` objects are never joined or closed | `process_manager.py:42`, `:74` | Zombie entries on *nix and handle leaks on Windows over long runs; relevant to the 72h goal (P0 to confirm). |
| N8 | The SyncManager is a single point of failure for logs and the stop event | `setting.py:65`, `process_manager.py:30`, `app.py:1450` | If the manager process dies, every `q.put` in every worker raises, and `updater.event` becomes unusable. Suspected cause of the 48h blank window (PLAN F6). Hypothesis until P0.3 confirms. |
| j | `kill()` instead of `terminate()` is deliberate upstream | `orphanSlayer.py:24-36` (#883) | On Windows `terminate()` and `kill()` are both `TerminateProcess`, so a `terminate → join → kill` sequence behaves the same there. On *nix/docker, sub-subprocesses started by a mod (e.g. AlasFpyBridge) are not reached by either; orphanSlayer covers them. P1.2 must not remove or bypass that path. |

---

## 5. Invariants

The PLAN §4 P1 invariants, with today's status and where each is enforced and proven.

| Invariant | Today | Enforced in | Proven by |
|-----------|-------|-------------|-----------|
| At most one worker per instance | **Violated** (F3, N1) | P1.2: class-level registry lock for `get_manager`; per-instance lock around every transition | P1.3 "concurrent start ×20 → 1 process" |
| Concurrent starts never duplicate | **Violated** (F3) | P1.2: `start` idempotent under the per-instance lock (`starting`/`running` → no-op) | P1.3 concurrent start ×20 |
| Stop returns after confirmed exit | **Violated** (F4) | P1.2: stop event → `terminate()` → `join(t)` → `kill()` → `join()`; state `stopped` only after `join` returns | P1.3 "stop when stopped", "repeated stop" (`is_alive()` is `False` when `stop()` returns) |
| Restart cannot race shutdown | **Violated**: `restart_processes` and `stop()` share no lock (`updater.py:235` vs `:241`) | P1.2: `restart` = `stop()` then `start()` under one lock; `start` during `stopping` waits | P1.3 "start during stop", "restart race" |
| Failure ≠ deliberate stop | **Violated** (F5, N2, N3) | P1.2: a `deliberate_stop` flag set by `stop()`; unexpected exit → `failed` with `exitcode`; `Reason:` text no longer decides state | P1.3 "unexpected exit → failed" |
| State comes from backend ownership only | **Partly holds**: no browser writes state, but it is derived from log text | P1.2: explicit state machine `stopped → starting → running → stopping → stopped`, `running → failed`, `revision` bumped on each transition; `.state` int mapped from it | P1.3 state/revision assertions |
| Status survives a GUI session closing | **Holds** (registry is class-level; sessions hold references only) | Keep: `InstanceService` is process-wide, not per session | P1.3 "status survives a GUI session closing" |
| Server restart → no duplicate or silently orphaned workers | **Violated** (F7) | P1.4: PID file written on start / removed on confirmed exit; adopt-or-kill on startup; deterministic `clearup()` | P1.4 orphan test |
| Single uvicorn worker | **Holds** (`gui.py:83-85`, no `workers=`) | Document as a requirement; P7 must not add workers | Review |
| Lifecycle works with no GUI session open | **Holds** for `--run`/`reloadalas`; there is no API yet | P2 API on top of `InstanceService` | P2.2 TestClient tests |

---

## 6. Compatibility contract for P1.2

P1.2 replaces the internals with `module/control/instances.py:InstanceService`. The surface below
is used by PyWebIO, the updater and the startup hooks and **must keep working with the same
behaviour**, delegating to `InstanceService` where marked.

| Member | Used by | P1.2 |
|--------|---------|------|
| `ProcessManager.get_manager(name)` | `app.py:163,181,1053`, `restart_processes` | Keep; make it race-free (class-level lock). |
| `ProcessManager._processes` (iterable of managers) | `app.py:1475` `clearup()` | Keep as a dict name → manager (or a view of it). |
| `ProcessManager.running_instances()` | `updater.py:211` | Keep; delegate to service state `running`. |
| `ProcessManager.restart_processes(instances, ev)` | `app.py:1549`, `updater.py:235,264` | Keep the signature and the `config/reloadalas` read-then-delete; each start goes through the service. |
| `pm.start(func, ev=None)` | `app.py:457,689`, `restart_processes` | Delegate; idempotent; `func=None` → `get_config_mod()`. |
| `pm.stop()` | `app.py:456,688,1476`, `updater.py:241` | Delegate; returns after confirmed exit; safe when already stopped. Keep it bounded in time: it runs on the session thread and in uvicorn shutdown. |
| `pm.alive` | `app.py:458,592,690`, `updater.py:228` | `True` for `starting`/`running` (and `stopping` until exit is confirmed). |
| `pm.state` → `0..4` | `app.py:163,181,1135` | Mapping: `running`/`starting`/`stopping` → 1; `stopped` → 2; `failed` → 3; stopped by the update event → 4. |
| `pm.config_name` | `updater.py:214,230`, `restart_processes` | Keep. |
| `pm.renderables`, `pm.renderables_max_length`, `pm.renderables_reduce_length` | `widgets.py:189` `put_log` | Keep names, list type, in-place append and front-trim by `renderables_reduce_length`. |
| Log lines `[<name>] exited. Reason: Manual stop` / `Finish` / `Update` | Users (log panel) | Keep writing them; stop **reading** them for state. |
| `config/reloadalas` (one name per line) | `updater.py:252`, `process_manager.py:218` | Keep the format. |
| `ProcessManager.run_process(config_name, func, q, e)` | worker target | Keep as the default target; the target becomes injectable so tests can use fake workers. |

Not part of the contract (internal, may change): `_process`, `_process_locks`,
`thd_log_queue_handler`, `start_log_queue_handler`, `_thread_log_queue_handler`.

P1.2 should also fix N2 by draining the queue after the worker exits, before the state
becomes `stopped`/`failed`. That changes no public member.

---

## 7. Open questions handed to later slices

1. **Orphans (P1.4)**: adopt a live worker as `running (unmanaged)`, or kill it, by deploy flag?
   Adoption cannot reattach the log queue (it lived in the old SyncManager), so an adopted worker
   would have no live log in the GUI.
2. **PID file location (P1.4)**: `config/tmp*` is already git-ignored (`.gitignore:9`), so
   `config/tmp/<instance>.pid` needs no `.gitignore` change. Confirm `deploy/atomic.py`'s
   `atomic_failure_cleanup('./config')` (`app.py:1522`) does not touch it.
3. **Stop event (P1.2)**: keep the shared `updater.event` for "stop all for update" and add a
   per-instance event for `stop()`? `alas.py:485` and `config.py:611` already honour any event
   passed in.
4. **terminate timeout (P1.2)**: how long `join(t)` waits after the stop event/`terminate()`. It must
   stay short enough for the session-thread caller (the button) and uvicorn shutdown. Suggested:
   stop event check interval is up to 5 s (`alas.py:491` `time.sleep(5)`), so graceful stop is
   only reliable while the worker waits for a task. Default to `terminate()` immediately on
   Windows (same as today's `kill()`) and treat the event as best-effort.
5. **Daemon/tool stop event (P1.2)**: pass `updater.event` (or a per-instance event) from
   `app.py:689` too? It is a one-token upstream edit; defer unless P1.2 needs it.
6. **SyncManager health (P3/P6)**: detect a dead manager and recreate it. P0.3 decides the priority.
