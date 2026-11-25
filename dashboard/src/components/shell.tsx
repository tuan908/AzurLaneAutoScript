import { toneDot } from "./ui";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Button } from "./ui";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { setToken, type InstanceStatus } from "../api";
import { useConnection, useConnectionError } from "../events";
import { useNow, type Theme } from "../hooks";
import { formatDuration, healthTone, statusLine } from "../status";
import { queries } from "../queries";
import { Icon } from "./ui";
import { CommandPalette } from "./command-palette";
const ProfileDialog = lazy(() => import("./profile-dialog"));
function Brand() {
  return (
    <div className="flex items-center gap-2.5 font-bold tracking-[-.01em] min-[861px]:min-w-60 [&_small]:block [&_small]:text-[11px] [&_small]:font-medium [&_small]:tracking-normal [&_small]:text-subtle">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-linear-to-br from-accent to-violet-500 text-[13px] font-extrabold text-white" aria-hidden="true">AL</span>
      <span>
        ALAS Control Center
        <small>Local automation server</small>
      </span>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="grid h-full place-items-center p-6">
      <form
        className="grid w-full max-w-95 gap-3.5 rounded-[14px] border border-edge bg-panel p-7 shadow-alas-lg"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value);
          onDone();
        }}
      >
        <Brand />
        <div>
          <h2>Password required</h2>
          <p className="text-subtle text-xs">This server is protected. The password is kept for this browser tab only.</p>
        </div>
        <label className="sr-only" htmlFor="password">Password</label>
        <Input id="password" type="password" data-agent-secret required placeholder="Password" value={value} onValueChange={setValue} />
        <Button variant="primary" type="submit">Unlock</Button>
      </form>
    </div>
  );
}

export function TopBar({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const connection = useConnection();
  const connectionError = useConnectionError();
  const health = useQuery(queries.health());
  const h = health.data;
  const overall = h?.health?.status;
  return (
    <header className="col-span-full flex min-h-13 flex-wrap items-center gap-4 border-b border-edge bg-panel px-4 py-2.5 max-[600px]:p-3">
      <Brand />
      <div className="flex flex-wrap items-center gap-2 min-[861px]:ml-auto max-[600px]:gap-1.5">
        <CommandPalette theme={theme} onTheme={onTheme} />
        <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary [&_strong]:font-semibold [&_strong]:text-ink" title={connectionError ?? "Live updates from the server"}>
          <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(connection === "open" ? "ok" : connection === "connecting" ? "warn" : "bad")}`} />
          {connection === "open" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
        {overall && (
          <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary [&_strong]:font-semibold [&_strong]:text-ink">
            <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(overall === "ok" ? "ok" : overall === "warn" ? "warn" : "bad")}`} />
            Health <strong>{overall === "ok" ? "OK" : overall === "warn" ? "Warning" : "Failing"}</strong>
          </span>
        )}
        {health.isError && <span className="text-xs text-warn" role="status">
          {h ? "Server summary is stale" : "Server summary unavailable"}
        </span>}
        {h && (
          <>
            <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary max-[600px]:hidden [&_strong]:font-semibold [&_strong]:text-ink">
              <span><strong>{h.instances.running}</strong>/{h.instances.total}</span> running
            </span>
            <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary max-[600px]:hidden [&_strong]:font-semibold [&_strong]:text-ink">Up <strong>{formatDuration(h.uptimeSeconds)}</strong></span>
          </>
        )}
        {h?.logQueueManagerAlive === false && <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary [&_strong]:font-semibold [&_strong]:text-ink text-bad">Log queue down</span>}
        <SegmentedControl className="inline-flex rounded-full border border-edge bg-panel-2 p-0.5 [&_button]:h-6 [&_button]:rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-[9px] [&_button]:text-xs [&_button]:text-subtle [&_button[data-checked]]:bg-panel [&_button[data-checked]]:text-ink" aria-label="Theme" value={theme} onValueChange={(next) => { if (next === "system" || next === "light" || next === "dark") onTheme(next); }}>
          <SegmentedControlIndicator />
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <SegmentedControlItem key={t} value={t}>
              {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
    </header>
  );
}

export function Rail({
  instances,
  selected,
  onSelect,
  onCreate,
}: {
  instances: InstanceStatus[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (id: string) => void;
}) {
  const now = useNow(instances.some((instance) => instance.state === "stopped" && instance.stoppedAt) ? 15_000 : null);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setCreating(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return (
    <nav className="flex min-h-0 gap-1.5 overflow-x-auto border-b border-edge bg-panel-2 px-3 py-3.5 min-[861px]:flex-col min-[861px]:overflow-y-auto min-[861px]:border-r min-[861px]:border-b-0" aria-label="Instances">
      <div className="hidden items-center justify-between px-1 pb-1 min-[861px]:flex">
        <span className="text-[11px] font-semibold tracking-[.06em] uppercase text-subtle">Instances</span>
        <span className="text-subtle text-xs">{instances.length}</span>
      </div>
      {instances.map((s) => {
        const tone = healthTone(s);
        const flag = s.health?.recovery.gaveUp ? "gave up" : s.health?.state === "human_takeover" ? "needs you"
          : s.health?.state === "stalled" ? "stalled" : s.unmanaged ? "external" : null;
        return (
          <SdkButton key={s.id} className="grid! h-auto! min-h-16 w-full min-w-50 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-alas! border border-transparent! bg-transparent! px-3 py-2.5 text-left transition-colors hover:border-edge! hover:bg-panel! aria-[current=true]:border-edge-strong! aria-[current=true]:bg-panel! aria-[current=true]:shadow-alas min-[861px]:min-w-0" onClick={() => onSelect(s.id)}
            aria-current={s.id === selected ? "true" : undefined}>
            <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(tone.tone)}`} />
            <span className="min-w-0 truncate font-semibold">{s.id}</span>
            {flag ? <span className={`text-[11px] font-semibold ${tone.tone === "bad" ? "text-bad" : "text-warn"}`}>{flag}</span> : <span />}
            <span className="col-start-2 col-end-[-1] truncate text-xs text-subtle">{statusLine(s, now)}</span>
          </SdkButton>
        );
      })}
      <Button ref={trigger} className="min-w-32.5 border-dashed! text-secondary! min-[861px]:mt-1.5" onClick={() => setCreating(true)}><Icon name="plus" />New profile</Button>
      {creating && <Suspense fallback={<span role="status">Loading profile editor…</span>}><ProfileDialog instances={instances} onClose={close} onCreate={onCreate} /></Suspense>}
    </nav>
  );
}
