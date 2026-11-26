import { describe, expect, it } from "vitest";

import type { ConfigField, ConfigTask } from "@/api/client";

import { formatNextRun, headerPaths, isChanged, parseNextRun, schedulerOf } from "./task-state";

const field = (over: Partial<ConfigField>): ConfigField => ({
  path: "Exercise.Exercise.Mode",
  type: "input",
  label: "Mode",
  help: "",
  default: "a",
  readOnly: false,
  ...over,
});

const task: ConfigTask = {
  id: "Exercise",
  name: "Exercise",
  help: "",
  groups: [
    {
      id: "Scheduler",
      name: "Scheduler",
      help: "",
      fields: [
        field({ path: "Exercise.Scheduler.Enable", type: "checkbox", default: false }),
        field({
          path: "Exercise.Scheduler.NextRun",
          type: "datetime",
          default: "2020-01-01 00:00:00",
        }),
      ],
    },
    { id: "Exercise", name: "Exercise", help: "", fields: [field({})] },
  ],
};

describe("task state", () => {
  it("finds the scheduler fields the task header owns", () => {
    expect(schedulerOf(task)?.enable.path).toBe("Exercise.Scheduler.Enable");
    expect([...headerPaths(task)]).toEqual([
      "Exercise.Scheduler.Enable",
      "Exercise.Scheduler.NextRun",
    ]);
    expect(schedulerOf({ ...task, groups: task.groups.slice(1) })).toBeNull();
  });

  it("compares with the default across value types, ignoring runtime state", () => {
    expect(isChanged(field({ default: 30 }), "30")).toBe(false);
    expect(isChanged(field({ default: false, type: "checkbox" }), true)).toBe(true);
    expect(
      isChanged(field({ type: "datetime", default: "2020-01-01 00:00:00" }), "2026-01-01 00:00:00"),
    ).toBe(false);
    expect(isChanged(field({ readOnly: true }), "b")).toBe(false);
  });

  it("round-trips ALAS datetimes", () => {
    const t = parseNextRun("2026-11-26 21:05:09");
    expect(t).not.toBeNull();
    expect(formatNextRun(t ?? 0)).toBe("2026-11-26 21:05:09");
    expect(parseNextRun("nope")).toBeNull();
  });
});
