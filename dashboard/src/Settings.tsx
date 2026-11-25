import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Textarea } from "@ui-sdk/react/textarea";
import { Button, Card } from "./components/ui";
import { Select } from "./components/select";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { QueryNotice } from "./components/query-content";
import { queries } from "./queries";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type ConfigField, type ConfigTask, type ConfigValue } from "./api";

import { useConfigEditor } from "./use-config-editor";

const LANGS = ["en-US", "zh-CN", "zh-TW", "ja-JP"];
const LANG_KEY = "alas.lang";

function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? "en-US";
  } catch {
    return "en-US";
  }
}

/** "2020-01-01 00:00:00" <-> datetime-local "2020-01-01T00:00:00" */
const toLocalInput = (v: ConfigValue) => (typeof v === "string" ? v.replace(" ", "T").slice(0, 19) : "");

function Field({
  field,
  value,
  edited,
  disabled,
  error,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  edited: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (v: ConfigValue) => void;
}) {
  const id = `f-${field.path}`;
  let control;
  if (field.readOnly) {
    control = <span className="font-code text-[12.5px] text-subtle">{value === null ? "—" : String(value)}</span>;
  } else if (field.type === "checkbox") {
    control = (
      <Switch disabled={disabled} id={id} aria-label={`${field.label} ${field.path}`} checked={value === true} onCheckedChange={onChange}><SwitchThumb /></Switch>
    );
  } else if (field.type === "select") {
    const options = field.options ?? [];
    const known = options.some((o) => String(o.value) === String(value));
    control = (
      <Select id={id} label={`${field.label} ${field.path}`} disabled={disabled} items={[...(!known ? [{ value: String(value), label: String(value) }] : []), ...options.map(o => ({ value: String(o.value), label: o.label }))]} value={String(value)} onValueChange={(next) => {
          const picked = options.find(o => String(o.value) === next);
          onChange(picked ? picked.value : next);
        }} />
    );
  } else if (field.type === "datetime") {
    control = (
      <Input disabled={disabled} id={id} type="datetime-local" step={1} value={toLocalInput(value)} onValueChange={onChange} />
    );
  } else if (field.type === "textarea") {
    control = <Textarea disabled={disabled} id={id} rows={4} value={value === null ? "" : String(value)} onValueChange={onChange} />;
  } else {
    control = <Input disabled={disabled} id={id} type="text" value={value === null ? "" : String(value)} onValueChange={onChange} />;
  }
  return (
    <div className={`-mx-4.5 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-edge px-4.5 py-3 first-of-type:border-t-0 min-[981px]:grid-cols-[minmax(200px,.9fr)_minmax(220px,1.1fr)] [&>label]:flex [&>label]:flex-col [&>label]:gap-0.5 [&>label]:text-[13px] [&>label]:font-semibold ${error ? "bg-bad-soft/70 shadow-[inset_3px_0_0_var(--bad)]" : edited ? "bg-warn-soft/70 shadow-[inset_3px_0_0_var(--warn)]" : ""}`}>
      <label htmlFor={id}>
        {field.label}
        <span className="wrap-anywhere font-code text-[11px] leading-[1.4] font-normal text-subtle">{field.path}</span>
      </label>
      <div className="flex min-w-0 items-center [&_[data-slot=select-trigger]]:w-full">{control}</div>
      {error && <div className="col-span-full text-xs text-bad">{error}</div>}
      {field.help && <div className="col-span-full whitespace-pre-line text-xs text-subtle">{field.help}</div>}
    </div>
  );
}

const route = getRouteApi("/$instanceId/settings");

export function Settings() {
  const { instanceId: id } = route.useParams();
  const { q: search, task: taskId } = route.useSearch();
  const navigate = route.useNavigate();
  const onSearch = (next: string) => void navigate({
    search: (previous) => ({ ...previous, q: next }), replace: true,
  });
  const onTask = (next: string) => void navigate({ search: { q: "", task: next } });
  const [lang, setLangState] = useState(readLang);
  const editor = useConfigEditor(id);
  const { doc, edits, errors, notice, conflict } = editor;
  const schema = useQuery(queries.configSchema(id, lang));

  const tasks = useMemo(() => schema.data?.menus.flatMap((m) => m.tasks) ?? [], [schema.data]);
  const current: ConfigTask | undefined = tasks.find((t) => t.id === taskId) ?? tasks[0];

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const hits: { task: ConfigTask; field: ConfigField }[] = [];
    for (const task of tasks)
      for (const group of task.groups)
        for (const field of group.fields)
          if (field.label.toLowerCase().includes(q) || field.path.toLowerCase().includes(q)) hits.push({ task, field });
    return hits.slice(0, 200);
  }, [search, tasks]);

  const setLang = (next: string) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* not remembered */
    }
  };

  const notices = <>
    <QueryNotice query={schema} label="settings schema" />
    <QueryNotice query={doc} label="configuration" />
  </>;
  if (!schema.data || !doc.data) return notices;

  const editCount = Object.keys(edits).length;
  const renderField = (field: ConfigField) => (
    <Field
      key={field.path}
      field={field}
      value={editor.valueOf(field)}
      disabled={editor.blocked || schema.isError}
      edited={field.path in edits}
      error={errors[field.path]}
      onChange={(v) => editor.change(field, v)}
    />
  );

  const showBar = editCount > 0 || notice !== null || conflict || editor.error !== null;

  return (
    <>
    {notices}
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 min-[981px]:grid-cols-[250px_minmax(0,1fr)]">
      <aside className="flex max-h-75 flex-col gap-2.5 overflow-hidden rounded-alas border border-edge bg-panel p-3 shadow-alas min-[981px]:sticky min-[981px]:top-32.5 min-[981px]:max-h-[calc(100vh-150px)] [&_[data-slot=select-trigger]]:w-full" aria-label="Setting groups">
        <Input aria-label="Search settings" placeholder="Search all settings…" value={search} onValueChange={onSearch} />
        <Select label="Settings language" items={LANGS} value={lang} onValueChange={setLang} />
        <div className="-mx-1 overflow-y-auto px-1">
          {schema.data.menus.map((menu) => (
            <div key={menu.id}>
              <div className="mx-2 mt-3 mb-1 text-[11px] font-semibold tracking-[.06em] uppercase text-subtle first:mt-0.5">{menu.name}</div>
              {menu.tasks.map((task) => (
                <SdkButton
                  key={task.id}
                  className="block! h-auto! w-full rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left text-[13px] text-secondary hover:bg-panel-3! hover:text-ink aria-[current=true]:bg-accent-soft! aria-[current=true]:font-semibold aria-[current=true]:text-accent!"
                  aria-current={current?.id === task.id && !searchHits ? "true" : undefined}
                  onClick={() => onTask(task.id)}
                >
                  {task.name}
                </SdkButton>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col gap-4 pb-18">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h3>{searchHits ? `${searchHits.length} matching setting${searchHits.length === 1 ? "" : "s"}` : current?.name}</h3>
          <span className="text-subtle text-xs font-code">revision {doc.data.revision}</span>
        </div>
        {!searchHits && current?.help && <p className="mb-1.5 whitespace-pre-line text-[12.5px] text-subtle">{current.help}</p>}

        {showBar && (
          <div className="fixed inset-x-3 bottom-5 z-20 mx-auto flex max-w-240 flex-wrap items-center gap-3 rounded-xl border border-edge-strong bg-panel py-2.5 pr-3 pl-4 shadow-alas-lg min-[861px]:right-6 min-[861px]:left-74" role="region" aria-label="Unsaved changes">
            <span className="text-[13px]">
              {conflict ? (
                <span className="text-bad">The config changed elsewhere (GUI or a running task).</span>
              ) : editor.error !== null && !Object.keys(errors).length ? (
                <span className="text-bad">{editor.error?.message}</span>
              ) : Object.keys(errors).length ? (
                <span className="text-bad">Fix the highlighted values; nothing was saved.</span>
              ) : notice && !editCount ? (
                <span className="text-ok">{notice}</span>
              ) : (
                <span>{editCount} unsaved change{editCount === 1 ? "" : "s"}</span>
              )}
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              {conflict && (
                <Button disabled={editor.busy} onClick={() => void editor.reload()}>
                  Reload, discard my edits
                </Button>
              )}
              <Button disabled={!editCount || editor.busy} onClick={editor.discard}>
                Discard
              </Button>
              <Button variant="primary" disabled={!editCount || editor.blocked || schema.isError} onClick={editor.submit}>
                Save{editCount ? ` (${editCount})` : ""}
              </Button>
            </div>
          </div>
        )}

        {searchHits ? (
          <Card className="[&_h3]:mb-0.5">
            {searchHits.length === 0 && <div className="py-4.5 text-center text-[13px] text-subtle">No setting matches.</div>}
            {searchHits.map(({ task, field }, i) => (
              <div key={field.path}>
                {(searchHits[i - 1]?.task.id !== task.id) && <div className="mt-3.5 text-[11px] font-semibold tracking-[.06em] uppercase text-subtle first:mt-0">{task.name}</div>}
                {renderField(field)}
              </div>
            ))}
          </Card>
        ) : (
          current?.groups.map((group) => (
            <Card key={group.id} className="[&_h3]:mb-0.5">
              <h3>{group.name}</h3>
              {group.help && <p className="mb-1.5 whitespace-pre-line text-[12.5px] text-subtle">{group.help}</p>}
              {group.fields.map(renderField)}
            </Card>
          ))
        )}
      </section>
    </div>
    </>
  );
}
