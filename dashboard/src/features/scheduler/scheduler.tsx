import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Card } from "@/shared/ui/card";
import { QueryContent } from "@/shared/ui/query-content";
import { StatusBadge } from "@/shared/ui/status-badge";

import { useWorkspaceStatus } from "../instances/workspace";
import { useLogs } from "../logs/log-store";
import { recentCompletions } from "./completions";
import { tasksQuery } from "./queries";
import { QueueList } from "./queue-list";
export function Scheduler() {
  const status = useWorkspaceStatus();
  const tasks = useQuery(tasksQuery(status.id));
  const lines = useLogs(status.id);
  const history = useMemo(() => recentCompletions(lines), [lines]);
  return (
    <>
      <QueryContent query={tasks} label="task queue">
        {(data) => (
          <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))]">
            <Card heading="Running">
              <QueueList items={[]} runningNow={data.running} empty="Nothing is running." />
            </Card>
            <Card heading="Pending" description="due, in priority order">
              <QueueList items={data.pending} empty="No pending tasks." />
            </Card>
            <Card heading="Waiting" description="by next run">
              <QueueList items={data.waiting} empty="No waiting tasks." />
            </Card>
          </div>
        )}
      </QueryContent>
      <Card heading="Recent task completions" description="from the live log">
        {history.length ? (
          <ol className="m-0 flex list-none flex-col p-0">
            {history.map((c) => (
              <li
                key={c.seq}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-0.5 py-2 last:border-b-0"
              >
                <span className="font-code text-xs text-subtle">{c.time ?? "—"}</span>
                <span className="truncate font-medium">{c.task}</span>
                {c.result && (
                  <StatusBadge tone={c.result === "success" ? "ok" : "bad"}>{c.result}</StatusBadge>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="py-4.5 text-center text-[13px] text-subtle">
            No completed tasks in the live log.
          </div>
        )}
      </Card>
    </>
  );
}
