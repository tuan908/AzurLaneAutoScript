import { Button as SdkButton } from "@ui-sdk/react/button";
import { lazy, Suspense, useRef, useState } from "react";

import type { InstanceStatus } from "@/api/client";
import { Button } from "@/shared/ui/button";
import { Icon } from "@/shared/ui/icon";
import { SectionLabel } from "@/shared/ui/section-label";
import { toneDot } from "@/shared/ui/status-badge";
import { useNow } from "@/shared/use-now";

import { healthTone, statusLine } from "./status";

const ProfileDialog = lazy(() => import("./profile-dialog"));

export function InstanceRail({
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
  const now = useNow(
    instances.some((instance) => instance.state === "stopped" && instance.stoppedAt)
      ? 15_000
      : null,
  );
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setCreating(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <nav
      className="flex min-h-0 gap-1.5 overflow-x-auto border-b border-edge bg-panel-2 px-3 py-3.5 min-[861px]:flex-col min-[861px]:overflow-y-auto min-[861px]:border-r min-[861px]:border-b-0"
      aria-label="Instances"
    >
      <div className="hidden items-center justify-between px-1 pb-1 min-[861px]:flex">
        <SectionLabel>Instances</SectionLabel>
        <span className="text-subtle text-xs">{instances.length}</span>
      </div>
      {instances.map((s) => {
        const tone = healthTone(s);
        const flag = s.health?.recovery.gaveUp
          ? "gave up"
          : s.health?.state === "human_takeover"
            ? "needs you"
            : s.health?.state === "stalled"
              ? "stalled"
              : s.unmanaged
                ? "external"
                : null;
        return (
          <SdkButton
            key={s.id}
            className="grid! h-auto! min-h-16 w-full min-w-50 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-alas! border border-transparent! bg-transparent! px-3 py-2.5 text-left transition-colors hover:bg-fill! aria-[current=true]:bg-panel! aria-[current=true]:shadow-raised min-[861px]:min-w-0"
            onClick={() => onSelect(s.id)}
            aria-current={s.id === selected ? "true" : undefined}
          >
            <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(tone.tone)}`} />
            <span className="min-w-0 truncate font-semibold">{s.id}</span>
            {flag ? (
              <span
                className={`text-[11px] font-semibold ${tone.tone === "bad" ? "text-bad" : "text-warn"}`}
              >
                {flag}
              </span>
            ) : (
              <span />
            )}
            <span className="col-start-2 col-end-[-1] truncate text-xs text-subtle">
              {statusLine(s, now)}
            </span>
          </SdkButton>
        );
      })}
      <Button
        ref={trigger}
        className="min-w-32.5 text-secondary! min-[861px]:mt-1.5"
        onClick={() => setCreating(true)}
      >
        <Icon name="plus" />
        New profile
      </Button>
      {creating && (
        <Suspense fallback={<span role="status">Loading profile editor…</span>}>
          <ProfileDialog instances={instances} onClose={close} onCreate={onCreate} />
        </Suspense>
      )}
    </nav>
  );
}
