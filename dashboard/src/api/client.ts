import * as z from "zod";

import {
  ApiErrorBodySchema,
  ConfigAppliedSchema,
  ConfigDocSchema,
  ConfigSchemaSchema,
  HealthDetailsSchema,
  HealthSchema,
  InstancesSchema,
  InstanceStatusSchema,
  LogChunkSchema,
  PolicyAppliedSchema,
  RecoverySnapshotSchema,
  TasksSchema,
  type ConfigValue,
  type PolicyUpdate,
} from "./schemas";

export type {
  ConfigField,
  ConfigSchema,
  ConfigTask,
  ConfigValue,
  InstancePolicy,
  InstanceStatus,
  LogLine,
  Task,
} from "./schemas";

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

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  method: "GET" | "POST" | "PATCH" = "GET",
  json?: unknown,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const token = currentToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, {
    method,
    headers,
    ...(signal ? { signal } : {}),
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const body: unknown = await res.json().catch((error: unknown) => {
    if (res.ok || signal?.aborted) throw error;
    return {};
  });
  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(body);
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    throw parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, record)
      : new ApiError(res.status, "http_error", res.statusText, record);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      "invalid_response",
      `Unexpected response from ${method} ${path}:\n${z.prettifyError(parsed.error)}`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

const instancePath = (id: string) => `/instances/${encodeURIComponent(id)}`;

export const api = {
  health: (signal?: AbortSignal) => request("/health", HealthSchema, "GET", undefined, signal),
  healthDetails: (signal?: AbortSignal) =>
    request("/health/details", HealthDetailsSchema, "GET", undefined, signal),
  instances: (signal?: AbortSignal) =>
    request("/instances", InstancesSchema, "GET", undefined, signal).then((r) => r.instances),
  instance: (id: string) => request(instancePath(id), InstanceStatusSchema),
  createProfile: (id: string, source: string | null) =>
    request("/instances", InstanceStatusSchema, "POST", { id, source }),
  tasks: (id: string, signal?: AbortSignal) =>
    request(`${instancePath(id)}/tasks`, TasksSchema, "GET", undefined, signal),
  logs: (id: string, after = 0, limit = 2000, signal?: AbortSignal) =>
    request(
      `${instancePath(id)}/logs?after=${after}&limit=${limit}`,
      LogChunkSchema,
      "GET",
      undefined,
      signal,
    ),
  command: (id: string, action: "start" | "stop" | "restart") =>
    request(`${instancePath(id)}/${action}`, InstanceStatusSchema, "POST"),
  configSchema: (id: string, lang: string, signal?: AbortSignal) =>
    request(
      `${instancePath(id)}/config/schema?lang=${encodeURIComponent(lang)}`,
      ConfigSchemaSchema,
      "GET",
      undefined,
      signal,
    ),
  config: (id: string, signal?: AbortSignal) =>
    request(`${instancePath(id)}/config`, ConfigDocSchema, "GET", undefined, signal),
  recovery: (signal?: AbortSignal) =>
    request("/recovery", RecoverySnapshotSchema, "GET", undefined, signal),
  updatePolicy: (changes: PolicyUpdate) =>
    request("/recovery/policy", PolicyAppliedSchema, "PATCH", changes),
  updateConfig: (id: string, revision: string, changes: Record<string, ConfigValue>) =>
    request(`${instancePath(id)}/config`, ConfigAppliedSchema, "PATCH", { revision, changes }),
};

export function openEvents(signal: AbortSignal): Promise<Response> {
  const token = currentToken();
  return fetch(`${API}/events`, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
