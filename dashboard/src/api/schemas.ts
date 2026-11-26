import * as z from "zod";

// Runtime contract for every response the dashboard reads. Types are inferred from these
// schemas; schemas.test.ts keeps them in step with the OpenAPI types in generated.ts.
// z.object strips unknown keys, so a newer server can add fields without breaking the UI.

const timestamp = z.iso.datetime({ offset: true });
const count = z.int().nonnegative();

export const INSTANCE_STATES = ["stopped", "starting", "running", "stopping", "failed"] as const;
export const HEALTH_STATES = [
  "ok",
  "idle",
  "stopped",
  "stalled",
  "crashed",
  "human_takeover",
  "waiting_retry",
  "unmanaged",
] as const;
export const CHECK_STATUSES = ["ok", "warn", "fail"] as const;
export const FIELD_TYPES = [
  "input",
  "select",
  "checkbox",
  "datetime",
  "textarea",
  "storage",
  "lock",
  "state",
] as const;

export const MAX_STALL_MINUTES = 1440;
export const MAX_RESTARTS_PER_HOUR = 60;

// ------------------------------------------------------------------ instances

export const InstancePolicySchema = z.object({
  autoRestart: z.boolean(),
  restartOnStall: z.boolean(),
  stallMinutes: z.int().min(0).max(MAX_STALL_MINUTES),
});

export const InstanceRecoverySchema = z.object({
  gaveUp: z.boolean(),
  nextAttemptAt: timestamp.nullable(),
  pendingReason: z.string().nullable(),
  policy: InstancePolicySchema,
  restartsLastHour: count,
});

export const InstanceHealthSchema = z.object({
  state: z.enum(HEALTH_STATES),
  detail: z.string(),
  recovery: InstanceRecoverySchema,
});

export const InstanceStatusSchema = z.object({
  id: z.string().min(1),
  state: z.enum(INSTANCE_STATES),
  processId: z.int().nullable(),
  startedAt: timestamp.nullable(),
  stoppedAt: timestamp.nullable(),
  exitCode: z.int().nullable(),
  currentTask: z.string().nullable(),
  lastActivityAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  legacyState: z.int(),
  revision: z.int(),
  runLogStartSeq: count,
  logDraining: z.boolean(),
  unmanaged: z.boolean(),
  taskFailures: count,
  taskSuccesses: count,
  // null until the health monitor has checked the instance
  health: InstanceHealthSchema.nullable().exactOptional(),
});

export const InstancesSchema = z.object({ instances: z.array(InstanceStatusSchema) });

// ------------------------------------------------------------------ health

export const HealthCheckSchema = z.object({
  name: z.string(),
  status: z.enum(CHECK_STATUSES),
  detail: z.string(),
});

export const HealthChecksSchema = z.object({
  status: z.enum(CHECK_STATUSES),
  checks: z.array(HealthCheckSchema),
});

export const InstanceCountsSchema = z.object({ total: count, running: count, failed: count });

export const HealthSchema = z.object({
  status: z.string(),
  apiVersion: z.int(),
  time: timestamp,
  serverPid: z.int(),
  uptimeSeconds: z.number().nonnegative(),
  instances: InstanceCountsSchema,
  logQueueManagerAlive: z.boolean().nullable().exactOptional(),
  health: HealthChecksSchema.exactOptional(),
});

export const MetricsSchema = z.object({
  taskSuccesses: count,
  taskFailures: count,
  workerRestarts: count,
  sseConnections: count,
});

export const HealthDetailsSchema = HealthSchema.extend({
  metrics: MetricsSchema,
  instanceDetails: z.array(InstanceStatusSchema),
});

// ------------------------------------------------------------------ scheduler and logs

export const TaskSchema = z.object({ command: z.string(), nextRun: z.string().nullable() });

export const TasksSchema = z.object({
  running: z.array(TaskSchema),
  pending: z.array(TaskSchema),
  waiting: z.array(TaskSchema),
});

export const LogLineSchema = z.object({ seq: z.int().positive(), text: z.string() });

export const LogChunkSchema = z.object({ lines: z.array(LogLineSchema), lastSeq: count });

// ------------------------------------------------------------------ configuration

export const ConfigValueSchema = z.union([z.string(), z.boolean(), z.number()]);

export const ConfigOptionSchema = z.object({
  value: ConfigValueSchema.nullable(),
  label: z.string(),
});

export const ConfigFieldSchema = z.object({
  path: z.string(),
  type: z.enum(FIELD_TYPES),
  label: z.string(),
  help: z.string(),
  default: ConfigValueSchema.nullable(),
  readOnly: z.boolean(),
  options: z.array(ConfigOptionSchema).exactOptional(),
  validate: z.string().exactOptional(),
  valuetype: z.string().exactOptional(),
});

export const ConfigGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  help: z.string(),
  fields: z.array(ConfigFieldSchema),
});

export const ConfigTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  help: z.string(),
  groups: z.array(ConfigGroupSchema),
});

export const ConfigMenuSchema = z.object({
  id: z.string(),
  name: z.string(),
  tasks: z.array(ConfigTaskSchema),
});

export const ConfigSchemaSchema = z.object({ lang: z.string(), menus: z.array(ConfigMenuSchema) });

// The config itself is ALAS's nested task/group/argument document: validated as an object
// here, its values are read through the schema above.
export const ConfigDocSchema = z.object({
  revision: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

export const ConfigAppliedSchema = z.object({
  revision: z.string().min(1),
  applied: z.record(z.string(), z.unknown()),
});

// ------------------------------------------------------------------ recovery

// Explicit exactOptional: .partial() would add `| undefined`, which exactOptionalPropertyTypes rejects.
export const PolicyOverrideSchema = z.object({
  autoRestart: InstancePolicySchema.shape.autoRestart.exactOptional(),
  restartOnStall: InstancePolicySchema.shape.restartOnStall.exactOptional(),
  stallMinutes: InstancePolicySchema.shape.stallMinutes.exactOptional(),
});

export const RecoveryPolicySchema = z.object({
  maxRestartsPerHour: z.int().min(0).max(MAX_RESTARTS_PER_HOUR),
  backoffSeconds: z.array(count),
  instances: z.record(z.string(), PolicyOverrideSchema),
});

export const RecoveryEventSchema = z.object({
  time: timestamp,
  instanceId: z.string(),
  action: z.string(),
  reason: z.string(),
  detail: z.string(),
});

export const RecoverySnapshotSchema = z.object({
  policy: RecoveryPolicySchema,
  history: z.array(RecoveryEventSchema),
});

export const PolicyAppliedSchema = z.object({ policy: RecoveryPolicySchema });

// ------------------------------------------------------------------ requests

export const PolicyUpdateSchema = z.object({
  maxRestartsPerHour: RecoveryPolicySchema.shape.maxRestartsPerHour.exactOptional(),
  backoffSeconds: z.array(count).exactOptional(),
  instances: z.record(z.string(), PolicyOverrideSchema).exactOptional(),
});

// Same rule as the server (module/control/configuration.py).
const RESERVED_NAME = /^(template.*|con|prn|aux|nul|com\d|lpt\d)$/i;

export const ProfileNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/, {
    error: "Use 1–48 letters, digits, hyphens or underscores, starting with a letter or digit",
  })
  .refine((name) => !RESERVED_NAME.test(name), { error: "This profile name is reserved" });

export const ApiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ------------------------------------------------------------------ types

export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type InstanceHealth = z.infer<typeof InstanceHealthSchema>;
export type InstancePolicy = z.infer<typeof InstancePolicySchema>;
export type Health = z.infer<typeof HealthSchema>;
export type HealthDetails = z.infer<typeof HealthDetailsSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Tasks = z.infer<typeof TasksSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type LogChunk = z.infer<typeof LogChunkSchema>;
export type ConfigValue = z.infer<typeof ConfigFieldSchema>["default"];
export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type ConfigTask = z.infer<typeof ConfigTaskSchema>;
export type ConfigSchema = z.infer<typeof ConfigSchemaSchema>;
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;
export type RecoverySnapshot = z.infer<typeof RecoverySnapshotSchema>;
export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>;
