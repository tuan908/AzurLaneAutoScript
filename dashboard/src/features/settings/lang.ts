export const LANGS = ["en-US", "zh-CN", "zh-TW", "ja-JP"];
const LANG_KEY = "alas.lang";

export function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? "en-US";
  } catch {
    return "en-US";
  }
}

export function saveLang(lang: string) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered when storage is unavailable.
  }
}
