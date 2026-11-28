import { useEffect, useState } from "react";
import * as z from "zod";

import { loadPreference, savePreference } from "./storage";

export const THEMES = ["system", "light", "dark"] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;
const THEME_KEY = "alas.theme";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => loadPreference(THEME_KEY, ThemeSchema, "system"));
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
    savePreference(THEME_KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}
