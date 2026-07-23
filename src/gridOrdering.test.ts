import { describe, expect, it } from "vitest";
import {
  columnReflowOffsets,
  moveId,
  moveIdBefore,
  normalizedIdOrder,
  restoreSourceOrder,
} from "./gridOrdering";

describe("grid ordering", () => {
  it("preserves known IDs and appends newly available IDs", () => {
    expect(normalizedIdOrder(["a", "b", "c"], ["b", "missing", "b"])).toEqual(["b", "a", "c"]);
  });

  it("moves IDs without changing their identity", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveIdBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("restores source IDs first and keeps unknown IDs in their applied relative order", () => {
    expect(restoreSourceOrder(["a", "b", "c", "d"], ["c", "x", "a", "y", "b", "d"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "x",
      "y",
    ]);
  });

  it("computes variable-width live reflow offsets without moving the applied order", () => {
    expect(
      columnReflowOffsets(["a", "b", "c", "d"], ["a", "c", "b", "d"], {
        a: 80,
        b: 140,
        c: 60,
        d: 100,
      }),
    ).toEqual({ a: 0, b: 60, c: -140, d: 0 });
  });
});
