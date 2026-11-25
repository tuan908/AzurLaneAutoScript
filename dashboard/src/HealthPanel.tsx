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

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>Instance health</h3>
          <HealthBadge status={status} />
        </div>
        {h ? (
          <dl className="stats">
            <div>
              <dt>State</dt>
              <dd>{HEALTH_LABEL[h.state] ?? h.state}</dd>
            </div>
            <div>
              <dt>Detail</dt>
              <dd>{h.detail || "—"}</dd>
            </div>
            <div>
              <dt>Restarts last hour</dt>
              <dd>
                {rec!.restartsLastHour}
                {global ? ` / ${global.maxRestartsPerHour}` : ""}
              </dd>
            </div>
            <div>
              <dt>Recovery</dt>
              <dd>
                {rec!.gaveUp
                  ? "gave up — start it manually"
                  : rec!.nextAttemptAt
                    ? `restart (${rec!.pendingReason}) in ${untilText(rec!.nextAttemptAt)}`
                    : "nothing pending"}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="muted">The health monitor has not checked this instance yet.</div>
        )}
        {h?.state === "human_takeover" && (
          <p className="error small">
            Alas stopped and asked for a person (for example a task failed 3 times, or the emulator is not
            reachable). It is never restarted automatically — check the log, fix the cause, then start it.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Recovery for {status.id}</h3>
        <div className="field">
          <label htmlFor="r-auto">
            Restart when the worker crashes
            <span className="muted small">Not after a deliberate stop, a normal finish, an update or a human-takeover request</span>
          </label>
          <div className="field-control">
            <input
              id="r-auto"
              type="checkbox"
              checked={policy.autoRestart}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ autoRestart: e.target.checked })}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="r-stall">
            Restart when a task stalls
            <span className="muted small">A task is running but nothing was logged for the stall time</span>
          </label>
          <div className="field-control">
            <input
              id="r-stall"
              type="checkbox"
              checked={policy.restartOnStall}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ restartOnStall: e.target.checked })}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="r-stall-min">
            Stall time (minutes)
            <span className="muted small">0 turns stall detection off</span>
          </label>
          <div className="field-control">
            <input
              id="r-stall-min"
              type="number"
              min={0}
              max={1440}
              value={stallMinutes}
              onChange={(e) => setStallMinutes(e.target.value)}
              onBlur={() => {
                const n = Number(stallMinutes);
                if (Number.isInteger(n) && n !== policy.stallMinutes) update.mutate({ stallMinutes: n });
              }}
            />
          </div>
        </div>
        {update.error && <div className="error small">{(update.error as Error).message}</div>}
        {global && (
          <p className="muted small">
            All instances: at most{" "}
            <input
              className="inline-number"
              type="number"
              min={0}
              max={60}
              defaultValue={global.maxRestartsPerHour}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n !== global.maxRestartsPerHour) updateGlobal.mutate({ maxRestartsPerHour: n });
              }}
            />{" "}
            restarts per hour, waiting {global.backoffSeconds.join("s, ")}s between attempts.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Server checks</h3>
        {metrics && <dl className="stats">
          <div><dt>Tasks succeeded</dt><dd>{metrics.taskSuccesses}</dd></div>
          <div><dt>Tasks failed</dt><dd>{metrics.taskFailures}</dd></div>
          <div><dt>Automatic restarts</dt><dd>{metrics.workerRestarts}</dd></div>
          <div><dt>Live connections opened</dt><dd>{metrics.sseConnections}</dd></div>
        </dl>}
        <ul className="checks">
          {serverChecks.map((c) => (
            <li key={c.name}>
              <span className={`dot dot-${c.status}`} />
              <strong>{c.name}</strong>
              <span className="muted small">{c.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Recovery history</h3>
        {history.length === 0 ? (
          <div className="muted small">No recovery actions for this instance.</div>
        ) : (
          <table className="history">
            <tbody>
              {history.map((e, i) => (
                <tr key={i}>
                  <td className="muted small">{new Date(e.time).toLocaleString()}</td>
                  <td>{e.action}</td>
                  <td>{e.reason}</td>
                  <td className="muted small">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
