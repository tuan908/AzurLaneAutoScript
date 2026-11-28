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
