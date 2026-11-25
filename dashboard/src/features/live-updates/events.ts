import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { openEvents } from "@/api/client";

import { createDashboardSync } from "./dashboard-sync";
import { startEventStream } from "./event-stream";

export type Connection = "connecting" | "open" | "closed";
type ConnectionSnapshot = { state: Connection; error: string | null };
let snapshot: ConnectionSnapshot = { state: "connecting", error: null };
const listeners = new Set<() => void>();
function publish(state: Connection, error: string | null = null) {
  if (snapshot.state === state && snapshot.error === error) return;
  snapshot = { state, error };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function useConnection(): Connection {
  return useSyncExternalStore(subscribe, () => snapshot.state);
}
export function useConnectionError(): string | null {
  return useSyncExternalStore(subscribe, () => snapshot.error);
}

export function connectEvents(client: QueryClient): () => void {
  let sync = createDashboardSync(
    client,
    () => publish("open"),
    () => publish("connecting", snapshot.error),
  );
  const stop = startEventStream({
    open: openEvents,
    onConnecting: () => {
      sync = createDashboardSync(
        client,
        () => publish("open"),
        () => publish("connecting", snapshot.error),
      );
      publish("connecting", snapshot.error);
    },
    onFrame: (frame, signal) => sync(frame, signal),
    onFailure: (error) => publish("closed", error instanceof Error ? error.message : String(error)),
  });
  return () => {
    stop();
    publish("closed");
  };
}
