import { describe, expect, it } from "vitest";
import { clampSourcePane, sourcePaneBounds, SOURCE_SEPARATOR_PX } from "./sourcePaneState";
describe("SQL source pane bounds", () => {
  it("protects 160px tables and 180px columns within minimum workspace height", () => {
    expect(sourcePaneBounds(476)).toEqual({ available: 469, min: 160, max: 289 });
    expect(clampSourcePane(476, -100).top).toBe(160);
    expect(clampSourcePane(476, 10000).top).toBe(289);
  });
  it.each([0, 7, 100, 250, 347, 476, 776])("never exceeds total height %s", (height) => {
    const result = clampSourcePane(height, 10000);
    expect(result.top).toBeGreaterThanOrEqual(0);
    expect(result.top).toBeLessThanOrEqual(result.available);
    expect(result.available - result.top).toBeGreaterThanOrEqual(0);
    expect(result.available + Math.min(height, SOURCE_SEPARATOR_PX)).toBe(height);
  });
  it("resets to 32 percent and clamps retained preference after resizing", () => {
    expect(clampSourcePane(1007, null).top).toBe(320);
    expect(clampSourcePane(476, 500).top).toBe(289);
    expect(clampSourcePane(776, 500).top).toBe(500);
    expect(clampSourcePane(476, NaN).top).toBe(160);
  });
});
