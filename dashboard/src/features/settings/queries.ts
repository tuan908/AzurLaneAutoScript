import { queryOptions } from "@tanstack/react-query";

import { api } from "@/api/client";
import { queryKeys } from "@/api/query-keys";

export const configSchemaQuery = (id: string, lang: string) =>
  queryOptions({
    queryKey: queryKeys.configSchema(id, lang),
    queryFn: ({ signal }) => api.configSchema(id, lang, signal),
    // Never refetched by invalidation: the schema only changes with an ALAS update.
    staleTime: "static",
  });

export const configQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.config(id),
    queryFn: ({ signal }) => api.config(id, signal),
  });
