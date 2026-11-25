import { Link } from "@tanstack/react-router";
import { createContext, use, type ReactNode } from "react";

import { type InstanceStatus } from "@/api/client";
import { Button } from "@/shared/ui/button";
import { Icon } from "@/shared/ui/icon";
import { StatusBadge } from "@/shared/ui/status-badge";
import { useNow } from "@/shared/use-now";

import { TAB_LABELS, tabPath, TABS } from "./navigation";
import { healthTone, statusLine } from "./status";
import { useInstanceCommand } from "./use-instance-command";
import { WorkspaceBanners } from "./workspace-banners";

const WorkspaceStatus = createContext<InstanceStatus | null>(null);

export function useWorkspaceStatus() {
  const status = use(WorkspaceStatus);
  if (!status) throw new Error("This view requires a profile");
  return status;
}

export function Workspace({ status, children }: { status: InstanceStatus; children: ReactNode }) {
  const command = useInstanceCommand(status.id);
  const busy =
    status.unmanaged ||
    command.isPending ||
    status.state === "starting" ||
    status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";
  const tone = healthTone(status);

  return (
    <>
      <div className="sticky top-0 z-5 border-b border-edge bg-canvas/90 px-4 pt-4.5 backdrop-blur-md min-[861px]:px-6">
        <div className="flex flex-wrap items-center gap-3 [&_h2]:min-w-0 [&_h2]:wrap-anywhere">
          <h2>{status.id}</h2>
          <StatusBadge tone={tone.tone} pulse={status.state === "running"} large>
            {tone.label}
          </StatusBadge>
          <WorkerStatusLine status={status} />
          <div className="ml-auto flex gap-2 max-[600px]:w-full max-[600px]:flex-wrap max-[600px]:[&_button]:flex-1">
            {alive ? (
              <Button
                variant="danger"
                disabled={busy}
                data-agent-confirm="Stop this automation worker"
                onClick={() => command.mutate("stop")}
              >
                <Icon name="stop" />
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                data-agent-confirm="Start this automation worker"
                onClick={() => command.mutate("start")}
              >
                <Icon name="play" />
                Start
              </Button>
            )}
            <Button
              disabled={busy}
              data-agent-confirm="Restart this automation worker"
              onClick={() => command.mutate("restart")}
            >
              <Icon name="restart" />
              Restart
            </Button>
          </div>
        </div>
        <nav
          aria-label="Profile views"
          className="mt-3.5 flex gap-0.5 overflow-x-auto [scrollbar-width:thin] [&_a]:relative [&_a]:inline-flex [&_a]:items-center [&_a]:h-9.5 [&_a]:shrink-0 [&_a]:border-0 [&_a]:bg-transparent [&_a]:px-3 [&_a]:font-semibold [&_a]:whitespace-nowrap [&_a]:no-underline [&_a]:text-subtle [&_a:hover]:text-ink [&_a[aria-current=page]]:text-ink [&_a[aria-current=page]]:after:absolute [&_a[aria-current=page]]:after:inset-x-2 [&_a[aria-current=page]]:after:bottom-0 [&_a[aria-current=page]]:after:h-0.5 [&_a[aria-current=page]]:after:bg-accent"
        >
          {TABS.map((name) => (
            <Link key={name} to={tabPath(name)} params={{ instanceId: status.id }} search={{}}>
              {TAB_LABELS[name]}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-4 pt-5 pb-10 min-[861px]:px-6">
        <WorkspaceBanners status={status} commandError={command.error} />
        <WorkspaceStatus value={status}>{children}</WorkspaceStatus>
      </div>
    </>
  );
}

function WorkerStatusLine({ status }: { status: InstanceStatus }) {
  const now = useNow(status.state === "stopped" && status.stoppedAt ? 1000 : null);
  return <span className="text-[13px] text-subtle">{statusLine(status, now)}</span>;
}
