# Task pool

Status: `todo`, `doing`, `done`, `pending` (needs a decision, see the note).
Priority: H = contract or correctness risk, M = duplication or dead code, L = tidiness.

| ID | P | Area | Finding | Plan | Status |
|---|---|---|---|---|---|
| T01 | H | API contract | `alasd` JSON structs are a hand-written copy of `dashboard/openapi.json`; only the route list is tested. A renamed or missing field would only show up in the browser. | Contract test: call every documented operation and validate the body against its documented schema, strict about undocumented fields. | done |
| T02 | M | API contract | `logQueueManager` check and `logQueueManagerAlive` field are fakes kept from the Python server (always ok/true). The dashboard still renders a "Log queue down" chip that can never show. | Delete end to end: Go, `openapi.json`, generated types, zod schema, top bar. | done |
| T03 | H | Worker protocol | Exit codes (10, 11, 75), the worker lock folder, and the protocol words (`stop`, `{"log"}`) are defined in Python and again in Go with nothing checking they agree. | Python stays the source (exit codes come from upstream `module/exception.py`); a Go contract test reads the Python definitions. | done |
| T04 | M | Instances | Sidecar `instances` method is dead (Go never calls it). The listing rule of `module.config.utils.alas_instance` is reimplemented in Go with no parity check. | Delete the dead method. Share one fixture of config file names and expected instances, tested by both Go and Python. | done |
| T05 | M | Dashboard logs | The ALAS log line format is parsed in `log-highlight.tsx` and again in `log-severity.ts`, with different prefix regexes. Severity matches `ERROR` anywhere, so `INFO … @ X_ERROR_Y` turns red. | One `log-format.ts` parser used by both; severity from the parsed level. | done |
| T06 | H | Toolchain | No single command runs every check; Go, Python, dashboard and contract checks are run by hand. No CI. | `dev_tools/check.sh` as the one entry point; a GitHub Actions workflow on the fork runs it. | done |
| T07 | L | Docs | `doc/modernization/*` still describes the Python server (ProcessManager, SyncManager, Starlette, PyWebIO) as current. | Mark the historical parts, point current docs at `alasd`. | done |
| T08 | L | Deploy | `sync-control.py` still recognises `control_server.py`; the only target already runs `alasd.exe`. | Delete the fallback. | done |
| T09 | L | alasd | `instances.Tasks` has an error branch whose two arms do the same; the "owned by an earlier server" message is written twice. | Simplify, one constant. | done |
| T10 | M | Recovery policy | Policy bounds (`maxRestartsPerHour` ≤ 60, `stallMinutes` ≤ 1440, backoff ≤ 86400) are hard-coded in Go and in the dashboard; `openapi.json` doesn't state them. | State them once in `openapi.json` (`minimum`/`maximum`); Go and dashboard tests compare against it. | done |
| T11 | L | Upstream boundary | `module/webui/setting.py` still starts a `multiprocessing.Manager` in `State.init` that nothing uses since the GUI is gone. | Upstream-owned file (ADR 0001). | pending: change upstream or leave |
| T12 | L | Toolchain | Owned Python code has no linter; Go has `vet`, the dashboard `oxlint`. | `ruff` on owned Python paths only, in `check.sh`. | done |
| T13 | M | Profiles | The profile-name rule (1–48 characters, reserved names) is written in `module/control/configuration.py` and copied into `dashboard/src/api/schemas.ts` ("Same rule as the server"). | One fixture of valid and invalid names run by a Python and a dashboard test. | done |
| T14 | M | Dashboard | Time helpers lived in `features/instances/status.ts` and `features/settings/task-state.ts`, each parsing ALAS local times its own way; scheduler and top bar imported `instances` only for them. Preferences repeated the same try/catch storage code three times. | `shared/time.ts` (one parser), `shared/storage.ts`; rules: network only in `api/client.ts`, storage only in `shared/storage.ts`. | done |
| T15 | H | Error contract | `alasd` maps sidecar errors to HTTP statuses by Python class name, unchecked: a rename would turn a 409 into a 500. | Test that each mapped name is a Python exception class. | done |
| T16 | L | Dashboard UX | The same "next run" time reads "in 2h 5m" in the scheduler (`untilNextRun`) and "in 2 hours" in settings (`relativeTime`). | Pick one wording; then delete the other helper. | pending: UX decision |
| T17 | M | Toolchain | `uv.lock`, `requirements.txt` and `dashboard/src/api/generated.ts` are generated from a source but nothing checked they were regenerated. | `check.sh` fails on a stale one, with the command that fixes it. | done |

