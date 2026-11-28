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
