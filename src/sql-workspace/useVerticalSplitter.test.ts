import { describe, expect, it } from "vitest";
import { clampQueryPane, QUERY_SEPARATOR_PX } from "./useVerticalSplitter";

describe("SQL Query and output split", () => {
  it("has a usable range at the minimum workspace height", () => {
    expect(clampQueryPane(438, null)).toEqual({ min: 125, max: 179, top: 159 });
    expect(clampQueryPane(438, 10000).top).toBe(179);
    expect(438 - 179 - QUERY_SEPARATOR_PX).toBe(252);
  });

  it("clamps a stored preference against the measured space", () => {
    expect(clampQueryPane(810, 370).top).toBe(370);
    expect(clampQueryPane(438, 370).top).toBe(179);
    expect(clampQueryPane(0, 370)).toEqual({ min: 0, max: 0, top: 0 });
  });
});
