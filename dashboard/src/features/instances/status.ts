import type { InstanceStatus } from "../../api/client";

export type Tone = "ok" | "warn" | "bad" | "idle";

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Alas writes times as local "YYYY-MM-DD HH:MM:SS"; the API's own times are ISO with an offset. */
export function parseTime(value: string): number {
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value);
  return new Date(local ? value.replace(" ", "T") : value).getTime();
}

export function since(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  return formatDuration((now - parseTime(iso)) / 1000);
}

/** "in 2h 5m", or "due now" once the time has passed */
export function untilNextRun(value: string, now: number): string {
  const t = parseTime(value);
  if (Number.isNaN(t)) return value;
  const seconds = (t - now) / 1000;
  return seconds <= 0 ? "due now" : `in ${formatDuration(seconds)}`;
}

export function healthTone(s: InstanceStatus): { tone: Tone; label: string } {
  const h = s.health;
  if (s.unmanaged) return { tone: "warn", label: "External" };
  if (h?.state === "human_takeover") return { tone: "bad", label: "Needs you" };
  if (h?.recovery?.gaveUp) return { tone: "bad", label: "Gave up" };
  if (s.state === "failed" || h?.state === "crashed") return { tone: "bad", label: "Failed" };
  if (h?.state === "stalled") return { tone: "warn", label: "Stalled" };
  if (s.state === "starting") return { tone: "warn", label: "Starting" };
  if (s.state === "stopping") return { tone: "warn", label: "Stopping" };
  if (s.state === "running") return { tone: "ok", label: h?.state === "idle" || !s.currentTask ? "Idle" : "Running" };
  return { tone: "idle", label: "Stopped" };
}

export function statusLine(s: InstanceStatus, now: number): string {
  switch (s.state) {
    case "running":
      return s.currentTask ? `Running ${s.currentTask}` : "Waiting for the next task";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "failed":
      return s.health?.detail || s.lastError || "Stopped on an error";
    default:
      return s.stoppedAt ? `Stopped ${since(s.stoppedAt, now)} ago` : "Not started";
  }
}
