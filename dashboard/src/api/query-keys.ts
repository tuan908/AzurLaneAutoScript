// One place for query keys, so mutations in any feature can name what they invalidate.
export const queryKeys = {
  instances: ["instances"] as const,
  tasks: (id: string) => ["tasks", id] as const,
  health: ["health"] as const,
  healthDetails: ["health/details"] as const,
  recovery: ["recovery"] as const,
  config: (id: string) => ["config", id] as const,
  configSchema: (id: string, lang: string) => ["configSchema", id, lang] as const,
};
