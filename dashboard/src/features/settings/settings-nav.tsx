import { Button as SdkButton } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";

import type { ConfigSchema, ConfigTask } from "@/api/client";

type Menu = ConfigSchema["menus"][number];

const rowClass =
  "flex! h-auto! w-full items-center gap-2 rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left leading-snug whitespace-normal! hover:bg-fill! aria-[current=page]:bg-accent-fill! aria-[current=page]:text-white!";

export function SettingsNav({
  menus,
  currentMenuId,
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
  onMenu,
  onTask,
}: {
  menus: Menu[];
  currentMenuId: string | undefined;
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
  onMenu: (menuId: string) => void;
  onTask: (taskId: string) => void;
}) {
  return (
    <aside
      className="flex max-h-100 flex-col gap-2.5 overflow-hidden rounded-alas border border-edge bg-panel p-3 shadow-alas min-[981px]:sticky min-[981px]:top-30 min-[981px]:max-h-[calc(100vh-140px)]"
      aria-label="Settings menu"
    >
      <Input
        type="search"
        aria-label="Search settings"
        placeholder="Search settings…"
        value={search}
        onValueChange={onSearch}
      />
      <nav aria-label="Setting categories" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {menus.map((menu) => {
            const states = menu.tasks.map(enabledOf).filter((v) => v !== null);
            const on = states.filter(Boolean).length;
            const open = !searching && menu.id === currentMenuId;
            return (
              <li key={menu.id}>
                <SdkButton
                  className={`${rowClass} text-[13.5px] font-semibold text-ink`}
                  aria-current={open && !currentTaskId ? "page" : undefined}
                  aria-expanded={open}
                  onClick={() => onMenu(menu.id)}
                >
                  <span className="min-w-0 flex-1">{menu.name}</span>
                  {states.length > 0 && (
                    <span
                      className="text-[11px] font-normal whitespace-nowrap tabular-nums opacity-70"
                      title={`${on} of ${states.length} tasks turned on`}
                    >
                      {on} of {states.length} on
                    </span>
                  )}
                </SdkButton>
                {open && (
                  <ul className="m-0 mt-0.5 mb-1.5 ml-2.5 flex list-none flex-col gap-0.5 border-l border-edge p-0 pl-1.5">
                    {menu.tasks.map((task) => (
                      <li key={task.id}>
                        <SdkButton
                          className={`${rowClass} text-[13px] text-secondary hover:text-ink aria-[current=page]:font-semibold`}
                          aria-current={currentTaskId === task.id ? "page" : undefined}
                          onClick={() => onTask(task.id)}
                        >
                          <span className="min-w-0 flex-1">{task.name}</span>
                          <TaskDot enabled={enabledOf(task)} />
                        </SdkButton>
                        {task.id === currentTaskId && outline.length > 2 && (
                          <ol className="my-1 ml-3 flex list-none flex-col border-l border-edge p-0">
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
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-edge pt-2.5 text-[12.5px] text-secondary [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5">
        <label htmlFor="settings-changed-only">
          <Switch id="settings-changed-only" checked={changedOnly} onCheckedChange={onChangedOnly}>
            <SwitchThumb />
          </Switch>
          Only changed
        </label>
        <label htmlFor="settings-show-keys" title="Show the config file name of each setting">
          <Switch id="settings-show-keys" checked={showKeys} onCheckedChange={onShowKeys}>
            <SwitchThumb />
          </Switch>
          Show keys
        </label>
      </div>
    </aside>
  );
}

function TaskDot({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${enabled ? "bg-ok" : "border border-current opacity-40"}`}
      />
      <span className="sr-only">{enabled ? "(on)" : "(off)"}</span>
    </>
  );
}
