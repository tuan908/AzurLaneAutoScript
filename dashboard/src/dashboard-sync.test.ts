import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { createDashboardSync } from "./dashboard-sync";
import { startEventStream } from "./event-stream";
import { deferred, instanceFixture } from "./test-fixtures";
import { logStore } from "./logStore";

const resync = { event: "resync", data: '{"streamId":"server"}' };
const backlog = (seq: number) => ({ lines: [{ seq, text: `line ${seq}` }], lastSeq: seq });

afterEach(() => {
  logStore.clear();
  vi.restoreAllMocks();
});

it("recovers missed logs on a new connection before reporting Live", async () => {
  vi.spyOn(api, "instances").mockResolvedValue([instanceFixture()]);
  vi.spyOn(api, "logs").mockResolvedValueOnce(backlog(1)).mockResolvedValueOnce(backlog(2));
  const seen: number[] = [];
  const synced = deferred<void>();
  const onReady = () => {
    seen.push(logStore.lastSeq("alas"));
    if (seen.length === 2) synced.resolve();
  };
  const client = new QueryClient();
  let synchronize = createDashboardSync(client, onReady, () => {});
  const open = vi.fn(async () => new Response(`event: resync\ndata: ${resync.data}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const stop = startEventStream({
    open, retryMs: 1,
    onConnecting: () => { synchronize = createDashboardSync(client, onReady, () => {}); },
    onFrame: (frame, signal) => synchronize(frame, signal),
    onFailure: () => {},
  });
  try {
    await synced.promise;
    expect(open).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([1, 2]);
  } finally {
    stop();
  }
});

it("does not publish a partial backlog and can recover on retry", async () => {
  vi.spyOn(api, "instances").mockResolvedValue([instanceFixture(), instanceFixture({ id: "other" })]);
  const logs = vi.spyOn(api, "logs").mockResolvedValueOnce(backlog(1)).mockRejectedValueOnce(new Error("backlog failed"));
  const ready = vi.fn();
  const sync = createDashboardSync(new QueryClient(), ready, () => {});
  const signal = new AbortController().signal;
  await expect(sync(resync, signal)).rejects.toThrow("backlog failed");
  expect(ready).not.toHaveBeenCalled();
  expect(logStore.get("alas")).toEqual([]);
  logs.mockResolvedValue(backlog(2));
  await sync(resync, signal);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(logStore.lastSeq("alas")).toBe(2);
});

it("does not apply a backlog that finishes after cancellation", async () => {
  vi.spyOn(api, "instances").mockResolvedValue([instanceFixture()]);
  const response = deferred<ReturnType<typeof backlog>>();
  const requested = deferred<void>();
  vi.spyOn(api, "logs").mockImplementation(() => {
    requested.resolve();
    return response.promise;
  });
  const ready = vi.fn();
  const sync = createDashboardSync(new QueryClient(), ready, () => {});
  const controller = new AbortController();
  const synchronizing = sync(resync, controller.signal);
  await requested.promise;
  controller.abort();
  response.resolve(backlog(1));
  await expect(synchronizing).rejects.toMatchObject({ name: "AbortError" });
  expect(logStore.get("alas")).toEqual([]);
  expect(ready).not.toHaveBeenCalled();
});
