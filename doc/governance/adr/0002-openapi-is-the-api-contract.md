# 0002. `dashboard/openapi.json` is the single source of the API contract

Status: accepted, 2026-11-28

## Context

The HTTP contract between `alasd` and the dashboard existed in three hand-maintained forms:
Go structs in `alasd`, `dashboard/openapi.json` (with types generated from it), and the
dashboard's zod schemas. Since the Python server was removed, nothing generates the document;
only the route list was checked against it.

## Options

1. Generate Go types from the document (oapi-codegen): a new tool and dependency, and the
   generated types would still be wrapped by the hand-written state types of `alasd`.
2. Generate the document from Go types: the document gains Go's quirks, and the dashboard
   would depend on a Go build step.
3. Keep the document authoritative and test both sides against it.

## Decision

Option 3. `openapi.json` is edited by hand and is the only definition of the contract.

- Go: `alasd/internal/api/contract_test.go` calls every documented operation and validates
  the body against its schema, strictly (missing, mistyped and undocumented fields fail),
  plus the payloads of the event stream. Unknown schema keywords fail the test, so the
  validator cannot silently ignore a new feature. `TestRoutesMatchOpenAPI` keeps the route
  set equal.
- Dashboard: `src/api/generated.ts` is generated from the document (`bun run gen:api`), and
  `src/api/schemas.test.ts` keeps the zod schemas assignable to those types.

## Consequences

Changing the API means editing `openapi.json` first; both test suites then point at every
place that must follow.
