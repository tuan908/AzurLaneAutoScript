import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";
import { QueryContent } from "@/shared/ui/query-content";
import { toneDot } from "@/shared/ui/status-badge";

import { recoveryQuery } from "./queries";

const actionTone = (action: string) => {
  if (action === "restarted") {
    return "ok";
  } else if (action === "scheduled") {
    return "warn";
  } else if (action === "gave_up" || action === "restart_failed") {
    return "bad";
  } else {
    return "idle";
  }
};

export function RecoveryHistory({ instanceId }: { instanceId: string }) {
  const recovery = useQuery(recoveryQuery());
  return (
    <Card
      heading="Recovery history"
      description="newest first, kept until the server restarts"
      className="min-[861px]:flex-1"
    >
      <QueryContent query={recovery} label="recovery history">
        {(data) => {
          const history = data.history.filter((entry) => entry.instanceId === instanceId);
          return history.length === 0 ? (
            <div className="py-4.5 text-center text-[13px] text-subtle">
              No recovery actions for this instance.
            </div>
          ) : (
            <ol className="flex flex-col [&_li]:relative [&_li]:grid [&_li]:grid-cols-[16px_minmax(0,1fr)] [&_li]:gap-2.5 [&_li]:pb-3.5 [&_li]:before:absolute [&_li]:before:top-3.5 [&_li]:before:bottom-0 [&_li]:before:left-1.75 [&_li]:before:w-0.5 [&_li]:before:bg-edge [&_li:last-child]:before:hidden">
              {history.map((e) => (
                <li key={`${e.time}|${e.action}|${e.reason}`}>
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${toneDot(actionTone(e.action))}`}
                  />
                  <div>
                    <div className="text-[13px] font-semibold">
                      {e.action.replace("_", " ")} <span className="text-subtle">· {e.reason}</span>
                    </div>
                    <div className="text-right text-xs tabular-nums text-subtle">
                      {new Date(e.time).toLocaleString()}
                      {e.detail ? ` — ${e.detail}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          );
        }}
      </QueryContent>
    </Card>
  );
}
