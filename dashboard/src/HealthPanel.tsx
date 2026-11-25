import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type InstancePolicy, type InstanceStatus } from "./api";

export const HEALTH_LABEL: Record<string, string> = {
  ok: "healthy",
  idle: "idle",
  stopped: "stopped",
  stalled: "stalled",
  crashed: "crashed",
  human_takeover: "needs you",
  unmanaged: "unmanaged",
};

export function HealthBadge({ status }: { status: InstanceStatus }) {
  const h = status.health;
  if (!h || h.state === "ok" || h.state === "idle" || h.state === "stopped") {
    return h?.recovery.gaveUp ? <span className="badge badge-failed">gave up</span> : null;
  }
  const cls = h.state === "stalled" ? "badge-starting" : "badge-failed";
  return <span className={`badge ${cls}`}>{HEALTH_LABEL[h.state] ?? h.state}</span>;
}

function untilText(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function HealthPanel({ status }: { status: InstanceStatus }) {
  const qc = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const health = useQuery({ queryKey: ["health/details"], queryFn: api.healthDetails, refetchInterval: 10000 });
  const recovery = useQuery({ queryKey: ["recovery"], queryFn: api.recovery, refetchInterval: 10000 });
  const [stallMinutes, setStallMinutes] = useState<string>("");

  const policy: InstancePolicy = status.health?.recovery.policy ?? {
    autoRestart: false,
    restartOnStall: false,
    stallMinutes: 30,
  };
  useEffect(() => setStallMinutes(String(policy.stallMinutes)), [policy.stallMinutes]);

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

  const h = status.health;
  const rec = h?.recovery;
  const global = recovery.data?.policy;
  const history = (recovery.data?.history ?? []).filter((e) => e.instanceId === status.id);
  const serverChecks = (health.data?.health?.checks ?? []).filter((c) => !c.name.startsWith("instance:"));
  const metrics = health.data?.metrics;

  const actionTone = (action: string) =>
    action === "restarted" ? "ok" : action === "scheduled" ? "warn" : action === "gave_up" || action === "restart_failed" ? "bad" : "idle";

  return (
    <>
      <dl className="metrics">
        <div className="metric"><dt>Health</dt><dd>{h ? HEALTH_LABEL[h.state] ?? h.state : "—"}</dd></div>
        <div className="metric">
          <dt>Restarts last hour</dt>
          <dd>{rec ? rec.restartsLastHour : "—"}{global ? <small> / {global.maxRestartsPerHour}</small> : null}</dd>
        </div>
        <div className="metric">
          <dt>Next recovery</dt>
          <dd>{rec?.gaveUp ? <span className="text-bad">Gave up</span>
            : rec?.nextAttemptAt ? <>{untilText(rec.nextAttemptAt)} <small>{rec.pendingReason}</small></> : "None"}</dd>
        </div>
        {metrics && <div className="metric"><dt>Automatic restarts</dt><dd>{metrics.workerRestarts}<small> since server start</small></dd></div>}
      </dl>
      {h?.detail && <p className="muted small">{h.detail}</p>}

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h3>Recovery for {status.id}</h3></div>
          <div className="option-row">
            <label htmlFor="r-auto">
              Restart when the worker crashes
              <span>Never after a deliberate stop, a normal finish, an update or a human-takeover request</span>
            </label>
            <span className="switch">
              <input id="r-auto" type="checkbox" checked={policy.autoRestart} disabled={update.isPending}
                onChange={(e) => update.mutate({ autoRestart: e.target.checked })} />
              <span className="track" aria-hidden="true" />
            </span>
          </div>
          <div className="option-row">
            <label htmlFor="r-stall">
              Restart when a task stalls
              <span>A task is running but nothing was logged for the stall time</span>
            </label>
            <span className="switch">
              <input id="r-stall" type="checkbox" checked={policy.restartOnStall} disabled={update.isPending}
                onChange={(e) => update.mutate({ restartOnStall: e.target.checked })} />
              <span className="track" aria-hidden="true" />
            </span>
          </div>
          <div className="option-row">
            <label htmlFor="r-stall-min">
              Stall time (minutes)
              <span>0 turns stall detection off</span>
            </label>
            <input id="r-stall-min" type="number" min={0} max={1440} value={stallMinutes}
              onChange={(e) => setStallMinutes(e.target.value)}
              onBlur={() => {
                const n = Number(stallMinutes);
                if (Number.isInteger(n) && n !== policy.stallMinutes) update.mutate({ stallMinutes: n });
              }} />
          </div>
          {global && (
            <div className="option-row">
              <label htmlFor="r-max">
                Restarts per hour, all instances
                <span>Waits {global.backoffSeconds.join("s, ")}s between attempts, then gives up</span>
              </label>
              <input id="r-max" type="number" min={0} max={60} defaultValue={global.maxRestartsPerHour}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n !== global.maxRestartsPerHour) updateGlobal.mutate({ maxRestartsPerHour: n });
                }} />
            </div>
          )}
          {(update.error || updateGlobal.error) && (
            <p className="text-bad small">{((update.error || updateGlobal.error) as Error).message}</p>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h3>Server checks</h3></div>
          <ul className="check-list">
            {serverChecks.map((c) => (
              <li key={c.name}>
                <span className={`dot tone-${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad"}`} />
                <strong>{c.name}</strong>
                <span className="muted small">{c.detail}</span>
              </li>
            ))}
          </ul>
          {metrics && (
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Tasks succeeded</dt><dd>{metrics.taskSuccesses}</dd>
              <dt>Tasks failed</dt><dd>{metrics.taskFailures}</dd>
              <dt>Live connections opened</dt><dd>{metrics.sseConnections}</dd>
            </dl>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h3>Recovery history</h3><span className="muted small">newest first, kept until the server restarts</span></div>
        {history.length === 0 ? (
          <div className="empty">No recovery actions for this instance.</div>
        ) : (
          <ol className="timeline">
            {history.map((e, i) => (
              <li key={i}>
                <span className={`dot tone-${actionTone(e.action)}`} />
                <div>
                  <div className="what">{e.action.replace("_", " ")} <span className="muted">· {e.reason}</span></div>
                  <div className="when">{new Date(e.time).toLocaleString()}{e.detail ? ` — ${e.detail}` : ""}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
