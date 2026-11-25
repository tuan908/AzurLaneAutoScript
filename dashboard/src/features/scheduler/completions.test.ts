import { describe, expect, it } from "vitest";

import { parseCompletion, recentCompletions } from "./completions";

const line = (seq: number, text: string) => ({ seq, text });

describe("parseCompletion", () => {
  it("reads time, task and result from an Alas log line", () => {
    expect(
      parseCompletion(
        line(7, "INFO     12:01:17.115 │ Scheduler: End task `Commission` [success]"),
      ),
    ).toEqual({
      seq: 7,
      time: "12:01:17",
      task: "Commission",
      result: "success",
    });
  });

  it("tolerates a missing result and time", () => {
    expect(parseCompletion(line(1, "Scheduler: End task `Research`"))).toEqual({
      seq: 1,
      time: null,
      task: "Research",
      result: null,
    });
  });

  it("ignores other lines, including task starts", () => {
    expect(
      parseCompletion(line(2, "INFO 12:00:00.000 │ Scheduler: Start task `Commission`")),
    ).toBeNull();
  });
});

describe("recentCompletions", () => {
  it("returns the newest first, up to the limit", () => {
    const lines = [
      line(1, "Scheduler: End task `A` [success]"),
      line(2, "noise"),
      line(3, "Scheduler: End task `B` [failed]"),
      line(4, "Scheduler: End task `C` [success]"),
    ];
    expect(recentCompletions(lines, 2).map((c) => c.task)).toEqual(["C", "B"]);
  });
});
