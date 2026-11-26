import { useSyncExternalStore } from "react";
import * as z from "zod";

export const LANGS = ["en-US", "zh-CN", "zh-TW", "ja-JP"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;
const LANG_KEY = "alas.lang";

export function readLang(): Lang {
  try {
    return LangSchema.catch("en-US").parse(localStorage.getItem(LANG_KEY));
  } catch {
    return "en-US";
  }
}

let currentLang: Lang | null = null;
const listeners = new Set<() => void>();

export function saveLang(lang: Lang) {
  currentLang = lang;
  for (const listener of listeners) listener();
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered when storage is unavailable.
  }
}

const getLang = () => (currentLang ??= readLang());

export function useLang() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLang);
}

const KEYS_KEY = "alas.settings.showKeys";

export function readShowKeys() {
  try {
    return localStorage.getItem(KEYS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowKeys(show: boolean) {
  try {
    localStorage.setItem(KEYS_KEY, show ? "1" : "0");
  } catch {
    // Not remembered when storage is unavailable.
  }
}
