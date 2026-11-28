import type * as z from "zod";

// Preferences remembered in this browser (theme, language, settings view). Storage can be
// unavailable (private windows, blocked site data): reads then fall back and writes are
// dropped, so a preference is simply not remembered. Values are validated when read.

export function loadPreference<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(localStorage.getItem(key));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered when storage is unavailable.
  }
}
