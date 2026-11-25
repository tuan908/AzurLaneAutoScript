import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { ApiError, api, type ConfigField, type ConfigTask, type ConfigValue } from "./api";

const LANGS = ["en-US", "zh-CN", "zh-TW", "ja-JP"];
const LANG_KEY = "alas.lang";

function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? "en-US";
  } catch {
    return "en-US";
  }
}

function deepGet(obj: unknown, path: string): ConfigValue {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return (cur ?? null) as ConfigValue;
}

/** "2020-01-01 00:00:00" <-> datetime-local "2020-01-01T00:00:00" */
const toLocalInput = (v: ConfigValue) => (typeof v === "string" ? v.replace(" ", "T").slice(0, 19) : "");

function Field({
  field,
  value,
  edited,
  error,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  edited: boolean;
  error?: string;
  onChange: (v: ConfigValue) => void;
}) {
  const id = `f-${field.path}`;
  let control;
  if (field.readOnly) {
    control = <span className="readonly">{value === null ? "—" : String(value)}</span>;
  } else if (field.type === "checkbox") {
    control = (
      <span className="switch">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" aria-hidden="true" />
      </span>
    );
  } else if (field.type === "select") {
    const options = field.options ?? [];
    const known = options.some((o) => String(o.value) === String(value));
    control = (
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          onChange(picked ? picked.value : e.target.value);
        }}
      >
        {!known && <option value={String(value)}>{String(value)}</option>}
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "datetime") {
    control = (
      <input id={id} type="datetime-local" step={1} value={toLocalInput(value)} onChange={(e) => onChange(e.target.value)} />
    );
  } else if (field.type === "textarea") {
    control = <textarea id={id} rows={4} value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input id={id} type="text" value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`field ${edited ? "field-edited" : ""} ${error ? "field-error" : ""}`}>
      <label htmlFor={id}>
        {field.label}
        <span className="path">{field.path}</span>
      </label>
      <div className="field-control">{control}</div>
      {error && <div className="field-error-text">{error}</div>}
      {field.help && <div className="help">{field.help}</div>}
    </div>
  );
}

export function Settings({ id }: { id: string }) {
  const qc = useQueryClient();
  const [lang, setLangState] = useState(readLang);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState<Record<string, ConfigValue>>({});
  const editRevision = useRef<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const schema = useQuery({ queryKey: ["configSchema", id, lang], queryFn: () => api.configSchema(id, lang), staleTime: Infinity });
  const doc = useQuery({ queryKey: ["config", id], queryFn: () => api.config(id) });

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

  const save = useMutation({
    mutationFn: () => api.updateConfig(id, editRevision.current!, edits),
    onSuccess: (result) => {
      setEdits({});
      setErrors({});
      setConflict(false);
      setNotice(`Saved ${Object.keys(result.applied).length} setting(s)`);
      void qc.invalidateQueries({ queryKey: ["config", id] });
      void qc.invalidateQueries({ queryKey: ["tasks", id] });
    },
    onError: (e) => {
      setNotice(null);
      if (e instanceof ApiError && e.status === 400 && e.body.fields) {
        setErrors(e.body.fields as Record<string, string>);
      } else if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
      }
    },
  });

  const setLang = (next: string) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* not remembered */
    }
  };

  const valueOf = (field: ConfigField): ConfigValue =>
    field.path in edits ? edits[field.path] : deepGet(doc.data?.config, field.path);

  const change = (field: ConfigField, v: ConfigValue) => {
    if (!Object.keys(edits).length) editRevision.current = doc.data!.revision;
    setNotice(null);
    setEdits((old) => {
      const next = { ...old };
      const original = deepGet(doc.data?.config, field.path);
      const normalized = field.type === "datetime" && typeof v === "string" ? v.replace("T", " ") : v;
      if (String(normalized) === String(original)) delete next[field.path];
      else next[field.path] = v;
      return next;
    });
    setErrors((old) => {
      if (!(field.path in old)) return old;
      const next = { ...old };
      delete next[field.path];
      return next;
    });
  };

  if (schema.isError) {
    return <div className="banner tone-bad" role="alert"><div className="banner-body">{(schema.error as Error).message}</div></div>;
  }
  if (doc.isError && !doc.data) {
    return <div className="banner tone-bad" role="alert"><div className="banner-body">{doc.error.message}</div></div>;
  }
  if (!schema.data || !doc.data) return <div className="card"><div className="skeleton" /></div>;

  const editCount = Object.keys(edits).length;
  const renderField = (field: ConfigField) => (
    <Field
      key={field.path}
      field={field}
      value={valueOf(field)}
      edited={field.path in edits}
      error={errors[field.path]}
      onChange={(v) => change(field, v)}
    />
  );

  const showBar = editCount > 0 || notice !== null || conflict || save.isError;

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="Setting groups">
        <input aria-label="Search settings" placeholder="Search all settings…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Settings language" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <div className="tree">
          {schema.data.menus.map((menu) => (
            <div key={menu.id}>
              <div className="menu-name">{menu.name}</div>
              {menu.tasks.map((task) => (
                <button
                  key={task.id}
                  className={`task-link ${current?.id === task.id && !searchHits ? "active" : ""}`}
                  aria-current={current?.id === task.id && !searchHits ? "true" : undefined}
                  onClick={() => {
                    setSearch("");
                    setTaskId(task.id);
                  }}
                >
                  {task.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="settings-body">
        <div className="settings-title">
          <h3>{searchHits ? `${searchHits.length} matching setting${searchHits.length === 1 ? "" : "s"}` : current?.name}</h3>
          <span className="muted small mono">revision {doc.data.revision}</span>
        </div>
        {!searchHits && current?.help && <p className="group-help">{current.help}</p>}

        {showBar && (
          <div className="save-bar" role="region" aria-label="Unsaved changes">
            <span className="msg">
              {conflict ? (
                <span className="text-bad">The config changed elsewhere (GUI or a running task).</span>
              ) : save.isError && !Object.keys(errors).length ? (
                <span className="text-bad">{(save.error as Error).message}</span>
              ) : Object.keys(errors).length ? (
                <span className="text-bad">Fix the highlighted values; nothing was saved.</span>
              ) : notice && !editCount ? (
                <span className="text-ok">{notice}</span>
              ) : (
                <span>{editCount} unsaved change{editCount === 1 ? "" : "s"}</span>
              )}
            </span>
            <div className="actions">
              {conflict && (
                <button
                  className="btn"
                  onClick={() => {
                    setEdits({});
                    setConflict(false);
                    void qc.invalidateQueries({ queryKey: ["config", id] });
                  }}
                >
                  Reload, discard my edits
                </button>
              )}
              <button className="btn" disabled={!editCount || save.isPending} onClick={() => (setEdits({}), setErrors({}))}>
                Discard
              </button>
              <button className="btn btn-primary" disabled={!editCount || save.isPending || conflict} onClick={() => save.mutate()}>
                Save{editCount ? ` (${editCount})` : ""}
              </button>
            </div>
          </div>
        )}

        {searchHits ? (
          <div className="card group-card">
            {searchHits.length === 0 && <div className="empty">No setting matches.</div>}
            {searchHits.map(({ task, field }, i) => (
              <div key={field.path}>
                {(i === 0 || searchHits[i - 1].task.id !== task.id) && <div className="hit-task">{task.name}</div>}
                {renderField(field)}
              </div>
            ))}
          </div>
        ) : (
          current?.groups.map((group) => (
            <div key={group.id} className="card group-card">
              <h3>{group.name}</h3>
              {group.help && <p className="group-help">{group.help}</p>}
              {group.fields.map(renderField)}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
