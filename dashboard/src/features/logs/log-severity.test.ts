import { describe, expect, it } from "vitest";

import { lineSeverities } from "./log-severity";

const lines = (...texts: string[]) => texts.map((text, i) => ({ seq: i + 1, text }));

describe("lineSeverities", () => {
  it("carries an error through its traceback until the next log line", () => {
    const levels = lineSeverities(
      lines(
        "ERROR    21:14:32.000 | Exception occurred",
        "Traceback (most recent call last):",
        '  File "alas.py", line 74, in run',
        "GameStuckError: Wait too long",
        "INFO     21:14:33.000 | Save config",
        "  wrapped info text",
      ),
    );
    expect([...levels.values()]).toEqual(["error", "error", "error", "error", "", ""]);
  });

  it("marks warnings and stops at divider lines", () => {
    const levels = lineSeverities(
      lines(
        "WARNING  21:14:31.200 | Game stuck",
        "  continued",
        "──────── OPPONENT 1 ────────",
        "after",
      ),
    );
    expect([...levels.values()]).toEqual(["warn", "warn", "", ""]);
  });
});
