import { describe, expect, it } from "vitest";
import { splitHelp } from "./help";

describe("splitHelp", () => {
  it("keeps short single-line help whole", () => {
    expect(splitHelp("Enable when running Alas on phones")).toEqual(["Enable when running Alas on phones", ""]);
  });

  it("shows the first line and hides the rest", () => {
    expect(splitHelp("Common serials below\n- BlueStacks 127.0.0.1:5555\n- MuMu 127.0.0.1:7555"))
      .toEqual(["Common serials below", "- BlueStacks 127.0.0.1:5555\n- MuMu 127.0.0.1:7555"]);
  });

  it("splits a long line at a word boundary", () => {
    const text = `${"word ".repeat(40)}end`;
    const [summary, more] = splitHelp(text);
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith(" ")).toBe(false);
    expect(`${summary} ${more}`).toBe(text);
  });

  it("ignores surrounding blank lines", () => {
    expect(splitHelp("\n  Only line  \n")).toEqual(["Only line", ""]);
  });
});
