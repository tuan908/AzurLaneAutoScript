import { queryOptions } from "@tanstack/react-query";

import { api } from "@/api/client";

import { taskKey } from "../instances/instance-cache";

export const tasksQuery = (id: string) =>
  queryOptions({
    queryKey: taskKey(id),
    queryFn: ({ signal }) => api.tasks(id, signal),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
