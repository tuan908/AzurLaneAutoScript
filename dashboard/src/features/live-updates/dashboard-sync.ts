import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";

import {
  applyInstanceUpdate,
  beginInstanceGeneration,
  instanceKey,
  instanceOptions,
} from "../instances/instance-cache";
import { LOG_LIMIT, logStore } from "../logs/log-store";
import { parseEvent } from "./event-protocol";
import type { EventFrame } from "./event-stream";

export function createDashboardSync(
  client: QueryClient,
  onReady: () => void,
  onSyncing: () => void,
) {
  let ready = false;
  return async (frame: EventFrame, signal: AbortSignal) => {
    signal.throwIfAborted();
    const event = parseEvent(frame.event, frame.data);
    if (!event) {
      if (["resync", "instance.status.changed", "log.appended"].includes(frame.event))
        throw new Error(`Invalid SSE payload: ${frame.event}`);
      return;
    }
    if (event.type === "resync") {
      ready = false;
      onSyncing();
      const changed = await beginInstanceGeneration(client, event.streamId, signal);
      signal.throwIfAborted();
      if (changed) logStore.clear();
      await client.invalidateQueries({
        queryKey: instanceKey,
        exact: true,
        refetchType: "none",
      });
      signal.throwIfAborted();
      const instances = await client.fetchQuery(instanceOptions(client));
      // Limit concurrent backlog requests; publish only after every request succeeds.
      const backlogs: {
        id: string;
        lines: Awaited<ReturnType<typeof api.logs>>["lines"];
      }[] = [];
      for (let i = 0; i < instances.length; i += 4) {
        signal.throwIfAborted();
        backlogs.push(
          ...(await Promise.all(
            instances.slice(i, i + 4).map(async (instance) => ({
              id: instance.id,
              lines: (await api.logs(instance.id, 0, LOG_LIMIT, signal)).lines,
            })),
          )),
        );
      }
      signal.throwIfAborted();
      for (const backlog of backlogs) logStore.reset(backlog.id, backlog.lines);
      logStore.retain(instances.map((instance) => instance.id));
      ready = true;
      onReady();
      return;
    }
    if (!ready) throw new Error("SSE delta received before resync");
    if (event.type === "instance.status.changed") applyInstanceUpdate(client, event.data);
    else logStore.append(event.instanceId, event.lines);
  };
}
