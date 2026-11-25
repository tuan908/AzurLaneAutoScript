import * as z from "zod";

import { InstanceStatusSchema, LogLineSchema } from "@/api/schemas";

const jsonText = z.codec(z.string(), z.json(), {
  decode: (text, ctx) => {
    try {
      return JSON.parse(text) as z.core.util.JSONType;
    } catch (error) {
      ctx.issues.push({
        code: "invalid_format",
        format: "json",
        input: text,
        message: error instanceof Error ? error.message : "Invalid JSON",
      });
      return z.NEVER;
    }
  },
  encode: (value) => JSON.stringify(value),
});

// The SSE event name is the discriminator; the data line carries the rest of the event.
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resync"), streamId: z.string().min(1) }),
  z.object({ type: z.literal("instance.status.changed"), data: InstanceStatusSchema }),
  z.object({
    type: z.literal("log.appended"),
    instanceId: z.string().min(1),
    lines: z.array(LogLineSchema),
  }),
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export function parseEvent(event: string | undefined, data: string): StreamEvent | null {
  const payload = jsonText.safeParse(data);
  if (!payload.success) return null;
  const body = payload.data;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const parsed = StreamEventSchema.safeParse({ ...body, type: event });
  return parsed.success ? parsed.data : null;
}
