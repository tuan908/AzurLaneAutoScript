import { describe, expect, it } from "vitest";
import { parseEvent } from "./event-protocol";
describe("SSE boundary", () => {
  it("accepts valid resync and logs", () => {
    expect(parseEvent("resync", '{"streamId":"a"}')).toEqual({ type: "resync", streamId: "a" });
    expect(parseEvent("log.appended", '{"instanceId":"a","lines":[{"seq":1,"text":"ready"}]}')).toEqual({ type: "log.appended", instanceId: "a", lines: [{seq:1,text:"ready"}] });
  });
  it("rejects malformed JSON and invalid payloads", () => {
    expect(parseEvent("resync", "{")).toBeNull();
    expect(parseEvent("resync", '{"streamId":1}')).toBeNull();
    expect(parseEvent("instance.status.changed", '{"data":{"id":"a","revision":1}}')).toBeNull();
    expect(parseEvent("log.appended", '{"instanceId":"a","lines":[{"seq":-1,"text":"bad"}]}')).toBeNull();
    expect(parseEvent("unknown", "{}")).toBeNull();
  });
});
