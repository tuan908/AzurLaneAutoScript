import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@ui-sdk/react/accordion";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { useState } from "react";

import type { ConfigSchema } from "@/api/client";
import { SectionLabel } from "@/shared/ui/section-label";
import { Select } from "@/shared/ui/select";

import { LANGS } from "./lang";

export function SettingsNav({
  menus,
  currentTaskId,
  searching,
  search,
  onSearch,
  lang,
  onLang,
  onTask,
}: {
  menus: ConfigSchema["menus"];
  currentTaskId: string | undefined;
  searching: boolean;
  search: string;
  onSearch: (next: string) => void;
  lang: string;
  onLang: (next: string) => void;
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
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Language</SectionLabel>
        <Select
          className="min-h-7.5! w-28! min-w-0! text-[12.5px]!"
          label="Settings language"
          items={LANGS}
          value={lang}
          onValueChange={onLang}
        />
      </div>
      <Accordion
        multiple
        value={openMenus}
        onValueChange={(next) => setOpenMenus(next.map(String))}
        className="-mx-1 flex flex-col gap-0.5 overflow-y-auto border-t border-edge px-1 pt-2"
      >
        {menus.map((menu) => (
          <AccordionItem key={menu.id} value={menu.id}>
            <AccordionHeader className="m-0">
              <AccordionTrigger className="flex! h-auto! min-h-0! w-full items-center justify-between rounded-alas-sm! border-0! bg-transparent! px-2 py-1.5 text-left hover:bg-panel-3!">
                <SectionLabel>{menu.name}</SectionLabel>
                {menu.tasks.some((t) => t.id === currentTaskId) && !searching && (
                  <span
                    className="mr-auto ml-2 size-1.5 rounded-full bg-accent"
                    aria-hidden="true"
                  />
                )}
              </AccordionTrigger>
            </AccordionHeader>
            <AccordionPanel className="pb-1">
              {menu.tasks.map((task) => (
                <SdkButton
                  key={task.id}
                  className="block! h-auto! w-full rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left text-[13px] leading-snug whitespace-normal! text-secondary hover:bg-panel-3! hover:text-ink aria-[current=true]:bg-accent-soft! aria-[current=true]:font-semibold aria-[current=true]:text-accent!"
                  aria-current={currentTaskId === task.id && !searching ? "true" : undefined}
                  onClick={() => onTask(task.id)}
                >
                  {task.name}
                </SdkButton>
              ))}
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </aside>
  );
}
