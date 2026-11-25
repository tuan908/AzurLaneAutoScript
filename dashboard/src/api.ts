import type { components, operations } from "./api.generated";

type Schemas = components["schemas"];
export type InstanceStatus = Schemas["InstanceStatus"];
export type InstancePolicy = Schemas["InstancePolicy"];
export type Task = Schemas["Task"];
export type LogLine = Schemas["LogLine"];
export type ConfigValue = Schemas["ConfigField"]["default"];
export type ConfigField = Schemas["ConfigField"];
export type ConfigTask = Schemas["ConfigTask"];

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
  health: () => request<Schemas["Health"]>("/health"),
  healthDetails: () => request<Schemas["HealthDetails"]>("/health/details"),
  instances: () => request<Schemas["Instances"]>("/instances").then((r) => r.instances),
  instance: (id: string) => request<InstanceStatus>(`/instances/${encodeURIComponent(id)}`),
  createProfile: (id: string, source: string | null) => request<InstanceStatus>("/instances", "POST", { id, source }),
  tasks: (id: string) => request<Schemas["Tasks"]>(`/instances/${encodeURIComponent(id)}/tasks`),
  logs: (id: string, after = 0, limit = 2000) =>
    request<Schemas["LogChunk"]>(`/instances/${encodeURIComponent(id)}/logs?after=${after}&limit=${limit}`),
  command: (id: string, action: "start" | "stop" | "restart") =>
    request<InstanceStatus>(`/instances/${encodeURIComponent(id)}/${action}`, "POST"),
  configSchema: (id: string, lang: string) =>
    request<Schemas["ConfigSchema"]>(`/instances/${encodeURIComponent(id)}/config/schema?lang=${encodeURIComponent(lang)}`),
  config: (id: string) => request<Schemas["ConfigDoc"]>(`/instances/${encodeURIComponent(id)}/config`),
  recovery: () => request<Schemas["RecoverySnapshot"]>("/recovery"),
  updatePolicy: (changes: operations["recovery_policy"]["requestBody"]["content"]["application/json"]) =>
    request<Schemas["PolicyApplied"]>("/recovery/policy", "PATCH", changes),
  updateConfig: (id: string, revision: string, changes: Record<string, ConfigValue>) =>
    request<Schemas["ConfigApplied"]>(
      `/instances/${encodeURIComponent(id)}/config`,
      "PATCH",
      { revision, changes },
    ),
};

export function openEvents(signal: AbortSignal): Promise<Response> {
  const token = currentToken();
  return fetch(`${API}/events`, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
