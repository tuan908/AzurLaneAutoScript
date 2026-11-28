import { describe, expect, it } from "vitest";

import { parseLogLine } from "./log-format";

describe("parseLogLine", () => {
  it("reads the live console format with either separator", () => {
    for (const sep of ["│", "|"]) {
      expect(parseLogLine(`INFO     20:34:15.112 ${sep} Click @ REWARD_GOTO_MAIN`)).toEqual({
        kind: "entry",
        format: "console",
        indent: "",
        date: "",
        time: "20:34:15.112",
        level: "INFO",
        gap: "     ",
        body: "Click @ REWARD_GOTO_MAIN",
      });
    }
  });

  it("reads the file format", () => {
    const line = parseLogLine("2026-11-26 22:58:57.366 | WARNING | Game stuck");
    expect(line).toMatchObject({
      kind: "entry",
      format: "file",
      date: "2026-11-26 ",
      level: "WARNING",
    });
    expect(line.kind === "entry" && line.body).toBe("Game stuck");
  });

  it("tells rules, exceptions and plain text apart", () => {
    expect(parseLogLine("──────── OPPONENT 1 ────────").kind).toBe("rule");
    expect(parseLogLine("GameStuckError: Wait too long")).toMatchObject({
      kind: "text",
      exception: true,
    });
    expect(parseLogLine('  File "alas.py", line 74')).toMatchObject({
      kind: "text",
      exception: false,
    });
  });
});
