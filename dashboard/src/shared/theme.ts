import { useEffect, useState } from "react";
import * as z from "zod";

export const THEMES = ["system", "light", "dark"] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;
const THEME_KEY = "alas.theme";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return ThemeSchema.catch("system").parse(localStorage.getItem(THEME_KEY));
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
