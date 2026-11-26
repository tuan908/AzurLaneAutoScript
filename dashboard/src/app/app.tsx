import { useQueryClient } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";
import { useEffect, useRef, useState } from "react";

import { ApiError, setToken } from "@/api/client";
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
  const [signInOpen, setSignInOpen] = useState(false);
  const mainContent = useRef<HTMLElement>(null);
  const instances = useInstances();
  const locked = instances.error instanceof ApiError && instances.error.status === 401;

  const ready = instances.data !== undefined;
  useEffect(() => {
    return ready && !locked && !signInOpen ? connectEvents(qc) : undefined;
  }, [qc, ready, locked, signInOpen]);

  const list = instances.data ?? [];
  const { instanceId, tab, go } = useDashboardRoute();

  if (locked || signInOpen) {
    return (
      <Login
        onUnlock={async (password) => {
          setSignInOpen(true);
          setToken(password);
          const result = await instances.refetch();
          if (result.error instanceof ApiError && result.error.status === 401) {
            return "The server rejected this password. Check it and try again.";
          }
          if (result.error) return "Could not unlock the dashboard. Try again.";
          setSignInOpen(false);
          return null;
        }}
      />
    );
  }

  return (
    <div className="grid h-auto min-h-full grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] min-[861px]:h-full min-[861px]:grid-cols-[272px_minmax(0,1fr)] min-[861px]:grid-rows-[auto_minmax(0,1fr)]">
      <a
        href="#dashboard-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-alas-sm focus:bg-panel focus:px-3 focus:py-2 focus:text-ink"
        onClick={(event) => {
          // The dashboard uses the URL hash for routing.
          event.preventDefault();
          mainContent.current?.focus();
        }}
      >
        Skip to main content
      </a>
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
      <main
        ref={mainContent}
        id="dashboard-content"
        tabIndex={-1}
        className="relative flex min-h-0 min-w-0 flex-col focus-visible:-outline-offset-2 min-[861px]:overflow-y-auto"
      >
        {ready ? (
          <Outlet />
        ) : (
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
        )}
      </main>
    </div>
  );
}
