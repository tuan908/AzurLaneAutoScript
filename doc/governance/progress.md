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
