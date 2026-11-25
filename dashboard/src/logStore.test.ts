import { describe, expect, it } from "vitest";
import { LogStore } from "./logStore";

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, text: `line ${from + i}` }));

describe("LogStore", () => {
  it("caps lines per instance", () => {
    const store = new LogStore(5);
    store.append("alas", lines(1, 8));
    expect(store.get("alas").map((l) => l.seq)).toEqual([4, 5, 6, 7, 8]);
  });

  it("ignores lines it already has", () => {
    const store = new LogStore(10);
    store.append("alas", lines(1, 3));
    store.append("alas", lines(2, 5));
    expect(store.get("alas").map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reset keeps newer streamed lines", () => {
    const store = new LogStore(10);
    store.append("alas", lines(1, 6));
    store.reset("alas", lines(1, 4));
    expect(store.get("alas").map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reset to a new server's lower seqs replaces everything", () => {
    const store = new LogStore(10);
    store.append("alas", lines(100, 102));
    store.reset("alas", lines(1, 2));
    expect(store.get("alas").map((l) => l.seq)).toEqual([1, 2]);
  });

  it("keeps instances apart", () => {
    const store = new LogStore(10);
    store.append("a", lines(1, 2));
    store.append("b", lines(1, 1));
    expect(store.get("a")).toHaveLength(2);
    expect(store.get("b")).toHaveLength(1);
  });
});
