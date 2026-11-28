import { useSyncExternalStore } from "react";
import * as z from "zod";

import { loadPreference, savePreference } from "@/shared/storage";

export const LANGS = ["en-US", "zh-CN", "zh-TW", "ja-JP"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;
const LANG_KEY = "alas.lang";

export function readLang(): Lang {
  return loadPreference(LANG_KEY, LangSchema, "en-US");
}

let currentLang: Lang | null = null;
const listeners = new Set<() => void>();

export function saveLang(lang: Lang) {
  currentLang = lang;
  for (const listener of listeners) listener();
  savePreference(LANG_KEY, lang);
}

const getLang = () => (currentLang ??= readLang());

export function useLang() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLang);
}

const KEYS_KEY = "alas.settings.showKeys";

const ShowKeysSchema = z.enum(["0", "1"]);

export function readShowKeys() {
  return loadPreference(KEYS_KEY, ShowKeysSchema, "0") === "1";
}

export function saveShowKeys(show: boolean) {
  savePreference(KEYS_KEY, show ? "1" : "0");
}
