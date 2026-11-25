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
}

export interface Health {
  status: string;
  apiVersion: number;
  time: string;
  serverPid: number;
  uptimeSeconds: number;
  instances: { total: number; running: number; failed: number };
  logQueueManagerAlive?: boolean | null;
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

export const API = "/api/v1";
const TOKEN_KEY = "alas.token";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
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

async function request<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const token = currentToken();
  const res = await fetch(API + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } }).error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? res.statusText);
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
};

export function eventsUrl(): string {
  const token = currentToken();
  return token ? `${API}/events?access_token=${encodeURIComponent(token)}` : `${API}/events`;
}
