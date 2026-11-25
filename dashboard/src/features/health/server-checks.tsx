import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";
import { QueryContent } from "@/shared/ui/query-content";
import { toneDot } from "@/shared/ui/status-badge";

import { healthDetailsQuery } from "./queries";

export function ServerChecks() {
  const health = useQuery(healthDetailsQuery());
  return (
    <Card heading="Server checks">
      <QueryContent query={health} label="server checks">
        {(data) => {
          const checks = (data.health?.checks ?? []).filter(
            (check) => !check.name.startsWith("instance:"),
          );
          const metrics = data.metrics;
          return (
            <>
              {checks.length ? (
                <ul className="flex flex-col [&_li]:grid [&_li]:grid-cols-[auto_max-content_minmax(0,1fr)] [&_li]:items-center [&_li]:gap-2.5 [&_li]:border-b [&_li]:border-edge [&_li]:py-[9px] [&_li]:text-[13px] [&_li:last-child]:border-b-0">
                  {checks.map((c) => (
                    <li key={c.name}>
                      <span
                        className={`inline-block size-2 shrink-0 rounded-full ${toneDot(c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad")}`}
                      />
                      <strong>{c.name}</strong>
                      <span className="text-subtle text-xs">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-subtle">No server checks were reported.</p>
              )}
              {metrics && (
                <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4.5 gap-y-2 text-[13px] [&_dt]:text-subtle [&_dd]:wrap-anywhere">
                  <dt>Automatic restarts</dt>
                  <dd>{metrics.workerRestarts}</dd>
                  <dt>Tasks succeeded</dt>
                  <dd>{metrics.taskSuccesses}</dd>
                  <dt>Tasks failed</dt>
                  <dd>{metrics.taskFailures}</dd>
                  <dt>Live connections opened</dt>
                  <dd>{metrics.sseConnections}</dd>
                </dl>
              )}
            </>
          );
        }}
      </QueryContent>
    </Card>
  );
}
