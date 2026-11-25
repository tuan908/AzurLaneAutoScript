import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, setToken, type InstanceStatus, type Task } from "./api";
import { connectEvents, useConnection } from "./events";
import { useLogs } from "./logStore";
import { HealthBadge, HealthPanel } from "./HealthPanel";
import { Settings } from "./Settings";

const TAB_LABELS = { overview: "Overview", scheduler: "Scheduler", logs: "Logs", settings: "Settings", health: "Health" };
type Tab = keyof typeof TAB_LABELS;
const TABS = Object.keys(TAB_LABELS) as Tab[];

/** Location is #/<instance>/<tab> */
function useRoute(ids: string[]): [string | null, Tab, (id: string, tab?: Tab) => void] {
  const read = (): [string | null, Tab] => {
    const [id, tab] = window.location.hash.replace(/^#\/?/, "").split("/");
    try {
      return [id ? decodeURIComponent(id) : null, TABS.includes(tab as Tab) ? (tab as Tab) : "overview"];
    } catch {
      return [null, "overview"];
    }
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [selected, tab] = route;
  const effective = selected && ids.includes(selected) ? selected : (ids[0] ?? null);
  return [effective, tab, (id, next = "overview") => (window.location.hash = `/${encodeURIComponent(id)}/${next}`)];
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function since(iso: string | null): string {
  if (!iso) return "—";
  return formatDuration((Date.now() - new Date(iso).getTime()) / 1000);
}

function useNow(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
}

function StateBadge({ state }: { state: InstanceStatus["state"] }) {
  return <span className={`badge badge-${state}`}>{state}</span>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(value);
        onDone();
      }}
    >
      <h2>Password required</h2>
      <p>This ALAS server has a password. It is kept for this browser tab only.</p>
      <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit">Unlock</button>
    </form>
  );
}

function Header() {
  useNow(5000);
  const connection = useConnection();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15000 });
  const h = health.data;
  return (
    <header className="header">
      <div className="brand">
        <strong>ALAS Control Center</strong>
        <span className="muted">local automation server</span>
      </div>
      <div className="header-stats">
        {h && (
          <>
            <span>server up {formatDuration(h.uptimeSeconds)}</span>
            <span>
              {h.instances.running}/{h.instances.total} running
            </span>
            {h.instances.failed > 0 && <span className="text-failed">{h.instances.failed} failed</span>}
            {h.logQueueManagerAlive === false && <span className="text-failed">log queue manager down</span>}
            {h.health && (
              <span className={`conn conn-${h.health.status === "ok" ? "open" : h.health.status === "warn" ? "connecting" : "closed"}`}>
                health {h.health.status}
              </span>
            )}
          </>
        )}
        <span className={`conn conn-${connection}`} title="Live updates">
          {connection === "open" ? "live" : connection}
        </span>
      </div>
    </header>
  );
}

function InstanceList({
  instances,
  selected,
  onSelect,
  onCreate,
}: {
  instances: InstanceStatus[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const create = useMutation({
    mutationFn: ({ id, source }: { id: string; source: string | null }) => api.createProfile(id, source),
    onSuccess: async (profile) => {
      await qc.invalidateQueries({ queryKey: ["instances"] });
      setCreating(false);
      onCreate(profile.id);
    },
  });
  return (
    <nav className="sidebar" aria-label="Instances">
      <h3>Instances</h3>
      {instances.map((s) => (
        <button
          key={s.id}
          className={`instance-item ${s.id === selected ? "active" : ""}`}
          onClick={() => onSelect(s.id)}
          aria-current={s.id === selected ? "true" : undefined}
        >
          <span className="instance-name">{s.id}</span>
          <span className="badges">
            <HealthBadge status={s} />
            <StateBadge state={s.state} />
          </span>
          <span className="muted small">{s.currentTask ?? (s.state === "running" ? "waiting for task" : "")}</span>
        </button>
      ))}
      {creating ? (
        <form className="profile-form" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          create.mutate({ id: String(fields.get("name")).trim(), source: String(fields.get("source")) || null });
        }}>
          <label>Profile name <input name="name" required maxLength={48} /></label>
          <label>Copy from <select name="source">
            <option value="">Default settings</option>
            {instances.map((instance) => <option key={instance.id}>{instance.id}</option>)}
          </select></label>
          <button disabled={create.isPending}>Create</button>
          <button type="button" className="secondary" disabled={create.isPending} onClick={() => {
            create.reset();
            setCreating(false);
          }}>Cancel</button>
          {create.error && <p role="alert" className="error">{create.error.message}</p>}
        </form>
      ) : <button className="secondary" onClick={() => setCreating(true)}>New profile</button>}
    </nav>
  );
}

function TaskList({ title, tasks, empty }: { title: string; tasks: Task[]; empty: string }) {
  return (
    <div className="task-group">
      <h4>{title}</h4>
      {tasks.length === 0 ? (
        <div className="muted small">{empty}</div>
      ) : (
        <ul>
          {tasks.map((t) => (
            <li key={t.command}>
              <span>{t.command}</span>
              <span className="muted small">{t.nextRun}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Logs({ id }: { id: string }) {
  const lines = useLogs(id);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? lines.filter((l) => l.text.toLowerCase().includes(f)) : lines;
    return list;
  }, [lines, filter]);
  const virtualLog = useVirtualizer({
    count: shown.length,
    getScrollElement: () => ref.current,
    getItemKey: (index) => shown[index].seq,
    estimateSize: () => 18,
    overscan: 8,
    useFlushSync: false,
  });

  useEffect(() => {
    if (follow && shown.length) virtualLog.scrollToIndex(shown.length - 1, { align: "end" });
  }, [shown, follow, virtualLog]);

  const download = () => {
    const blob = new Blob([shown.map((l) => l.text).join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${id}-log.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="card logs-card">
      <div className="card-head">
        <h3>Log</h3>
        <input aria-label="Filter logs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <button className="secondary" onClick={download}>
          Export
        </button>
      </div>
      <div className="log" ref={ref} role="region" aria-label="Recent log lines" tabIndex={0}>
        {shown.length === 0 ? (
          <div className="muted">No log lines yet.</div>
        ) : (
          <div className="log-lines" style={{ height: virtualLog.getTotalSize() }}>
            {virtualLog.getVirtualItems().map((item) => {
              const line = shown[item.index];
              const severity = /ERROR|CRITICAL|Traceback/.test(line.text) ? "log-error" : /WARNING/.test(line.text) ? "log-warn" : "";
              return <div key={item.key} ref={virtualLog.measureElement} data-index={item.index}
                className={`log-line ${severity}`} style={{ transform: `translateY(${item.start}px)` }}>{line.text}</div>;
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function InstancePanel({ status, tab, onTab }: { status: InstanceStatus; tab: Tab; onTab: (tab: Tab) => void }) {
  useNow(1000);
  const qc = useQueryClient();
  const tasks = useQuery({
    queryKey: ["tasks", status.id], queryFn: () => api.tasks(status.id), refetchInterval: 10000,
    enabled: tab === "scheduler" || tab === "overview",
  });
  const lines = useLogs(status.id);
  const history = useMemo(() => lines.filter((line) => line.text.includes("Scheduler: End task")).slice(-30).reverse(), [lines]);
  const command = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => api.command(status.id, action),
    onSuccess: (next) => {
      qc.setQueryData<InstanceStatus[]>(["instances"], (old) => old?.map((s) => (s.id === next.id ? next : s)));
      void qc.invalidateQueries({ queryKey: ["tasks", status.id] });
    },
  });
  const busy = status.unmanaged || command.isPending || status.state === "starting" || status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";

  return (
    <main className="main">
      <section className="card">
        <div className="card-head">
          <h2>{status.id}</h2>
          <StateBadge state={status.state} />
          <div className="tabs">
            {TABS.map((name) => (
              <button key={name} aria-pressed={tab === name} className={tab === name ? "" : "secondary"} onClick={() => onTab(name)}>
                {TAB_LABELS[name]}
              </button>
            ))}
          </div>
          <div className="actions">
            {!alive && (
              <button disabled={busy} onClick={() => command.mutate("start")}>
                Start
              </button>
            )}
            {alive && (
              <button className="danger" disabled={busy} onClick={() => command.mutate("stop")}>
                Stop
              </button>
            )}
            <button className="secondary" disabled={busy} onClick={() => command.mutate("restart")}>
              Restart
            </button>
          </div>
        </div>
        {command.error && <div className="error">{(command.error as Error).message}</div>}
        {status.lastError && <div className="error">{status.lastError}</div>}
        <dl className="stats">
          <div>
            <dt>Current task</dt>
            <dd>{status.currentTask ?? "—"}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{alive ? since(status.startedAt) : "—"}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{status.lastActivityAt ? `${since(status.lastActivityAt)} ago` : "—"}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{status.processId ?? "—"}</dd>
          </div>
          <div>
            <dt>Exit code</dt>
            <dd>{status.exitCode ?? "—"}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{status.revision}</dd>
          </div>
        </dl>
      </section>

      {tab === "settings" ? (
        <Settings key={status.id} id={status.id} />
      ) : tab === "health" ? (
        <HealthPanel key={status.id} status={status} />
      ) : tab === "logs" ? (
        <Logs key={status.id} id={status.id} />
      ) : (
        <>
      <section className="card">
        <div className="card-head">
          <h3>Scheduler</h3>
          {tasks.isError && <span className="text-failed small">{(tasks.error as Error).message}</span>}
        </div>
        <div className="tasks">
          <TaskList title="Running" tasks={tasks.data?.running ?? []} empty="Nothing running" />
          <TaskList title="Pending" tasks={tasks.data?.pending ?? []} empty="No pending tasks" />
          <TaskList title="Waiting" tasks={tasks.data?.waiting ?? []} empty="No waiting tasks" />
        </div>
      </section>

      {tab === "scheduler" && <section className="card">
        <h3>Recent task completions</h3>
        {history.length ? <ul>{history.map((line) => <li key={line.seq}>{line.text}</li>)}</ul>
          : <p className="muted">No completed tasks in the live log.</p>}
      </section>}
        </>
      )}
    </main>
  );
}

export function App() {
  const qc = useQueryClient();
  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances, refetchInterval: 30000 });
  const locked = instances.error instanceof ApiError && instances.error.status === 401;

  const ready = instances.isSuccess;
  useEffect(() => {
    if (ready && !locked) return connectEvents(qc);
  }, [qc, ready, locked]);

  const list = instances.data ?? [];
  const [selected, tab, go] = useRoute(list.map((s) => s.id));
  const current = list.find((s) => s.id === selected);

  if (locked) {
    return <Login onDone={() => void instances.refetch()} />;
  }

  return (
    <div className="app">
      <Header />
      <div className="body">
        <InstanceList instances={list} selected={selected} onSelect={(id) => go(id, tab)} onCreate={(id) => go(id, "settings")} />
        {current ? (
          <InstancePanel status={current} tab={tab} onTab={(next) => go(current.id, next)} />
        ) : (
          <main className="main">
            <div className="card muted">
              {instances.isLoading ? "Loading…" : instances.error ? (instances.error as Error).message : "No instances"}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
