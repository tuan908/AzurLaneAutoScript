import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api, eventsUrl, type InstanceStatus, type LogLine } from "./api";
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
 * One EventSource for the whole app. The REST snapshot is authoritative: on every
 * (re)connect the instance list and log backlogs are refetched, then SSE applies deltas.
 */
export function connectEvents(qc: QueryClient): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let closed = false;

  const resync = async () => {
    await qc.invalidateQueries();
    const instances = qc.getQueryData<InstanceStatus[]>(["instances"]) ?? (await api.instances().catch(() => []));
    await Promise.all(
      instances.map((s) =>
        api
          .logs(s.id)
          .then((chunk) => logStore.reset(s.id, chunk.lines))
          .catch(() => undefined),
      ),
    );
  };

  const open = () => {
    if (closed) return;
    setConnection("connecting");
    source = new EventSource(eventsUrl());
    source.onopen = () => {
      setConnection("open");
      void resync();
    };
    source.onerror = () => {
      setConnection("closed");
      source?.close();
      source = null;
      // EventSource retries by itself only for some failures; always reconnect ourselves
      retry = window.setTimeout(open, 3000);
    };
    source.addEventListener("instance.status.changed", (e) => {
      const { data } = JSON.parse((e as MessageEvent).data) as { data: InstanceStatus };
      upsertInstance(qc, data);
    });
    source.addEventListener("log.appended", (e) => {
      const { instanceId, lines } = JSON.parse((e as MessageEvent).data) as {
        instanceId: string;
        lines: LogLine[];
      };
      logStore.append(instanceId, lines);
    });
  };

  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    source?.close();
  };
}
