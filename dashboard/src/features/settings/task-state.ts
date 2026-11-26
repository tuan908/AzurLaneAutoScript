import type { ConfigField, ConfigTask, ConfigValue } from "@/api/client";

export const SCHEDULER_GROUP = "Scheduler";

export function schedulerOf(task: ConfigTask) {
  const group = task.groups.find((g) => g.id === SCHEDULER_GROUP);
  if (!group) return null;
  const enable = group.fields.find((f) => f.path.endsWith(".Enable") && f.type === "checkbox");
  const nextRun = group.fields.find((f) => f.path.endsWith(".NextRun"));
  return enable ? { group, enable, nextRun } : null;
}

export function headerPaths(task: ConfigTask) {
  const s = schedulerOf(task);
  return new Set([s?.enable.path, s?.nextRun?.path].filter((p): p is string => !!p));
}

// NextRun is runtime state, not a preference.
const isState = (field: ConfigField) => field.type === "datetime" || field.readOnly;

export function isChanged(field: ConfigField, value: ConfigValue) {
  if (isState(field) || field.default === null) return false;
  return String(value ?? "") !== String(field.default);
}

// ALAS writes server-local time; the server runs on the same machine as the browser.
export function parseNextRun(value: ConfigValue): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = new Date(value.replace(" ", "T")).getTime();
  return Number.isNaN(t) ? null : t;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function formatNextRun(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function relativeTime(t: number, now: number) {
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

// Rarely touched groups, folded under "Advanced". Search and the Changed filter still list them.
export const ADVANCED_GROUPS = new Set(["EmulatorInfo", "Error", "Optimization", "DropRecord"]);

const family = (id: string) => /^(.*?)\d?$/.exec(id)?.[1];

// Main2, Event2, EventB… are parallel slots: a full copy of their base task's settings.
export function slotsOf(task: ConfigTask, tasks: ConfigTask[]) {
  const base = /^(.*?)\d$/.exec(task.id)?.[1];
  const root = base && tasks.some((t) => t.id === base) ? base : task.id;
  const siblings = tasks.filter((t) => t.id !== root && family(t.id) === root && /\d$/.test(t.id));
  if (!siblings.length) return null;
  const rootTask = tasks.find((t) => t.id === root);
  return rootTask ? { root: rootTask, slots: siblings, isSlot: task.id !== root } : null;
}

export type Match = "strong" | "weak" | null;

export function matchField(field: ConfigField, q: string): Match {
  if (!q) return "strong";
  if (field.label.toLowerCase().includes(q) || field.path.toLowerCase().includes(q))
    return "strong";
  if (
    field.help.toLowerCase().includes(q) ||
    field.options?.some((o) => o.label.toLowerCase().includes(q))
  )
    return "weak";
  return null;
}
