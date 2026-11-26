import type { InstanceStatus } from "@/api/client";
import { Banner } from "@/shared/ui/banner";
import { Button } from "@/shared/ui/button";
import { useNow } from "@/shared/use-now";

import { useDashboardRoute, type Tab } from "./navigation";
import { untilNextRun } from "./status";

export function WorkspaceBanners({
  status,
  commandError,
}: {
  status: InstanceStatus;
  commandError: Error | null;
}) {
  const { go } = useDashboardRoute();
  const h = status.health;
  const nextRetry = h?.state === "crashed" && !h.recovery.gaveUp ? h.recovery.nextAttemptAt : null;
  const now = useNow(nextRetry ? 1000 : null);
  const toLogs = { label: "Open logs", tab: "logs" as const };
  const toHealth = { label: "Recovery settings", tab: "health" as const };
  const items: {
    tone: "bad" | "warn";
    title: string;
    body: string;
    links?: { label: string; tab: Tab }[];
    announce?: boolean;
  }[] = [];
  if (commandError)
    items.push({
      tone: "bad",
      title: "Command failed",
      body: commandError.message,
    });
  if (status.unmanaged)
    items.push({
      tone: "warn",
      title: "Started outside this server",
      body: "This worker was found running from an earlier server. It is shown here but cannot be controlled until it exits.",
    });
  if (h?.state === "human_takeover")
    items.push({
      tone: "bad",
      title: "Alas needs you",
      body: "It stopped and asked for a person (for example no emulator matches the serial in Settings, or too many tasks failed within an hour). Check the log, fix the cause, then start it again.",
      links: [toLogs],
    });
  else if (h?.recovery.gaveUp)
    items.push({
      tone: "bad",
      title: "Automatic recovery gave up",
      body: "Too many restarts within an hour. Start it manually once the cause is fixed.",
      links: [toLogs, toHealth],
    });
  else if (h?.state === "waiting_retry")
    items.push({
      tone: "warn",
      title: "Waiting for the game",
      body: `The game could not log in, probably maintenance or an update. ${nextRetry ? `Alas checks again ${untilNextRun(nextRetry, now)}.` : "Turn on automatic restart to check again hourly."}`,
      links: [toLogs],
      announce: false,
    });
  else if (h && nextRetry)
    items.push({
      tone: "warn",
      title: "Crashed — restarting automatically",
      body: `Next attempt ${untilNextRun(nextRetry, now)}. ${h.detail}`,
      announce: false,
    });
  else if (h?.state === "stalled")
    items.push({
      tone: "warn",
      title: "Task looks stalled",
      body: h.detail,
      links: [toLogs, toHealth],
    });
  else if (status.state === "failed" && status.lastError)
    items.push({
      tone: "bad",
      title: "Worker stopped on an error",
      body: status.lastError,
      links: [toLogs],
    });
  return (
    <>
      <span className="sr-only" role="status">
        {nextRetry ? "Worker crashed. Automatic recovery is scheduled." : ""}
      </span>
      {items.map((b) => (
        <Banner
          key={b.title}
          tone={b.tone}
          heading={b.title}
          announce={b.announce ?? true}
          action={b.links?.map((link) => (
            <Button key={link.tab} size="small" onClick={() => go(status.id, link.tab)}>
              {link.label}
            </Button>
          ))}
        >
          {b.body}
        </Banner>
      ))}
    </>
  );
}
