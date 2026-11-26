import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { ConfigField, ConfigTask } from "@/api/client";
import { Card } from "@/shared/ui/card";
import { QueryNotice } from "@/shared/ui/query-content";
import { SectionLabel } from "@/shared/ui/section-label";

import { readLang, readShowKeys, saveLang, saveShowKeys } from "./lang";
import { configSchemaQuery } from "./queries";
import { SaveBar } from "./save-bar";
import { SettingField } from "./setting-field";
import { SettingHelp } from "./setting-help";
import { SettingsNav } from "./settings-nav";
import { TaskHeader } from "./task-header";
import { headerPaths, isChanged, schedulerOf } from "./task-state";
import { useConfigEditor } from "./use-config-editor";

const route = getRouteApi("/$instanceId/settings");
const MAX_SEARCH_HITS = 200;

function searchFields(
  tasks: ConfigTask[],
  query: string,
  changedOnly: boolean,
  isDifferent: (field: ConfigField) => boolean,
) {
  const q = query.trim().toLowerCase();
  if (!q && !changedOnly) return null;
  const hits: { task: ConfigTask; field: ConfigField }[] = [];
  for (const task of tasks)
    for (const group of task.groups)
      for (const field of group.fields) {
        if (changedOnly && !isDifferent(field)) continue;
        if (q && !field.label.toLowerCase().includes(q) && !field.path.toLowerCase().includes(q))
          continue;
        hits.push({ task, field });
      }
  return hits.slice(0, MAX_SEARCH_HITS);
}

export function Settings() {
  const { instanceId: id } = route.useParams();
  const { q: search, task: taskId, changed: changedOnly } = route.useSearch();
  const navigate = route.useNavigate();
  const [lang, setLang] = useState(readLang);
  const [showKeys, setShowKeys] = useState(readShowKeys);
  const editor = useConfigEditor(id);
  const { doc, edits, errors } = editor;
  const schema = useQuery(configSchemaQuery(id, lang));

  const tasks = useMemo(() => schema.data?.menus.flatMap((m) => m.tasks) ?? [], [schema.data]);
  const current = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const isDifferent = (field: ConfigField) =>
    field.path in edits || isChanged(field, editor.valueOf(field));
  const searchHits = searchFields(tasks, search, changedOnly, isDifferent);

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
      error={errors[field.path]}
      onChange={(v) => editor.change(field, v)}
    />
  );
  const inHeader = current ? headerPaths(current) : new Set<string>();
  const bodyGroups =
    current?.groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => !inHeader.has(f.path)) }))
      .filter((g) => g.fields.length > 0) ?? [];
  const fieldCount = bodyGroups.reduce((n, g) => n + g.fields.length, 0);
  const enabledOf = (task: ConfigTask) => {
    const scheduler = schedulerOf(task);
    return scheduler ? editor.valueOf(scheduler.enable) === true : null;
  };

  return (
    <>
      {notices}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 min-[981px]:grid-cols-[250px_minmax(0,1fr)]">
        <SettingsNav
          menus={schema.data.menus}
          currentTaskId={current?.id}
          searching={searchHits !== null}
          enabledOf={enabledOf}
          search={search}
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
          onSearch={(next) =>
            void navigate({
              search: (previous) => ({ ...previous, q: next }),
              replace: true,
            })
          }
          lang={lang}
          onLang={(next) => {
            setLang(next);
            saveLang(next);
          }}
          onTask={(next) => void navigate({ search: { q: "", task: next, changed: false } })}
        />

        <section className="flex min-w-0 max-w-240 flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-lg">
              {searchHits
                ? `${searchHits.length} ${changedOnly ? "changed" : "matching"} setting${searchHits.length === 1 ? "" : "s"}`
                : current?.name}
            </h2>
            {!searchHits && current && (
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
          {!searchHits && current?.help && <SettingHelp text={current.help} about={current.name} />}
          {!searchHits && current && (
            <TaskHeader
              instanceId={id}
              task={current}
              valueOf={editor.valueOf}
              edited={(field) => field.path in edits}
              disabled={editor.blocked || schema.isError}
              onChange={editor.change}
            />
          )}

          <SaveBar editor={editor} saveBlocked={schema.isError} />
          <p className={editor.notice ? "text-[13px] text-ok" : "sr-only"} role="status">
            {editor.notice}
          </p>

          {searchHits ? (
            <Card className="[&_h3]:mb-0.5">
              {searchHits.length === 0 && (
                <div className="py-4.5 text-center text-[13px] text-subtle">
                  {changedOnly ? "Every setting matches its default." : "No setting matches."}
                </div>
              )}
              {searchHits.map(({ task, field }, i) => (
                <div key={field.path}>
                  {searchHits[i - 1]?.task.id !== task.id && (
                    <div className="mt-3.5 first:mt-0">
                      <SectionLabel>{task.name}</SectionLabel>
                    </div>
                  )}
                  {renderField(field)}
                </div>
              ))}
            </Card>
          ) : (
            bodyGroups.map((group) => (
              <Card key={group.id} className="[&_h3]:mb-0.5">
                <h3>{group.name}</h3>
                {group.help && (
                  <SettingHelp className="mb-1.5" text={group.help} about={group.name} />
                )}
                {group.fields.map(renderField)}
              </Card>
            ))
          )}
        </section>
      </div>
    </>
  );
}
