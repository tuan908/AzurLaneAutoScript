import {
  createHashHistory,
  createLazyRoute,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  stripSearchParams,
} from "@tanstack/react-router";

import { useInstances } from "@/features/instances/queries";
import { Workspace } from "@/features/instances/workspace";
import { LogsSearchSchema } from "@/features/logs/search";
import { SettingsSearchSchema } from "@/features/settings/search";

import { App } from "./app";

function RouteNotFound() {
  return (
    <div className="grid min-h-[50vh] place-content-center gap-2 text-center text-subtle">
      <h2>Page not found</h2>
      <span>Choose a profile from the sidebar.</span>
    </div>
  );
}

const root = createRootRoute({
  component: App,
  notFoundComponent: RouteNotFound,
});

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: function DashboardIndex() {
    const { data } = useInstances();
    const first = data?.[0];
    return first ? (
      <Navigate to="/$instanceId/overview" params={{ instanceId: first.id }} replace />
    ) : (
      <div className="grid min-h-[50vh] place-content-center gap-2 text-center text-subtle">
        <h2>No instances yet</h2>
        <span>Create a profile from the sidebar to get started.</span>
      </div>
    );
  },
});

const instance = createRoute({
  getParentRoute: () => root,
  path: "$instanceId",
  component: function InstanceLayout() {
    const { instanceId } = instance.useParams();
    const { data } = useInstances();
    const status = data?.find((profile) => profile.id === instanceId);
    if (!status) {
      return (
        <div className="grid min-h-[50vh] place-content-center gap-2 text-center text-subtle">
          <h2>Instance not found</h2>
          <span>Select an existing instance from the sidebar.</span>
        </div>
      );
    }
    return (
      <Workspace key={instanceId} status={status}>
        <Outlet />
      </Workspace>
    );
  },
});

const instanceIndex = createRoute({
  getParentRoute: () => instance,
  path: "/",
  component: function InstanceIndex() {
    const { instanceId } = instance.useParams();
    return <Navigate to="/$instanceId/overview" params={{ instanceId }} replace />;
  },
});

const overview = createRoute({
  getParentRoute: () => instance,
  path: "overview",
  staticData: { dashboardTab: "overview" },
}).lazy(() =>
  import("../features/overview/overview").then(({ Overview }) =>
    createLazyRoute("/$instanceId/overview")({ component: Overview }),
  ),
);

const scheduler = createRoute({
  getParentRoute: () => instance,
  path: "scheduler",
  staticData: { dashboardTab: "scheduler" },
}).lazy(() =>
  import("../features/scheduler/scheduler").then(({ Scheduler }) =>
    createLazyRoute("/$instanceId/scheduler")({ component: Scheduler }),
  ),
);

const logs = createRoute({
  getParentRoute: () => instance,
  path: "logs",
  staticData: { dashboardTab: "logs" },
  validateSearch: LogsSearchSchema,
  search: { middlewares: [stripSearchParams({ filter: "", level: "all" })] },
}).lazy(() =>
  import("../features/logs/logs").then(({ Logs }) =>
    createLazyRoute("/$instanceId/logs")({ component: Logs }),
  ),
);

const settings = createRoute({
  getParentRoute: () => instance,
  path: "settings",
  staticData: { dashboardTab: "settings" },
  validateSearch: SettingsSearchSchema,
  search: { middlewares: [stripSearchParams({ q: "", task: "" })] },
}).lazy(() =>
  import("../features/settings/settings").then(({ Settings }) =>
    createLazyRoute("/$instanceId/settings")({ component: Settings }),
  ),
);

const health = createRoute({
  getParentRoute: () => instance,
  path: "health",
  staticData: { dashboardTab: "health" },
}).lazy(() =>
  import("../features/health/health-panel").then(({ HealthPanel }) =>
    createLazyRoute("/$instanceId/health")({ component: HealthPanel }),
  ),
);

const routeTree = root.addChildren([
  index,
  instance.addChildren([instanceIndex, overview, scheduler, logs, settings, health]),
]);
export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  notFoundMode: "root",
  defaultPendingComponent: () => (
    <div role="status" className="p-4 text-subtle">
      Loading view…
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
