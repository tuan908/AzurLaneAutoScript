import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";

import { THEMES, ThemeSchema, type Theme } from "@/shared/theme";

const LABELS: Record<Theme, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

export function ThemeSwitch({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  return (
    <SegmentedControl
      className="inline-flex rounded-full! p-0.5 [&_button]:h-6 [&_button]:rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2.25 [&_button]:text-xs [&_button]:text-subtle [&_button[data-checked]]:text-ink [&_[data-slot=segmented-control-indicator]]:rounded-full"
      aria-label="Theme"
      value={theme}
      onValueChange={(next) => {
        const parsed = ThemeSchema.safeParse(next);
        if (parsed.success) onTheme(parsed.data);
      }}
    >
      <SegmentedControlIndicator />
      {THEMES.map((t) => (
        <SegmentedControlItem key={t} value={t}>
          {LABELS[t]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
