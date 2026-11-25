import { useEffect, useState } from "react";
export function useNow(intervalMs: number | null = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (intervalMs === null) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type Theme = "system" | "light" | "dark";
const THEME_KEY = "alas.theme";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* not remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}
