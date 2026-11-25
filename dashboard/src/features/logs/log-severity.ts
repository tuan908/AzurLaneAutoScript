export function logTone(level: string) {
  return level === "error" ? "text-terminal-bad" : level === "warn" ? "text-terminal-warn" : "";
}
export function severity(text: string): "error" | "warn" | "" {
  if (/ERROR|CRITICAL|Traceback/.test(text)) return "error";
  if (/WARNING/.test(text)) return "warn";
  return "";
}
