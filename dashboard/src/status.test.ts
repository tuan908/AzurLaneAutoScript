import { describe, expect, it } from "vitest";
import type { InstanceStatus } from "./api";
import { instanceFixture as make } from "./test-fixtures";
import { formatDuration, healthTone, statusLine, untilNextRun } from "./status";

type Health = NonNullable<InstanceStatus["health"]>;
const health = (state: Health["state"], gaveUp = false): Health => ({
  state, detail: "", recovery: {
    policy: { autoRestart: false, restartOnStall: false, stallMinutes: 30 },
    restartsLastHour: 0, nextAttemptAt: null, pendingReason: null, gaveUp,
  },
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
    expect(statusLine(make({ state: "running", currentTask: "Research" }), 0)).toBe("Running Research");
    expect(statusLine(make({ state: "running" }), 0)).toBe("Waiting for the next task");
    expect(statusLine(make({ state: "failed", lastError: "Worker exited with code 1" }), 0)).toBe("Worker exited with code 1");
    expect(statusLine(make({ state: "stopped" }), 0)).toBe("Not started");
  });
});
