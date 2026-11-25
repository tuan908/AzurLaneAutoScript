import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { taskKey, instanceOptions } from "../features/instances/instance-cache";

export function useInstances() {
  return useQuery(instanceOptions(useQueryClient()));
}

export const queries = {
  health: () => queryOptions({ queryKey: ["health"], queryFn: ({ signal }) => api.health(signal), staleTime: 10_000, refetchInterval: 15_000 }),
  tasks: (id: string) => queryOptions({ queryKey: taskKey(id), queryFn: ({ signal }) => api.tasks(id, signal), staleTime: 5_000, refetchInterval: 10_000 }),
  healthDetails: () => queryOptions({ queryKey: ["health/details"], queryFn: ({ signal }) => api.healthDetails(signal), staleTime: 5_000, refetchInterval: 10_000 }),
  recovery: () => queryOptions({ queryKey: ["recovery"], queryFn: ({ signal }) => api.recovery(signal), staleTime: 5_000, refetchInterval: 10_000 }),
  configSchema: (id: string, lang: string) => queryOptions({ queryKey: ["configSchema", id, lang], queryFn: ({ signal }) => api.configSchema(id, lang, signal), staleTime: Infinity }),
  config: (id: string) => queryOptions({ queryKey: ["config", id], queryFn: ({ signal }) => api.config(id, signal) }),
};
