import { Button, Card, Metric } from "../../shared/ui/ui";
import type { InstanceStatus } from "../../api/client";
import { useQuery } from "@tanstack/react-query";
import { QueryContent } from "../../shared/ui/query-content";
import { useDashboardRoute } from "../../app/navigation";
import { useNow } from "../../shared/hooks";
import { queries } from "../../api/queries";
import { healthTone, since } from "../instances/status";
import { QueueList } from "../scheduler/queue-list";
import { LogPeek } from "../logs/log-preview";
import { useWorkspaceStatus } from "../instances/workspace";

export function Overview() {
  const status = useWorkspaceStatus();
  const { go } = useDashboardRoute();
  const tasks = useQuery(queries.tasks(status.id));
  const health = status.health;
  const policy = health?.recovery.policy;
  return (
    <>
      <OverviewMetrics status={status} />

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]">
        <Card heading="Up next" action={
          <Button variant="ghost" size="small" onClick={() => go(status.id, "scheduler")}>Full schedule</Button>
        }>
          <QueryContent query={tasks} label="task queue">{(data) => (
            <QueueList items={[...data.pending, ...data.waiting].slice(0, 7)} runningNow={data.running} empty="No tasks are scheduled." />
          )}</QueryContent>
        </Card>
        <LogPeek id={status.id} onOpen={() => go(status.id, "logs")} />
      </div>

      <Card heading="Process" action={
        <Button variant="ghost" size="small" onClick={() => go(status.id, "health")}>Health and recovery</Button>
      }>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4.5 gap-y-2 text-[13px] [&_dt]:text-subtle [&_dd]:wrap-anywhere">
          <dt>Health</dt><dd>{health ? `${healthTone(status).label}${health.detail ? ` — ${health.detail}` : ""}` : "Not checked yet"}</dd>
          <dt>Recovery</dt>
          <dd>{policy ? [policy.autoRestart && "restart on crash", policy.restartOnStall && `restart after ${policy.stallMinutes} min stall`]
            .filter(Boolean).join(", ") || "off" : "—"}</dd>
          <dt>Process ID</dt><dd className="font-code">{status.processId ?? "—"}</dd>
          <dt>Started</dt><dd>{status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"}</dd>
          <dt>Stopped</dt><dd>{status.stoppedAt ? new Date(status.stoppedAt).toLocaleString() : "—"}</dd>
          <dt>Exit code</dt><dd className="font-code">{status.exitCode ?? "—"}</dd>
        </dl>
      </Card>
    </>
  );
}

function OverviewMetrics({ status }: { status: InstanceStatus }) {
  const alive = status.state === "running" || status.state === "starting";
  const now = useNow((alive && status.startedAt) || status.lastActivityAt ? 1000 : null);
  return (
    <dl className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 max-[600px]:grid-cols-2">
      <Metric label="Current task">{status.currentTask ?? (alive ? "Waiting" : "—")}</Metric>
      <Metric label="Uptime">{alive ? since(status.startedAt, now) : "—"}</Metric>
      <Metric label="Last activity">{status.lastActivityAt ? <>{since(status.lastActivityAt, now)} <small>ago</small></> : "—"}</Metric>
      <Metric label="Tasks this run">{status.taskSuccesses ?? 0} <small>done</small>{status.taskFailures ? <> · <span className="text-bad">{status.taskFailures}</span> <small>failed</small></> : null}</Metric>
    </dl>
  );
}
