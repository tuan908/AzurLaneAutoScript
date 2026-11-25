import type { ConfigField, ConfigValue } from "./api";
export type ConfigDocument = { revision: string; config: unknown };
export type Draft = { baseline: ConfigDocument; edits: Record<string, ConfigValue> };

export function valueAt(obj: unknown, path: string): ConfigValue {
  let value = obj;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

export function changeDraft(draft: Draft | null, document: ConfigDocument, field: Pick<ConfigField, "path" | "type">, value: ConfigValue): Draft | null {
  const baseline = draft?.baseline ?? document;
  const edits = { ...draft?.edits };
  const normalized = field.type === "datetime" && typeof value === "string" ? value.replace("T", " ") : value;
  const original = valueAt(baseline.config, field.path);
  if (Object.is(normalized, original)) delete edits[field.path];
  else edits[field.path] = normalized;
  return Object.keys(edits).length ? { baseline, edits } : null;
}
export function draftValue(draft: Draft | null, document: ConfigDocument | undefined, path: string): ConfigValue {
  if (draft && Object.hasOwn(draft.edits, path)) return draft.edits[path] ?? null;
  return valueAt(draft?.baseline.config ?? document?.config, path);
}
