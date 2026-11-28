import { describe, expect, expectTypeOf, it } from "vitest";
import type * as z from "zod";

import { instanceFixture } from "@/api/test-fixtures";

import names from "../../../tests/control/fixtures/profile_names.json";
import contract from "../../openapi.json";
import type { components } from "./generated";
import {
  ConfigAppliedSchema,
  ConfigDocSchema,
  ConfigFieldSchema,
  ConfigSchemaSchema,
  HealthDetailsSchema,
  HealthSchema,
  InstanceHealthSchema,
  InstanceStatusSchema,
  LogChunkSchema,
  PolicyAppliedSchema,
  PolicyOverrideSchema,
  PolicyUpdateSchema,
  MAX_BACKOFF_SECONDS,
  MAX_RESTARTS_PER_HOUR,
  MAX_STALL_MINUTES,
  ProfileNameSchema,
  RecoverySnapshotSchema,
  TasksSchema,
} from "./schemas";

type Api = components["schemas"];
type Out<S extends z.ZodType> = z.output<S>;

describe("schemas match the OpenAPI contract", () => {
  it("infer exactly the generated types", () => {
    expectTypeOf<Out<typeof InstanceStatusSchema>>().toEqualTypeOf<Api["InstanceStatus"]>();
    expectTypeOf<Out<typeof InstanceHealthSchema>>().toEqualTypeOf<Api["InstanceHealth"]>();
    expectTypeOf<Out<typeof HealthSchema>>().toEqualTypeOf<Api["Health"]>();
    expectTypeOf<Out<typeof HealthDetailsSchema>>().toEqualTypeOf<Api["HealthDetails"]>();
    expectTypeOf<Out<typeof TasksSchema>>().toEqualTypeOf<Api["Tasks"]>();
    expectTypeOf<Out<typeof LogChunkSchema>>().toEqualTypeOf<Api["LogChunk"]>();
    expectTypeOf<Out<typeof ConfigFieldSchema>>().toEqualTypeOf<Api["ConfigField"]>();
    expectTypeOf<Out<typeof ConfigSchemaSchema>>().toEqualTypeOf<Api["ConfigSchema"]>();
    expectTypeOf<Out<typeof PolicyOverrideSchema>>().toEqualTypeOf<Api["PolicyOverride"]>();
    expectTypeOf<Out<typeof RecoverySnapshotSchema>>().toEqualTypeOf<Api["RecoverySnapshot"]>();
    expectTypeOf<Out<typeof PolicyAppliedSchema>>().toEqualTypeOf<Api["PolicyApplied"]>();
    expectTypeOf<Out<typeof PolicyUpdateSchema>>().toEqualTypeOf<Api["PolicyUpdate"]>();
  });

  it("keep the config document open where OpenAPI has no shape for it", () => {
    // generated.ts types these as Record<string, never>; the real value is ALAS's nested config.
    expectTypeOf<Out<typeof ConfigDocSchema>["config"]>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<Out<typeof ConfigAppliedSchema>["revision"]>().toEqualTypeOf<
      Api["ConfigApplied"]["revision"]
    >();
  });
});

const now = "2026-11-25T08:35:13.676947+00:00";
const health = {
  state: "crashed",
  detail: "Worker exited with code 1",
  recovery: {
    gaveUp: false,
    nextAttemptAt: now,
    pendingReason: "crashed",
    policy: { autoRestart: true, restartOnStall: false, stallMinutes: 30 },
    restartsLastHour: 1,
  },
};

describe("InstanceStatusSchema", () => {
  it("accepts what the server sends, with Python's ISO timestamps", () => {
    const status = {
      ...instanceFixture({ state: "running", startedAt: now, processId: 42 }),
      health,
    };
    expect(InstanceStatusSchema.parse(status)).toEqual(status);
  });

  it("drops fields it does not know, so a newer server is still readable", () => {
    const parsed = InstanceStatusSchema.parse({ ...instanceFixture(), addedLater: 1 });
    expect(parsed).not.toHaveProperty("addedLater");
  });

  it.each([
    ["an unknown state", { state: "paused" }],
    ["a timestamp without an offset", { startedAt: "2026-11-25 08:35:13" }],
    ["a fractional pid", { processId: 1.5 }],
    ["a negative counter", { taskSuccesses: -1 }],
    ["a missing field", { revision: undefined }],
  ])("rejects %s", (_, override) => {
    expect(InstanceStatusSchema.safeParse({ ...instanceFixture(), ...override }).success).toBe(
      false,
    );
  });
});

const snapshotWith = (maxRestartsPerHour: number) => ({
  policy: {
    maxRestartsPerHour,
    backoffSeconds: [30],
    instances: { alas: { autoRestart: true } },
  },
  history: [],
});

describe("other responses", () => {
  it("requires positive log sequence numbers", () => {
    expect(LogChunkSchema.safeParse({ lines: [{ seq: 1, text: "a" }], lastSeq: 1 }).success).toBe(
      true,
    );
    expect(LogChunkSchema.safeParse({ lines: [{ seq: 0, text: "a" }], lastSeq: 0 }).success).toBe(
      false,
    );
  });

  it("bounds the recovery policy like the server does", () => {
    expect(RecoverySnapshotSchema.safeParse(snapshotWith(3)).success).toBe(true);
    expect(RecoverySnapshotSchema.safeParse(snapshotWith(61)).success).toBe(false);
  });

  it("keeps the config document as an open object", () => {
    const doc = { revision: "abc", config: { Alas: { Emulator: { Serial: "auto" } } } };
    expect(ConfigDocSchema.parse(doc)).toEqual(doc);
    expect(ConfigDocSchema.safeParse({ revision: "", config: {} }).success).toBe(false);
  });
});

// Same fixture as tests/control/test_profile_names.py, which checks the server's rule.
describe("ProfileNameSchema", () => {
  it.each(names.valid)("accepts %j", (name) => {
    expect(ProfileNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ...names.invalid.format.map((name) => [name, "Use 1–48"]),
    ...names.invalid.reserved.map((name) => [name, "reserved"]),
  ])("rejects %j with a readable reason", (name, reason) => {
    const result = ProfileNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(reason);
  });

  it("trims before checking", () => {
    expect(ProfileNameSchema.parse("  main  ")).toBe("main");
  });
});

describe("policy limits match the contract", () => {
  const schemas = contract.components.schemas;
  it("uses the minimum/maximum of openapi.json", () => {
    for (const name of ["RecoveryPolicy", "PolicyUpdate"] as const) {
      expect(schemas[name].properties.maxRestartsPerHour.maximum).toBe(MAX_RESTARTS_PER_HOUR);
      expect(schemas[name].properties.backoffSeconds.items.maximum).toBe(MAX_BACKOFF_SECONDS);
    }
    for (const name of ["InstancePolicy", "PolicyOverride"] as const) {
      expect(schemas[name].properties.stallMinutes.maximum).toBe(MAX_STALL_MINUTES);
    }
  });
});
