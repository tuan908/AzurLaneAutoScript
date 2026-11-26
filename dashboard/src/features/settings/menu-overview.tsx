import { useQuery } from "@tanstack/react-query";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";

import type { ConfigField, ConfigSchema, ConfigTask, ConfigValue } from "@/api/client";
import { useNow } from "@/shared/use-now";

import { tasksQuery } from "../scheduler/queries";
import { splitHelp } from "./help";
import { parseNextRun, relativeTime, schedulerOf } from "./task-state";

type Menu = ConfigSchema["menus"][number];

// Plain-language summaries of the ALAS menus, keyed by menu id.
const MENU_ABOUT: Record<string, string> = {
  Alas: "Emulator connection, game client and how Alas behaves.",
  Farm: "Repeat campaign stages to farm resources and experience.",
  Event: "Play the current event's stages and spend its points.",
  EventDaily: "Daily event stages, raids and coalitions.",
  Reward: "Collect commissions, research, dorm, guild and other rewards.",
  DailyMission: "Daily missions, hard stages, exercises, shops and the shipyard.",
  Opsi: "Operation Siren: daily missions, exploration and bosses.",
  Island: "Island production, orders, deliveries and the restaurant.",
};

export function menuAbout(menu: Menu) {
  return MENU_ABOUT[menu.id] ?? "";
}

export function MenuOverview({
  instanceId,
  menu,
  valueOf,
  edited,
  disabled,
  onChange,
  onTask,
}: {
  instanceId: string;
  menu: Menu;
  valueOf: (field: ConfigField) => ConfigValue;
  edited: (field: ConfigField) => boolean;
  disabled: boolean;
  onChange: (field: ConfigField, value: ConfigValue) => void;
  onTask: (taskId: string) => void;
}) {
  const now = useNow(30_000);
  const queue = useQuery(tasksQuery(instanceId));
  return (
    <ul className="m-0 list-none overflow-hidden rounded-alas border border-edge bg-panel p-0 shadow-alas">
      {menu.tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          now={now}
          running={queue.data?.running.some((t) => t.command === task.id) ?? false}
          valueOf={valueOf}
          edited={edited}
          disabled={disabled}
          onChange={onChange}
          onOpen={() => onTask(task.id)}
        />
      ))}
    </ul>
  );
}

function TaskRow({
  task,
  now,
  running,
  valueOf,
  edited,
  disabled,
  onChange,
  onOpen,
}: {
  task: ConfigTask;
  now: number;
  running: boolean;
  valueOf: (field: ConfigField) => ConfigValue;
  edited: (field: ConfigField) => boolean;
  disabled: boolean;
  onChange: (field: ConfigField, value: ConfigValue) => void;
  onOpen: () => void;
}) {
  const scheduler = schedulerOf(task);
  const enabled = scheduler ? valueOf(scheduler.enable) === true : null;
  const next = scheduler?.nextRun ? parseNextRun(valueOf(scheduler.nextRun)) : null;
  const [summary] = splitHelp(task.help);
  let status = "Settings only, no schedule";
  if (running) status = "Running now";
  else if (enabled === false) status = "Off";
  else if (enabled && next !== null)
    status = next <= now ? "Runs as soon as possible" : `Next run ${relativeTime(next, now)}`;
  else if (enabled) status = "On";
  const changed = scheduler ? edited(scheduler.enable) : false;
  return (
    <li
      className={`flex items-center gap-3 border-t border-edge first:border-t-0 ${changed ? "bg-warn-soft/60" : ""}`}
    >
      <SdkButton
        className="flex! h-auto! min-w-0 flex-1 items-center gap-3 rounded-none! border-0! bg-transparent! py-3 pl-4.5 text-left whitespace-normal! hover:bg-fill!"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-ink">{task.name}</span>
          {summary && <span className="text-xs text-subtle">{summary}</span>}
          <span
            className={`text-xs ${running ? "text-ok" : enabled ? "text-secondary" : "text-subtle"}`}
          >
            {status}
          </span>
        </span>
        <span aria-hidden="true" className="text-lg text-subtle">
          ›
        </span>
      </SdkButton>
      {scheduler && (
        <span className="pr-4.5">
          <Switch
            aria-label={`Run ${task.name}`}
            disabled={disabled}
            checked={enabled === true}
            onCheckedChange={(v) => onChange(scheduler.enable, v)}
          >
            <SwitchThumb />
          </Switch>
        </span>
      )}
    </li>
  );
}
