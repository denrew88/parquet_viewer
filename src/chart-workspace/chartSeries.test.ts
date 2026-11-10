import { describe, expect, it } from "vitest";
import {
  barDisplay,
  distributionOutliers,
  distributionTooltip,
  histogramSeries,
  lineCoordinates,
  pointTooltip,
  sortGroups,
  temporalTooltipFormatter,
} from "./chartSeries";

describe("chart display analytics", () => {
  it("preserves exact scatter tooltip text, row and optional ID", () => {
    const tooltip = pointTooltip({
      details: [{ x: "9007199254740993", y: "0.000001", row: 100_001, label: "order A" }],
      x: "Units",
      y: "Price",
      label: "Order ID",
      xFormat: String,
      yFormat: String,
    });
    expect(tooltip({ dataIndex: 0, value: [1, 2] })).toBe(
      "Units: 9007199254740993\nPrice: 0.000001\nSource row: 100,001\nOrder ID: order A",
    );
  });

  it("splits line gaps in temporal units without changing valid observations", () => {
    const points: [number, number][] = [
      [0, 4],
      [1e9, 5],
      [10e9, 6],
    ];
    expect(lineCoordinates(points, 5, "ns")).toEqual([
      [0, 4],
      [1e9, 5],
      [5.5e9, null],
      [10e9, 6],
    ]);
    expect(lineCoordinates(points, undefined, undefined)).toBe(points);
  });

  it("formats line hover from a clock origin without dropping nanoseconds or the timezone", () => {
    const utc = temporalTooltipFormatter("2026-01-01T00:00:00.123456789Z", "ns", String);
    expect(utc?.(10_000_000_001)).toBe("2026-01-01 00:00:10.12345679Z");
    expect(utc?.(-123_456_790)).toBe("2025-12-31 23:59:59.999999999Z");
    const korea = temporalTooltipFormatter("2026-01-01 09:00:00 [Asia/Seoul]", "ns", String);
    expect(korea?.(10_000_000_000)).toBe("2026-01-01 09:00:10 [Asia/Seoul]");
    const date = temporalTooltipFormatter("2026-01-01", "days", String);
    expect(date?.(2)).toBe("2026-01-03");
    expect(temporalTooltipFormatter("-1000000", "ns", String)).toBeUndefined();
  });

  it("uses interval geometry and the included total for percent and density", () => {
    const bins = [
      { start: 0, end: 2, count: 4 },
      { start: 2, end: 3, count: 4 },
    ];
    const density = histogramSeries(bins, "density", String);
    expect(density.series.type).toBe("custom");
    expect(density.series.data).toEqual([
      [0, 2, 0.25, 4],
      [2, 3, 0.5, 4],
    ]);
    expect(histogramSeries(bins, "percent", String).series.data).toEqual([
      [0, 2, 50, 4],
      [2, 3, 50, 4],
    ]);
    expect(histogramSeries(bins, "count", String).tooltip({ dataIndex: 1 })).toBe(
      "Bin: [2, 3]\nCount: 4\nIn range: 8 rows\nShare: 50%",
    );
  });

  it("uses the full bar denominator and reports outliers without changing group counts", () => {
    const groups = [
      {
        label: "B",
        count: 20,
        value: 30,
        summary: [0, 1, 2, 4, 100] as [number, number, number, number, number],
        whiskers: [0, 4] as [number, number],
        outlierCount: 1,
        outliers: [100],
      },
      { label: "A", count: 100, value: 60 },
    ];
    expect(sortGroups(groups, "count").map((group) => group.label)).toEqual(["A", "B"]);
    const bars = barDisplay(groups, "sum", 120, true, true);
    expect(bars.label({ dataIndex: 0 })).toBe("30 · 25%");
    expect(bars.tooltip({ dataIndex: 0 })).toContain("N: 20");
    const outliers = distributionOutliers(groups);
    expect(outliers.values).toEqual([[0, 100]]);
    expect(distributionTooltip(groups, outliers.values, String)({ dataIndex: 0 })).toContain(
      "Whiskers: 0 to 4\nOutliers: 1",
    );
  });
});
