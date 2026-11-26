import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useBlocker } from "@tanstack/react-router";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useMemo, useState } from "react";

import type { ConfigField, ConfigTask } from "@/api/client";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { QueryNotice } from "@/shared/ui/query-content";
import { SectionLabel } from "@/shared/ui/section-label";

import { readShowKeys, saveShowKeys, useLang } from "./lang";
import { configSchemaQuery } from "./queries";
import { SaveBar } from "./save-bar";
import { SettingField } from "./setting-field";
import { SettingHelp } from "./setting-help";
import { SettingsNav } from "./settings-nav";
import { TaskHeader } from "./task-header";
import {
  ADVANCED_GROUPS,
  headerPaths,
  isChanged,
  matchField,
  schedulerOf,
  slotsOf,
} from "./task-state";
import { useActiveGroup } from "./use-active-group";
import { useConfigEditor } from "./use-config-editor";

const route = getRouteApi("/$instanceId/settings");
const MAX_SEARCH_HITS = 200;
const STACK = "flex flex-col gap-4";
const COLUMNS = `${STACK} @min-[72rem]:block @min-[72rem]:columns-2 @min-[72rem]:gap-4 @min-[72rem]:[&>*]:mb-4 @min-[72rem]:[&>*]:break-inside-avoid`;

type Hit = { task: ConfigTask; field: ConfigField };

function searchFields(
  tasks: ConfigTask[],
  query: string,
  changedOnly: boolean,
  isDifferent: (field: ConfigField) => boolean,
) {
  const q = query.trim().toLowerCase();
  if (!q && !changedOnly) return null;
  const strong: Hit[] = [];
  const weak: Hit[] = [];
  for (const task of tasks)
    for (const group of task.groups)
      for (const field of group.fields) {
        if (changedOnly && !isDifferent(field)) continue;
        const match = matchField(field, q);
        if (match === "strong") strong.push({ task, field });
        else if (match === "weak") weak.push({ task, field });
      }
  return { strong: strong.slice(0, MAX_SEARCH_HITS), weak: weak.slice(0, MAX_SEARCH_HITS) };
}

export function Settings() {
  const { instanceId: id } = route.useParams();
  const { q: search, task: taskId, changed: changedOnly } = route.useSearch();
  const navigate = route.useNavigate();
  const lang = useLang();
  const [showKeys, setShowKeys] = useState(readShowKeys);
  const editor = useConfigEditor(id);
  const { doc, edits, errors } = editor;
  const schema = useQuery(configSchemaQuery(id, lang));
  const dirty = Object.keys(edits).length > 0;

  useBlocker({
    shouldBlockFn: ({ next }) =>
      next.pathname !== `/${encodeURIComponent(id)}/settings` &&
      !window.confirm("You have unsaved settings. Leave and discard them?"),
    enableBeforeUnload: () => dirty,
    disabled: !dirty,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        editor.submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  const tasks = useMemo(() => schema.data?.menus.flatMap((m) => m.tasks) ?? [], [schema.data]);
  const current = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const isDifferent = (field: ConfigField) =>
    field.path in edits || isChanged(field, editor.valueOf(field));
  const hits = searchFields(tasks, search, changedOnly, isDifferent);

  const inHeader = current ? headerPaths(current) : new Set<string>();
  const bodyGroups =
    current?.groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => !inHeader.has(f.path)) }))
      .filter((g) => g.fields.length > 0) ?? [];
  const mainGroups = bodyGroups.filter((g) => !ADVANCED_GROUPS.has(g.id));
  const advancedGroups = bodyGroups.filter((g) => ADVANCED_GROUPS.has(g.id));
  const activeGroup = useActiveGroup(hits ? [] : mainGroups.map((g) => g.id));

  const notices = (
    <>
      <QueryNotice query={schema} label="settings schema" />
      <QueryNotice query={doc} label="configuration" />
    </>
  );
  if (!schema.data || !doc.data) return notices;

  const renderField = (field: ConfigField) => (
    <SettingField
      key={field.path}
      field={field}
      value={editor.valueOf(field)}
      disabled={editor.blocked || schema.isError}
      edited={field.path in edits}
      changed={isChanged(field, editor.valueOf(field))}
      showKey={showKeys}
      highlight={search}
      error={errors[field.path]}
      onChange={(v) => editor.change(field, v)}
    />
  );
  const renderGroup = (group: (typeof bodyGroups)[number]) => (
    <Card key={group.id} className="scroll-mt-36 [&_h3]:mb-0.5">
      <h3 id={`group-${group.id}`}>{group.name}</h3>
      {group.help && <SettingHelp className="mb-1.5" text={group.help} about={group.name} />}
      {group.fields.map(renderField)}
    </Card>
  );
  const renderHits = (list: Hit[]) =>
    list.map(({ task, field }, i) => (
      <div key={field.path}>
        {list[i - 1]?.task.id !== task.id && (
          <div className="mt-3.5 first:mt-0">
            <SectionLabel>{task.name}</SectionLabel>
          </div>
        )}
        {renderField(field)}
      </div>
    ));

  const fieldCount = bodyGroups.reduce((n, g) => n + g.fields.length, 0);
  const advancedFields = advancedGroups.flatMap((g) => g.fields);
  const advancedAttention = advancedFields.some((f) => f.path in edits || f.path in errors);
  const advancedChanged = advancedFields.filter((f) => isDifferent(f)).length;
  const slots = current ? slotsOf(current, tasks) : null;
  const hitCount = hits ? hits.strong.length + hits.weak.length : 0;
  const enabledOf = (task: ConfigTask) => {
    const scheduler = schedulerOf(task);
    return scheduler ? editor.valueOf(scheduler.enable) === true : null;
  };
  const goTask = (next: string) => void navigate({ search: { q: "", task: next, changed: false } });

  return (
    <>
      {notices}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 min-[981px]:grid-cols-[250px_minmax(0,1fr)]">
        <SettingsNav
          menus={schema.data.menus}
          currentTaskId={current?.id}
          searching={hits !== null}
          enabledOf={enabledOf}
          outline={mainGroups.map((g) => ({ id: g.id, name: g.name }))}
          activeGroup={activeGroup}
          search={search}
          onSearch={(next) =>
            void navigate({
              search: (previous) => ({ ...previous, q: next }),
              replace: true,
            })
          }
          changedOnly={changedOnly}
          onChangedOnly={(next) =>
            void navigate({
              search: (previous) => ({ ...previous, changed: next }),
              replace: true,
            })
          }
          showKeys={showKeys}
          onShowKeys={(next) => {
            setShowKeys(next);
            saveShowKeys(next);
          }}
          onTask={goTask}
        />

        <section className="@container flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-lg">
              {hits
                ? `${hitCount}${hitCount >= MAX_SEARCH_HITS ? "+" : ""} ${changedOnly ? "changed" : "matching"} setting${hitCount === 1 ? "" : "s"}`
                : current?.name}
            </h2>
            {!hits && current && (
              <span className="text-xs text-subtle">
                {fieldCount} settings in {bodyGroups.length} group
                {bodyGroups.length === 1 ? "" : "s"}
              </span>
            )}
            <span
              className="ml-auto font-code text-[11px] text-subtle"
              title="Config file revision"
            >
              rev {doc.data.revision}
            </span>
          </div>
          {!hits && current?.help && <SettingHelp text={current.help} about={current.name} />}
          {!hits && slots && (
            <p className="text-xs text-subtle">
              {slots.isSlot ? (
                <>
                  An extra slot of{" "}
                  <SlotLink name={slots.root.name} onClick={() => goTask(slots.root.id)} />. It
                  keeps its own copy of every setting and its own schedule, so it can farm a
                  different stage.
                </>
              ) : (
                <>
                  Has extra slots with their own settings and schedule:{" "}
                  {slots.slots.map((slot, i) => (
                    <span key={slot.id}>
                      {i > 0 && ", "}
                      <SlotLink name={slot.name} onClick={() => goTask(slot.id)} />
                    </span>
                  ))}
                  .
                </>
              )}
            </p>
          )}
          {!hits && current && (
            <TaskHeader
              instanceId={id}
              task={current}
              valueOf={editor.valueOf}
              edited={(field) => field.path in edits}
              disabled={editor.blocked || schema.isError}
              onChange={editor.change}
            />
          )}
          <p className={editor.notice ? "text-[13px] text-ok" : "sr-only"} role="status">
            {editor.notice}
          </p>

          {hits ? (
            <>
              {(hits.strong.length > 0 || hitCount === 0) && (
                <Card className="[&_h3]:mb-0.5">
                  {hitCount === 0 && (
                    <div className="py-4.5 text-center text-[13px] text-subtle">
                      {changedOnly ? "No setting differs from its default." : "No setting matches."}
                    </div>
                  )}
                  {renderHits(hits.strong)}
                </Card>
              )}
              {hits.weak.length > 0 && (
                <Card heading="Mentioned in help or options" className="[&_h3]:mb-0.5">
                  {renderHits(hits.weak)}
                </Card>
              )}
            </>
          ) : (
            <>
              <div className={mainGroups.length > 1 ? COLUMNS : STACK}>
                {mainGroups.map(renderGroup)}
              </div>
              {advancedGroups.length > 0 && (
                <Collapsible
                  key={current?.id}
                  defaultOpen={advancedAttention}
                  className="flex flex-col gap-4"
                >
                  <CollapsibleTrigger className="flex! h-auto! w-full items-center gap-2 rounded-alas! border! border-dashed! border-edge-strong! bg-transparent! px-4.5 py-3 text-left text-[13px] font-semibold text-secondary hover:bg-panel-2! hover:text-ink">
                    Advanced
                    <span className="font-normal text-subtle">
                      {advancedGroups.map((g) => g.name).join(" · ")}
                    </span>
                    {advancedChanged > 0 && (
                      <span className="ml-auto text-[11px] font-medium text-accent">
                        {advancedChanged} changed
                      </span>
                    )}
                  </CollapsibleTrigger>
                  <CollapsiblePanel
                    hiddenUntilFound
                    className={advancedGroups.length > 1 ? COLUMNS : STACK}
                  >
                    {advancedGroups.map(renderGroup)}
                  </CollapsiblePanel>
                </Collapsible>
              )}
            </>
          )}

          <div className="sticky bottom-4 z-10 empty:hidden">
            <SaveBar editor={editor} saveBlocked={schema.isError} />
          </div>
        </section>
      </div>
    </>
  );
}

function SlotLink({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="small"
      className="inline! h-auto! min-h-0! p-0! align-baseline text-xs! font-semibold text-accent! hover:bg-transparent! hover:underline"
      onClick={onClick}
    >
      {name}
    </Button>
  );
}
