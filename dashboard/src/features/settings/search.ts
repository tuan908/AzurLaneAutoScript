import "zod/compile";

import * as z from "zod";

export const SettingsSearchSchema = z.object({
  q: z.string().default("").catch(""),
  task: z.string().default("").catch(""),
});
