# 0001. Governance covers the code this fork owns

Status: accepted, 2026-11-28

## Context

ALAS game logic (`module/` except `module/control`, `campaign/`, `assets/`, `submodule/`,
about 90k lines) is upstream code. We merge `LmeSzinc/AzurLaneAutoScript` regularly and
contribute fixes back through PRs against `bug_fix`.

## Decision

Architecture governance applies to the code this fork owns:

- `alasd/` (Go control server)
- `module/control/` (Python worker and config sidecar)
- `dashboard/` (React UI)
- `native/` (Rust extension)
- `deploy/Windows/` sync and launcher tooling, `start-control.*`
- `dev_tools/` files we added, `tests/control`, `tests/ocr`, the toolchain files

Upstream code is treated as an external dependency. It changes only when our layer needs
it, and preferably through an upstream PR, so local diffs stay small.

## Consequences

Upstream merges stay cheap. Entropy inside upstream code is out of scope here; findings
worth fixing go to upstream as small PRs (for example #6199).
