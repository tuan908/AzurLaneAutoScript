import { Card } from "../components/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useWorkspaceStatus } from "./workspace";
import { useLogs } from "../logStore";
import { queries } from "../queries";
import { QueueList } from "./queue";
import { QueryContent } from "../components/query-content";
export function Scheduler() {
  const status = useWorkspaceStatus();
  const tasks = useQuery(queries.tasks(status.id));
  const lines = useLogs(status.id);
  const history = useMemo(() => lines.filter((line) => line.text.includes("Scheduler: End task")).slice(-30).reverse(), [lines]);
  return (
    <>
      <QueryContent query={tasks} label="task queue">{(data) => (
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
      )}</QueryContent>
      <Card heading="Recent task completions" description="from the live log">
        {history.length ? (
          <div className="flex flex-col">
            {history.map((line) => <div key={line.seq} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-0.5 py-[9px] last:border-b-0"><span className="font-code text-xs">{line.text}</span></div>)}
          </div>
        ) : <div className="py-4.5 text-center text-[13px] text-subtle">No completed tasks in the live log.</div>}
      </Card>
    </>
  );
}
