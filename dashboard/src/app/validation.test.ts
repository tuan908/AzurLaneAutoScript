import { describe, expect, it } from "vitest";

import { MaxRestartsInput, StallMinutesInput } from "@/features/health/policy-input";
import { TabSchema } from "@/features/instances/navigation";
import { LogsSearchSchema } from "@/features/logs/search";
import { LangSchema } from "@/features/settings/lang";
import { SettingsSearchSchema } from "@/features/settings/search";
import { ThemeSchema } from "@/shared/theme";

describe("route search params", () => {
  it("fill in defaults for missing params", () => {
    expect(LogsSearchSchema.parse({})).toEqual({ filter: "", level: "all" });
    expect(SettingsSearchSchema.parse({})).toEqual({ q: "", task: "", menu: "", changed: false });
  });

  it("fall back instead of throwing on a hand-edited URL", () => {
    expect(LogsSearchSchema.parse({ filter: 42, level: "verbose" })).toEqual({
      filter: "",
      level: "all",
    });
    expect(SettingsSearchSchema.parse({ q: ["a"], task: "Commission" })).toEqual({
      q: "",
      task: "Commission",
      menu: "",
      changed: false,
    });
  });
});

describe("stored preferences", () => {
  it("fall back when storage holds something unexpected", () => {
    expect(ThemeSchema.catch("system").parse("solarized")).toBe("system");
    expect(ThemeSchema.catch("system").parse(null)).toBe("system");
    expect(ThemeSchema.catch("system").parse("dark")).toBe("dark");
    expect(LangSchema.catch("en-US").parse("fr-FR")).toBe("en-US");
    expect(LangSchema.catch("en-US").parse("ja-JP")).toBe("ja-JP");
  });

  it("only accept known tabs from commands", () => {
    expect(TabSchema.safeParse("logs").success).toBe(true);
    expect(TabSchema.safeParse("admin").success).toBe(false);
  });
});

describe("recovery policy inputs", () => {
  it.each([
    ["30", 30],
    [" 0 ", 0],
    ["1440", 1440],
  ])("stall minutes %j -> %d", (text, value) => {
    expect(StallMinutesInput.parse(text)).toBe(value);
  });

  it.each(["", "  ", "abc", "1.5", "-1", "1441"])("rejects stall minutes %j", (text) => {
    expect(StallMinutesInput.safeParse(text).success).toBe(false);
  });

  it("does not turn an empty field into 0", () => {
    expect(StallMinutesInput.safeParse("").error?.issues[0]?.message).toBe("Enter a number");
  });

  it("bounds restarts per hour", () => {
    expect(MaxRestartsInput.parse("60")).toBe(60);
    expect(MaxRestartsInput.safeParse("61").success).toBe(false);
  });
});
