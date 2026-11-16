import { describe, expect, it } from "vitest";
import type { CustomSeriesOption } from "echarts/charts";
import {
  chartDetailRange,
  groupObservations,
  scatterTileSeries,
  sparseBarSeries,
} from "./chartFidelitySeries";
import { histogramSeries, lineCoordinates } from "./chartSeries";

function marker(series: CustomSeriesOption, row: number[], scale: number) {
  const render = series.renderItem!;
  return render(
    {} as Parameters<typeof render>[0],
    {
      value: (index: number) => row[index],
      coord: ([x, y]: number[]) => [x * scale, 100 - y * scale],
    } as unknown as Parameters<typeof render>[1],
  );
}

describe("chart fidelity marks and ranges", () => {
  it("uses exact inclusive data coordinates for drag and the full axis for wheel zoom", () => {
    const extent: [number, number, number, number] = [-100, 100, 1000, 2000];
    const view = {
      x: { startValue: -2, endValue: 3 },
      y: { start: 20, end: 80 },
    };
    expect(chartDetailRange(view, extent, true)).toEqual({
      kind: "range",
      x: [-2, 3],
      y: [1200, 1800],
    });
    expect(chartDetailRange(view, extent, false)).toEqual({ kind: "range", x: [-2, 3] });
    expect(chartDetailRange({ ...view, x: { start: 0, end: 100 } }, extent, false)).toBeNull();
  });

  it("leaves visible evidence for a singleton tile and for small nonzero bars", () => {
    const tiles = scatterTileSeries([
      [10, 11, 10, 11, 1],
      [0, 1, 0, 1, 999_999],
    ]);
    expect(marker(tiles, [10, 11, 10, 11, 1], 10)).toMatchObject({
      type: "group",
      children: [{ type: "rect" }, { type: "circle" }],
    });
    expect(marker(tiles, [10, 11, 10, 11, 0], 10)).toBeNull();
    expect(marker(sparseBarSeries([0, -1], false), [1, -1], 0.01)).toMatchObject({
      type: "circle",
    });
    expect(marker(sparseBarSeries([0, -1], false), [0, 0], 0.01)).toBeNull();
    const histogram = histogramSeries(
      [
        { start: 0, end: 1, count: 0 },
        { start: 1, end: 2, count: 1 },
      ],
      "count",
      String,
    );
    expect(marker(histogram.series, [0, 1, 0, 0], 0.01)).toBeNull();
    expect(marker(histogram.series, [1, 2, 1, 1], 0.01)).toMatchObject({ type: "circle" });
  });

  it("breaks sampled strokes only across known empty buckets and preserves duplicate observations", () => {
    const points: [number, number][] = [
      [0, 1],
      [1, 100],
      [4, 4],
    ];
    expect(
      lineCoordinates(points, undefined, undefined, [
        [0, 1, 1, 1, 1],
        [1, 2, 100, 100, 1],
        [4, 5, 4, 4, 1],
      ]),
    ).toEqual([
      [0, 1],
      [1, 100],
      [3, null],
      [4, 4],
    ]);
    const observations = groupObservations([
      { label: "Rare", count: 4, observations: [7, 7, 8, 100], whiskers: [7, 8] },
    ]);
    expect(observations.values).toEqual([
      [0, 7, 2],
      [0, 8, 1],
    ]);
    expect(observations.tooltip(0, String)).toContain("Observations at this value: 2");
  });
});
