import type { ConfigField, ConfigTask, ConfigValue } from "@/api/client";
import { parseTime } from "@/shared/time";

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

export function parseNextRun(value: ConfigValue): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = parseTime(value);
  return Number.isNaN(t) ? null : t;
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
