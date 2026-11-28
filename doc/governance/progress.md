# Progress

One entry per round: problem, options, choice, verification, anti-regression check.

## Round 1 — API responses checked against the contract (T01)

- Problem: `alasd` structs are a hand copy of `dashboard/openapi.json`; only routes were tested.
- Options: generate Go from the document, generate the document from Go, or test both sides
  against the document (ADR 0002).
- Choice: test against the document. New `alasd/internal/api/contract_test.go`: every
  documented operation is called on a test server and its body validated strictly; the
  event stream payloads too. No new dependency (a ~150-line validator of the keywords the
  document uses; unknown keywords fail).
- Verified: all 17 operations pass. Mutation check: renaming one JSON field of the instance
  status and adding one to `/health` produced 10 failures across 5 operations, then reverted.
- Anti-regression: the test itself, plus `TestContractValidatorCatchesDrift`.

## Round 2 — the Python/Go boundary is checked (T03, T04, T09)

- Problem: exit codes, the worker lock folder and the protocol words were defined in Python
  and copied into Go unchecked; the instance listing rule existed in both languages with no
  parity check; a sidecar method was dead.
- Choice: Python stays the source (exit codes and the listing rule are upstream's). The Go
  copies are named constants, and Go tests read the Python definitions:
  - `alasd/internal/worker/protocol_test.go`: exit codes, lock folder, `LOG_KEY`, `STOP_COMMAND`
    (the worker now uses those names instead of inline literals).
  - `alasd/internal/sidecar/sidecar_test.go`: every method alasd calls exists in
    `sidecar.py`, and every public sidecar method is called. It found `instances` (dead,
    deleted). `read_raw` became `_read_raw`, which removed a special case from the dispatcher.
  - `tests/control/fixtures/instance_listing.json`: one set of cases for the listing rule,
    run by a Python test against upstream's `alas_instance()` and a Go test against
    `Service.List`.
- Also: the redundant error branch in `instances.Tasks` and the duplicated "owned by an
  earlier server" message are gone; `gofmt` applied to `alasd`.
- Verified: all Go and Python tests pass.

## Round 3 — fake health signal deleted, policy limits single-sourced (T02, T10)

- T02: `logQueueManager` check and `logQueueManagerAlive` reported a process that no longer
  exists and were hard-coded to ok/true. Deleted from `openapi.json`, `alasd`, the generated
  types, the zod schema and the top bar's "Log queue down" chip, which could never show.
  Old clients are unaffected: the dashboard's zod objects drop unknown keys, and nothing
  else read the field (`sync-control.py`, `soak_probe.py` checked).
- T10: the recovery policy limits now live in `openapi.json` as `minimum`/`maximum`
  (`maxRestartsPerHour` ≤ 60, `stallMinutes` ≤ 1440, backoff items ≤ 86400, at least one).
  Go and the dashboard keep named constants for them, and a test on each side compares the
  constant with the contract. The dashboard now also bounds backoff values, which it didn't.
  The API contract test validates `minimum`/`maximum` too.
- Considered: importing `openapi.json` into the dashboard bundle to read the limits; rejected
  (ships the whole contract to the browser for three numbers).
- Verified: Go tests, dashboard typecheck/lint/format and 88 unit tests.

## Round 4 — one parser for the ALAS log line (T05)

- Problem: the log line format was parsed in `log-highlight.tsx` and again in
  `log-severity.ts` with different regexes. A probe with real worker output found two bugs:
  - the highlighter only knew the ASCII `|` separator, but the live log uses `│`, so live
    lines never got their level and time coloured (the time was painted as numbers);
  - severity matched `ERROR` anywhere, so `INFO … @ POPUP_ERROR_CONFIRM` showed as an error.
- Choice: `features/logs/log-format.ts` parses a line once into entry / rule / text, with
  both separators. Highlighting renders the parsed parts; severity comes from the parsed
  level, plain text inherits the entry above it, a traceback or exception line is an error.
- Verified: existing tests unchanged and passing; new tests for both formats, the `│`
  separator and the level-not-message rule (93 tests).

## Round 5 — profile name rule tested on both sides (T13)

- Problem: the dashboard copied the server's profile name rule ("Same rule as the server")
  with nothing checking the copies agree.
- Options: a `pattern` in `openapi.json` (can't express case-insensitive reserved names in
  JSON Schema); a shared fixture.
- Choice: `validate_profile_name` in `module/control/configuration.py` is the rule, and
  `tests/control/fixtures/profile_names.json` lists valid names and invalid ones by reason,
  including both length boundaries. A Python test and the dashboard's schema test run it.
- Verified: 26 Python cases, dashboard 108 tests.

## Round 6 — enforced boundaries and one check command (T06, T12)

- Boundaries (ADR 0003): `alasd/cmd/alasd/architecture_test.go` lists the allowed edges
  between Go packages; `dashboard/src/architecture.test.ts` enforces the layers
  `api → shared → features → app` and forbids cycles between features. Mutation checks:
  a planted `worker → sidecar` import, a `features → app` import and a feature cycle were
  each reported, then reverted.
- Fixed on the way: `sidecar` imported `worker` only for its process helper, which is now
  `internal/proc`; the instance test fixture moved from `features/instances` to `api`,
  which removed the only layer violation (a test in `api` importing a feature).
- Lint (T12): `ruff` on owned Python paths only (configured in `pyproject.toml`). 43
  findings fixed. Mostly current-syntax upgrades, plus: re-raises in the worker and the LZ4
  decoder now use `from None`, and loading OCR weights uses `zip(..., strict=True)` so a
  corrupt params file fails instead of loading partially.
- One command (T06, ADR 0004): `dev_tools/check.sh` runs Go (gofmt, vet for Linux and
  Windows, race tests), Python (ruff, 1587 tests in one run) and the dashboard (types,
  lint, format, 111 tests) in about 40 s; `.github/workflows/check.yml` runs it on this
  fork's branches.

## Round 7 — current map, stale docs marked, dead deploy fallback removed (T07, T08)

- `doc/governance/architecture.md`: processes, state ownership, every contract with its
  single source and the test that checks it, module rules, and "where to make a change".
- `doc/modernization/PLAN.md` and `lifecycle.md` describe the removed Python server; they
  carry a "historical" banner pointing to the map instead of being rewritten. The other
  modernization docs were checked and are current (`baseline.md` and `soak-probe.md` are
  about the upstream install, which still runs `gui.py`).
- `sync-control.py` no longer recognises `control_server.py`; the only target runs `alasd.exe`.

## Round 8 — dashboard shared time and storage, error contract (T14, T15)

- Time: `shared/time.ts` now holds the duration and relative-time helpers and the one
  parser of ALAS local times. `features/instances/status.ts` and
  `features/settings/task-state.ts` lost their copies; the top bar no longer imports
  `features/instances` just to format uptime. Tests moved with the code.
- Storage: `shared/storage.ts` (`loadPreference` validates what it reads,
  `savePreference` drops writes when storage is unavailable) replaced three hand-written
  copies in theme and language settings. The login token stays in `api/client.ts`: it is
  session-only with an in-memory fallback, a different policy.
- Rules added to `src/architecture.test.ts`: only `api/client.ts` uses the network; only
  `shared/storage.ts` (and the token) use browser storage. Mutation-checked.
- Error contract (T15): `alasd/internal/api/errors_test.go` checks that every Python class
  name `mapError` turns into a status exists in `module/control` or `module/config`.
- Pending (T16): two wordings for the same next-run time; needs a UX choice.
- Verified: `dev_tools/check.sh` green.

## Round 9 — generated files can't go stale (T17)

- `check.sh` now fails when `uv.lock` doesn't match `pyproject.toml`, when
  `requirements.txt` differs from `uv export`, or when `src/api/generated.ts` differs from
  what `openapi.json` generates. Each failure prints the command that fixes it.
- Found by mutation-checking these checks: `check.sh <group>` never ran anything (the group
  list was empty when arguments were given) and still reported success. Fixed; an unknown
  group now fails with exit code 2. Full runs (no arguments, as CI calls it) were not affected.
- Verified: planted drift in `generated.ts` and in `requirements.txt` each fail the right
  group; the full run is green.

## Round 9b — review pass and the scheduler log markers (T18)

- Review of the whole branch diff instead of a separate reviewer (per earlier feedback to
  skip review loops): one stale comment fixed; worker log parsing, `sync-control` process
  matching and the lint edits confirmed behaviour-preserving; `alasd.exe` still cross-builds.
- T18: `tests/control/fixtures/scheduler_log.json` holds the marker templates and sample
  lines (both separators, and upstream's end marker without a result). A Python test checks
  `alas.py` still logs those templates; `alasd` (current task, success/failure counters) and
  the dashboard (recent completions) test against the same lines.

## Status after round 10 (2026-11-28)

Acceptance criteria, for the owned code (ADR 0001):

- One authoritative source per core concept: the API contract, policy limits, worker
  protocol, sidecar methods, error types, instance listing, profile names, scheduler and
  takeover log lines, log line format, time parsing and preference storage each have one
  source, listed with its checking test in `architecture.md`.
- Clear modules and public interfaces: package and layer rules in `architecture.md`,
  enforced by `cmd/alasd/architecture_test.go` and `src/architecture.test.ts`.
- No unexplained duplicates: remaining copies across the Go/Python/TypeScript boundary are
  each fixture- or source-tested; T16 (two next-run wordings) is pending a UX decision.
- No cycles: Go forbids them; the dashboard test forbids feature cycles.
- Business logic decoupled from UI, storage and frameworks: network and browser storage
  each have one owner (enforced); config logic stays in upstream Python behind the sidecar.
- Anti-regression: everything above runs in `dev_tools/check.sh` and CI; each new check was
  mutation-tested (planted drift caught, then reverted).
- Contracts preserved: no API change except removing the dead `logQueueManagerAlive`
  field (nothing read it); all suites green.

Pending decisions: T11 (upstream file), T16 (UX wording). Not merged into
`modernize/main` yet: branch `governance/main` in the worktree `../alas-governance`.
