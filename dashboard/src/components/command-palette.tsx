import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent, DialogShortcut, DialogTitle, DialogTrigger } from "@ui-sdk/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { InstanceStatus } from "../api";
import type { Theme } from "../hooks";
import { readLang } from "../lang";
import { TAB_LABELS, TABS, useDashboardRoute, type Tab } from "../navigation";
import { queries, useInstances } from "../queries";
import { healthTone } from "../status";
import { useInstanceCommand } from "../use-instance-command";
import { toneDot } from "./ui";

const itemClass =
  "flex! h-auto! min-h-9 w-full items-center gap-2.5 rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left text-[13px] text-ink data-highlighted:bg-accent-soft! data-highlighted:text-accent!";
const groupLabelClass = "px-2.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-[.06em] uppercase text-subtle";

export function CommandPalette({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { instanceId, go } = useDashboardRoute();
  const navigate = useNavigate();
  const instances = useInstances().data ?? [];
  const current = instances.find((i) => i.id === instanceId);
  const schema = useQuery({ ...queries.configSchema(current?.id ?? "", readLang()), enabled: open && current !== undefined });
  const settingTasks = schema.data?.menus.flatMap((menu) => menu.tasks.map((task) => ({ menu: menu.name, task }))) ?? [];

  const openSettings = (search: { q: string; task: string }) => {
    if (!current) return;
    void navigate({ to: "/$instanceId/settings", params: { instanceId: current.id }, search });
  };

  const run = (value: string) => {
    const [kind, ...rest] = value.split(":");
    const arg = rest.join(":");
    if (kind === "go") go(arg);
    else if (kind === "tab" && current) go(current.id, arg as Tab);
    else if (kind === "task") openSettings({ q: "", task: arg });
    else if (kind === "search") openSettings({ q: query.trim(), task: "" });
    else if (kind === "theme") onTheme(arg as Theme);
    setOpen(false);
    setQuery("");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <DialogTrigger shortcut="mod+k" className="inline-flex! h-7! min-h-0! items-center gap-2 rounded-full! border! border-edge! bg-panel-2! px-2.5! text-[12.5px]! font-normal! text-subtle! hover:text-ink!">
        <svg className="size-3.5" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        Search…
        <DialogShortcut className="rounded border border-edge bg-panel px-1 font-code text-[11px]" />
      </DialogTrigger>
      <DialogBackdrop className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
      <DialogContent className="fixed! top-[12vh]! left-1/2! z-50 m-0! w-[min(600px,calc(100vw-24px))]! max-w-none! -translate-x-1/2 overflow-hidden rounded-xl! border! border-edge-strong! bg-panel! p-0! text-ink shadow-alas-lg">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command onAction={run} query={query} onQueryChange={setQuery} loop
          className="flex! w-full! max-w-none! flex-col rounded-none! border-0! bg-transparent! shadow-none!">
          <div className="flex items-center gap-2.5 border-b border-edge px-3.5">
            <svg className="size-4 shrink-0 text-subtle" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <CommandInput aria-label="Search commands" placeholder="Go to an instance, a view, or a setting…"
              className="h-12! min-h-0! w-full rounded-none! border-0! bg-transparent! px-0! text-[14px] shadow-none! outline-none! ring-0! focus:shadow-none! focus-visible:outline-none!" />
          </div>
          <CommandEmpty className="px-4 py-6 text-center text-[13px] text-subtle [&:not([data-empty])]:hidden">Nothing matches.</CommandEmpty>
          <CommandList className="max-h-[min(60vh,440px)] overflow-y-auto p-1.5">
            {current && query.trim() && (
              <CommandGroup>
                <CommandGroupLabel className={groupLabelClass}>Settings of {current.id}</CommandGroupLabel>
                <CommandItem value="search:settings" keywords={[query]} className={itemClass}>
                  <span>Search settings for “{query.trim()}”</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandGroupLabel className={groupLabelClass}>Instances</CommandGroupLabel>
              {instances.map((instance) => <InstanceItem key={instance.id} instance={instance} />)}
            </CommandGroup>
            {current && (
              <>
                <CommandSeparator className="my-1 border-t border-edge" />
                <CommandGroup>
                  <CommandGroupLabel className={groupLabelClass}>{current.id}</CommandGroupLabel>
                  {TABS.map((tab) => (
                    <CommandItem key={tab} value={`tab:${tab}`} keywords={[tab]} className={itemClass}>
                      Open {TAB_LABELS[tab]}
                    </CommandItem>
                  ))}
                  <InstanceActions status={current} />
                </CommandGroup>
              </>
            )}
            {settingTasks.length > 0 && (
              <>
                <CommandSeparator className="my-1 border-t border-edge" />
                <CommandGroup>
                  <CommandGroupLabel className={groupLabelClass}>Setting pages</CommandGroupLabel>
                  {settingTasks.map(({ menu, task }) => (
                    <CommandItem key={task.id} value={`task:${task.id}`} keywords={[task.id, menu, "settings"]} className={itemClass}>
                      <span className="min-w-0 flex-1 truncate">{task.name}</span>
                      <span className="text-[11px] text-subtle">{menu}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            <CommandSeparator className="my-1 border-t border-edge" />
            <CommandGroup>
              <CommandGroupLabel className={groupLabelClass}>Appearance</CommandGroupLabel>
              {(["system", "light", "dark"] as Theme[]).filter((t) => t !== theme).map((t) => (
                <CommandItem key={t} value={`theme:${t}`} keywords={["theme", "appearance"]} className={itemClass}>
                  {t === "system" ? "Use the system theme" : t === "light" ? "Switch to light theme" : "Switch to dark theme"}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function InstanceItem({ instance }: { instance: InstanceStatus }) {
  const tone = healthTone(instance);
  return (
    <CommandItem value={`go:${instance.id}`} keywords={["instance", "profile"]} className={itemClass}>
      <span className={`size-2 shrink-0 rounded-full ${toneDot(tone.tone)}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{instance.id}</span>
      <span className="text-[11px] text-subtle">{tone.label}</span>
    </CommandItem>
  );
}

function InstanceActions({ status }: { status: InstanceStatus }) {
  const command = useInstanceCommand(status.id);
  const busy = status.unmanaged || command.isPending || status.state === "starting" || status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";
  const actions = alive ? (["stop", "restart"] as const) : (["start", "restart"] as const);
  return (
    <>
      {actions.map((action) => (
        <CommandItem key={action} value={`cmd:${action}`} disabled={busy} keywords={["worker", "automation"]}
          data-agent-confirm={`${action[0]!.toUpperCase()}${action.slice(1)} this automation worker`}
          onSelect={() => command.mutate(action)}
          className={itemClass}>
          {action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"} {status.id}
        </CommandItem>
      ))}
    </>
  );
}
