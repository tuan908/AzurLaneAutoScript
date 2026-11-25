import { useQuery } from "@tanstack/react-query";
import { useNow } from "../../shared/use-now";
import { Metric } from "../../shared/ui/metric";
import { useWorkspaceStatus } from "../instances/workspace";
import { recoveryQuery } from "./queries";
import { RecoveryControls } from "./recovery-controls";
import { RecoveryHistory } from "./recovery-history";
import { ServerChecks } from "./server-checks";

export const HEALTH_LABEL: Record<string, string> = {
  ok: "healthy",
  idle: "idle",
  stopped: "stopped",
  stalled: "stalled",
  crashed: "crashed",
  human_takeover: "needs you",
  unmanaged: "unmanaged",
};

function untilText(iso: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function RecoveryCountdown({ at }: { at: string }) {
  return untilText(at, useNow());
}

export function HealthPanel() {
  const status = useWorkspaceStatus();
  const recovery = useQuery(recoveryQuery());
  const h = status.health;
  const rec = h?.recovery;
  const global = recovery.data?.policy;

  return (
    <>
      <dl className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] max-[600px]:grid-cols-2">
        <Metric label="Health">{h ? HEALTH_LABEL[h.state] ?? h.state : "—"}</Metric>
        <Metric label="Restarts last hour">{rec ? rec.restartsLastHour : "—"}{global ? <small> / {global.maxRestartsPerHour}</small> : null}</Metric>
        <Metric label="Next recovery">{rec?.gaveUp ? <span className="text-bad">Gave up</span>
          : rec?.nextAttemptAt ? <><RecoveryCountdown at={rec.nextAttemptAt} /> <small>{rec.pendingReason}</small></> : rec ? "None" : "—"}</Metric>
      </dl>
      {h?.detail && <p className="text-subtle text-xs">{h.detail}</p>}

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]">
        <RecoveryControls status={status} />
        <ServerChecks />
      </div>

      <RecoveryHistory instanceId={status.id} />
    </>
  );
}
