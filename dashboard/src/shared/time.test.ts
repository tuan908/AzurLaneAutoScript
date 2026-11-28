import { describe, expect, it } from "vitest";

import { formatAlasTime, formatDuration, parseTime, untilNextRun } from "./time";

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

describe("ALAS local times", () => {
  it("round-trip through parseTime and formatAlasTime", () => {
    expect(formatAlasTime(parseTime("2026-11-26 21:05:09"))).toBe("2026-11-26 21:05:09");
    expect(parseTime("nope")).toBeNaN();
  });
});
