// The one parser of an ALAS log line. Highlighting (log-highlight.tsx) and severity
// (log-severity.ts) both read lines through it.
//
// Formats, with "│" (the live console log) or "|" (log files) as the separator:
//   console  INFO     21:14:22.713 │ message
//   file     2026-11-26 22:58:57.366 | WARNING | message
// Anything else is a rule (──── TITLE ────) or plain text: a traceback frame, a wrapped line.

export const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;
export type Level = (typeof LEVELS)[number];

const LEVEL = `(${LEVELS.join("|")})`;
const TIME = String.raw`(\d\d:\d\d:\d\d(?:\.\d+)?)`;
const SEP = "[|│]";
const CONSOLE = new RegExp(String.raw`^(\s*)${LEVEL}(\s+)${TIME}\s*${SEP}\s?`);
const FILE = new RegExp(
  String.raw`^(\s*)(\d{4}-\d\d-\d\d )?${TIME}\s*${SEP}\s*${LEVEL}\s*${SEP}\s?`,
);
const RULE = /^[\s─═━-]*[─═━]{4,}/;
const EXCEPTION = /^[A-Za-z_.]*(?:Error|Exception|Takeover|Interrupt)\b:?/;

export type LogLine =
  | {
      kind: "entry";
      format: "console" | "file";
      indent: string;
      date: string;
      time: string;
      level: Level;
      // Spaces between level and time in the console format
      gap: string;
      // The message after the prefix
      body: string;
    }
  | { kind: "rule"; text: string }
  // `exception`: the last line of a traceback, like `GameStuckError: Wait too long`
  | { kind: "text"; text: string; exception: boolean };

export function parseLogLine(text: string): LogLine {
  const consoleMatch = CONSOLE.exec(text);
  if (consoleMatch) {
    const [whole, indent = "", level, gap = " ", time = ""] = consoleMatch;
    return {
      kind: "entry",
      format: "console",
      indent,
      date: "",
      time,
      level: level as Level,
      gap,
      body: text.slice(whole.length),
    };
  }
  const file = FILE.exec(text);
  if (file) {
    const [whole, indent = "", date = "", time = "", level] = file;
    return {
      kind: "entry",
      format: "file",
      indent,
      date,
      time,
      level: level as Level,
      gap: " ",
      body: text.slice(whole.length),
    };
  }
  if (RULE.test(text)) return { kind: "rule", text };
  return { kind: "text", text, exception: EXCEPTION.test(text) };
}
