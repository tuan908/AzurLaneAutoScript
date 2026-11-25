import { useInstanceCommand } from "../use-instance-command";
import { type InstanceStatus } from "../api";
import { useNow } from "../hooks";
import { healthTone, statusLine, untilNextRun } from "../status";
import { TAB_LABELS, TABS, tabPath, useDashboardRoute, type Tab } from "../navigation";
import { Banner, Button, Icon, StatusBadge } from "../components/ui";
import { Link } from "@tanstack/react-router";
import { createContext, use, type ReactNode } from "react";

const WorkspaceStatus = createContext<InstanceStatus | null>(null);

export function useWorkspaceStatus() {
  const status = use(WorkspaceStatus);
  if (!status) throw new Error("This view requires a profile");
  return status;
}

function Banners({ status, commandError }: { status: InstanceStatus; commandError: Error | null }) {
  const { go } = useDashboardRoute();
  const h = status.health;
  const now = useNow(h?.state === "crashed" && h.recovery.nextAttemptAt ? 1000 : null);
  const toLogs = { label: "Open logs", tab: "logs" as const };
  const toHealth = { label: "Recovery settings", tab: "health" as const };
  const items: { tone: "bad" | "warn"; title: string; body: string; links?: { label: string; tab: Tab }[] }[] = [];
  if (commandError) items.push({ tone: "bad", title: "Command failed", body: commandError.message });
  if (status.unmanaged) items.push({ tone: "warn", title: "Started outside this server",
    body: "This worker was found running from an earlier server. It is shown here but cannot be controlled until it exits." });
  if (h?.state === "human_takeover") items.push({ tone: "bad", title: "Alas needs you",
    body: "It stopped and asked for a person (for example a task failed 3 times, or the emulator is not reachable). Check the log, fix the cause, then start it again.", links: [toLogs] });
  else if (h?.recovery.gaveUp) items.push({ tone: "bad", title: "Automatic recovery gave up",
    body: "Too many restarts within an hour. Start it manually once the cause is fixed.", links: [toLogs, toHealth] });
  else if (h?.state === "crashed" && h.recovery.nextAttemptAt) items.push({ tone: "warn", title: "Crashed — restarting automatically",
    body: `Next attempt ${untilNextRun(h.recovery.nextAttemptAt, now)}. ${h.detail}` });
  else if (h?.state === "stalled") items.push({ tone: "warn", title: "Task looks stalled", body: h.detail, links: [toLogs, toHealth] });
  else if (status.state === "failed" && status.lastError) items.push({ tone: "bad", title: "Worker stopped on an error", body: status.lastError, links: [toLogs] });
  return (
    <>
      {items.map((b) => (
        <Banner key={b.title} tone={b.tone} heading={b.title} action={b.links?.map((link) => (
          <Button key={link.tab} size="small" onClick={() => go(status.id, link.tab)}>{link.label}</Button>
        ))}>{b.body}</Banner>
      ))}
    </>
  );
}

export function Workspace({ status, children }: { status: InstanceStatus; children: ReactNode }) {
  const command = useInstanceCommand(status.id);
  const busy = status.unmanaged || command.isPending || status.state === "starting" || status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";
  const tone = healthTone(status);

  return (
    <main className="flex min-h-0 min-w-0 flex-col min-[861px]:overflow-y-auto">
      <div className="sticky top-0 z-5 border-b border-edge bg-canvas/90 px-4 pt-4.5 backdrop-blur-md min-[861px]:px-6">
        <div className="flex flex-wrap items-center gap-3 [&_h2]:min-w-0 [&_h2]:wrap-anywhere">
          <h2>{status.id}</h2>
          <StatusBadge tone={tone.tone} pulse={status.state === "running"} large>{tone.label}</StatusBadge>
          <WorkerStatusLine status={status} />
          <div className="ml-auto flex gap-2 max-[600px]:w-full max-[600px]:flex-wrap max-[600px]:[&_button]:flex-1">
            {alive ? (
              <Button variant="danger" disabled={busy} data-agent-confirm="Stop this automation worker" onClick={() => command.mutate("stop")}>
                <Icon name="stop" />Stop
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} data-agent-confirm="Start this automation worker" onClick={() => command.mutate("start")}>
                <Icon name="play" />Start
              </Button>
            )}
            <Button disabled={busy} data-agent-confirm="Restart this automation worker" onClick={() => command.mutate("restart")}>
              <Icon name="restart" />Restart
            </Button>
          </div>
        </div>
        <nav aria-label="Profile views" className="mt-3.5 flex gap-0.5 overflow-x-auto [scrollbar-width:thin] [&_a]:relative [&_a]:inline-flex [&_a]:items-center [&_a]:h-9.5 [&_a]:shrink-0 [&_a]:border-0 [&_a]:bg-transparent [&_a]:px-3 [&_a]:font-semibold [&_a]:whitespace-nowrap [&_a]:no-underline [&_a]:text-subtle [&_a:hover]:text-ink [&_a[aria-current=page]]:text-ink [&_a[aria-current=page]]:after:absolute [&_a[aria-current=page]]:after:inset-x-2 [&_a[aria-current=page]]:after:bottom-0 [&_a[aria-current=page]]:after:h-0.5 [&_a[aria-current=page]]:after:bg-accent">
          {TABS.map((name) => (
            <Link key={name} to={tabPath(name)} params={{ instanceId: status.id }} search={{}}>{TAB_LABELS[name]}</Link>
          ))}
        </nav>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-4 pt-5 pb-10 min-[861px]:px-6">
        <Banners status={status} commandError={command.error} />
        <WorkspaceStatus value={status}>{children}</WorkspaceStatus>
      </div>
    </main>
  );
}

function WorkerStatusLine({ status }: { status: InstanceStatus }) {
  const now = useNow(status.state === "stopped" && status.stoppedAt ? 1000 : null);
  return <span className="text-[13px] text-subtle">{statusLine(status, now)}</span>;
}
