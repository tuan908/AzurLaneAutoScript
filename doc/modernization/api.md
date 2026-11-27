# Control API

The Go control server `alasd` (alasd/) serves the API at `/api/v1` and the dashboard at
`/dashboard`. It owns one Python worker process per running instance
(`python -m module.control.worker <instance> <func>`, JSON log lines on stdout, `stop` on
stdin) and asks a long-lived Python sidecar (`python -m module.control.sidecar`) for
everything that needs the Alas config code: schema, config read and update, profile creation
and the task queue.

`dashboard/openapi.json` is the contract. It is maintained by hand now; a Go test
(`TestRoutesMatchOpenAPI`) fails when a route and the document disagree. After changing it:

```sh
cd dashboard && bun run gen:api
```

An optional deploy password requires an Authorization bearer header on every API route,
including the event stream. Without a password, requests require a local client and Host.
The versioned API covers lifecycle, profile creation and copying, task snapshots, log tails,
configuration and recovery. An unmanaged worker returns 409 for lifecycle commands. Instances
with no active task report an empty running queue even if a task is ready to run.
