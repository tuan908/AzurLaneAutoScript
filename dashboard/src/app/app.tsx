import { useQueryClient } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";
import { useEffect } from "react";

import { ApiError } from "@/api/client";
import { InstanceRail } from "@/features/instances/instance-rail";
import { useDashboardRoute } from "@/features/instances/navigation";
import { useInstances } from "@/features/instances/queries";
import { connectEvents } from "@/features/live-updates/events";
import { useTheme } from "@/shared/theme";
import { Button } from "@/shared/ui/button";

import { Login } from "./login";
import { TopBar } from "./top-bar";

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
      <InstanceRail
        instances={list}
        selected={instanceId ?? null}
        onSelect={(id) => go(id, tab)}
        onCreate={(id) => go(id, "settings")}
      />
      <ToastRegion side="bottom" align="end" className="z-50">
        {() => (
          <Toast className="grid! min-w-70 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-alas! border! border-edge-strong! bg-panel! px-3.5! py-3! text-ink! shadow-alas-lg before:mt-1.5 before:size-2 before:rounded-full before:bg-accent data-[type=success]:before:bg-ok data-[type=error]:before:bg-bad">
            <ToastTitle className="col-start-2 text-[13px] font-semibold" />
            <ToastDescription className="col-start-2 text-xs text-subtle" />
            <ToastClose
              aria-label="Dismiss"
              className="col-start-3 row-start-1 h-6! min-h-0! w-6! rounded-sm! border-0! bg-transparent! p-0! text-subtle! hover:text-ink!"
            />
          </Toast>
        )}
      </ToastRegion>
      {ready ? (
        <Outlet />
      ) : (
        <main className="flex min-h-0 min-w-0 flex-col min-[861px]:overflow-y-auto">
          <div className="grid min-h-[50vh] place-content-center place-items-center gap-2 text-center text-subtle">
            {instances.isLoading ? (
              <span>Loading instances…</span>
            ) : instances.error ? (
              <>
                <span className="text-bad">{instances.error.message}</span>
                <Button onClick={() => void instances.refetch()}>Retry</Button>
              </>
            ) : null}
          </div>
        </main>
      )}
    </div>
  );
}
