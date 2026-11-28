import { useQuery } from "@tanstack/react-query";

import { CommandPalette } from "@/features/command-palette/command-palette";
import { healthQuery } from "@/features/health/queries";
import { useConnection, useConnectionError } from "@/features/live-updates/events";
import { LANGS, LangSchema, saveLang, useLang } from "@/features/settings/lang";
import type { Theme } from "@/shared/theme";
import { formatDuration } from "@/shared/time";
import { Chip } from "@/shared/ui/chip";
import { Select } from "@/shared/ui/select";

import { Brand } from "./brand";
import { ThemeSwitch } from "./theme-switch";

const HEALTH_LABEL = { ok: "OK", warn: "Warning", fail: "Failing" } as const;
const HEALTH_TONE = { ok: "ok", warn: "warn", fail: "bad" } as const;

export function TopBar({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const connection = useConnection();
  const connectionError = useConnectionError();
  const health = useQuery(healthQuery());
  const h = health.data;
  const lang = useLang();
  const overall = h?.health?.status;
  return (
    <header className="col-span-full flex min-h-13 flex-wrap items-center gap-4 border-b border-edge bg-panel/75 backdrop-blur-xl backdrop-saturate-150 px-4 py-2.5 max-[600px]:p-3">
      <Brand />
      <div className="flex flex-wrap items-center gap-2 min-[861px]:ml-auto max-[600px]:gap-1.5">
        <CommandPalette theme={theme} onTheme={onTheme} />
        <Chip
          tone={connection === "open" ? "ok" : connection === "connecting" ? "warn" : "bad"}
          title={connectionError ?? "Live updates from the server"}
        >
          {connection === "open"
            ? "Live"
            : connection === "connecting"
              ? "Connecting"
              : "Reconnecting"}
        </Chip>
        <span className="sr-only" role="status">
          {connectionError
            ? "Live updates interrupted. Reconnecting."
            : connection === "open"
              ? "Live updates connected."
              : ""}
        </span>
        {overall && (
          <Chip tone={HEALTH_TONE[overall]}>
            Health <strong>{HEALTH_LABEL[overall]}</strong>
          </Chip>
        )}
        {health.isError && (
          <span className="text-xs text-warn" role="status">
            {h ? "Server summary is stale" : "Server summary unavailable"}
          </span>
        )}
        {h && (
          <>
            <Chip className="max-[600px]:hidden">
              <span>
                <strong>{h.instances.running}</strong>/{h.instances.total}
              </span>{" "}
              running
            </Chip>
            <Chip className="max-[600px]:hidden">
              Up <strong>{formatDuration(h.uptimeSeconds)}</strong>
            </Chip>
          </>
        )}
        <Select
          className="min-h-7! w-24! min-w-0! rounded-full! border-transparent! bg-fill! text-xs!"
          label="Settings language"
          items={LANGS}
          value={lang}
          onValueChange={(next) => {
            const parsed = LangSchema.safeParse(next);
            if (parsed.success) saveLang(parsed.data);
          }}
        />
        <ThemeSwitch theme={theme} onTheme={onTheme} />
      </div>
    </header>
  );
}
