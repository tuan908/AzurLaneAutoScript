# 0004. One command runs every check

Status: accepted, 2026-11-28

## Decision

`dev_tools/check.sh` is the only entry point for verification, locally and in CI
(`.github/workflows/check.yml`, on this fork's own branches). It runs:

- `alasd`: `gofmt` (fails on unformatted files), `go vet` for Linux and Windows, all tests
  with the race detector. The tests include the API contract (ADR 0002), the Python/Go
  protocol and the package rules (ADR 0003).
- Python: `ruff` on the owned paths listed in `pyproject.toml` (upstream code is excluded,
  ADR 0001), and the test suites that run without the screenshot collection.
- Dashboard: types, `oxlint`, `oxfmt`, unit tests, including the architecture test.

Groups can run alone: `dev_tools/check.sh go`, `py`, `ui`.

## Consequences

A new kind of check is added to this script, not run by hand. Cross-language fixtures
(`tests/control/fixtures/`) are run from both sides' suites, so the one command covers them.
