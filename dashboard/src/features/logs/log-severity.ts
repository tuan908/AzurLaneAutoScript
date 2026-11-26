export type Severity = "error" | "warn" | "";

export function logTone(level: Severity) {
  if (level === "error")
    return "bg-[#ff453a]/16 text-[#ffb4ab] shadow-[inset_3px_0_0_#ff453a] hover:bg-[#ff453a]/24!";
  if (level === "warn")
    return "bg-[#ffd60a]/7 text-[#ffe680] shadow-[inset_3px_0_0_#ffd60a99] hover:bg-[#ffd60a]/12!";
  return "";
}

export function severity(text: string): Severity {
  if (/ERROR|CRITICAL|Traceback/.test(text)) return "error";
  if (/WARNING/.test(text)) return "warn";
  return "";
}

const PREFIXED =
  /^\s*(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d|(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+\d\d:\d\d)/;
const RULE = /^[\s─═━-]*[─═━]{4,}/;

// Traceback frames and wrapped lines carry no level: they belong to the error above them.
export function lineSeverities(lines: readonly { seq: number; text: string }[]) {
  const result = new Map<number, Severity>();
  let block: Severity = "";
  for (const line of lines) {
    let level = severity(line.text);
    if (PREFIXED.test(line.text) || RULE.test(line.text)) block = level;
    else if (level === "") level = block;
    else block = level;
    result.set(line.seq, level);
  }
  return result;
}
