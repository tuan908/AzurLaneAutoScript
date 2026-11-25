# ALAS lifecycle ownership map (P1.1)

Status: v2 (2026-11-25, review fixes). Slice P1.1 of `doc/modernization/PLAN.md`.
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
| Overview scheduler button | `app.py:456-458` `onclick_on=lambda: self.alas.stop()`, `onclick_off=lambda: self.alas.start(None, updater.event)`, `get_state=lambda: self.alas.alive` | `stop()`, `start(None, ev)`, `.alive` | switch polled every 1 s (`app.py:496`) | The only **scheduler button** that passes the update event (startup and updater recovery also pass it, through `restart_processes()`, §2.3/§2.4). `func=None` → `get_config_mod()`. |
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
| `clearup()` | `app.py:1475-1476` `for alas in ProcessManager._processes.values(): alas.stop()` | `stop()` on every entry (iterating the **live** dict), then `State.clearup()` (`setting.py:70` `cls.manager.shutdown()`), then `task_handler.stop()` (`app.py:1478`) | uvicorn on_shutdown; updater before reload (`updater.py:257`); Force restart (`app.py:963`) |
| Reload supervisor | `gui.py:101-102` `if b: process.kill()` | kills the uvicorn child ≤ 1 s after `restart_event` | reload only. **Nothing makes the kill wait for cleanup.** Force restart runs `clearup()` before `restart_event.set()` (`app.py:963-964`), but the updater arms a 2 s timer first and only then calls `clearup()` (`updater.py:256-257`). If `clearup()` takes longer than ~2 s (today only when the SyncManager or a kill is slow; routinely once P1.2's `stop()` joins), the supervisor kills the server while workers are still alive and they are orphaned (§2.4, N9). |
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
| Reload | `updater.py:254-257` `from module.webui.app import clearup`, `self._trigger_reload(2)`, `clearup()` | arms a 2 s `threading.Timer` that sets `restart_event`, **then** runs `clearup()` | Reload only. The timer does not wait for `clearup()` (N9). On the scheduled path, `clearup()` also self-joins (N10). |
| Update failed | `updater.py:263-264` `self.event.clear()`, `ProcessManager.restart_processes(instances, self.event)` | `restart_processes` | |

Threads: the GUI's update button calls `updater.run_update` on the PyWebIO session thread
(`app.py:859`, `:876`). The **scheduled** update runs as a generator on the global `task_handler`
thread: `startup()` adds `updater.schedule_update()` (`app.py:1453`), which calls `self.run_update()`
(`updater.py:295`). That path reaches `clearup()` → `task_handler.stop()` (`app.py:1478`) →
`self._thread.join(timeout=2)` (`module/webui/utils.py:246-249`) **on the handler's own thread**. Python
raises `RuntimeError: cannot join current thread`, so `clearup()` does not finish: "Alas closed." is
never logged. The handler loop catches the error and drops the `schedule_update` task (`utils.py:215-217`).
Workers and the SyncManager have already been stopped by then, so today the symptom is only a logged
traceback. Any cleanup step added after that point would be skipped.

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

- `module/device/device.py:33` `process_manager.py L149 run_process()`: part of a **historical stack-trace example** in a
  docstring, not a pinned source reference. Its `L149` is stale: at the pinned commit `run_process` starts at
  `process_manager.py:134`.
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

Mapped to the findings in PLAN §1, plus new ones (N1–N12).

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
| N9 | Reload signal is not ordered after cleanup | `updater.py:256-257`, `gui.py:101-102` | The supervisor can kill the server while `clearup()` is still stopping workers, leaving orphans. Becomes likely once `stop()` joins (P1.2). |
| N10 | Scheduled update self-joins the task-handler thread | `app.py:1453`, `updater.py:295`, `app.py:1478`, `utils.py:246-249` | `RuntimeError` inside `clearup()`; any work after `task_handler.stop()` is skipped, and the scheduled update task is removed. |
| N11 | `clearup()` iterates the live registry with no shutdown gate | `app.py:1475` | A session's `get_manager()` can insert during iteration (`RuntimeError: dictionary changed size during iteration`), and a start that races cleanup (button, `restart_processes`) can spawn a worker after its instance was stopped. Nothing rejects starts once shutdown begins. |
| N12 | One uvicorn worker is assumed, not enforced | `gui.py:83-85` | `uvicorn.run(...)` omits `workers`, and uvicorn 0.17.6 then reads `WEB_CONCURRENCY` (upstream `uvicorn/config.py:331-332`; `uvicorn/main.py:449-456` starts a multiprocess supervisor when `workers > 1`). With `WEB_CONCURRENCY=2`, two servers each have their own registry and each runs the `--run`/`reloadalas` startup hook, so each spawns its own ALAS worker for the same instance. P1.2's in-process locks cannot prevent that. (Read from the uvicorn 0.17.6 source, not reproduced on the Windows host.) |
| j | `kill()` instead of `terminate()` is deliberate upstream | `orphanSlayer.py:24-36` (#883) | On Windows `terminate()` and `kill()` are both `TerminateProcess`, so a `terminate → join → kill` sequence behaves the same there. On *nix/docker, sub-subprocesses started by a mod (e.g. AlasFpyBridge) are not reached by either; orphanSlayer covers them. P1.2 must not remove or bypass that path. |

---

## 5. Invariants

The PLAN §4 P1 invariants, with today's status and where each is enforced and proven.

| Invariant | Today | Enforced in | Proven by |
|-----------|-------|-------------|-----------|
| At most one worker per instance | **Violated** (F3, N1, N12) | P1.2: class-level registry lock for `get_manager`; per-instance lock around every transition. Across servers: see "Single uvicorn worker" | P1.3 "concurrent start ×20 → 1 process": 20 threads each call `ProcessManager.get_manager(fresh_name).start(...)` for the **same name that is not yet in the registry**, released together by a barrier. Assert one registry entry, one spawned fake worker (count spawns in the fake target factory), and every thread got the same manager object. |
| Concurrent starts never duplicate | **Violated** (F3) | P1.2: `start` idempotent under the per-instance lock (`starting`/`running` → no-op) | P1.3 concurrent start ×20 (above), plus the same race on a pre-created manager so the per-instance lock is tested on its own |
| Stop returns after confirmed exit | **Violated** (F4) | P1.2: stop event → `terminate()` → `join(t)` → `kill()` → `join()`; state `stopped` only after `join` returns | P1.3 "stop confirms exit": start a fake worker that ignores the stop event (and, on *nix, ignores SIGTERM so the `kill()` fallback is exercised), keep the **original** `Process` handle (and its PID) taken while it was alive, call `stop()`, and assert immediately on return that `handle.is_alive()` is `False`, `handle.exitcode is not None`, and (psutil if available) the PID is gone. "Stop when stopped" and "repeated stop" stay as separate idempotence tests; they do not prove the join. |
| Restart cannot race shutdown | **Violated**: `restart_processes` and `stop()` share no lock (`updater.py:235` vs `:241`); nothing gates starts during server cleanup (N11) | P1.2: `restart` = `stop()` then `start()` under one lock; `start` during `stopping` waits. P1.4: a **server-wide shutdown gate** in `InstanceService`: `shutdown()` takes the registry lock, closes the gate, takes a stable snapshot (`list(...)`) of the registry, releases the lock, then stops every instance in the snapshot. `get_manager()` and `start()` check the gate under the registry lock; `start()` checks it **again after acquiring the per-instance lock**, so a start that was waiting behind a stop is rejected (logged, no spawn) once the gate is closed. `clearup()` calls `shutdown()` instead of iterating `_processes` itself. | P1.3 "start during stop", "restart race". P1.4 "start races server cleanup": threads keep calling `get_manager(name).start()` (existing and fresh names) and `restart_processes([...])` while another thread runs the real `clearup()` path with fake workers. Assert no `RuntimeError`, no fake worker alive after `clearup()` returns, no spawn after the gate closed, and later starts are rejected. |
| Failure ≠ deliberate stop | **Violated** (F5, N2, N3) | P1.2: outcome classification (§6.1) from backend-owned signals, never log text | P1.3 outcome matrix (§6.1): one test per row, including a caught exception that today exits with code 0 |
| State comes from backend ownership only | **Partly holds**: no browser writes state, but it is derived from log text | P1.2: explicit state machine `stopped → starting → running → stopping → stopped`, `running → failed`, `revision` bumped on each transition; `.state` int mapped from it | P1.3 state/revision assertions |
| Status survives a GUI session closing | **Holds** (registry is class-level; sessions hold references only) | Keep: `InstanceService` is process-wide, not per session | P1.3 "status survives a GUI session closing" |
| Server restart → no duplicate or silently orphaned workers | **Violated** (F7, N9, N10) | P1.4: PID file written on start / removed on confirmed exit; adopt-or-kill on startup; deterministic `clearup()` through the shutdown gate. The reload signal must be sent **only after `clearup()` has returned**. Preferred fix: in `_run_update`, call `clearup()` before `_trigger_reload()`, a two-line reorder in `updater.py` that needs review to add it to PLAN §7. The alternative without touching `updater.py`: `clearup()` blocks until every worker is confirmed gone and the timer is re-armed from `clearup()`. `clearup()` must not join `task_handler` from its own thread: skip the join when `threading.current_thread() is task_handler._thread`. | P1.4 orphan test. P1.4 "scheduled update reload": run `updater.schedule_update()` (or `_run_update`) **on a real `TaskHandler` thread**, with `State.restart_event` replaced by a recording event, `update()` stubbed to succeed, and fake workers whose stop takes longer than the 2 s timer. Assert that when `restart_event` is set, every fake worker has already exited and `clearup()` has finished ("Alas closed." logged, the cleanup-done flag set), and that no `RuntimeError: cannot join current thread` was raised. |
| Single uvicorn worker | **Holds only while `WEB_CONCURRENCY` is unset** (N12): `gui.py:83-85` omits `workers=`, so uvicorn 0.17.6 falls back to `WEB_CONCURRENCY` | P1.4: an **owner lock** taken by `InstanceService` at server startup, before the `restart_processes` startup hook, with `filelock` (3.3.0, already installed) on a git-ignored path such as `config/tmp/control.lock`. A second server process that cannot take it within a short timeout logs an error and refuses to own instances: its startup hook spawns nothing and its `start()` is rejected. This also covers two `gui.py` launched by hand. Optional, needs review to add `gui.py` to PLAN §7: pass `workers=1` explicitly in `gui.py:83-85`. P7 must not add workers. | P1.4 "second owner refused": two processes build an `InstanceService` on the same lock path. The second refuses to start a fake worker, and only one worker exists. |
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
| `ProcessManager.running_instances()` | `updater.py:211` | Keep the **liveness filter**: every instance whose `pm.alive` is `True`, i.e. `starting`, `running` **and `stopping`** until exit is confirmed. Never filter on state `running` only: the updater waits only on the list it captured (`updater.py:211-228`), so an omitted `stopping` worker could still be alive while the update replaces code. P1.3 "updater sees stopping": put a fake worker into `stopping` (slow stop on another thread), assert it is in `running_instances()`, and that `Updater._wait_update` does not return until that worker has exited. |
| `ProcessManager.restart_processes(instances, ev)` | `app.py:1549`, `updater.py:235,264` | Keep the signature and the `config/reloadalas` read-then-delete; each start goes through the service. |
| `pm.start(func, ev=None)` | `app.py:457,689`, `restart_processes` | Delegate; idempotent; `func=None` → `get_config_mod()`. |
| `pm.stop()` | `app.py:456,688,1476`, `updater.py:241` | Delegate; returns after confirmed exit; safe when already stopped. Keep it bounded in time: it runs on the session thread and in uvicorn shutdown. |
| `pm.alive` | `app.py:458,592,690`, `updater.py:228` | `True` for `starting`/`running` (and `stopping` until exit is confirmed). |
| `pm.state` → `0..4` | `app.py:163,181,1135` | Mapping: `running`/`starting`/`stopping` → 1; `stopped` → 2; `failed` → 3; `stopped` with reason `update` → 4. Classification in §6.1. |
| `pm.config_name` | `updater.py:214,230`, `restart_processes` | Keep. |
| `pm.renderables`, `pm.renderables_max_length`, `pm.renderables_reduce_length` | `widgets.py:189` `put_log` | Keep names, list type, in-place append and front-trim by `renderables_reduce_length`. |
| Log lines `[<name>] exited. Reason: Manual stop` / `Finish` / `Update` | Users (log panel) | Keep writing them; stop **reading** them for state. |
| `config/reloadalas` (one name per line) | `updater.py:252`, `process_manager.py:218` | Keep the format. |
| `ProcessManager.run_process(config_name, func, q, e)` | worker target | Keep as the default target; the target becomes injectable so tests can use fake workers. |

Not part of the contract (internal, may change): `_process`, `_process_locks`,
`thd_log_queue_handler`, `start_log_queue_handler`, `_thread_log_queue_handler`.

P1.2 should also fix N2, with these rules:

- **Exit confirmation and state publication never wait on the log drain.** `stop()` and the exit
  watcher publish `stopped`/`failed` as soon as `join()` confirms exit and the outcome (§6.1) is known.
  The SyncManager queue is unbounded and may be dead (N8), so tying lifecycle progress to it could stall
  shutdown or strand a transition.
- **The drain is bounded.** After exit the log thread keeps reading until the queue is empty, or a
  deadline (e.g. 2 s), or an item cap, whichever comes first. Any manager error (`EOFError`,
  `BrokenPipeError`, `ConnectionError`) ends the drain. It runs on the log thread, never under the
  per-instance or registry lock.
- **Late records stay with their run.** Each run gets a run id and its own queue, created per `start()`.
  The drainer for run *k* appends only run *k*'s records. A new `start()` does not wait for the old
  drainer: it signals it to stop, and anything run *k* left unread is discarded with one summary
  line ("N log lines of the previous run dropped"), never shown as part of run *k+1*.
- None of this changes a public member: `renderables` keeps its contract (§2.2).

### 6.1 Outcome classification (replaces log parsing)

A flag set only by `pm.stop()` is not enough. The updater stops workers by setting its event directly
(`updater.py:223`), and today a normal tool return and a caught worker exception **both exit with code 0**
(`process_manager.py:167-183`). P1.2 classifies an exited run from backend-owned signals, in this order:

1. **Worker outcome record.** Before exit, the worker reports one of `finished`, `update`, `failed` over a
   per-run channel owned by `InstanceService`, not the SyncManager: a `multiprocessing.Value`, or a
   one-shot `Pipe` created per `start()`. A small wrapper writes it around the dispatch, in
   `module/control/` so tests can import it without heavy deps, called from `run_process`:
   - normal return → `finished`, unless the stop event is set at that moment → `update` (covers the
     `alas.py:559-563` `break`);
   - `SystemExit` with code 0/`None` while the stop event is set → `update` (covers `alas.py:489`
     `exit(0)`); other `SystemExit` → `failed` if the code is non-zero, else `finished`;
   - `Exception` caught at `process_manager.py:182-183` → `failed`, and the worker then exits with a
     **non-zero code** (e.g. 1) instead of 0.
   The `Reason: ...` log lines stay for users.
2. **Deliberate stop.** `stop()` sets `stop_requested` under the per-instance lock before signalling the
   worker.
3. **Process exit.** `exitcode` from `join()`: non-zero, negative (signal), or `None` after `kill()`.

| Case | Signals | State | `.state` int |
|------|---------|-------|--------------|
| `pm.stop()` (button, updater timeout, `clearup()`) | `stop_requested` (overrides everything else) | `stopped` | 2 (same as today's `Manual stop`) |
| Function returned normally (alas loop end, tool, mod) | record `finished`, exit 0 | `stopped` | 2 |
| Cooperative update stop (updater set its event, worker returned or `exit(0)`) | record `update` | `stopped` (reason `update`) | 4 |
| Caught exception | record `failed`, exit ≠ 0 | `failed` | 3 |
| Crash / killed from outside / `os._exit(n)` | no record, or exit ≠ 0 / negative | `failed` | 3 |
| Exit 0 with no record (worker died before the wrapper ran) | no record, exit 0 | `failed` | 3 |

P1.3 covers each row with a fake target run through the same wrapper, including **an exception
caught by the wrapper whose old code path would have exited with 0**, an `exit(0)` with the event set,
an event set directly by the test (not via `stop()`), and a tool-style target that simply returns.
Each test asserts state, `.state` int and `revision`, and none parses log text.

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
