import * as z from "zod";

export const LOG_LEVELS = ["all", "warn", "error"] as const;

export const LogsSearchSchema = z.object({
  filter: z.string().default("").catch(""),
  level: z.enum(LOG_LEVELS).default("all").catch("all"),
});

export type LogsSearch = z.infer<typeof LogsSearchSchema>;
