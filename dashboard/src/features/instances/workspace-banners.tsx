import type { InstanceStatus } from "../../api/client";
import { useNow } from "../../shared/use-now";
import { Banner } from "../../shared/ui/banner";
import { Button } from "../../shared/ui/button";
import { useDashboardRoute, type Tab } from "./navigation";
import { untilNextRun } from "./status";

export function WorkspaceBanners({ status, commandError }: { status: InstanceStatus; commandError: Error | null }) {
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
