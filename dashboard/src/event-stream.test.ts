import { describe, expect, it, vi } from "vitest";
import { EventDecoder, startEventStream } from "./event-stream";

describe("SSE framing", () => {
  it("handles chunk boundaries, CRLF and multiline data", () => {
    const decoder = new EventDecoder();
    expect(decoder.push(": ping\r\n\r\nevent: resync\r")).toEqual([]);
    expect(decoder.push("\ndata:{\"streamId\":\r\ndata: \"a\"}\r\n\r")).toEqual([]);
    expect(decoder.push("\n")).toEqual([{event: "resync", data: "{\"streamId\":\n\"a\"}"}]);
  });
  it("bounds incomplete and complete frames", () => {
    expect(() => new EventDecoder(8).push("data: long")).toThrow();
    expect(() => new EventDecoder(8).push("data: long\n\n")).toThrow();
  });
  it("ignores comments and retry directives", () => {
    expect(new EventDecoder().push(": ping\n\nretry: 3000\n\n")).toEqual([]);
  });
  it("does not dispatch additional buffered frames after cancellation", async () => {
    const seen: string[] = [];
    let stop: (() => void) | undefined;
    await new Promise<void>(resolve => {
      stop = startEventStream({
        open: async () => new Response("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n", { headers: {"content-type":"text/event-stream"} }),
        onConnecting: () => {},
        onFailure: () => {},
        onFrame: async frame => { seen.push(frame.event); stop?.(); resolve(); },
      });
    });
    await Promise.resolve();
    expect(seen).toEqual(["a"]);
  });

  it("aborts and retries a connection that stops sending data", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const open = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const failure = vi.fn();
    const stop = startEventStream({
      open, idleMs: 100, retryMs: 10,
      onConnecting: () => {},
      onFailure: failure,
      onFrame: async () => {},
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledWith(new Error("SSE connection timed out"));
      await vi.advanceTimersByTimeAsync(10);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
