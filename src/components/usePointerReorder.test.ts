import { describe, expect, it } from "vitest";
import { reorderAtInsertion } from "./usePointerReorder";

describe("pointer reorder insertion", () => {
  it("moves stable IDs before and after a target without duplicating them", () => {
    expect(reorderAtInsertion(["a", "b", "c", "d"], "d", "b", "before")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(reorderAtInsertion(["a", "b", "c", "d"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("is a no-op for stale IDs and self targets", () => {
    expect(reorderAtInsertion(["a", "b"], "missing", "b", "before")).toEqual(["a", "b"]);
    expect(reorderAtInsertion(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
  });
});
