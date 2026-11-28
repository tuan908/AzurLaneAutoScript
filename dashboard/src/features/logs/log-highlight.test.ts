import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LogText } from "./log-highlight";

const html = (text: string) => renderToStaticMarkup(createElement(LogText, { text }));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, "").replaceAll("&quot;", '"');

describe("LogText", () => {
  it("colors the level, time, button and numbers of a streamed line", () => {
    const out = html("INFO     21:14:22.713 | Click ( 223,  176) @ OPPONENT_0_0");
    expect(out).toContain('<span class="text-[#5ac8fa]">INFO</span>');
    expect(out).toContain('<span class="text-terminal-dim">21:14:22.713</span>');
    expect(out).toContain('<span class="text-[#ff9f0a]">@ OPPONENT_0_0</span>');
    expect(out).toContain('<span class="text-[#c8b3ff]">223</span>');
    expect(plain(out)).toContain("Click ( 223,  176) @ OPPONENT_0_0");
  });

  it("reads the file log format and highlights tasks, tags and banners", () => {
    const out = html(
      "2026-11-26 22:58:57.366 | WARNING | Scheduler: Start task `Exercise` [Emotion fleet_1] <<< UI CLICK >>>",
    );
    expect(out).toContain('font-semibold">WARNING');
    expect(out).toContain('<span class="text-[#30d158]">`Exercise`</span>');
    expect(out).toContain('<span class="text-[#66d4cf]">[Emotion fleet_1]</span>');
    expect(out).toContain("&lt;&lt;&lt; UI CLICK &gt;&gt;&gt;");
  });

  it("shows divider lines and unknown text unchanged", () => {
    expect(html("──────── OPPONENT 1 ────────")).toContain("text-[#da8fff]");
    expect(plain(html("plain text"))).toBe("plain text");
    expect(html("GameStuckError: Wait too long")).toContain("font-bold text-[#ff6961]");
  });

  it("reads the live log separator │", () => {
    const out = html("INFO     20:34:15.112 │ Click ( 835,  619) @ REWARD_GOTO_MAIN");
    expect(out).toContain('<span class="text-[#5ac8fa]">INFO</span>');
    expect(out).toContain('<span class="text-terminal-dim">20:34:15.112</span>');
    expect(plain(out)).toBe("INFO     20:34:15.112 │ Click ( 835,  619) @ REWARD_GOTO_MAIN");
  });
});
