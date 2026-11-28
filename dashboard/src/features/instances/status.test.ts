import { describe, expect, it } from "vitest";

import type { InstanceStatus } from "@/api/client";
import { instanceFixture as make } from "@/api/test-fixtures";

import { healthTone, statusLine } from "./status";

type Health = NonNullable<InstanceStatus["health"]>;
const health = (state: Health["state"], gaveUp = false): Health => ({
  state,
  detail: "",
  recovery: {
    policy: { autoRestart: false, restartOnStall: false, stallMinutes: 30 },
    restartsLastHour: 0,
    nextAttemptAt: null,
    pendingReason: null,
    gaveUp,
  },
});

describe("healthTone", () => {
  it("puts the most urgent signal first", () => {
    expect(healthTone(make({ state: "failed", health: health("human_takeover") }))).toEqual({
      tone: "bad",
      label: "Needs you",
    });
    expect(healthTone(make({ state: "running", health: health("ok", true) }))).toEqual({
      tone: "bad",
      label: "Gave up",
    });
    expect(
      healthTone(
        make({
          state: "running",
          currentTask: "Commission",
          health: health("stalled"),
        }),
      ).label,
    ).toBe("Stalled");
    expect(
      healthTone(
        make({
          state: "running",
          currentTask: "Commission",
          health: health("ok"),
        }),
      ),
    ).toEqual({ tone: "ok", label: "Running" });
    expect(healthTone(make({ state: "running", health: health("idle") })).label).toBe("Idle");
    expect(healthTone(make({ state: "stopped" }))).toEqual({
      tone: "idle",
      label: "Stopped",
    });
    expect(healthTone(make({ state: "running", unmanaged: true })).label).toBe("External");
  });
});

describe("statusLine", () => {
  it("describes what the instance is doing", () => {
    expect(statusLine(make({ state: "running", currentTask: "Research" }), 0)).toBe(
      "Running Research",
    );
    expect(statusLine(make({ state: "running" }), 0)).toBe("Waiting for the next task");
    expect(statusLine(make({ state: "failed", lastError: "Worker exited with code 1" }), 0)).toBe(
      "Worker exited with code 1",
    );
    expect(statusLine(make({ state: "stopped" }), 0)).toBe("Press Start to run tasks");
  });
});
