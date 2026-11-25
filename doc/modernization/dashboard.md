# Dashboard

`/dashboard/` serves the Bun/Vite production build. TanStack Router uses a shared profile
layout and lazy child routes for Overview, Scheduler, Logs, Settings, and Health. Hash URLs
preserve existing deep links. Logs owns the text and severity filters in its search params.
Settings owns its search text and selected task in its search params. React Query owns
server snapshots. The live log store is bounded and the log view virtualizes rows with
TanStack Virtual.

The sidebar provides profile creation and copying. Overview shows process state.
Scheduler shows running, pending and waiting tasks, plus completions from the recent live
log. Logs offers search, follow and filtered text export. Settings handles schema-driven
edits. Health shows worker and log-queue state, recovery policy and in-memory counters.

Health, Scheduler, Overview, and Settings distinguish loading from successful empty
results. Failed requests offer a retry, and failed refreshes keep the last successful
response visible with a stale notice. Shared buttons, cards, metrics, status badges,
banners, and selects own the repeated visual patterns.

The first runnable version uses hash routing, CSS and controlled forms. Playwright tests
use an isolated Windows runtime with a fake worker.

## Hardening audit

- **TypeScript:** The dashboard and Playwright specs check indexed access, optional
  properties, index-signature access, return paths, and overrides. Generated API types
  describe the REST contract. SSE payloads also get runtime validation at the boundary.
  Type checking uses TypeScript 7. The OpenAPI generator uses the TypeScript 5 API.
- **State consistency:** A new SSE generation keeps the last profile snapshot visible
  until its replacement arrives. Regression tests cover late REST responses, generation
  changes, incomplete or cancelled backlogs, reconnects, inactivity, and log ordering.
  Browser tests exercise pending saves, draft conflicts, pending commands across profile
  changes, missing profiles, and failed query recovery.
- **React performance:** Countdown components receive the current time explicitly.
  Components with no countdown skip the timer. Feature views and the profile dialog
  stay in lazy chunks. Vite reports a 119 kB gzip production entry. Removed unused direct
  dependencies on `clsx`, `lucide-react`, and `radix-ui`.
  [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)
- **Composition:** The profile layout supplies status through context and renders its
  routes as children. Shared controls expose explicit variants. Query views receive
  data through their content callback only when a successful snapshot exists.
  [Vercel Composition Patterns](https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns)

The TanStack Virtual lint warning remains. The log view opts out of React Compiler
memoization because the virtualizer owns its own mutable state.
