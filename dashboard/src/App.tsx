import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, setToken, type InstanceStatus, type LogLine, type Task } from "./api";
import { connectEvents, useConnection } from "./events";
import { useLogs } from "./logStore";
import { HealthPanel } from "./HealthPanel";
import { Settings } from "./Settings";
import { formatDuration, healthTone, since, statusLine, untilNextRun } from "./status";

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

function useNow(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
}

type Theme = "system" | "light" | "dark";
const THEME_KEY = "alas.theme";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* not remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}

// ------------------------------------------------------------------ icons

const paths = {
  play: "M5 3.5v9l7.5-4.5z",
  stop: "M4 4h8v8H4z",
  restart: "M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3",
  plus: "M8 3v10M3 8h10",
  download: "M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10",
};

function Icon({ name }: { name: keyof typeof paths }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------ shell pieces

function Pill({ tone, pulse, large, children }: { tone: string; pulse?: boolean; large?: boolean; children: ReactNode }) {
  return <span className={`pill tone-${tone}${pulse ? " pulse" : ""}${large ? " pill-lg" : ""}`}>{children}</span>;
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">AL</span>
      <span>
        ALAS Control Center
        <small>Local automation server</small>
      </span>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="center-screen">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value);
          onDone();
        }}
      >
        <Brand />
        <div>
          <h2>Password required</h2>
          <p className="muted small">This server is protected. The password is kept for this browser tab only.</p>
        </div>
        <label className="sr-only" htmlFor="password">Password</label>
        <input id="password" type="password" autoFocus placeholder="Password" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn btn-primary" type="submit">Unlock</button>
      </form>
    </div>
  );
}

function TopBar({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  useNow(5000);
  const connection = useConnection();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15000 });
  const h = health.data;
  const overall = h?.health?.status;
  return (
    <header className="topbar">
      <Brand />
      <div className="topbar-stats">
        <span className="stat-chip" title="Live updates from the server">
          <span className={`dot tone-${connection === "open" ? "ok" : connection === "connecting" ? "warn" : "bad"}`} />
          {connection === "open" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
        {overall && (
          <span className="stat-chip">
            <span className={`dot tone-${overall === "ok" ? "ok" : overall === "warn" ? "warn" : "bad"}`} />
            Health <strong>{overall === "ok" ? "OK" : overall === "warn" ? "Warning" : "Failing"}</strong>
          </span>
        )}
        {h && (
          <>
            <span className="stat-chip">
              <strong>{h.instances.running}</strong>/{h.instances.total} running
            </span>
            <span className="stat-chip">Up <strong>{formatDuration(h.uptimeSeconds)}</strong></span>
          </>
        )}
        {h?.logQueueManagerAlive === false && <span className="stat-chip text-bad">Log queue down</span>}
        <div className="theme-toggle" role="group" aria-label="Theme">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button key={t} aria-pressed={theme === t} onClick={() => onTheme(t)}>
              {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function Rail({
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
  useNow(15000);
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
    <nav className="rail" aria-label="Instances">
      <div className="rail-head">
        <span className="eyebrow">Instances</span>
        <span className="muted small">{instances.length}</span>
      </div>
      {instances.map((s) => {
        const tone = healthTone(s);
        const flag = s.health?.recovery.gaveUp ? "gave up" : s.health?.state === "human_takeover" ? "needs you"
          : s.health?.state === "stalled" ? "stalled" : s.unmanaged ? "external" : null;
        return (
          <button key={s.id} className="fleet-card" onClick={() => onSelect(s.id)}
            aria-current={s.id === selected ? "true" : undefined}>
            <span className={`dot tone-${tone.tone}`} />
            <span className="fleet-name">{s.id}</span>
            {flag ? <span className={`fleet-flag text-${tone.tone === "bad" ? "bad" : "warn"}`}>{flag}</span> : <span />}
            <span className="fleet-sub">{statusLine(s)}</span>
          </button>
        );
      })}
      {creating ? (
        <form className="profile-form" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          create.mutate({ id: String(fields.get("name")).trim(), source: String(fields.get("source")) || null });
        }}>
          <label>Profile name <input name="name" required maxLength={48} autoFocus /></label>
          <label>Copy from <select name="source">
            <option value="">Default settings</option>
            {instances.map((instance) => <option key={instance.id}>{instance.id}</option>)}
          </select></label>
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={create.isPending}>Create</button>
            <button type="button" className="btn btn-sm" disabled={create.isPending} onClick={() => {
              create.reset();
              setCreating(false);
            }}>Cancel</button>
          </div>
          {create.error && <p role="alert" className="text-bad small">{create.error.message}</p>}
        </form>
      ) : (
        <button className="btn new-profile" onClick={() => setCreating(true)}>
          <Icon name="plus" />New profile
        </button>
      )}
    </nav>
  );
}

// ------------------------------------------------------------------ views

function severity(text: string): "error" | "warn" | "" {
  if (/ERROR|CRITICAL|Traceback/.test(text)) return "error";
  if (/WARNING/.test(text)) return "warn";
  return "";
}

function LogPeek({ id, onOpen }: { id: string; onOpen: () => void }) {
  const lines = useLogs(id);
  const last = lines.slice(-14);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [last]);
  return (
    <section className="terminal">
      <div className="terminal-bar">
        <span>Live log</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onOpen}>Open logs</button>
      </div>
      <div className="log log-peek log-static" ref={ref} role="region" aria-label="Latest log lines" tabIndex={0}>
        {last.length === 0 ? <div className="log-empty">No log lines yet.</div> : last.map((line) => (
          <div key={line.seq} className={`log-line ${severity(line.text) && `log-${severity(line.text)}`}`}>{line.text}</div>
        ))}
      </div>
    </section>
  );
}

function QueueList({ items, runningNow, empty }: { items: Task[]; runningNow?: Task[]; empty: string }) {
  if (!items.length && !runningNow?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="queue">
      {runningNow?.map((t) => (
        <div key={`now-${t.command}`} className="queue-item now">
          <strong>{t.command}</strong>
          <span className="when">running now</span>
        </div>
      ))}
      {items.map((t) => (
        <div key={t.command} className="queue-item">
          <span>{t.command}</span>
          <span className="when" title={t.nextRun ?? undefined}>{t.nextRun ? untilNextRun(t.nextRun) : "not scheduled"}</span>
        </div>
      ))}
    </div>
  );
}

function Overview({ status, onTab }: { status: InstanceStatus; onTab: (tab: Tab) => void }) {
  const alive = status.state === "running" || status.state === "starting";
  const tasks = useQuery({ queryKey: ["tasks", status.id], queryFn: () => api.tasks(status.id), refetchInterval: 10000 });
  const upNext = [...(tasks.data?.pending ?? []), ...(tasks.data?.waiting ?? [])].slice(0, 7);
  const health = status.health;
  const policy = health?.recovery.policy;
  return (
    <>
      <dl className="metrics">
        <div className="metric"><dt>Current task</dt><dd>{status.currentTask ?? (alive ? "Waiting" : "—")}</dd></div>
        <div className="metric"><dt>Uptime</dt><dd>{alive ? since(status.startedAt) : "—"}</dd></div>
        <div className="metric"><dt>Last activity</dt><dd>{status.lastActivityAt ? <>{since(status.lastActivityAt)} <small>ago</small></> : "—"}</dd></div>
        <div className="metric">
          <dt>Tasks this run</dt>
          <dd>{status.taskSuccesses ?? 0} <small>done</small>{status.taskFailures ? <> · <span className="text-bad">{status.taskFailures}</span> <small>failed</small></> : null}</dd>
        </div>
      </dl>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Up next</h3>
            <div className="right">
              <button className="btn btn-ghost btn-sm" onClick={() => onTab("scheduler")}>Full schedule</button>
            </div>
          </div>
          {tasks.isError ? <div className="text-bad small">{(tasks.error as Error).message}</div>
            : tasks.isLoading ? <div className="skeleton" />
              : <QueueList items={upNext} runningNow={tasks.data?.running} empty="No tasks are scheduled." />}
        </section>
        <LogPeek id={status.id} onOpen={() => onTab("logs")} />
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Process</h3>
          <div className="right">
            <button className="btn btn-ghost btn-sm" onClick={() => onTab("health")}>Health and recovery</button>
          </div>
        </div>
        <dl className="kv">
          <dt>Health</dt><dd>{health ? `${healthTone(status).label}${health.detail ? ` — ${health.detail}` : ""}` : "Not checked yet"}</dd>
          <dt>Recovery</dt>
          <dd>{policy ? [policy.autoRestart && "restart on crash", policy.restartOnStall && `restart after ${policy.stallMinutes} min stall`]
            .filter(Boolean).join(", ") || "off" : "—"}</dd>
          <dt>Process ID</dt><dd className="mono">{status.processId ?? "—"}</dd>
          <dt>Started</dt><dd>{status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"}</dd>
          <dt>Stopped</dt><dd>{status.stoppedAt ? new Date(status.stoppedAt).toLocaleString() : "—"}</dd>
          <dt>Exit code</dt><dd className="mono">{status.exitCode ?? "—"}</dd>
        </dl>
      </section>
    </>
  );
}

function Scheduler({ status }: { status: InstanceStatus }) {
  const tasks = useQuery({ queryKey: ["tasks", status.id], queryFn: () => api.tasks(status.id), refetchInterval: 10000 });
  const lines = useLogs(status.id);
  const history = useMemo(() => lines.filter((line) => line.text.includes("Scheduler: End task")).slice(-30).reverse(), [lines]);
  return (
    <>
      {tasks.isError && <div className="banner tone-bad"><div className="banner-body">{(tasks.error as Error).message}</div></div>}
      <div className="grid grid-3">
        <section className="card">
          <div className="card-head"><h3>Running</h3></div>
          <QueueList items={[]} runningNow={tasks.data?.running} empty="Nothing is running." />
        </section>
        <section className="card">
          <div className="card-head"><h3>Pending</h3><span className="muted small">due, in priority order</span></div>
          <QueueList items={tasks.data?.pending ?? []} empty="No pending tasks." />
        </section>
        <section className="card">
          <div className="card-head"><h3>Waiting</h3><span className="muted small">by next run</span></div>
          <QueueList items={tasks.data?.waiting ?? []} empty="No waiting tasks." />
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h3>Recent task completions</h3><span className="muted small">from the live log</span></div>
        {history.length ? (
          <div className="queue">
            {history.map((line) => <div key={line.seq} className="queue-item"><span className="mono small">{line.text}</span></div>)}
          </div>
        ) : <div className="empty">No completed tasks in the live log.</div>}
      </section>
    </>
  );
}

type Level = "all" | "warn" | "error";

function Logs({ id }: { id: string }) {
  const lines = useLogs(id);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines.filter((l: LogLine) => {
      if (f && !l.text.toLowerCase().includes(f)) return false;
      const s = severity(l.text);
      return level === "all" || (level === "error" ? s === "error" : s !== "");
    });
  }, [lines, filter, level]);
  const virtualLog = useVirtualizer({
    count: shown.length,
    getScrollElement: () => ref.current,
    getItemKey: (index) => shown[index].seq,
    estimateSize: () => 18,
    overscan: 12,
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
    <section className="terminal">
      <div className="terminal-bar">
        <input aria-label="Filter logs" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="seg" role="group" aria-label="Log level">
          {(["all", "warn", "error"] as Level[]).map((l) => (
            <button key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>
              {l === "all" ? "All" : l === "warn" ? "Warnings+" : "Errors"}
            </button>
          ))}
        </div>
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
        <button className="btn btn-sm" onClick={download}><Icon name="download" />Export</button>
        <span className="count">{shown.length.toLocaleString()} / {lines.length.toLocaleString()} lines</span>
      </div>
      <div className="log log-full" ref={ref} role="region" aria-label="Recent log lines" tabIndex={0}>
        {shown.length === 0 ? (
          <div className="log-empty">{lines.length ? "No line matches the filter." : "No log lines yet."}</div>
        ) : (
          <div className="log-lines" style={{ height: virtualLog.getTotalSize() }}>
            {virtualLog.getVirtualItems().map((item) => {
              const line = shown[item.index];
              const s = severity(line.text);
              return <div key={item.key} ref={virtualLog.measureElement} data-index={item.index}
                className={`log-line ${s && `log-${s}`}`} style={{ transform: `translateY(${item.start}px)` }}>{line.text}</div>;
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function Banners({ status, commandError }: { status: InstanceStatus; commandError: Error | null }) {
  const h = status.health;
  const items: { tone: string; title: string; body: string }[] = [];
  if (commandError) items.push({ tone: "bad", title: "Command failed", body: commandError.message });
  if (status.unmanaged) items.push({ tone: "warn", title: "Started outside this server",
    body: "This worker was found running from an earlier server. It is shown here but cannot be controlled until it exits." });
  if (h?.state === "human_takeover") items.push({ tone: "bad", title: "Alas needs you",
    body: "It stopped and asked for a person (for example a task failed 3 times, or the emulator is not reachable). Check the log, fix the cause, then start it again." });
  else if (h?.recovery.gaveUp) items.push({ tone: "bad", title: "Automatic recovery gave up",
    body: "Too many restarts within an hour. Start it manually once the cause is fixed." });
  else if (h?.state === "crashed" && h.recovery.nextAttemptAt) items.push({ tone: "warn", title: "Crashed — restarting automatically",
    body: `Next attempt ${untilNextRun(h.recovery.nextAttemptAt)}. ${h.detail}` });
  else if (h?.state === "stalled") items.push({ tone: "warn", title: "Task looks stalled", body: h.detail });
  else if (status.state === "failed" && status.lastError) items.push({ tone: "bad", title: "Worker stopped on an error", body: status.lastError });
  return (
    <>
      {items.map((b) => (
        <div key={b.title} className={`banner tone-${b.tone}`} role={b.tone === "bad" ? "alert" : "status"}>
          <div className="banner-body"><strong>{b.title}</strong>{b.body}</div>
        </div>
      ))}
    </>
  );
}

function Workspace({ status, tab, onTab }: { status: InstanceStatus; tab: Tab; onTab: (tab: Tab) => void }) {
  useNow(1000);
  const qc = useQueryClient();
  const command = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => api.command(status.id, action),
    onSuccess: (next) => {
      qc.setQueryData<InstanceStatus[]>(["instances"], (old) => old?.map((s) => (s.id === next.id ? next : s)));
      void qc.invalidateQueries({ queryKey: ["tasks", status.id] });
    },
  });
  const busy = status.unmanaged || command.isPending || status.state === "starting" || status.state === "stopping";
  const alive = status.state === "running" || status.state === "starting";
  const tone = healthTone(status);

  return (
    <main className="workspace">
      <div className="ws-head">
        <div className="ws-title">
          <h2>{status.id}</h2>
          <Pill tone={tone.tone} pulse={status.state === "running"} large>{tone.label}</Pill>
          <span className="sub">{statusLine(status)}</span>
          <div className="ws-actions">
            {alive ? (
              <button className="btn btn-danger" disabled={busy} onClick={() => command.mutate("stop")}>
                <Icon name="stop" />Stop
              </button>
            ) : (
              <button className="btn btn-primary" disabled={busy} onClick={() => command.mutate("start")}>
                <Icon name="play" />Start
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => command.mutate("restart")}>
              <Icon name="restart" />Restart
            </button>
          </div>
        </div>
        <div className="tabbar">
          {TABS.map((name) => (
            <button key={name} aria-pressed={tab === name} onClick={() => onTab(name)}>{TAB_LABELS[name]}</button>
          ))}
        </div>
      </div>
      <div className="ws-body">
        <Banners status={status} commandError={command.error as Error | null} />
        {tab === "settings" ? <Settings key={status.id} id={status.id} />
          : tab === "health" ? <HealthPanel key={status.id} status={status} />
            : tab === "logs" ? <Logs key={status.id} id={status.id} />
              : tab === "scheduler" ? <Scheduler status={status} />
                : <Overview status={status} onTab={onTab} />}
      </div>
    </main>
  );
}

export function App() {
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
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
    <div className="shell">
      <TopBar theme={theme} onTheme={setTheme} />
      <Rail instances={list} selected={selected} onSelect={(id) => go(id, tab)} onCreate={(id) => go(id, "settings")} />
      {current ? (
        <Workspace status={current} tab={tab} onTab={(next) => go(current.id, next)} />
      ) : (
        <main className="workspace">
          <div className="empty-state">
            {instances.isLoading ? <span>Loading instances…</span>
              : instances.error ? <span className="text-bad">{(instances.error as Error).message}</span>
                : <><h2>No instances yet</h2><span>Create a profile from the sidebar to get started.</span></>}
          </div>
        </main>
      )}
    </div>
  );
}
