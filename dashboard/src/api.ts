export type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface InstanceStatus {
  id: string;
  state: InstanceState;
  processId: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  currentTask: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  legacyState: number;
  revision: number;
  runLogStartSeq: number;
  health?: InstanceHealth | null;
}

export type HealthState = "ok" | "idle" | "stopped" | "stalled" | "crashed" | "human_takeover";

export interface InstancePolicy {
  autoRestart: boolean;
  restartOnStall: boolean;
  stallMinutes: number;
}

export interface InstanceHealth {
  state: HealthState;
  detail: string;
  recovery: {
    policy: InstancePolicy;
    restartsLastHour: number;
    nextAttemptAt: string | null;
    pendingReason: string | null;
    gaveUp: boolean;
  };
}

export interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface RecoveryPolicy {
  maxRestartsPerHour: number;
  backoffSeconds: number[];
  instances: Record<string, Partial<InstancePolicy>>;
}

export interface RecoveryEvent {
  time: string;
  instanceId: string;
  action: string;
  reason: string;
  detail: string;
}

export interface Health {
  status: string;
  apiVersion: number;
  time: string;
  serverPid: number;
  uptimeSeconds: number;
  instances: { total: number; running: number; failed: number };
  logQueueManagerAlive?: boolean | null;
  health?: { status: "ok" | "warn" | "fail"; checks: HealthCheck[] };
}

export interface Task {
  command: string;
  nextRun: string;
}

export interface Tasks {
  running: Task[];
  pending: Task[];
  waiting: Task[];
}

export interface LogLine {
  seq: number;
  text: string;
}

export interface LogChunk {
  lines: LogLine[];
  lastSeq: number;
}

export type FieldType = "input" | "select" | "checkbox" | "datetime" | "textarea" | "lock" | "state";
export type ConfigValue = string | number | boolean | null;

export interface ConfigField {
  path: string;
  type: FieldType;
  label: string;
  help: string;
  default: ConfigValue;
  readOnly: boolean;
  options?: { value: ConfigValue; label: string }[];
  validate?: string;
  valuetype?: string;
}

export interface ConfigGroup {
  id: string;
  name: string;
  help: string;
  fields: ConfigField[];
}

export interface ConfigTask {
  id: string;
  name: string;
  help: string;
  groups: ConfigGroup[];
}

export interface ConfigSchema {
  lang: string;
  menus: { id: string; name: string; tasks: ConfigTask[] }[];
}

export interface ConfigDoc {
  revision: string;
  config: Record<string, unknown>;
}

export const API = "/api/v1";
const TOKEN_KEY = "alas.token";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
  memoryToken = token;
}

let memoryToken = "";

function currentToken() {
  return getToken() || memoryToken;
}

async function request<T>(path: string, method: "GET" | "POST" | "PATCH" = "GET", json?: unknown): Promise<T> {
  const token = currentToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } }).error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? res.statusText, body);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>("/health"),
  instances: () => request<{ instances: InstanceStatus[] }>("/instances").then((r) => r.instances),
  instance: (id: string) => request<InstanceStatus>(`/instances/${encodeURIComponent(id)}`),
  tasks: (id: string) => request<Tasks>(`/instances/${encodeURIComponent(id)}/tasks`),
  logs: (id: string, after = 0, limit = 2000) =>
    request<LogChunk>(`/instances/${encodeURIComponent(id)}/logs?after=${after}&limit=${limit}`),
  command: (id: string, action: "start" | "stop" | "restart") =>
    request<InstanceStatus>(`/instances/${encodeURIComponent(id)}/${action}`, "POST"),
  configSchema: (id: string, lang: string) =>
    request<ConfigSchema>(`/instances/${encodeURIComponent(id)}/config/schema?lang=${encodeURIComponent(lang)}`),
  config: (id: string) => request<ConfigDoc>(`/instances/${encodeURIComponent(id)}/config`),
  recovery: () => request<{ policy: RecoveryPolicy; history: RecoveryEvent[] }>("/recovery"),
  updatePolicy: (changes: Partial<Omit<RecoveryPolicy, "instances">> & { instances?: Record<string, Partial<InstancePolicy>> }) =>
    request<{ policy: RecoveryPolicy }>("/recovery/policy", "PATCH", changes),
  updateConfig: (id: string, revision: string, changes: Record<string, ConfigValue>) =>
    request<{ revision: string; applied: Record<string, ConfigValue> }>(
      `/instances/${encodeURIComponent(id)}/config`,
      "PATCH",
      { revision, changes },
    ),
};

export function eventsUrl(): string {
  const token = currentToken();
  return token ? `${API}/events?access_token=${encodeURIComponent(token)}` : `${API}/events`;
}
