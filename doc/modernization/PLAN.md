# ALAS modernization — implementation plan

Status: draft v1 (2026-11-25). Owner: tuan908.
Source: the "ALAS modernization plan" proposal, checked against this checkout at `a868d2abe`.

Goal: an automation runtime that stays reliable for 72h+ even when its interface fails,
with a stable HTTP API and a React dashboard, while staying mergeable with upstream ALAS.

This file is the single source of truth for the T3 workflows in
`~/.t3/workflows/alas-modernize.ts`. Agents read it; keep slice IDs stable.

---

## 1. What the code actually does today (verified)

The proposal was written from public docs. These findings from the local checkout change
some of its assumptions.

| # | Finding | Where | Consequence for the plan |
|---|---------|-------|--------------------------|
| F1 | **There is no FastAPI.** The web server is plain Starlette 0.14.2 + PyWebIO 1.6.2 under uvicorn 0.17.6. `module/webui/fastapi.py` is a copy of PyWebIO's helper, not FastAPI. | `requirements.txt`, `module/webui/fastapi.py` | OpenAPI is not free. P2.1 decides between pinning `fastapi==0.65.2` (pins `starlette==0.14.2`, `pydantic<2`) or plain Starlette routes + pydantic 1.10 models. |
| F2 | **Runtime is Python 3.7** (requirements compiled with 3.7; Windows bundle). The WSL dev box has 3.14, which is not the runtime. | `requirements.txt` header | All new Python must be 3.7-compatible: no walrus, no `typing.Literal`/`Protocol` (use `typing_extensions` 4.3.0, already present), no `asyncio.to_thread`, no PEP 604 unions. Checked with `vermin -t=3.7-`. Tests run on uv-provided 3.8 (no 3.7 build available). |
| F3 | `ProcessManager.start()` has **no lock**: two concurrent starts can both see `alive == False` and spawn two workers. | `module/webui/process_manager.py:36` | P1.2 fixes this; it is the first invariant test. |
| F4 | `stop()` calls `Process.kill()` and **never joins**; the lock dict is per-instance and created lazily (not race-free). | `process_manager.py:63` | "Stopping waits for confirmed exit" is not true today. |
| F5 | Instance state is **inferred by parsing the last log line** (`Reason: Manual stop/Finish/Update`) into ints 1–4. | `process_manager.py:100` | Replace with an explicit state machine; keep the int mapping for PyWebIO. |
| F6 | Logs flow worker → `State.manager.Queue()` (a **SyncManager proxy living in a separate manager process**) → handler thread → `renderables` list (max 400, drops 80) → one `RichLog.put_log` generator per browser session rendering HTML. | `process_manager.py`, `setting.py:63`, `widgets.py:189` | The manager process is a single point of failure and a prime suspect for the 48h blank window. Phase 0 must watch it. |
| F7 | Process ownership is an **in-memory class dict** in the uvicorn process. With `EnableReload`, `gui.py` runs the server in a child and `kill()`s it on restart; non-daemon worker children can be orphaned. `config/reloadalas` re-starts instances after update. | `gui.py:91`, `app.py:1466`, `process_manager.py:193` | "Server restart → no orphaned workers" needs a PID file / adoption story (P1.4). |
| F8 | Config writes are **atomic** (`deploy/atomic.py` → `os.replace`) but **unlocked and unversioned**. The worker's `AzurLaneConfig.save()` writes its whole in-memory `self.data`, so a GUI edit made since the worker last loaded is **silently lost**. | `module/config/config.py:265`, `module/config/utils.py:99`, `app.py:534` | Lost-update bug exists today. P5.3 adds a cross-process lock (`filelock` 3.3.0 is already installed via uiautomator2) and re-read-merge on save. |
| F9 | The file logger opens `./log/{date}_{name}.txt` **once at process start**: a 72h run writes to day 1's file forever, with no rotation, and `tracebacks_show_locals=True`. | `module/logger.py:171` | Disk growth, not memory. P3.3 adds rotation/date roll in a way upstream can absorb. |
| F10 | Server binds **0.0.0.0 by default**; the only auth is the optional PyWebIO password. | `gui.py:60` | A start/stop API must not be open to the LAN. P2.3 adds token auth reusing `Password`, and the launcher binds 127.0.0.1. |
| F11 | Existing recovery: `GameStuckError`/`GameTooManyClickError` → app restart; 3 failures of a task → `RequestHumanTakeover`; `stop_event` checked in loop/wait. | `alas.py:77`, `alas.py:596`, `alas.py:485` | Phase 6 audits and extends these; it does not duplicate them. |
| F12 | Config metadata field types in `module/config/argument/args.json`: `input` 430, `select` 414, `checkbox` 323, `datetime` 97, `storage` 70, `textarea` 37, `lock` 4, `state` 1. | `args.json` | The form renderer needs exactly these 8 kinds (storage/lock/state are read-only). |
| F13 | No `upstream` remote; `origin` is the fork. pytest suite exists (`pyproject.toml`, `tests/`). Bun, uv, gh are installed in WSL. | — | Add `upstream` before the sync workflow runs. |

---

## 2. Decisions

1. **Keep the Python engine.** No rewrite of automation, scheduler, OCR, device code.
2. **One process owner.** The new API is mounted **inside the existing Starlette app** built by
   `module/webui/app.py:app()`, so PyWebIO and the API share the same `ProcessManager`
   registry. A separate control server is only added in P7 as a headless entry that builds the
   same app. Never run legacy GUI and control server as two owners of one instance.
3. **Frontend observes, never owns.** Browser close/refresh/crash must not touch workers.
4. **REST for commands, SSE for events.** REST snapshot is authoritative; SSE is incremental.
5. **No dependency upgrades during the migration** except the minimum new ones (FastAPI-or-not
   in P2.1, nothing else). Dependency modernization is deferred (§8).
6. **Minimal upstream touch-points.** New code lives in `module/control/`, `dashboard/`,
   `tests/control/`. Edits to upstream files are kept small and listed in §7.
7. React UI is served at `/dashboard` next to PyWebIO at `/` until it reaches parity.

Stack: React 19, Vite + Bun, TanStack Router/Query/Virtual, shadcn/ui + Tailwind,
React Hook Form, openapi-typescript, Vitest + Playwright; backend pytest.
Avoid: Redis, Celery, GraphQL, Redux, a second backend, a DB for settings.

---

## 3. Branching and delivery

```
upstream/master ──► master (fork mirror, untouched)
                      └── modernize/main        integration branch (all slices land here)
                            ├── modernize/p1-2-lifecycle-lock
                            ├── modernize/p2-2-instance-endpoints
                            └── ...  one branch per slice, one PR per slice
```

- Everything stays local until the owner explicitly asks to push. Slices land by local merge into `modernize/main`.
- Create once: `git switch -c modernize/main master && git add doc/modernization && git commit -m "Doc: modernization plan"`
- Add upstream once: `git remote add upstream https://github.com/LmeSzinc/AzurLaneAutoScript.git`
- Slice branch name: `modernize/<slice-id-lowercase-with-dash>-<slug>`, e.g. `modernize/p1-2-lifecycle-lock`.
- Commit style follows upstream: `Add: ...`, `Fix: ...`, `Upd: ...`, `Doc: ...`, `Test: ...`.
- Every slice must leave the legacy PyWebIO GUI working.
- **Doc first, then implement.** Each phase P1–P7 has a spec doc: `lifecycle.md` (P1), `api.md`
  (P2), `events.md` (P3), `dashboard.md` (P4), `config.md` (P5), `recovery.md` (P6),
  `operations.md` (P7), all under `doc/modernization/`. If the doc exists, the phase's slices go
  straight to implementation against it. If not, a **discovery slice `Pn.0`** maps the current
  code and writes the doc (current state with file:line, data and caller maps, defects,
  invariants and contract, per-slice notes, open questions), and it lands before any `Pn.N`
  implementation slice. P1.1 was P1's discovery. P0 is discovery by nature: its doc,
  `baseline.md`, comes from the soak data in P0.3.
- **Implementation slices keep the spec current**: each one updates its phase doc on the same
  branch (what changed, how to use it, which invariants and defects it closes) and marks resolved
  any open finding it fixes.
- GPL-3.0 obligations apply if the modified build is distributed.

### Verification commands (used by the workflows)

```bash
# Python 3.7 syntax/stdlib compatibility of changed files
uvx vermin -t=3.7- --no-tips --violations <changed .py files>
# Control-plane tests (requirements file is created in P1.3)
uv run --no-project --python 3.8 --with-requirements tests/control/requirements-test.txt -m pytest tests/control -q
# Dashboard (once dashboard/ exists)
cd dashboard && bun install --frozen-lockfile && bun run typecheck && bun run test
```

Control tests must not import heavy runtime deps (numpy, cnocr, mxnet, adbutils).
Use fake worker targets for lifecycle tests; real MuMu only for soak/integration.

---

## 4. Phases and slices

Each slice is one PR. `manual` slices need a human on the Windows host.
Estimates are part-time hours, excluding soak wall-clock time.

### P0 — Reliability baseline (3–5h + 72h soak)

Goal: find out whether the 48h blank window is Electron, PyWebIO session, the SyncManager
process, the uvicorn server, or the worker — before changing anything.

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P0.1 | code | `dev_tools/soak_probe.py`: stdlib + psutil (3.7). Every N s append a CSV row per process of interest — gui/uvicorn python, SyncManager child, each worker, Electron main/renderers, MuMu (`MuMuPlayer*`, `MuMuVMMHeadless*`) — with RSS, threads, handles (Windows `num_handles`), CPU; plus newest `log/*.txt` mtime and last log line timestamp; plus HTTP `GET /` status+latency of the GUI. Survives target processes dying. | Runs on Windows for 10 min and produces a sane CSV; unit test for row building with fake psutil objects. |
| P0.2 | manual | Two 72h soaks on Windows: **A** Electron as today; **B** `python gui.py --host 127.0.0.1 --port 22267` in a browser. In each, at ~24h close and reopen the UI. Run the probe; run the `alas-soak` workflow (csv mode) to analyze. | Two CSVs + notes on when/what went blank. |
| P0.3 | code+doc | `doc/modernization/baseline.md`: root-cause classification with evidence, and which of F3–F9 were observed. Implement the cheapest fix or mitigation the evidence supports (e.g. an Electron/PyWebIO workaround, or a regression test or probe check that reproduces the failure). If the evidence justifies no change yet, ship the reproduction as a test or a `soak_probe` check instead. | Classification written; fix or reproduction committed; P6 recovery scope adjusted. |

### P1 — Lifecycle ownership (6–12h)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P1.1 | doc (landed) | `doc/modernization/lifecycle.md`: every caller of `ProcessManager` (`app.py:163,181,1053,1475,1549`, updater, `restart_processes`, `reloadalas`), who reads `.state`, and the invariants below. | Reviewed map. |
| P1.2 | code | `module/control/instances.py`: `InstanceService` + explicit state machine `stopped → starting → running → stopping → stopped`, `running → failed` (unexpected exit, with exit code), `revision` counter bumped on every transition. Per-instance lock from a class-level lock (race-free). `start` idempotent; `stop` = set stop event → `terminate()` → `join(t)` → `kill()` → `join()`; restart waits for stop. Deliberate stop vs failure tracked by a flag, not log parsing. `ProcessManager` delegates to it; `.state` int mapping preserved for PyWebIO. Worker target injectable for tests. | All invariants below hold under test; PyWebIO start/stop unchanged in behaviour. |
| P1.3 | test | `tests/control/` with `requirements-test.txt` (pytest pinned for 3.8, nothing heavy) and fake workers: concurrent start ×20 → 1 process; stop when stopped; start during stop; restart race; unexpected exit → `failed`; status survives a GUI session closing. | Green on 3.8; vermin 3.7 clean. |
| P1.4 | code | Orphan safety: PID file `config/tmp/<instance>.pid` (or similar ignored path) written on start, removed on confirmed exit; on server startup detect a live PID that is an ALAS worker (psutil cmdline check) and either adopt as `running (unmanaged)` or kill per a deploy flag. Make `clearup()` and the `EnableReload` kill path stop workers deterministically. | "Server restart → no duplicate or silently orphaned workers" test passes. |

Invariants: at most one worker per instance; concurrent starts never duplicate; stop returns
after confirmed exit; restart cannot race shutdown; failure ≠ deliberate stop; state comes from
backend process ownership only. **Single uvicorn worker** (in-memory ownership).

Exit: all lifecycle operations work with no GUI session open.

### P2 — Application API (5–9h)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P2.1 | spike | Install `fastapi==0.65.2` with `starlette==0.14.2`, `pydantic==1.10.2` on 3.7/3.8; mount at `/api/v1` via `Mount` on the existing app; confirm PyWebIO routes unaffected and OpenAPI is produced. If it conflicts, use plain Starlette routes + pydantic models + a hand-built OpenAPI from `Model.schema()`. Record the decision in `doc/modernization/api.md`. Update `requirements-in.txt` and `requirements.txt` only for the chosen addition. | Decision doc + mounted empty router + `/api/v1/health`. |
| P2.2 | code | `module/control/api.py`: `GET /instances`, `GET /instances/{id}`, `POST .../start|stop|restart` returning `InstanceStatus` (`id, state, processId, startedAt, currentTask, lastActivityAt, lastError, revision`). 404 unknown instance, 409 illegal transition. Instance list from `config/*.json` the same way the GUI does. | API tests with fake workers via TestClient. |
| P2.3 | code | Auth + binding: when `Password` is set, require `Authorization: Bearer <Password>` (or a token derived from it) on `/api/*`; reject non-loopback clients when no password is set. Document. | Tests for 401/403 paths. |
| P2.4 | code | `GET /instances/{id}/tasks` (pending/waiting queue read from config, mirroring what the GUI shows), `dev_tools/export_openapi.py` → `dashboard/openapi.json`. | Snapshot test of the OpenAPI file. |

Exit: start/stop/status fully usable via curl with no Electron/PyWebIO page open; the §6
acceptance test passes.

### P3 — Events and logs (5–9h)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P3.1 | code | `module/control/events.py`: in-process bus; ring buffer of last 1000 envelopes `{id, timestamp, event}`; per-subscriber `asyncio.Queue(256)`; full queue ⇒ drop subscriber (it reconnects). Producers: state transitions (P1.2) and the existing log handler thread (via `loop.call_soon_threadsafe`). Messages truncated to 16 KB. Never blocks the worker or the log thread. | Unit tests: slow consumer dropped, flood bounded. |
| P3.2 | code | `GET /api/v1/events` SSE via Starlette `StreamingResponse` (no new dep): `Last-Event-ID` resume from ring, else `event: resync` telling the client to refetch REST; 15 s heartbeat comment. `GET /instances/{id}/logs?after=&limit=` from the in-memory buffer. | Reconnect test restores consistent state. |
| P3.3 | code | File log hygiene (F9): roll the file at date change and cap size (10 MB × 5) in a small, upstream-friendly change to `set_file_logger`/`RichFileHandler`; consider `tracebacks_show_locals` impact. | Test with a fake clock; no behaviour change for short runs. |

Exit: repeated connect/disconnect and sustained log production show no unbounded growth
(measured with the P0 probe over ≥12h).

### P4 — React dashboard (8–14h)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P4.1 | code | `dashboard/` scaffold: Bun, Vite, React 19, TanStack Router + Query, Tailwind, shadcn/ui, Vitest; `bun run gen:api` (openapi-typescript from `openapi.json`); dev proxy to `http://127.0.0.1:22267`. Scripts `typecheck`, `test`, `build`. | `bun run build` and `test` green. |
| P4.2 | code | SSE connection manager (backoff, resync → invalidate queries) + bounded log store (2000 entries, `useSyncExternalStore`). | Vitest for store bound and reconnect. |
| P4.3 | code | Overview + Instances pages (status, start/stop/restart, uptime, current task, last error). Selected instance in URL. | Playwright smoke against a fake backend. |
| P4.4 | code | Logs page (TanStack Virtual, filter, export) + Scheduler page (P2.4 data). | Playwright smoke. |
| P4.5 | code | Serve `dashboard/dist` from the backend at `/dashboard` with SPA fallback that never shadows `/api` or PyWebIO routes; built assets not committed (build step in launcher or release). | Works on Windows from a browser. |

### P5 — Configuration editor (8–16h)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P5.1 | code | `module/control/configuration.py` schema adapter: `args.json` + `menu.json` + i18n → `ConfigField` union for the 8 kinds in F12 (`input`→text/number, `select`, `checkbox`→boolean, `datetime`, `textarea`, `storage`/`lock`/`state` read-only); `GET /config/schema`. | Test: every field in `args.json` maps to a kind. |
| P5.2 | code | `GET /instances/{id}/config` with `revision` (sha256 of file bytes); `PATCH` with `If-Match` revision → 409 on mismatch; apply through `ConfigUpdater.save_callback` and existing validation; write via `write_file`; unknown keys preserved. | Round-trip test over a copy of `config/template.json`. |
| P5.3 | code | Writer safety (F8): cross-process `filelock` around read-modify-write for both the GUI (`_save_config`) and the worker (`AzurLaneConfig.save` re-reads file and applies only `modified` before writing). Smallest possible upstream diff. | Concurrent writer test (two processes) loses nothing; interrupted write leaves last valid file. |
| P5.4 | code | React form renderer by menu/group, React Hook Form, server-side validation errors shown per field, conflict (409) UX. | Playwright: edit, save, reload persists. |

### P6 — Reliability and recovery (6–12h)

P6.0 discovery (`recovery.md`) audits F11 plus the device reconnect and emulator restart paths in `module/device/`, maps them to the failure table below, and marks the gaps P0 confirmed.

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P6.1 | code+doc | Implement `GET /api/v1/health/details` with the signals the P6.0 audit in `recovery.md` shows are missing: server liveness, worker liveness, progress (last log/activity age vs current task), scheduler idle vs stuck, SyncManager alive. | Health tests with a fake clock; `recovery.md` updated. |
| P6.2 | code+doc | In-memory metrics (uptime, task successes/failures, worker restarts, SSE reconnects) exposed in health details; document each metric in `recovery.md`. | Tests with fake clock. |
| P6.3 | code | Opt-in supervisor (deploy flag, per instance): restart on unexpected worker exit with bounded backoff (e.g. 3 per hour), never after `RequestHumanTakeover` or deliberate stop; stop and report after repeated failures. Only if P0/P6.1 show worker crashes. | Fault-injection tests: kill worker → failed → restart → gives up after limit. |
| P6.4 | code | Diagnostics page (health details, metrics, recent errors). | Playwright smoke. |

Failure → recovery: browser disconnect → SSE reconnect; renderer crash → reload; history gap →
REST snapshot; worker crash → bounded restart; ADB drop → existing reconnect; game stuck →
existing app restart; MuMu hung → emulator restart last resort; repeated failure → stop + report.

### P7 — Deployment (6–7h + 72h soak)

| Slice | Kind | Scope | Done when |
|-------|------|-------|-----------|
| P7.1 | code+doc | `control_server.py` headless entry building the same app (PyWebIO optional), binding 127.0.0.1; `start-control.bat` using the bundled toolkit Python; optional browser open. Document start, stop, ports and auth in `doc/modernization/operations.md`. | Starts on Windows with no Electron. |
| P7.2 | code+doc | `deploy/Windows/register-control-task.ps1`: registers or unregisters a Task Scheduler task (runs in the user session, restarts on failure, no duplicate instances). Document it with upgrade notes in `operations.md`. | Script registers and removes the task on Windows; doc reviewed. |
| P7.3 | manual | Final 72h soak with the `alas-soak` workflow (http mode against `/api/v1/health/details`) + probe CSV; compare with P0 baseline. | No progressive degradation; report in `doc/modernization/soak-final.md`. |

---

## 5. Test matrix (owned by the slice in brackets)

Concurrent start [P1.3] · repeated stop [P1.3] · start during shutdown [P1.3] · unexpected exit
[P1.3] · browser reload / closed 24h [P0.2, P7.3] · SSE disconnect [P3.2] · slow consumer
[P3.1] · log flood [P3.1] · concurrent config writes [P5.3] · invalid config [P5.2] · server
restart / orphans [P1.4] · 72h soak [P0.2, P7.3].
Fault injection: kill browser, drop SSE, kill worker, drop ADB, fill buffers, interrupt write.

## 6. First milestone acceptance test (end of P2)

1. Start an instance through the API. 2. Confirm MuMu automation begins. 3. Close every browser
window. 4. Confirm automation continues. 5. Open a new browser session. 6. Read the real state
from the API. 7. Stop through the API. 8. Confirm the worker process exited (probe/Task Manager).

## 7. Upstream compatibility

- Upstream files we expect to touch (keep each diff small, list grows only by review):
  `module/webui/process_manager.py` (delegate to InstanceService), `module/webui/app.py`
  (mount API, startup/clearup hooks), `module/config/config.py` (save merge + lock),
  `module/webui/app.py:_save_config` (lock), `module/logger.py` (rotation),
  `requirements-in.txt` / `requirements.txt`.
- The `alas-upstream-sync` workflow merges `upstream/master` into `modernize/main` weekly in a
  worktree, runs the verification commands, and asks before landing.

## 8. Deferred (and the trigger to revisit)

SQLite metrics (need history across restarts) · persistent event journal (exact replay after
backend crash) · separate supervisor process (API crash interrupts recovery) · Tauri (tray/native
needed) · remote auth (beyond localhost) · multiple API workers (measured bottleneck) · Python
dependency modernization (compat/security blocks operation) · multi-host management.

## 9. Estimate

| Phase | Hours |
|-------|-------|
| P0 | 3–5 |
| P1 | 6–12 |
| P2 | 5–9 |
| P3 | 5–9 |
| P4 | 8–14 |
| P5 | 8–16 |
| P6 | 6–12 |
| P7 | 6–7 |
| **Total** | **47–84** (+ two 72h soaks) |

## 10. Workflows

Defined in `~/.t3/workflows/alas-modernize.ts`.

| Workflow | Use | Start |
|----------|-----|-------|
| `alas-slice` | One slice end-to-end: design (read-only) → you approve → build in a worktree → verify (vermin 3.7, pytest, bun) → independent review → fix loop → you choose merge locally / keep / discard. Never pushes. | `t3 workflow start alas-slice --key slice/P1.2/1 --input '{"slice":"P1.2"}'` |
| `alas-phase` | A whole phase: lists remaining slices, you approve, runs `alas-slice` for each in order, pauses at manual slices, then checks the phase exit criteria. | `t3 workflow start alas-phase --key phase/P1/1 --input '{"phase":"P1"}'` |
| `alas-soak` | Durable soak monitor: polls an HTTP health URL every N min for H hours (http mode) and/or waits for a probe CSV (csv mode), then an agent writes a report. | `t3 workflow start alas-soak --key soak/p0-a --input '{"label":"p0-electron","csvPath":"/mnt/d/AzurLaneAutoScript/log/soak.csv","hours":72}'` |
| `alas-upstream-sync` | Weekly (Mon 08:00) or manual: fetch upstream, trial-merge into `modernize/main` in a worktree, verify, ask before landing. | automatic, or `t3 workflow start alas-upstream-sync --key sync/manual-1 --input '{"scheduledAt":"2026-11-25T00:00:00Z"}'` |

Answer questions with `t3 workflow questions` or the Workflows page.
