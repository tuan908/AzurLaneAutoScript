import type { LogLine } from "../../api/client";

export interface Completion {
  seq: number;
  time: string | null;
  task: string;
  result: string | null;
}

const END_TASK = /Scheduler: End task `([^`]+)`(?:\s*\[([^\]]+)\])?/;
const CLOCK = /\b(\d{2}:\d{2}:\d{2})(?:\.\d+)?\b/;

export function parseCompletion(line: LogLine): Completion | null {
  const end = END_TASK.exec(line.text);
  const task = end?.[1];
  if (!end || !task) return null;
  const clock = CLOCK.exec(line.text.slice(0, end.index));
  return { seq: line.seq, time: clock?.[1] ?? null, task, result: end[2]?.toLowerCase() ?? null };
}

export function recentCompletions(lines: readonly LogLine[], limit = 30): Completion[] {
  const out: Completion[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    const parsed = line && parseCompletion(line);
    if (parsed) out.push(parsed);
  }
  return out;
}
