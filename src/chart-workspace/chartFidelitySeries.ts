import type { CustomSeriesOption } from "echarts/charts";
import type { ChartDetailRequest, ChartExtent, CountedChartExtent } from "./contract";
import { BLUE, categoryName, PURPLE, type ChartGroup } from "./chartSeries";
import type { PlotView } from "./usePlotZoom";

const counts = new Intl.NumberFormat("en-US");
const extentDimensions = ["X minimum", "X maximum", "Y minimum", "Y maximum", "Observations"];
const midpoint = (minimum: number, maximum: number) => minimum / 2 + maximum / 2;
const sparseMark = "#944716";

export function chartDetailRange(
  view: PlotView,
  extent: ChartExtent,
  includeY: boolean,
): Extract<ChartDetailRequest, { kind: "range" }> | null {
  const axisRange = (range: PlotView["x"], min: number, max: number): [number, number] => {
    if ("startValue" in range) return [range.startValue, range.endValue];
    const interpolate = (percent: number) => {
      const ratio = percent / 100;
      return min * (1 - ratio) + max * ratio;
    };
    return [interpolate(range.start), interpolate(range.end)];
  };
  const x = axisRange(view.x, extent[0], extent[1]);
  const y = includeY ? axisRange(view.y, extent[2], extent[3]) : undefined;
  if (![...x, ...(y ?? [])].every(Number.isFinite) || x[0] >= x[1] || (y && y[0] >= y[1]))
    return null;
  if (x[0] <= extent[0] && x[1] >= extent[1] && (!y || (y[0] <= extent[2] && y[1] >= extent[3])))
    return null;
  return { kind: "range", x, ...(y ? { y } : {}) };
}

export function scatterTileSeries(tiles: CountedChartExtent[]): CustomSeriesOption {
  const highest = tiles.reduce((max, tile) => Math.max(max, tile[4]), 1);
  const scale = Math.log1p(highest);
  return {
    id: "scatter-occupancy",
    type: "custom",
    name: "Occupied cell",
    clip: true,
    z: 1,
    dimensions: extentDimensions,
    encode: { x: [0, 1], y: [2, 3], tooltip: 4 },
    data: tiles,
    renderItem: (_, api) => {
      const count = Number(api.value(4));
      if (count < 1) return null;
      const [left, bottom] = api.coord([Number(api.value(0)), Number(api.value(2))]);
      const [right, top] = api.coord([Number(api.value(1)), Number(api.value(3))]);
      return {
        type: "group",
        children: [
          {
            type: "rect",
            shape: { x: left, y: top, width: right - left, height: bottom - top },
            style: { fill: `rgba(8, 127, 120, ${0.06 + (0.34 * Math.log1p(count)) / scale})` },
          },
          ...(count <= 2 || right - left < 3 || bottom - top < 3
            ? [
                {
                  type: "circle" as const,
                  shape: { cx: midpoint(left, right), cy: midpoint(top, bottom), r: 3 },
                  style: { fill: sparseMark, stroke: "#fff", lineWidth: 0.7 },
                },
              ]
            : []),
        ],
      };
    },
  };
}

export function lineBucketSeries(buckets: CountedChartExtent[]): CustomSeriesOption {
  return {
    id: "line-observations",
    type: "custom",
    name: "Observation interval",
    clip: true,
    z: 1,
    dimensions: extentDimensions,
    encode: { x: [0, 1], y: [2, 3], tooltip: 4 },
    data: buckets,
    renderItem: (_, api) => {
      const x = midpoint(Number(api.value(0)), Number(api.value(1)));
      const [center, bottom] = api.coord([x, Number(api.value(2))]);
      const [, top] = api.coord([x, Number(api.value(3))]);
      if (bottom - top < 3) {
        return {
          type: "circle",
          shape: { cx: center, cy: midpoint(top, bottom), r: 2 },
          style: { fill: BLUE, opacity: 0.65 },
        };
      }
      return {
        type: "line",
        shape: { x1: center, x2: center, y1: top, y2: bottom },
        style: { stroke: BLUE, opacity: 0.43, lineWidth: 2 },
      };
    },
  };
}

export function extentTooltip(
  extent: CountedChartExtent | undefined,
  xFormat: (value: number) => string,
  yFormat: (value: number) => string,
) {
  if (!extent) return "";
  const [xMin, xMax, yMin, yMax, count] = extent;
  return [
    `Observations: ${counts.format(count)}`,
    `X range: ${xFormat(xMin)} – ${xFormat(xMax)}`,
    `Y range: ${yFormat(yMin)} – ${yFormat(yMax)}`,
  ].join("\n");
}

export function sparseBarSeries(values: number[], vertical: boolean): CustomSeriesOption {
  return {
    id: "small-nonzero-bars",
    name: "Small nonzero value",
    type: "custom",
    clip: true,
    z: 4,
    encode: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 },
    data: values.map((value, index) => [index, value]),
    renderItem: (_, api) => {
      const index = Number(api.value(0));
      const value = Number(api.value(1));
      if (!value || !Number.isFinite(value)) return null;
      const [x, y] = api.coord(vertical ? [index, value] : [value, index]);
      const [zeroX, zeroY] = api.coord(vertical ? [index, 0] : [0, index]);
      if ((vertical ? Math.abs(y - zeroY) : Math.abs(x - zeroX)) >= 3) return null;
      return {
        type: "circle",
        shape: { cx: x, cy: y, r: 2.5 },
        style: { fill: sparseMark, stroke: "#fff", lineWidth: 0.7 },
      };
    },
  };
}

export function groupObservations(groups: ChartGroup[]) {
  const values: [number, number, number][] = [];
  groups.forEach((group, index) => {
    const counts = new Map<number, number>();
    for (const observation of group.observations ?? []) {
      if (group.whiskers && (observation < group.whiskers[0] || observation > group.whiskers[1]))
        continue;
      counts.set(observation, (counts.get(observation) ?? 0) + 1);
    }
    counts.forEach((count, value) => values.push([index, value, count]));
  });
  return {
    values,
    series: {
      type: "scatter",
      name: "Observation",
      data: values,
      symbol: "diamond",
      symbolSize: 6,
      itemStyle: { color: "#fff", borderColor: PURPLE, borderWidth: 1.5 },
      z: 5,
    },
    tooltip(index: number, format: (value: number) => string) {
      const observation = values[index];
      if (!observation) return "";
      const [group, value, count] = observation;
      return [
        categoryName(groups[group].label),
        `Value: ${format(value)}`,
        `Observations at this value: ${counts.format(count)}`,
      ].join("\n");
    },
  };
}
