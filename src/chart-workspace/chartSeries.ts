import type { CustomSeriesOption } from "echarts/charts";
import type { ChartData } from "./contract";
import type { ChartOptions } from "./chartModel";

export const TEAL = "#087f78";
export const PURPLE = "#77599c";
export const BLUE = "#356fa5";
const OUTLIER = "#a34458";
const numberFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 15 });
const percentFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

type NumberFormatter = (value: number) => string;
export type ChartGroup = NonNullable<ChartData["groups"]>[number];

interface TooltipDatum {
  dataIndex: number;
  seriesIndex?: number;
  value?: unknown;
}

function firstDatum(params: TooltipDatum | TooltipDatum[]): TooltipDatum | undefined {
  return Array.isArray(params) ? params[0] : params;
}

export function formatCoordinate(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude >= 1e12 || (magnitude > 0 && magnitude < 1e-5)
    ? value.toExponential(4)
    : numberFormat.format(value);
}

const nanosecondsPerSecond = 1_000_000_000n;
const timeOrigin =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?(?:\s+\[([^\]]+)\])?$/;

function zoneClock(zone: string) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    return (time: number) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(time).map(({ type, value }) => [type, value]),
      );
      return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    };
  } catch {
    return null;
  }
}

export function temporalTooltipFormatter(
  origin: string | undefined,
  unit: string | undefined,
  fallback: NumberFormatter,
): NumberFormatter | undefined {
  if (!origin || (unit !== "ns" && unit !== "days")) return undefined;
  const matches = timeOrigin.exec(unit === "days" ? `${origin}T00:00:00` : origin);
  if (!matches) return undefined;
  const [, day, clock, fraction = "", numericZone = "", namedZone] = matches;
  const local = `${day}T${clock}`;
  const wallTime = Date.parse(`${local}Z`);
  if (!Number.isFinite(wallTime)) return undefined;

  const dynamicZone =
    namedZone && !/^(?:UTC|GMT|(?:UTC)?[+-]\d\d:\d\d)$/.test(namedZone)
      ? zoneClock(namedZone)
      : null;
  let epoch = wallTime;
  if (dynamicZone) {
    // Identify a unique instant for this local wall clock. A daylight-saving fold
    // supplies two candidates, so retain elapsed units for an ambiguous origin.
    const nearby = [wallTime - 86_400_000, wallTime, wallTime + 86_400_000];
    const candidates = new Set(
      nearby.map((time) => time + wallTime - Date.parse(`${dynamicZone(time)}Z`)),
    );
    const matching = [...candidates].filter(
      (time) => Number.isFinite(time) && dynamicZone(time) === local,
    );
    if (matching.length !== 1) return undefined;
    epoch = matching[0];
  } else if (namedZone && !/^(?:UTC|GMT|(?:UTC)?[+-]\d\d:\d\d)$/.test(namedZone)) {
    return undefined;
  }

  const originNs = BigInt(epoch) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
  const suffix = namedZone ? ` [${namedZone}]` : numericZone;
  return (offset) => {
    const delta = Math.round(unit === "days" ? offset * 86_400_000_000_000 : offset);
    if (!Number.isFinite(delta)) return fallback(offset);
    const position = originNs + BigInt(delta);
    const remainder =
      ((position % nanosecondsPerSecond) + nanosecondsPerSecond) % nanosecondsPerSecond;
    const epochMs = Number((position - remainder) / 1_000_000n);
    const date = new Date(epochMs);
    if (!Number.isFinite(date.getTime())) return fallback(offset);
    const base = (dynamicZone ? dynamicZone(epochMs) : date.toISOString().split(".")[0]).replace(
      "T",
      " ",
    );
    if (unit === "days" && Number.isInteger(offset)) return base.split(" ")[0];
    const fractional = remainder.toString().padStart(9, "0").replace(/0+$/, "");
    const approximation = !Number.isSafeInteger(delta) && unit === "ns" ? "≈ " : "";
    return `${approximation}${base}${fractional ? `.${fractional}` : ""}${suffix}`;
  };
}

function valueLabel(value: number | null | undefined, format: NumberFormatter): string {
  return value == null ? "—" : format(value);
}

export function categoryName(label: string) {
  return label || "(empty)";
}

export function pointTooltip({
  details,
  x,
  y,
  label,
  xFormat,
  yFormat,
}: {
  details?: ChartData["pointDetails"];
  x: string;
  y: string;
  label?: string;
  xFormat: NumberFormatter;
  yFormat: NumberFormatter;
}) {
  return (params: TooltipDatum | TooltipDatum[]) => {
    const point = firstDatum(params);
    if (!point) return "";
    const detail = details?.[point.dataIndex];
    if (detail) {
      return [
        `${x}: ${detail.x}`,
        `${y}: ${detail.y}`,
        `Source row: ${numberFormat.format(detail.row)}`,
        ...(detail.label !== undefined ? [`${label ?? "Label"}: ${detail.label}`] : []),
      ].join("\n");
    }
    if (!Array.isArray(point.value)) return "";
    const [px, py] = point.value as [number, number | null];
    return py == null
      ? `${x}: ${valueLabel(px, xFormat)}\nGap`
      : `${x}: ${valueLabel(px, xFormat)}\n${y}: ${valueLabel(py, yFormat)}`;
  };
}

export function lineCoordinates(
  points: [number, number][],
  gap: number | undefined,
  unit: string | undefined,
): [number, number | null][] {
  if (!gap) return points;
  const threshold = unit === "ns" ? gap * 1e9 : unit === "days" ? gap / 86_400 : gap;
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    if (!previous || point[0] - previous[0] <= threshold) return [point];
    return [[previous[0] / 2 + point[0] / 2, null], point];
  });
}

export function histogramSeries(
  bins: NonNullable<ChartData["bins"]>,
  normalization: NonNullable<ChartOptions["histogramNormalization"]>,
  formatX: NumberFormatter,
) {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  const rows = bins.map(({ start, end, count }) => {
    const share = total === 0 ? 0 : count / total;
    const height =
      normalization === "percent"
        ? 100 * share
        : normalization === "density"
          ? end > start
            ? share / (end - start)
            : 0
          : count;
    return [start, end, Number.isFinite(height) ? height : null, count];
  });
  const name =
    normalization === "percent" ? "Percent" : normalization === "density" ? "Density" : "Count";
  const series: CustomSeriesOption = {
    type: "custom",
    name,
    clip: true,
    dimensions: ["Bin start", "Bin end", name, "Bin rows"],
    encode: { x: [0, 1], y: 2, tooltip: [3] },
    data: rows,
    renderItem: (_params, api) => {
      const start = Number(api.value(0));
      const end = Number(api.value(1));
      const value = Number(api.value(2));
      if (!Number.isFinite(value) || value <= 0) return null;
      const [left, top] = api.coord([start, value]);
      const [right, baseline] = api.coord([end, 0]);
      return {
        type: "rect",
        shape: {
          x: right > left ? left : left - 9,
          y: top,
          width: right > left ? right - left : 18,
          height: Math.max(0, baseline - top),
        },
        style: { fill: TEAL, stroke: "#fff", lineWidth: 1 },
      };
    },
  };
  const tooltip = (params: TooltipDatum | TooltipDatum[]) => {
    const index = firstDatum(params)?.dataIndex;
    if (index === undefined || !bins[index]) return "";
    const bin = bins[index];
    const height = rows[index][2];
    const share = total === 0 ? 0 : 100 * (bin.count / total);
    return [
      `Bin: [${formatX(bin.start)}, ${formatX(bin.end)}${index === bins.length - 1 ? "]" : ")"}`,
      `Count: ${numberFormat.format(bin.count)}`,
      `In range: ${numberFormat.format(total)} rows`,
      `Share: ${percentFormat.format(share)}%`,
      ...(normalization === "density" && height !== null
        ? [`Density: ${formatCoordinate(height)}`]
        : []),
    ].join("\n");
  };
  return { series, tooltip, name };
}

export function sortGroups(groups: ChartGroup[], order: ChartOptions["groupOrder"]): ChartGroup[] {
  const labels = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
  return [...groups].sort((a, b) => {
    const compared =
      order === "median"
        ? (a.summary?.[2] ?? 0) - (b.summary?.[2] ?? 0)
        : order === "count"
          ? b.count - a.count
          : 0;
    return compared || labels.compare(a.label, b.label);
  });
}

function violinWidths(groups: ChartGroup[], mode: ChartOptions["violinWidth"]): number[] {
  if (mode === "count") {
    const peak = Math.max(1, ...groups.map((group) => group.count));
    return groups.map((group) => group.count / peak);
  }
  if (mode !== "area") return groups.map(() => 1);
  const areas = groups.map(({ density = [] }) =>
    density.reduce((sum, [value, width], index) => {
      const previous = density[index - 1];
      return previous ? sum + Math.abs(value - previous[0]) * ((width + previous[1]) / 2) : sum;
    }, 0),
  );
  const least = Math.min(...areas.filter((area) => area > 0 && Number.isFinite(area)));
  return areas.map((area) => (area > 0 && Number.isFinite(area) ? least / area : 1));
}

export function violinSeries(
  groups: ChartGroup[],
  valueName: string,
  widthMode: ChartOptions["violinWidth"],
): CustomSeriesOption {
  const widths = violinWidths(groups, widthMode);
  const renderItem: NonNullable<CustomSeriesOption["renderItem"]> = (params, api) => {
    const index = params.dataIndex;
    const group = groups[index];
    if (!group?.summary) return null;
    const [min, q1, median, q3, max] = group.summary;
    const [lower, upper] = group.whiskers ?? [min, max];
    const [center, medianY] = api.coord([index, median]);
    const step = Math.abs(api.coord([index + 1, median])[0] - center);
    const density = group.density ?? [];
    const halfWidth = Math.min(step * 0.36, 44) * widths[index];
    const path = (side: -1 | 1, entries: [number, number][]) =>
      entries.map(([value, width]) => [
        center + side * halfWidth * width,
        api.coord([index, value])[1],
      ]);
    const points = [...path(-1, density), ...path(1, [...density].reverse())];
    const line = (from: number, to: number, lineWidth: number) => ({
      type: "line" as const,
      shape: {
        x1: center,
        x2: center,
        y1: api.coord([index, from])[1],
        y2: api.coord([index, to])[1],
      },
      style: { stroke: PURPLE, lineWidth },
    });
    return {
      type: "group",
      children: [
        ...(points.length >= 4
          ? [
              {
                type: "polygon" as const,
                shape: { points },
                style: { fill: "#e6ddef", stroke: PURPLE, lineWidth: 1.25 },
              },
            ]
          : []),
        line(lower, upper, 1),
        line(q1, q3, 3),
        { type: "circle", shape: { cx: center, cy: medianY, r: 3 }, style: { fill: PURPLE } },
      ],
    };
  };
  return {
    type: "custom",
    name: valueName,
    clip: true,
    renderItem,
    encode: { x: 0, y: [1, 2], tooltip: [3, 4], itemName: 5 },
    dimensions: ["Group", "Minimum", "Maximum", `Median of ${valueName}`, "Rows", "Label"],
    data: groups.map((group, index) => [
      index,
      group.summary?.[0] ?? 0,
      group.summary?.[4] ?? 0,
      group.summary?.[2] ?? 0,
      group.count,
      group.label,
    ]),
  };
}

export function distributionOutliers(groups: ChartGroup[]) {
  const values: [number, number][] = groups.flatMap((group, index) =>
    (group.outliers ?? []).map((value) => [index, value] as [number, number]),
  );
  return {
    values,
    series: {
      type: "scatter",
      name: "Outlier",
      data: values,
      symbolSize: 5,
      itemStyle: { color: OUTLIER, opacity: 0.68 },
      z: 6,
    },
  };
}

export function distributionTooltip(
  groups: ChartGroup[],
  outliers: [number, number][],
  format: NumberFormatter,
  showOutliers = true,
  rule?: ChartOptions["whiskers"],
) {
  function outlierSummary(group: ChartGroup) {
    if (group.outlierCount === undefined) return [];
    const shown = showOutliers ? (group.outliers?.length ?? 0) : 0;
    return [
      `Outliers: ${numberFormat.format(group.outlierCount)}`,
      ...(shown < group.outlierCount
        ? [`Outlier points shown: ${numberFormat.format(shown)}`]
        : []),
    ];
  }
  return (params: TooltipDatum | TooltipDatum[]) => {
    const point = firstDatum(params);
    if (!point) return "";
    if (point.seriesIndex === 1) {
      const outlier = outliers[point.dataIndex];
      if (outlier) {
        const group = groups[outlier[0]];
        return [
          categoryName(group.label),
          `Outlier: ${format(outlier[1])}`,
          `N: ${numberFormat.format(group.count)}`,
          ...outlierSummary(group),
        ].join("\n");
      }
    }
    const group = groups[point.dataIndex];
    if (!group?.summary) return "";
    const [min, q1, median, q3, max] = group.summary;
    const lines = [
      categoryName(group.label),
      `N: ${numberFormat.format(group.count)}`,
      ...(group.sampleCount !== undefined && group.sampleCount < group.count
        ? [
            `Sample: ${numberFormat.format(group.sampleCount)} of ${numberFormat.format(group.count)} rows`,
          ]
        : []),
      `Minimum: ${format(min)}`,
      `Q1: ${format(q1)}`,
      `Median: ${format(median)}`,
      `Q3: ${format(q3)}`,
      `Maximum: ${format(max)}`,
    ];
    if (group.whiskers)
      lines.push(`Whiskers: ${format(group.whiskers[0])} to ${format(group.whiskers[1])}`);
    if (rule) lines.push(`Rule: ${rule === "minmax" ? "Minimum and maximum" : "1.5 × IQR"}`);
    lines.push(...outlierSummary(group));
    return lines.join("\n");
  };
}

export function barDisplay(
  groups: ChartGroup[],
  aggregate: "count" | "sum" | "mean",
  total: number | undefined,
  showValues: boolean,
  showShare: boolean,
) {
  const values = groups.map((group) => (aggregate === "count" ? group.count : (group.value ?? 0)));
  const share = (value: number) => {
    if (aggregate === "mean" || !total || !Number.isFinite(total)) return null;
    const percent = (value / total) * 100;
    return Number.isFinite(percent) ? `${percentFormat.format(percent)}%` : null;
  };
  return {
    values,
    label: ({ dataIndex }: TooltipDatum) => {
      const value = values[dataIndex];
      if (value === undefined) return "";
      return [showValues ? formatCoordinate(value) : null, showShare ? share(value) : null]
        .filter(Boolean)
        .join(" · ");
    },
    tooltip: (params: TooltipDatum | TooltipDatum[]) => {
      const index = firstDatum(params)?.dataIndex;
      if (index === undefined || !groups[index]) return "";
      const value = values[index];
      const ratio = share(value);
      return [
        categoryName(groups[index].label),
        `${aggregate === "count" ? "Count" : aggregate === "sum" ? "Sum" : "Mean"}: ${formatCoordinate(value)}`,
        ...(aggregate === "count" ? [] : [`N: ${numberFormat.format(groups[index].count)}`]),
        ...(ratio !== null ? [`Share: ${ratio}`] : []),
      ].join("\n");
    },
  };
}
