import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@ui-sdk/react/accordion";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useState } from "react";

import type { ConfigSchema, ConfigTask } from "@/api/client";
import { SectionLabel } from "@/shared/ui/section-label";

export function SettingsNav({
  menus,
  currentTaskId,
  searching,
  enabledOf,
  outline,
  activeGroup,
  search,
  onSearch,
  changedOnly,
  onChangedOnly,
  showKeys,
  onShowKeys,
  onTask,
}: {
  menus: ConfigSchema["menus"];
  currentTaskId: string | undefined;
  searching: boolean;
  enabledOf: (task: ConfigTask) => boolean | null;
  outline: { id: string; name: string }[];
  activeGroup: string | null;
  search: string;
  onSearch: (next: string) => void;
  changedOnly: boolean;
  onChangedOnly: (next: boolean) => void;
  showKeys: boolean;
  onShowKeys: (next: boolean) => void;
  onTask: (taskId: string) => void;
}) {
  const currentMenu = menus.find((m) => m.tasks.some((t) => t.id === currentTaskId))?.id;
  const [openMenus, setOpenMenus] = useState<string[]>([]);
  const [revealedMenu, setRevealedMenu] = useState<string | undefined>();
  if (currentMenu !== revealedMenu) {
    setRevealedMenu(currentMenu);
    if (currentMenu && !openMenus.includes(currentMenu)) setOpenMenus([...openMenus, currentMenu]);
  }
  return (
    <aside
      className="flex max-h-75 flex-col gap-2.5 overflow-hidden rounded-alas border border-edge bg-panel p-3 shadow-alas min-[981px]:sticky min-[981px]:top-32.5 min-[981px]:max-h-[calc(100vh-150px)]"
      aria-label="Setting groups"
    >
      <Input
        aria-label="Search settings"
        placeholder="Search all settings…"
        value={search}
        onValueChange={onSearch}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] text-secondary [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5">
        <label htmlFor="settings-changed-only">
          <Switch id="settings-changed-only" checked={changedOnly} onCheckedChange={onChangedOnly}>
            <SwitchThumb />
          </Switch>
          Changed only
        </label>
        <label htmlFor="settings-show-keys">
          <Switch id="settings-show-keys" checked={showKeys} onCheckedChange={onShowKeys}>
            <SwitchThumb />
          </Switch>
          Show keys
        </label>
      </div>
      <Accordion
        multiple
        value={openMenus}
        onValueChange={(next) => setOpenMenus(next.map(String))}
        className="-mx-1 flex flex-col gap-0.5 overflow-y-auto border-t border-edge px-1 pt-2"
      >
        {menus.map((menu) => {
          const states = menu.tasks.map(enabledOf).filter((v) => v !== null);
          const on = states.filter(Boolean).length;
          return (
            <AccordionItem key={menu.id} value={menu.id}>
              <AccordionHeader className="m-0">
                <AccordionTrigger className="flex! h-auto! min-h-0! w-full items-center justify-between rounded-alas-sm! border-0! bg-transparent! px-2 py-1.5 text-left hover:bg-fill!">
                  <span className="min-w-0 truncate">
                    <SectionLabel>{menu.name}</SectionLabel>
                  </span>
                  {menu.tasks.some((t) => t.id === currentTaskId) && !searching && (
                    <span className="ml-2 size-1.5 rounded-full bg-accent" aria-hidden="true" />
                  )}
                  {states.length > 0 && (
                    <span
                      className="mr-1.5 ml-auto text-[11px] whitespace-nowrap text-subtle tabular-nums"
                      title={`${on} of ${states.length} tasks enabled`}
                    >
                      {on}/{states.length} on
                    </span>
                  )}
                </AccordionTrigger>
              </AccordionHeader>
              <AccordionPanel className="pb-1">
                {menu.tasks.map((task) => (
                  <div key={task.id}>
                    <SdkButton
                      className="block! h-auto! w-full rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left text-[13px] leading-snug whitespace-normal! text-secondary hover:bg-fill! hover:text-ink aria-[current=true]:bg-accent-fill! aria-[current=true]:font-semibold aria-[current=true]:text-white!"
                      aria-current={currentTaskId === task.id && !searching ? "true" : undefined}
                      onClick={() => onTask(task.id)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">{task.name}</span>
                        <TaskDot enabled={enabledOf(task)} />
                      </span>
                    </SdkButton>
                    {task.id === currentTaskId && !searching && outline.length > 2 && (
                      <ol className="my-1 ml-3.5 flex list-none flex-col border-l border-edge p-0">
                        {outline.map((group) => (
                          <li key={group.id}>
                            <a
                              href={`#group-${group.id}`}
                              aria-current={activeGroup === group.id ? "location" : undefined}
                              className="-ml-px block border-l-2 border-transparent py-1 pr-2 pl-3 text-xs text-subtle no-underline hover:text-ink aria-[current=location]:border-accent aria-[current=location]:font-semibold aria-[current=location]:text-ink"
                              onClick={(event) => {
                                // The URL hash belongs to the router.
                                event.preventDefault();
                                document
                                  .getElementById(`group-${group.id}`)
                                  ?.closest("section")
                                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }}
                            >
                              {group.name}
                            </a>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>
    </aside>
  );
}

function TaskDot({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${enabled ? "bg-ok" : "border border-edge-strong"}`}
      />
      <span className="sr-only">{enabled ? "(enabled)" : "(disabled)"}</span>
    </>
  );
}
