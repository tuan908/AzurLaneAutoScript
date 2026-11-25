import { queryOptions } from "@tanstack/react-query";

import { api } from "@/api/client";

export const configSchemaQuery = (id: string, lang: string) =>
  queryOptions({
    queryKey: ["configSchema", id, lang],
    queryFn: ({ signal }) => api.configSchema(id, lang, signal),
    staleTime: Infinity,
  });

export const configQuery = (id: string) =>
  queryOptions({
    queryKey: ["config", id],
    queryFn: ({ signal }) => api.config(id, signal),
  });
