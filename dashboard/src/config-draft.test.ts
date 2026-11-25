import { describe, expect, it } from "vitest";
import { changeDraft, draftValue } from "./config-draft";
const field = { path: "x", type: "input" } as const;
describe("config draft", () => {
  it("keeps a frozen baseline across server refreshes", () => {
    const first = changeDraft(null, { revision: "1", config: { x: "a", y: 1 } }, field, "b");
    const second = changeDraft(first, { revision: "2", config: { x: "c", y: 2 } }, { ...field, path: "y" }, 3);
    expect(second?.baseline.revision).toBe("1");
    expect(second?.edits).toEqual({ x: "b", y: 3 });
    expect(draftValue(first, { revision: "2", config: { y: 2 } }, "y")).toBe(1);
  });
  it("preserves value types and clears reverted edits", () => {
    const doc = { revision: "1", config: { x: 1 } };
    const draft = changeDraft(null, doc, field, "1");
    expect(draft?.edits).toEqual({ x: "1" });
    expect(changeDraft(draft, doc, field, 1)).toBeNull();
  });
});
