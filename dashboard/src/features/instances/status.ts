import type { InstanceStatus } from "@/api/client";
import { since } from "@/shared/time";

export type Tone = "ok" | "warn" | "bad" | "idle";

export function healthTone(s: InstanceStatus): { tone: Tone; label: string } {
  const h = s.health;
  if (s.unmanaged) return { tone: "warn", label: "External" };
  if (h?.state === "human_takeover") return { tone: "bad", label: "Needs you" };
  if (h?.recovery?.gaveUp) return { tone: "bad", label: "Gave up" };
  if (h?.state === "waiting_retry") return { tone: "warn", label: "Waiting for game" };
  if (s.state === "failed" || h?.state === "crashed") return { tone: "bad", label: "Failed" };
  if (h?.state === "stalled") return { tone: "warn", label: "Stalled" };
  if (s.state === "starting") return { tone: "warn", label: "Starting" };
  if (s.state === "stopping") return { tone: "warn", label: "Stopping" };
  if (s.state === "running")
    return {
      tone: "ok",
      label: h?.state === "idle" || !s.currentTask ? "Idle" : "Running",
    };
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
      return s.stoppedAt ? `Stopped ${since(s.stoppedAt, now)} ago` : "Press Start to run tasks";
  }
}
