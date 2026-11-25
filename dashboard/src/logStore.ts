import { useSyncExternalStore } from "react";
import type { LogLine } from "./api";

/** Lines kept per instance. Virtualization alone would not bound the array, this does. */
export const LOG_LIMIT = 2000;

const EMPTY: readonly LogLine[] = [];

function orderedLines(lines: readonly LogLine[]): LogLine[] {
  const unique = [...new Map(lines.map((line) => [line.seq, line])).values()];
  // oxlint-disable-next-line unicorn/no-array-sort -- unique is owned locally; retain ES2022 compatibility.
  return unique.sort((a, b) => a.seq - b.seq);
}

export class LogStore {
  private lines = new Map<string, LogLine[]>();
  private listeners = new Set<() => void>();

  constructor(private limit = LOG_LIMIT) {}

  get(id: string): readonly LogLine[] {
    return this.lines.get(id) ?? EMPTY;
  }

  lastSeq(id: string): number {
    return this.get(id).at(-1)?.seq ?? 0;
  }

  /** Append lines newer than what is held, dropping the oldest beyond the limit. */
  append(id: string, incoming: LogLine[]) {
    const last = this.lastSeq(id);
    const fresh = orderedLines(incoming.filter((line) => line.seq > last));
    if (!fresh.length) return;
    let next = this.get(id).concat(fresh);
    if (next.length > this.limit) next = next.slice(next.length - this.limit);
    this.lines.set(id, next);
    this.emit();
  }

  /**
   * Replace with an authoritative backlog (after a reconnect). Lines that arrived over
   * SSE while the backlog was in flight are kept when they continue it directly; after a
   * server restart seqs start again at 1, so old higher seqs are not a continuation.
   */
  reset(id: string, backlog: LogLine[]) {
    const snapshot = orderedLines(backlog);
    const backlogLast = snapshot.at(-1)?.seq ?? 0;
    const newer = this.get(id).filter((line) => line.seq > backlogLast);
    const next = newer[0]?.seq === backlogLast + 1 ? snapshot.concat(newer) : snapshot;
    this.lines.set(id, next.slice(-this.limit));
    this.emit();
  }

  retain(ids: readonly string[]) {
    const keep = new Set(ids);
    let changed = false;
    for (const id of this.lines.keys()) {
      if (!keep.has(id)) { this.lines.delete(id); changed = true; }
    }
    if (changed) this.emit();
  }

  clear() {
    this.lines.clear();
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export const logStore = new LogStore();

export function useLogs(id: string): readonly LogLine[] {
  return useSyncExternalStore(logStore.subscribe, () => logStore.get(id));
}
