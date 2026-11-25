import { describe, expect, it } from "vitest";
import type { InstanceStatus } from "./api";
import { formatDuration, healthTone, statusLine, untilNextRun } from "./status";

const base = {
  id: "alas", state: "stopped", processId: null, startedAt: null, stoppedAt: null, exitCode: null,
  currentTask: null, lastActivityAt: null, lastError: null, legacyState: 2, revision: 0,
} as unknown as InstanceStatus;

const make = (over: Record<string, unknown>) => ({ ...base, ...over }) as InstanceStatus;
const health = (state: string, gaveUp = false) => ({
  state, detail: "", recovery: { policy: {}, restartsLastHour: 0, nextAttemptAt: null, pendingReason: null, gaveUp },
});

describe("formatDuration", () => {
  it("picks the two largest units", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });
});

describe("untilNextRun", () => {
  const now = new Date("2026-11-25T10:00:00").getTime();
  it("reads Alas local times", () => {
    expect(untilNextRun("2026-11-25 12:30:00", now)).toBe("in 2h 30m");
    expect(untilNextRun("2020-01-01 00:00:00", now)).toBe("due now");
  });
  it("reads ISO times", () => {
    expect(untilNextRun(new Date(now + 45000).toISOString(), now)).toBe("in 45s");
  });
});

describe("healthTone", () => {
  it("puts the most urgent signal first", () => {
    expect(healthTone(make({ state: "failed", health: health("human_takeover") }))).toEqual({ tone: "bad", label: "Needs you" });
    expect(healthTone(make({ state: "running", health: health("ok", true) }))).toEqual({ tone: "bad", label: "Gave up" });
    expect(healthTone(make({ state: "running", currentTask: "Commission", health: health("stalled") })).label).toBe("Stalled");
    expect(healthTone(make({ state: "running", currentTask: "Commission", health: health("ok") }))).toEqual({ tone: "ok", label: "Running" });
    expect(healthTone(make({ state: "running", health: health("idle") })).label).toBe("Idle");
    expect(healthTone(make({ state: "stopped" }))).toEqual({ tone: "idle", label: "Stopped" });
    expect(healthTone(make({ state: "running", unmanaged: true })).label).toBe("External");
  });
});

describe("statusLine", () => {
  it("describes what the instance is doing", () => {
    expect(statusLine(make({ state: "running", currentTask: "Research" }))).toBe("Running Research");
    expect(statusLine(make({ state: "running" }))).toBe("Waiting for the next task");
    expect(statusLine(make({ state: "failed", lastError: "Worker exited with code 1" }))).toBe("Worker exited with code 1");
    expect(statusLine(make({ state: "stopped" }))).toBe("Not started");
  });
});
