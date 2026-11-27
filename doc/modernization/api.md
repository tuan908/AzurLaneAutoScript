# Control API

The legacy and headless servers build the same `ControlApi` over a single in-process
`ProcessManager` registry. Both use the existing Starlette runtime. Pydantic models describe
the OpenAPI response contracts using the version already present in the toolkit. Visit
`/api/v1/openapi.json` for the schema. From the repository root:

```sh
uv run -m dev_tools.export_openapi
cd dashboard && bun run gen:api
```

An optional deploy password requires an Authorization bearer header on every API route,
including the event stream. Without a password, requests require a local client and Host.
The versioned API covers lifecycle, profile creation and copying, task snapshots, log tails,
configuration and recovery. An unmanaged worker returns 409 for lifecycle commands. Instances
with no active task report an empty running queue even if a task is ready to run.
