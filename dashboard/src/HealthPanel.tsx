import { useWorkspaceStatus } from "./features/workspace";
import { QueryContent } from "./components/query-content";
import { Banner, Card, Metric, toneDot } from "./components/ui";
import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { queries } from "./queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNow } from "./hooks";
import { api, type InstancePolicy } from "./api";

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

const actionTone = (action: string) =>
    action === "restarted" ? "ok" : action === "scheduled" ? "warn" : action === "gave_up" || action === "restart_failed" ? "bad" : "idle";

export function HealthPanel() {
  const status = useWorkspaceStatus();
  const qc = useQueryClient();
  const health = useQuery(queries.healthDetails());
  const recovery = useQuery(queries.recovery());
  const [stallDraft, setStallDraft] = useState<string | null>(null);

  const h = status.health;
  const rec = h?.recovery;
  const policy = rec?.policy;
  const stallMinutes = stallDraft ?? String(policy?.stallMinutes ?? "");

  const update = useMutation({
    mutationFn: (changes: Partial<InstancePolicy>) => api.updatePolicy({ instances: { [status.id]: changes } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recovery"] });
      void qc.invalidateQueries({ queryKey: ["instances"] });
    },
  });
  const updateGlobal = useMutation({
    mutationFn: api.updatePolicy,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["recovery"] }),
  });

  const global = recovery.data?.policy;

  return (
    <>
      <dl className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 max-[600px]:grid-cols-2">
        <Metric label="Health">{h ? HEALTH_LABEL[h.state] ?? h.state : "—"}</Metric>
        <Metric label="Restarts last hour">{rec ? rec.restartsLastHour : "—"}{global ? <small> / {global.maxRestartsPerHour}</small> : null}</Metric>
        <Metric label="Next recovery">{rec?.gaveUp ? <span className="text-bad">Gave up</span>
            : rec?.nextAttemptAt ? <><RecoveryCountdown at={rec.nextAttemptAt} /> <small>{rec.pendingReason}</small></> : rec ? "None" : "—"}</Metric>
      </dl>
      {h?.detail && <p className="text-subtle text-xs">{h.detail}</p>}

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]">
        <Card heading={<>Recovery for {status.id}</>}>
          {policy ? <>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge py-3 last-of-type:border-b-0 [&_label]:flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[13px] [&_label]:font-semibold [&_label_span]:text-xs [&_label_span]:font-normal [&_label_span]:text-subtle [&_input[type=number]]:w-22.5">
              <label htmlFor="r-auto">
                Restart when the worker crashes
                <span>Never after a deliberate stop, a normal finish, an update or a human-takeover request</span>
              </label>
              <Switch id="r-auto" aria-label="Restart when the worker crashes" checked={policy.autoRestart} disabled={update.isPending} onCheckedChange={(next, details) => { details.cancel(); update.mutate({ autoRestart: next }); }}><SwitchThumb /></Switch>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge py-3 last-of-type:border-b-0 [&_label]:flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[13px] [&_label]:font-semibold [&_label_span]:text-xs [&_label_span]:font-normal [&_label_span]:text-subtle [&_input[type=number]]:w-22.5">
              <label htmlFor="r-stall">
                Restart when a task stalls
                <span>A task is running but nothing was logged for the stall time</span>
              </label>
              <Switch id="r-stall" aria-label="Restart when a task stalls" checked={policy.restartOnStall} disabled={update.isPending} onCheckedChange={(next, details) => { details.cancel(); update.mutate({ restartOnStall: next }); }}><SwitchThumb /></Switch>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge py-3 last-of-type:border-b-0 [&_label]:flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[13px] [&_label]:font-semibold [&_label_span]:text-xs [&_label_span]:font-normal [&_label_span]:text-subtle [&_input[type=number]]:w-22.5">
              <label htmlFor="r-stall-min">
                Stall time (minutes)
                <span>0 turns stall detection off</span>
              </label>
              <Input id="r-stall-min" type="number" min={0} max={1440} value={stallMinutes} disabled={update.isPending}
                onValueChange={setStallDraft}
                onBlur={() => {
                  const n = Number(stallMinutes);
                  if (stallMinutes.trim() && Number.isInteger(n) && n >= 0 && n <= 1440 && n !== policy.stallMinutes) update.mutate({ stallMinutes: n });
                  setStallDraft(null);
                }} />
            </div>
          </> : <p role="status" className="text-sm text-subtle">Waiting for instance health data…</p>}
          {global && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge py-3 last-of-type:border-b-0 [&_label]:flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[13px] [&_label]:font-semibold [&_label_span]:text-xs [&_label_span]:font-normal [&_label_span]:text-subtle [&_input[type=number]]:w-22.5">
              <label htmlFor="r-max">
                Restarts per hour, all instances
                <span>Waits {global.backoffSeconds.join("s, ")}s between attempts, then gives up</span>
              </label>
              <Input id="r-max" type="number" min={0} max={60} key={global.maxRestartsPerHour} defaultValue={String(global.maxRestartsPerHour)} disabled={updateGlobal.isPending || recovery.isError}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (e.target.value.trim() && Number.isInteger(n) && n >= 0 && n <= 60 && n !== global.maxRestartsPerHour) updateGlobal.mutate({ maxRestartsPerHour: n });
                }} />
            </div>
          )}
          {(update.error || updateGlobal.error) && (
            <Banner tone="bad">{(update.error ?? updateGlobal.error)?.message}</Banner>
          )}
        </Card>

        <Card heading="Server checks">
          <QueryContent query={health} label="server checks">{(data) => {
            const checks = (data.health?.checks ?? []).filter((check) => !check.name.startsWith("instance:"));
            const metrics = data.metrics;
            return (
              <>
                {checks.length ? <ul className="flex flex-col [&_li]:grid [&_li]:grid-cols-[auto_max-content_minmax(0,1fr)] [&_li]:items-center [&_li]:gap-2.5 [&_li]:border-b [&_li]:border-edge [&_li]:py-[9px] [&_li]:text-[13px] [&_li:last-child]:border-b-0">
                  {checks.map((c) => (
                    <li key={c.name}>
                      <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad")}`} />
                      <strong>{c.name}</strong>
                      <span className="text-subtle text-xs">{c.detail}</span>
                    </li>
                  ))}
                </ul> : <p className="text-sm text-subtle">No server checks were reported.</p>}
                {metrics && (
                  <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4.5 gap-y-2 text-[13px] [&_dt]:text-subtle [&_dd]:wrap-anywhere" >
                    <dt>Automatic restarts</dt><dd>{metrics.workerRestarts}</dd>
                    <dt>Tasks succeeded</dt><dd>{metrics.taskSuccesses}</dd>
                    <dt>Tasks failed</dt><dd>{metrics.taskFailures}</dd>
                    <dt>Live connections opened</dt><dd>{metrics.sseConnections}</dd>
                  </dl>
                )}
              </>
            );
          }}</QueryContent>
        </Card>
      </div>

      <Card heading="Recovery history" description="newest first, kept until the server restarts">
        <QueryContent query={recovery} label="recovery history">{(data) => {
          const history = data.history.filter((entry) => entry.instanceId === status.id);
          return history.length === 0 ? (
            <div className="py-4.5 text-center text-[13px] text-subtle">No recovery actions for this instance.</div>
          ) : (
            <ol className="flex flex-col [&_li]:relative [&_li]:grid [&_li]:grid-cols-[16px_minmax(0,1fr)] [&_li]:gap-2.5 [&_li]:pb-3.5 [&_li]:before:absolute [&_li]:before:top-3.5 [&_li]:before:bottom-0 [&_li]:before:left-[7px] [&_li]:before:w-0.5 [&_li]:before:bg-edge [&_li:last-child]:before:hidden">
              {history.map((e, i) => (
                <li key={i}>
                  <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(actionTone(e.action))}`} />
                  <div>
                    <div className="text-[13px] font-semibold">{e.action.replace("_", " ")} <span className="text-subtle">· {e.reason}</span></div>
                    <div className="text-right text-xs tabular-nums text-subtle">{new Date(e.time).toLocaleString()}{e.detail ? ` — ${e.detail}` : ""}</div>
                  </div>
                </li>
              ))}
            </ol>
          );
        }}</QueryContent>
      </Card>
    </>
  );
}

function RecoveryCountdown({ at }: { at: string }) {
  return untilText(at, useNow());
}
