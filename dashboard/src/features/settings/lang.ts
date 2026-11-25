import "zod/compile";

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

export function saveLang(lang: Lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered when storage is unavailable.
  }
}
