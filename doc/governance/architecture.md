# Architecture map

What runs, who owns which state, where each contract lives, and where to make a change.
Scope: the code this fork owns (ADR 0001). Upstream ALAS (`module/`, `campaign/`,
`assets/`, `alas.py`) is used as a library by the worker.

## Processes

```
browser ── HTTP + SSE ──▶ alasd (Go)                       one per ALAS folder
                           │  stdin "stop" / stdout {"log"}
                           ├──▶ python -m module.control.worker <id> <func>   one per running instance
                           │       └─ runs upstream Alas (alas.py) for that profile
                           └──▶ python -m module.control.sidecar            one, long-lived
                                   └─ upstream config code: schema, config files, task queue
```

## State ownership

| State | Owner | Others read it through |
|---|---|---|
| Worker processes, their log tail, current task, task counters | `alasd/internal/worker` (`Manager`, one per instance) | `instances.Service` |
| Instance list (which profiles exist) | files `config/<name>[.<mod>].json`; rule in upstream `alas_instance()` | `instances.Service.List` (Go copy, fixture-tested against Python) |
| Profile config values and revisions | files `config/<name>.json`, written only by upstream `ConfigUpdater` | sidecar `read` / `update` / `create` |
| Scheduler queue (pending, waiting tasks) | upstream `AzurLaneConfig` | sidecar `tasks` |
| Health classification, recovery history, restart counters | `alasd/internal/health.Monitor` (memory only) | API `/recovery`, status `health` field |
| Recovery policy | file `config/control.yaml`, `health.PolicyStore` | API `/recovery/policy` |
| Instance ownership across processes | lock file `config/tmp/workers/<id>.lock`, held by the worker | `worker.HeldElsewhere` (shows `unmanaged`) |
| Deploy settings (password, autostart) | `config/deploy.yaml`, read by upstream `DeployConfig` | sidecar `deploy`, once at start |
| Dashboard server state (statuses, logs, config) | TanStack Query cache, fed by REST and SSE | `features/*/queries.ts`, `features/live-updates` |
| Dashboard UI state (route, search, theme, language) | URL search params and `localStorage` | `app/router.tsx`, `shared/theme.ts`, `features/settings/lang.ts` |

## Contracts and their single source

| Contract | Source | Checked by |
|---|---|---|
| HTTP API and event payloads | `dashboard/openapi.json` | Go `contract_test.go`, `TestRoutesMatchOpenAPI`; dashboard `schemas.test.ts` (ADR 0002) |
| Recovery policy limits | `openapi.json` `minimum`/`maximum` | Go `limits_test.go`, dashboard `schemas.test.ts` |
| Worker protocol: exit codes, lock folder, `log` key, `stop` command | `module/exception.py`, `module/control/worker.py` | Go `protocol_test.go` |
| Sidecar methods | `module/control/sidecar.py` | Go `sidecar_test.go` (both directions) |
| Instance listing rule | upstream `alas_instance()` | `tests/control/fixtures/instance_listing.json`, Go and Python tests |
| Profile name rule | `validate_profile_name` in `module/control/configuration.py` | `tests/control/fixtures/profile_names.json`, Python and dashboard tests |
| ALAS log line format | upstream logger | dashboard `features/logs/log-format.ts`, its tests |

## Module rules

- `alasd`: `proc`, `timeutil` → `worker` → `sidecar` → `instances` → `health` → `api` →
  `cmd/alasd` (exact edges in `cmd/alasd/architecture_test.go`, ADR 0003).
- Dashboard: `api` → `shared` → `features/*` → `app`, no cycles between features
  (`src/architecture.test.ts`).
- Python: `module/control` imports upstream ALAS; upstream never imports `module/control`.

## Where to make a change

| Change | Edit | Then |
|---|---|---|
| A field of an API response | `openapi.json` first, then the Go struct, then `bun run gen:api` and the zod schema | `dev_tools/check.sh` names every place that disagrees |
| A new endpoint | `openapi.json`, a handler in `alasd/internal/api`, a query in the feature that uses it | same |
| How workers start, stop or report | `alasd/internal/worker` and, for the protocol, `module/control/worker.py` | protocol test |
| Health classification or recovery | `alasd/internal/health/monitor.go` | `monitor_test.go` |
| Anything about config values | upstream config code, reached through the sidecar | — |
| How a log line is coloured or classified | `dashboard/src/features/logs/log-format.ts` (parsing), `log-highlight.tsx` / `log-severity.ts` (presentation) | their tests |
| A new dashboard screen | a folder in `dashboard/src/features`, wired in `app/router.tsx` | architecture test |
| A new check | `dev_tools/check.sh` | CI runs it |

## Toolchain

`dev_tools/check.sh` (ADR 0004). Builds: `alasd/build.sh` (Go, Linux and Windows),
`native/build.sh` (Rust extension), `bun run build` (dashboard). Deploy to Windows:
`deploy/Windows/sync-from-wsl.sh`.
