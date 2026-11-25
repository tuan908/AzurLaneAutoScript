import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ConfigField, ConfigTask } from "../../api/client";
import { Card } from "../../shared/ui/card";
import { QueryNotice } from "../../shared/ui/query-content";
import { SectionLabel } from "../../shared/ui/section-label";
import { readLang, saveLang } from "./lang";
import { configSchemaQuery } from "./queries";
import { SaveBar } from "./save-bar";
import { SettingField } from "./setting-field";
import { SettingHelp } from "./setting-help";
import { SettingsNav } from "./settings-nav";
import { useConfigEditor } from "./use-config-editor";

const route = getRouteApi("/$instanceId/settings");
const MAX_SEARCH_HITS = 200;

function searchFields(tasks: ConfigTask[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hits: { task: ConfigTask; field: ConfigField }[] = [];
  for (const task of tasks)
    for (const group of task.groups)
      for (const field of group.fields)
        if (field.label.toLowerCase().includes(q) || field.path.toLowerCase().includes(q)) hits.push({ task, field });
  return hits.slice(0, MAX_SEARCH_HITS);
}

export function Settings() {
  const { instanceId: id } = route.useParams();
  const { q: search, task: taskId } = route.useSearch();
  const navigate = route.useNavigate();
  const [lang, setLang] = useState(readLang);
  const editor = useConfigEditor(id);
  const { doc, edits, errors } = editor;
  const schema = useQuery(configSchemaQuery(id, lang));

  const tasks = useMemo(() => schema.data?.menus.flatMap((m) => m.tasks) ?? [], [schema.data]);
  const current = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const searchHits = useMemo(() => searchFields(tasks, search), [search, tasks]);

  const notices = <>
    <QueryNotice query={schema} label="settings schema" />
    <QueryNotice query={doc} label="configuration" />
  </>;
  if (!schema.data || !doc.data) return notices;

  const renderField = (field: ConfigField) => (
    <SettingField
      key={field.path}
      field={field}
      value={editor.valueOf(field)}
      disabled={editor.blocked || schema.isError}
      edited={field.path in edits}
      error={errors[field.path]}
      onChange={(v) => editor.change(field, v)}
    />
  );
  const fieldCount = current?.groups.reduce((n, g) => n + g.fields.length, 0) ?? 0;

  return (
    <>
      {notices}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 min-[981px]:grid-cols-[250px_minmax(0,1fr)]">
        <SettingsNav
          menus={schema.data.menus}
          currentTaskId={current?.id}
          searching={searchHits !== null}
          search={search}
          onSearch={(next) => void navigate({ search: (previous) => ({ ...previous, q: next }), replace: true })}
          lang={lang}
          onLang={(next) => { setLang(next); saveLang(next); }}
          onTask={(next) => void navigate({ search: { q: "", task: next } })}
        />

        <section className="flex min-w-0 flex-col gap-4 pb-18">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-lg">{searchHits ? `${searchHits.length} matching setting${searchHits.length === 1 ? "" : "s"}` : current?.name}</h2>
            {!searchHits && current && <span className="text-xs text-subtle">
              {fieldCount} settings in {current.groups.length} group{current.groups.length === 1 ? "" : "s"}
            </span>}
            <span className="ml-auto font-code text-[11px] text-subtle" title="Config file revision">rev {doc.data.revision}</span>
          </div>
          {!searchHits && current?.help && <SettingHelp text={current.help} about={current.name} />}

          <SaveBar editor={editor} saveBlocked={schema.isError} />

          {searchHits ? (
            <Card className="[&_h3]:mb-0.5">
              {searchHits.length === 0 && <div className="py-4.5 text-center text-[13px] text-subtle">No setting matches.</div>}
              {searchHits.map(({ task, field }, i) => (
                <div key={field.path}>
                  {searchHits[i - 1]?.task.id !== task.id && <div className="mt-3.5 first:mt-0"><SectionLabel>{task.name}</SectionLabel></div>}
                  {renderField(field)}
                </div>
              ))}
            </Card>
          ) : (
            current?.groups.map((group) => (
              <Card key={group.id} className="[&_h3]:mb-0.5">
                <h3>{group.name}</h3>
                {group.help && <SettingHelp className="mb-1.5" text={group.help} about={group.name} />}
                {group.fields.map(renderField)}
              </Card>
            ))
          )}
        </section>
      </div>
    </>
  );
}
