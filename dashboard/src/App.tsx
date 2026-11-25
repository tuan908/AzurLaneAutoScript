import { Button } from "./components/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError } from "./api";
import { connectEvents } from "./events";
import { useTheme } from "./hooks";
import { useInstances } from "./queries";
import { Login, Rail, TopBar } from "./components/shell";
import { Outlet } from "@tanstack/react-router";
import { useDashboardRoute } from "./navigation";
export function App() {
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const instances = useInstances();
  const locked = instances.error instanceof ApiError && instances.error.status === 401;

  const ready = instances.data !== undefined;
  useEffect(() => {
    return ready && !locked ? connectEvents(qc) : undefined;
  }, [qc, ready, locked]);

  const list = instances.data ?? [];
  const { instanceId, tab, go } = useDashboardRoute();

  if (locked) {
    return <Login onDone={() => void instances.refetch()} />;
  }

  return (
    <div className="grid h-auto min-h-full grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] min-[861px]:h-full min-[861px]:grid-cols-[272px_minmax(0,1fr)] min-[861px]:grid-rows-[auto_minmax(0,1fr)]">
      <TopBar theme={theme} onTheme={setTheme} />
      <Rail instances={list} selected={instanceId ?? null} onSelect={(id) => go(id, tab)} onCreate={(id) => go(id, "settings")} />
      {ready ? <Outlet /> : (
        <main className="flex min-h-0 min-w-0 flex-col min-[861px]:overflow-y-auto">
          <div className="grid min-h-[50vh] place-content-center place-items-center gap-2 text-center text-subtle">
            {instances.isLoading ? <span>Loading instances…</span>
              : instances.error ? <><span className="text-bad">{instances.error.message}</span><Button onClick={() => void instances.refetch()}>Retry</Button></>
                : null}
          </div>
        </main>
      )}
    </div>
  );
}
