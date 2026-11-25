# Dashboard

`/dashboard/` serves the Bun/Vite production build. Hash routes keep the selected profile
and tab in the URL. React Query owns server snapshots. The live log store is bounded and
the log view virtualizes rows with TanStack Virtual.

The sidebar provides profile creation and copying. Overview shows process state.
Scheduler shows running, pending and waiting tasks, plus completions from the recent live
log. Logs offers search, follow and filtered text export. Settings handles schema-driven
edits. Health shows worker and log-queue state, recovery policy and in-memory counters.

The first runnable version uses hash routing, CSS and controlled forms. Playwright tests
use an isolated Windows runtime with a fake worker.
