import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api, openEvents, type InstanceStatus, type LogLine } from "./api";
import { logStore } from "./logStore";

export type Connection = "connecting" | "open" | "closed";

let connection: Connection = "connecting";
const listeners = new Set<() => void>();

function setConnection(next: Connection) {
  connection = next;
  for (const listener of listeners) listener();
}

export function useConnection(): Connection {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connection,
  );
}

function upsertInstance(qc: QueryClient, status: InstanceStatus) {
  qc.setQueryData<InstanceStatus[]>(["instances"], (old) => {
    if (!old) return old;
    const i = old.findIndex((s) => s.id === status.id);
    if (i < 0) return [...old, status];
    if (old[i].revision > status.revision) return old;
    const next = old.slice();
    next[i] = status;
    return next;
  });
  // The task queue changes when an instance starts, stops or moves to another task
  void qc.invalidateQueries({ queryKey: ["tasks", status.id] });
}

/**
 * One SSE stream for the whole app. The REST snapshot is authoritative: on every
 * (re)connect the instance list and log backlogs are refetched, then SSE applies deltas.
 */
export function connectEvents(qc: QueryClient): () => void {
  const controller = new AbortController();
  let retry: number | undefined;
  let lastStreamId: string | undefined;
  let retryDelay = 1000;

  const resync = async () => {
    await qc.invalidateQueries();
    const instances = qc.getQueryData<InstanceStatus[]>(["instances"]) ?? (await api.instances().catch(() => []));
    await Promise.all(
      instances.map((s) =>
        api
          .logs(s.id)
          .then((chunk) => {
            if (!controller.signal.aborted) logStore.reset(s.id, chunk.lines);
          })
          .catch(() => undefined),
      ),
    );
  };

  const open = async () => {
    if (controller.signal.aborted) return;
    setConnection("connecting");
    try {
      const response = await openEvents(controller.signal);
      if (!response.ok || !response.body) throw new Error(`Stream returned ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const fields = frame.split("\n");
            const event = fields.find((line) => line.startsWith("event: "))?.slice(7);
            const data = fields.find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const payload = JSON.parse(data);
            if (event === "resync") {
              if (lastStreamId !== payload.streamId) logStore.clear();
              lastStreamId = payload.streamId;
              await resync();
              retryDelay = 1000;
              if (!controller.signal.aborted) setConnection("open");
            } else if (event === "instance.status.changed") {
              upsertInstance(qc, payload.data);
            } else if (event === "log.appended") {
              logStore.append(payload.instanceId, payload.lines as LogLine[]);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      // REST polling keeps the dashboard usable during a stream outage.
    }
    if (!controller.signal.aborted) {
      setConnection("closed");
      retry = window.setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  };

  open();
  return () => {
    controller.abort();
    window.clearTimeout(retry);
  };
}
