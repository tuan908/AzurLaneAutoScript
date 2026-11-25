import * as z from "zod";

import { InstancePolicySchema, RecoveryPolicySchema } from "@/api/schemas";

// Number inputs give strings; an empty field must not coerce to 0.
const wholeNumberText = z.string().trim().nonempty({ error: "Enter a number" });

export const StallMinutesInput = wholeNumberText.pipe(
  z.coerce.number<string>().pipe(InstancePolicySchema.shape.stallMinutes),
);

export const MaxRestartsInput = wholeNumberText.pipe(
  z.coerce.number<string>().pipe(RecoveryPolicySchema.shape.maxRestartsPerHour),
);

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid value";
}
