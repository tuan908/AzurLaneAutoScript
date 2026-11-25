/** SSE framing is independent of the dashboard protocol. */
export type EventFrame = { event: string; data: string };

export class EventDecoder {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private size = 0;
  constructor(private readonly maxSize = 4_000_000) {}

  push(chunk: string): EventFrame[] {
    this.buffer += chunk;
    const frames: EventFrame[] = [];
    let index = 0;
    while (index < this.buffer.length) {
      const end = this.buffer.slice(index).search(/[\r\n]/);
      if (end < 0) break;
      const boundary = index + end;
      if (this.buffer[boundary] === "\r" && boundary === this.buffer.length - 1) break;
      const line = this.buffer.slice(index, boundary);
      index = boundary + (this.buffer[boundary] === "\r" && this.buffer[boundary + 1] === "\n" ? 2 : 1);
      this.size += line.length + 1;
      if (this.size > this.maxSize) throw new Error("SSE frame exceeds buffer limit");
      if (!line) {
        if (this.data.length) frames.push({ event: this.event || "message", data: this.data.join("\n") });
        this.event = "";
        this.data = [];
        this.size = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (name === "event") this.event = value;
        if (name === "data") this.data.push(value);
      }
    }
    this.buffer = this.buffer.slice(index);
    if (this.size + this.buffer.length > this.maxSize) throw new Error("SSE frame exceeds buffer limit");
    return frames;
  }
}

type TransportOptions = {
  open: (signal: AbortSignal) => Promise<Response>;
  onFrame: (frame: EventFrame, signal: AbortSignal) => Promise<void>;
  onConnecting: () => void;
  onFailure: (error: unknown) => void;
  idleMs?: number;
  retryMs?: number;
};

/** Each attempt owns its abort signal, reader, and watchdog. */
export function startEventStream(options: TransportOptions): () => void {
  const lifetime = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const initialDelay = options.retryMs ?? 1000;
  let delay = initialDelay;
  async function attempt() {
    if (lifetime.signal.aborted) return;
    const controller = new AbortController();
    const stop = () => controller.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener("abort", stop, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new Error("SSE connection timed out")), options.idleMs ?? 45_000);
    };
    const decoder = new EventDecoder();
    let reader: ReadableStreamDefaultReader<string> | undefined;
    try {
      options.onConnecting();
      arm();
      const response = await options.open(controller.signal);
      if (!response.ok || !response.body) throw new Error(`SSE returned HTTP ${response.status}`);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Unexpected SSE content type");
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const cancelRead = () => { void reader?.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", cancelRead, { once: true });
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) throw new Error("SSE connection ended");
          arm();
          for (const frame of decoder.push(value)) {
            controller.signal.throwIfAborted();
            await options.onFrame(frame, controller.signal);
            controller.signal.throwIfAborted();
            if (frame.event === "resync") delay = initialDelay;
            arm();
          }
        }
        controller.signal.throwIfAborted();
      } finally { controller.signal.removeEventListener("abort", cancelRead); }
    } catch (error) {
      if (!lifetime.signal.aborted) options.onFailure(controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      lifetime.signal.removeEventListener("abort", stop);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
    if (!lifetime.signal.aborted) {
      retry = setTimeout(() => void attempt(), delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
  void attempt();
  return () => { lifetime.abort(); clearTimeout(retry); };
}
