import type { Task } from "../api";
import { untilNextRun } from "../status";
import { useNow } from "../hooks";
export function QueueList({ items, runningNow, empty }: { items: Task[]; runningNow?: Task[]; empty: string }) {
  const now = useNow(items.some((task) => task.nextRun) ? 1000 : null);
  if (!items.length && !runningNow?.length) return <div className="py-4.5 text-center text-[13px] text-subtle">{empty}</div>;
  return (
    <div className="flex flex-col">
      {runningNow?.map((t) => (
        <div key={`now-${t.command}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-0.5 py-[9px] last:border-b-0 -mx-2 rounded-alas-sm border-0 bg-accent-soft px-2 py-2.5">
          <strong>{t.command}</strong>
          <span className="text-right text-xs tabular-nums text-subtle">running now</span>
        </div>
      ))}
      {items.map((t) => (
        <div key={t.command} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-edge px-0.5 py-[9px] last:border-b-0">
          <span>{t.command}</span>
          <span className="text-right text-xs tabular-nums text-subtle" title={t.nextRun ?? undefined}>{t.nextRun ? untilNextRun(t.nextRun, now) : "not scheduled"}</span>
        </div>
      ))}
    </div>
  );
}
