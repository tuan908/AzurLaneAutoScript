import { queryOptions } from "@tanstack/react-query";
import { api } from "../../api/client";

export const healthQuery = () =>
  queryOptions({ queryKey: ["health"], queryFn: ({ signal }) => api.health(signal), staleTime: 10_000, refetchInterval: 15_000 });

export const healthDetailsQuery = () =>
  queryOptions({ queryKey: ["health/details"], queryFn: ({ signal }) => api.healthDetails(signal), staleTime: 5_000, refetchInterval: 10_000 });

export const recoveryQuery = () =>
  queryOptions({ queryKey: ["recovery"], queryFn: ({ signal }) => api.recovery(signal), staleTime: 5_000, refetchInterval: 10_000 });
