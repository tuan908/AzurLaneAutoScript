import { parseLogLine } from "./log-format";

export type Severity = "error" | "warn" | "";

export function logTone(level: Severity) {
  if (level === "error")
    return "bg-[#ff453a]/16 text-[#ffb4ab] shadow-[inset_3px_0_0_#ff453a] hover:bg-[#ff453a]/24!";
  if (level === "warn")
    return "bg-[#ffd60a]/7 text-[#ffe680] shadow-[inset_3px_0_0_#ffd60a99] hover:bg-[#ffd60a]/12!";
  return "";
}

// Severity of each line, by seq. A log entry has the severity of its level; a rule resets it.
// Plain text (traceback frames, wrapped lines) belongs to the entry above it, and a traceback
// or exception line is an error on its own.
export function lineSeverities(lines: readonly { seq: number; text: string }[]) {
  const result = new Map<number, Severity>();
  let block: Severity = "";
  for (const { seq, text } of lines) {
    const line = parseLogLine(text);
    if (line.kind === "entry") {
      block =
        line.level === "ERROR" || line.level === "CRITICAL"
          ? "error"
          : line.level === "WARNING"
            ? "warn"
            : "";
    } else if (line.kind === "rule") {
      block = "";
    } else if (line.exception || text.startsWith("Traceback")) {
      block = "error";
    }
    result.set(seq, block);
  }
  return result;
}
