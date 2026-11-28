import { useQuery } from "@tanstack/react-query";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";

import type { ConfigField, ConfigTask, ConfigValue } from "@/api/client";
import { formatAlasTime, relativeTime } from "@/shared/time";
import { Button } from "@/shared/ui/button";
import { Icon } from "@/shared/ui/icon";
import { StatusBadge } from "@/shared/ui/status-badge";
import { useNow } from "@/shared/use-now";

import { tasksQuery } from "../scheduler/queries";
import { parseNextRun, schedulerOf } from "./task-state";

export function TaskHeader({
  instanceId,
  task,
  valueOf,
  edited,
  disabled,
  onChange,
}: {
  instanceId: string;
  task: ConfigTask;
  valueOf: (field: ConfigField) => ConfigValue;
  edited: (field: ConfigField) => boolean;
  disabled: boolean;
  onChange: (field: ConfigField, value: ConfigValue) => void;
}) {
  const now = useNow(30_000);
  const queue = useQuery(tasksQuery(instanceId));
  const scheduler = schedulerOf(task);
  if (!scheduler) return null;
  const { enable, nextRun } = scheduler;
  const enabled = valueOf(enable) === true;
  const next = nextRun ? parseNextRun(valueOf(nextRun)) : null;
  const running = queue.data?.running.some((t) => t.command === task.id);
  const pending = queue.data?.pending.some((t) => t.command === task.id);
  const changed = edited(enable) || (nextRun ? edited(nextRun) : false);

  let state: { tone: string; label: string };
  if (running) state = { tone: "ok", label: "Running now" };
  else if (!enabled) state = { tone: "idle", label: "Disabled" };
  else if (pending || (next !== null && next <= now)) state = { tone: "warn", label: "Due" };
  else state = { tone: "accent", label: "Scheduled" };

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-alas border border-edge bg-panel px-4.5 py-3 shadow-alas ${changed ? "shadow-[inset_3px_0_0_var(--warn)]" : ""}`}
      role="group"
      aria-label={`${task.name} schedule`}
    >
      <label htmlFor="task-enable" className="inline-flex items-center gap-2.5 font-semibold">
        <Switch
          id="task-enable"
          disabled={disabled}
          checked={enabled}
          onCheckedChange={(v) => onChange(enable, v)}
        >
          <SwitchThumb />
        </Switch>
        Run this task
      </label>
      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
      {nextRun && enabled && (
        <span className="text-[13px] text-subtle">
          {next === null ? (
            "Next run not set"
          ) : (
            <>
              Next run{" "}
              <time
                className="font-medium text-ink"
                dateTime={new Date(next).toISOString()}
                title={formatAlasTime(next)}
              >
                {next <= now ? "as soon as possible" : relativeTime(next, now)}
              </time>
            </>
          )}
        </span>
      )}
      {nextRun && (
        <Button
          size="small"
          className="ml-auto"
          disabled={disabled || running === true}
          title="Set the next run to now, then save"
          onClick={() => {
            if (!enabled) onChange(enable, true);
            onChange(nextRun, formatAlasTime(Date.now()));
          }}
        >
          <Icon name="play" />
          Run now
        </Button>
      )}
    </div>
  );
}
