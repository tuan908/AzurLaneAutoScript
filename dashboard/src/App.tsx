import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, setToken, type InstanceStatus, type Task } from "./api";
import { connectEvents, useConnection } from "./events";
import { useLogs } from "./logStore";
import { Settings } from "./Settings";

type Tab = "overview" | "settings";

/** Location is #/<instance>/<tab> */
function useRoute(ids: string[]): [string | null, Tab, (id: string, tab?: Tab) => void] {
  const read = (): [string | null, Tab] => {
    const [id, tab] = window.location.hash.replace(/^#\/?/, "").split("/");
    return [id ? decodeURIComponent(id) : null, tab === "settings" ? "settings" : "overview"];
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
}: {
  instances: InstanceStatus[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="sidebar">
      <h3>Instances</h3>
      {instances.map((s) => (
        <button
          key={s.id}
          className={`instance-item ${s.id === selected ? "active" : ""}`}
          onClick={() => onSelect(s.id)}
        >
          <span className="instance-name">{s.id}</span>
          <StateBadge state={s.state} />
          <span className="muted small">{s.currentTask ?? (s.state === "running" ? "waiting for task" : "")}</span>
        </button>
      ))}
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
    // Render the most recent lines only; the store already caps memory
    return list.slice(-1000);
  }, [lines, filter]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown, follow]);

  const download = () => {
    const blob = new Blob([lines.map((l) => l.text).join("\n")], { type: "text/plain" });
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
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <button className="secondary" onClick={download}>
          Export
        </button>
      </div>
      <div className="log" ref={ref}>
        {shown.length === 0 ? (
          <div className="muted">No log lines yet.</div>
        ) : (
          shown.map((l) => (
            <div key={l.seq} className={`log-line ${/ERROR|CRITICAL|Traceback/.test(l.text) ? "log-error" : /WARNING/.test(l.text) ? "log-warn" : ""}`}>
              {l.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function InstancePanel({ status, tab, onTab }: { status: InstanceStatus; tab: Tab; onTab: (tab: Tab) => void }) {
  useNow(1000);
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks", status.id], queryFn: () => api.tasks(status.id), refetchInterval: 10000 });
  const command = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => api.command(status.id, action),
    onSuccess: (next) => {
      qc.setQueryData<InstanceStatus[]>(["instances"], (old) => old?.map((s) => (s.id === next.id ? next : s)));
      void qc.invalidateQueries({ queryKey: ["tasks", status.id] });
    },
  });
  const busy = command.isPending || status.state === "starting" || status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";

  return (
    <main className="main">
      <section className="card">
        <div className="card-head">
          <h2>{status.id}</h2>
          <StateBadge state={status.state} />
          <div className="tabs">
            <button className={tab === "overview" ? "" : "secondary"} onClick={() => onTab("overview")}>
              Overview
            </button>
            <button className={tab === "settings" ? "" : "secondary"} onClick={() => onTab("settings")}>
              Settings
            </button>
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

      <Logs id={status.id} />
        </>
      )}
    </main>
  );
}

export function App() {
  const qc = useQueryClient();
  const [locked, setLocked] = useState(false);
  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances, refetchInterval: 30000 });

  useEffect(() => connectEvents(qc), [qc]);
  useEffect(() => {
    if (instances.error instanceof ApiError && instances.error.status === 401) setLocked(true);
  }, [instances.error]);

  const list = instances.data ?? [];
  const [selected, tab, go] = useRoute(list.map((s) => s.id));
  const current = list.find((s) => s.id === selected);

  if (locked) {
    return (
      <Login
        onDone={() => {
          setLocked(false);
          window.location.reload();
        }}
      />
    );
  }

  return (
    <div className="app">
      <Header />
      <div className="body">
        <InstanceList instances={list} selected={selected} onSelect={(id) => go(id, tab)} />
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
