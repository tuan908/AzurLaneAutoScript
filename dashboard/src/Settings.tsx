import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "@ui-sdk/react/accordion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
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
import { useMemo, useState, type ReactNode } from "react";
import { type ConfigField, type ConfigTask, type ConfigValue } from "./api";

import { useConfigEditor } from "./use-config-editor";
import { LANGS, readLang, saveLang } from "./lang";
import { splitHelp } from "./help";

/** "2020-01-01 00:00:00" <-> datetime-local "2020-01-01T00:00:00" */
const toLocalInput = (v: ConfigValue) => (typeof v === "string" ? v.replace(" ", "T").slice(0, 19) : "");

function Help({ text, about, className = "" }: { text: string; about: string; className?: string }) {
  const [summary, more] = splitHelp(text);
  if (!summary) return null;
  if (!more) return <p className={`whitespace-pre-line text-xs text-subtle ${className}`}>{summary}</p>;
  return (
    <Collapsible className={`text-xs text-subtle ${className}`}>
      <p className="whitespace-pre-line">
        {summary}{" "}
        <CollapsibleTrigger className="inline! h-auto! min-h-0! rounded-sm! border-0! bg-transparent! p-0! align-baseline text-xs! font-semibold text-accent! hover:underline [&[data-open]_.more]:hidden [&:not([data-open])_.less]:hidden">
          <span className="more">More</span><span className="less">Less</span><span className="sr-only"> about {about}</span>
        </CollapsibleTrigger>
      </p>
      <CollapsiblePanel className="mt-1 whitespace-pre-line">{more}</CollapsiblePanel>
    </Collapsible>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-semibold tracking-[.06em] uppercase text-subtle">{children}</span>;
}

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
      {field.help && <Help className="col-span-full" text={field.help} about={field.label} />}
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
  const currentMenu = schema.data?.menus.find((m) => m.tasks.some((t) => t.id === current?.id))?.id;
  const [openMenus, setOpenMenus] = useState<string[]>([]);
  const [revealedMenu, setRevealedMenu] = useState<string | undefined>();
  if (currentMenu !== revealedMenu) {
    setRevealedMenu(currentMenu);
    if (currentMenu && !openMenus.includes(currentMenu)) setOpenMenus([...openMenus, currentMenu]);
  }

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
    saveLang(next);
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
      <aside className="flex max-h-75 flex-col gap-2.5 overflow-hidden rounded-alas border border-edge bg-panel p-3 shadow-alas min-[981px]:sticky min-[981px]:top-32.5 min-[981px]:max-h-[calc(100vh-150px)]" aria-label="Setting groups">
        <Input aria-label="Search settings" placeholder="Search all settings…" value={search} onValueChange={onSearch} />
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Language</SectionLabel>
          <Select className="min-h-7.5! w-28! min-w-0! text-[12.5px]!" label="Settings language" items={LANGS} value={lang} onValueChange={setLang} />
        </div>
        <Accordion multiple value={openMenus} onValueChange={(next) => setOpenMenus(next.map(String))}
          className="-mx-1 flex flex-col gap-0.5 overflow-y-auto border-t border-edge px-1 pt-2">
          {schema.data.menus.map((menu) => (
            <AccordionItem key={menu.id} value={menu.id}>
              <AccordionHeader className="m-0">
                <AccordionTrigger className="flex! h-auto! min-h-0! w-full items-center justify-between rounded-alas-sm! border-0! bg-transparent! px-2 py-1.5 text-left hover:bg-panel-3!">
                  <SectionLabel>{menu.name}</SectionLabel>
                  {menu.tasks.some((t) => t.id === current?.id) && !searchHits && <span className="mr-auto ml-2 size-1.5 rounded-full bg-accent" aria-hidden="true" />}
                </AccordionTrigger>
              </AccordionHeader>
              <AccordionPanel className="pb-1">
                {menu.tasks.map((task) => (
                  <SdkButton
                    key={task.id}
                    className="block! h-auto! w-full rounded-alas-sm! border-0! bg-transparent! px-2.5 py-1.5 text-left text-[13px] leading-snug whitespace-normal! text-secondary hover:bg-panel-3! hover:text-ink aria-[current=true]:bg-accent-soft! aria-[current=true]:font-semibold aria-[current=true]:text-accent!"
                    aria-current={current?.id === task.id && !searchHits ? "true" : undefined}
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

      <section className="flex min-w-0 flex-col gap-4 pb-18">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="text-lg">{searchHits ? `${searchHits.length} matching setting${searchHits.length === 1 ? "" : "s"}` : current?.name}</h2>
          {!searchHits && current && <span className="text-xs text-subtle">
            {current.groups.reduce((n, g) => n + g.fields.length, 0)} settings in {current.groups.length} group{current.groups.length === 1 ? "" : "s"}
          </span>}
          <span className="ml-auto font-code text-[11px] text-subtle" title="Config file revision">rev {doc.data.revision}</span>
        </div>
        {!searchHits && current?.help && <Help text={current.help} about={current.name} />}

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
              {group.help && <Help className="mb-1.5" text={group.help} about={group.name} />}
              {group.fields.map(renderField)}
            </Card>
          ))
        )}
      </section>
    </div>
    </>
  );
}
