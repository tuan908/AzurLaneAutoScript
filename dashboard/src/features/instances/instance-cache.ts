import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { api, ApiError, type InstanceStatus } from "@/api/client";
import { queryKeys } from "@/api/query-keys";

export const instanceKey = queryKeys.instances;
export const taskKey = queryKeys.tasks;

type Generation = {
  streamId: string;
  epoch: number;
  awaitingSnapshot: boolean;
};
const generations = new WeakMap<QueryClient, Generation>();
export function instanceGeneration(client: QueryClient): number {
  return generations.get(client)?.epoch ?? 0;
}

export async function beginInstanceGeneration(
  client: QueryClient,
  streamId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const previous = generations.get(client);
  if (previous?.streamId === streamId) return false;
  // Cancel old snapshots before accepting a lower revision from a new server.
  await client.cancelQueries({ queryKey: instanceKey, exact: true });
  if (signal?.aborted) return false;
  generations.set(client, {
    streamId,
    epoch: (previous?.epoch ?? 0) + 1,
    awaitingSnapshot: true,
  });
  return true;
}

export function instanceOptions(client: QueryClient) {
  return queryOptions({
    queryKey: instanceKey,
    queryFn: ({ signal }) => api.instances(signal),
    staleTime: 5_000,
    refetchInterval: 30_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
    structuralSharing: (previous, incoming) => {
      const generation = generations.get(client);
      if (generation?.awaitingSnapshot) {
        generation.awaitingSnapshot = false;
        return incoming;
      }
      // Query stores one result type for this key, but its structural sharing callback takes unknown.
      return reconcileSnapshot(
        previous as InstanceStatus[] | undefined,
        incoming as InstanceStatus[],
      );
    },
  });
}

export function reconcileSnapshot(
  previous: InstanceStatus[] | undefined,
  incoming: InstanceStatus[],
): InstanceStatus[] {
  const byId = new Map(previous?.map((status) => [status.id, status]));
  return incoming.map((status) => {
    const old = byId.get(status.id);
    return old && old.revision > status.revision ? old : status;
  });
}

export function applyInstanceUpdate(
  client: QueryClient,
  incoming: InstanceStatus,
  epoch = instanceGeneration(client),
): boolean {
  if (epoch !== instanceGeneration(client) || generations.get(client)?.awaitingSnapshot)
    return false;
  let changed = false;
  client.setQueryData<InstanceStatus[]>(instanceKey, (previous) => {
    if (!previous) return previous;
    const old = previous.find((status) => status.id === incoming.id);
    if (old && old.revision > incoming.revision) return previous;
    changed =
      !old ||
      old.state !== incoming.state ||
      old.currentTask !== incoming.currentTask ||
      old.taskSuccesses !== incoming.taskSuccesses ||
      old.taskFailures !== incoming.taskFailures;
    return old
      ? previous.map((status) => (status.id === incoming.id ? incoming : status))
      : [...previous, incoming];
  });
  if (changed) void client.invalidateQueries({ queryKey: taskKey(incoming.id) });
  return true;
}
