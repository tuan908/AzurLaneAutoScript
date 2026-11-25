import { queryOptions } from "@tanstack/react-query";

import { api } from "@/api/client";
import { queryKeys } from "@/api/query-keys";

export const healthQuery = () =>
  queryOptions({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

export const healthDetailsQuery = () =>
  queryOptions({
    queryKey: queryKeys.healthDetails,
    queryFn: ({ signal }) => api.healthDetails(signal),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

export const recoveryQuery = () =>
  queryOptions({
    queryKey: queryKeys.recovery,
    queryFn: ({ signal }) => api.recovery(signal),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
