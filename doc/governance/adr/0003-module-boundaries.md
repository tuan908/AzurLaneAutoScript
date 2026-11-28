# 0003. Module boundaries are checked by tests

Status: accepted, 2026-11-28

## Decision

Each owned codebase has a written dependency direction, and a test fails on any import
against it. A new edge is a deliberate change to the test, not an accident.

- `alasd` (`cmd/alasd/architecture_test.go`): `proc`, `timeutil` → `worker` → `sidecar` →
  `instances` → `health` → `api` → `cmd/alasd`, with the exact allowed edges listed. A new
  package without rules fails the test. Go forbids cycles by itself.
- Dashboard (`src/architecture.test.ts`): layers `api` → `shared` → `features` → `app`, each
  importing only the layers before it; features may use each other but never in a cycle.
- Python worker and sidecar (`module/control`) talk to `alasd` only through the protocol
  checked in ADR 0002 and the round 2 tests; they import upstream ALAS, never the reverse.

## Alternatives

- Public `index.ts` per dashboard feature with a rule against deep imports: adds a forwarding
  file per feature and makes barrel cycles easy. The layer and cycle rules catch the
  coupling that matters without it.
- A lint plugin (eslint-plugin-boundaries, depguard): another tool and config for rules
  that fit in a 70-line test.

## Consequences

`proc` was split out of `worker`: `sidecar` used `worker` only for its process helper, a
dependency on the wrong concept. The instance test fixture moved from
`features/instances` to `api`, next to the type it builds.
