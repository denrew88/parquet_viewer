import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Maximize, RotateCcw, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  chartDataZoom,
  readNumericPlotGrid,
  usePlotZoom,
  type PlotView,
  type PlotZoomCache,
} from "./usePlotZoom";
import "./ChartZoom.css";
import {
  format,
  init,
  use as registerCharts,
  type EChartsCoreOption,
  type EChartsType,
} from "echarts/core";
import { BarChart, BoxplotChart, CustomChart, LineChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type {
  ChartBackend,
  ChartData,
  ChartDetailRequest,
  ChartExtent,
  ChartRequest,
  ChartScale,
} from "./contract";
import type { ChartImageSnapshot } from "./chartImageRender";
import {
  chartDetailRange,
  extentTooltip,
  groupObservations,
  lineBucketSeries,
  scatterTileSeries,
  sparseBarSeries,
} from "./chartFidelitySeries";
import { chartScales, type ChartKind, type ChartOptions } from "./chartModel";
import {
  BLUE,
  PURPLE,
  TEAL,
  barDisplay,
  categoryName,
  distributionOutliers,
  distributionTooltip,
  firstDatum,
  formatCoordinate,
  histogramSeries,
  lineCoordinates,
  pointTooltip,
  sortGroups,
  temporalTooltipFormatter,
  violinSeries,
} from "./chartSeries";
import { useChartDetail, type ChartDetailCache } from "./useChartDetail";
import type { ChartScheduler, RenderedChart } from "./useChartJob";

registerCharts([
  BarChart,
  BoxplotChart,
  CustomChart,
  LineChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const numberFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 15 });
const tickFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 });
const MAX_FILLED_LINE_POINTS = 4_000;

function formatNumericTick(value: number) {
  const magnitude = Math.abs(value);
  return magnitude >= 1e10 || (magnitude > 0 && magnitude < 1e-4)
    ? value.toExponential(3)
    : tickFormat.format(value);
}

interface PlotProps {
  data: ChartData;
  kind: ChartKind;
  x: string;
  y: string | null;
  xScale: ChartScale;
  yScale: ChartScale;
  markSize?: number;
  options?: ChartOptions;
  scatterLabel?: string;
  barAggregate?: NonNullable<ChartRequest["bar"]>["aggregate"];
}

interface ChartPlotProps extends PlotProps {
  title: string;
  zoomCache?: PlotZoomCache;
  cardId?: string;
  viewKey?: string;
  imageRequest: Omit<ChartRequest, "requestId">;
  overview: RenderedChart;
  backend: ChartBackend;
  scheduler: ChartScheduler;
  detailCache: ChartDetailCache;
  inspectRanges: boolean;
  captureImage?: RefObject<(() => ChartImageSnapshot) | null>;
  onCaptureReady?(ready: boolean): void;
  onExactScatterDetail?(visible: boolean): void;
}

function axisTitle(name: string, scale: ChartScale, origin?: string, unit?: string) {
  if (scale !== "linear") return `${name} · ${chartScales[scale]} scale`;
  if (!origin || unit === "days") return name;
  return `${name} · offset`;
}

function coordinateFormatter(
  scale: ChartScale,
  origin?: string,
  unit?: string,
): ((value: number) => string) | undefined {
  if (scale !== "linear") {
    const inverse =
      scale === "log" ? Math.exp : scale === "log10" ? (value: number) => 10 ** value : Math.expm1;
    return (value) => {
      const original = inverse(value);
      const domain = scale === "log1p" ? original > -1 : original > 0;
      return Number.isFinite(original) && domain
        ? formatCoordinate(original)
        : `${formatCoordinate(value)} (${chartScales[scale]})`;
    };
  }
  if (unit === "days" && origin) {
    const dayZero = Date.parse(`${origin}T00:00:00Z`);
    if (Number.isFinite(dayZero)) {
      return (value) => {
        const date = new Date(dayZero + 86_400_000 * value);
        return Number.isFinite(date.getTime())
          ? date.toISOString().slice(0, 10)
          : numberFormat.format(value);
      };
    }
  }
  if (unit === "ns") {
    const units: [number, string][] = [
      [86_400_000_000_000, "d"],
      [3_600_000_000_000, "h"],
      [60_000_000_000, "min"],
      [1_000_000_000, "s"],
      [1_000_000, "ms"],
      [1_000, "µs"],
      [1, "ns"],
    ];
    return (value) => {
      const [scale, suffix] = units.find(([scale]) => Math.abs(value) >= scale) ?? [1, "ns"];
      return `${numberFormat.format(value / scale)} ${suffix}`;
    };
  }
  return undefined;
}

function plotOption({
  data,
  kind,
  x,
  y,
  xScale,
  yScale,
  markSize,
  options = {},
  scatterLabel,
  barAggregate,
}: PlotProps): EChartsCoreOption {
  const groups = data.groups ?? [];
  const xTitle = axisTitle(x, xScale, data.xOrigin, data.xUnit);
  const yTitle = axisTitle(y ?? "Rows", yScale, data.yOrigin, data.yUnit);
  const xFormatter = coordinateFormatter(xScale, data.xOrigin, data.xUnit);
  const yFormatter = coordinateFormatter(yScale, data.yOrigin, data.yUnit);
  const xFormat = xFormatter ?? formatCoordinate;
  const yFormat = yFormatter ?? formatCoordinate;
  const axis = (name: string) => ({
    name,
    nameLocation: "middle",
    nameGap: 24,
    nameTruncate: { maxWidth: 160 },
    nameTextStyle: { color: "#455b64", fontSize: 10 },
    axisLabel: { hideOverlap: true, color: "#455b64", fontSize: 10 },
    axisLine: { lineStyle: { color: "#bccace" } },
    axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: "#e7eef0" } },
  });
  const valueAxis = (name: string, formatter?: (value: number) => string, unit?: string) => ({
    ...axis(name),
    type: "value",
    scale: true,
    minInterval: unit === "days" || unit === "ns" ? 1 : undefined,
    axisLabel: { ...axis(name).axisLabel, formatter: formatter ?? formatNumericTick },
  });
  const categoryAxis = (name: string, labels: string[], onY = false) => {
    const all = options.categoryLabels === "all" || labels.length <= 8;
    const long = labels.some((label) => Array.from(label).length > 11);
    const rotate = onY ? 0 : labels.length > 16 ? 50 : long || labels.length > 8 ? 35 : 0;
    return {
      ...axis(name),
      nameGap: onY ? 83 : rotate ? 50 : 24,
      type: "category",
      boundaryGap: true,
      data: labels,
      axisLabel: {
        ...axis(name).axisLabel,
        interval: all ? 0 : "auto",
        hideOverlap: !all,
        rotate,
        width: onY ? 76 : rotate ? 61 : labels.length <= 4 ? 90 : 54,
        overflow: "truncate",
        formatter: categoryName,
      },
      splitLine: { show: false },
    };
  };
  const grid = { left: 61, top: 13, right: 20, bottom: 47 };
  function categoryLayout(category: ReturnType<typeof categoryAxis>) {
    const { data: labels, axisLabel, nameGap } = category;
    const bottom = axisLabel.rotate ? 71 : grid.bottom;
    const widest = Math.max(
      1,
      ...labels.map((label) =>
        Array.from(label).reduce((width, char) => width + (char.codePointAt(0)! > 255 ? 10 : 6), 0),
      ),
    );
    const neededWidth =
      grid.left + grid.right + (Math.min(widest, axisLabel.width) + 9) * labels.length;
    if (axisLabel.rotate || labels.length < 2) return { grid: { ...grid, bottom } };
    return {
      grid: { ...grid, bottom },
      media: [
        {
          query: { maxWidth: neededWidth },
          option: {
            xAxis: { nameGap: 48, axisLabel: { rotate: 40, width: 52 } },
            grid: { bottom: 69 },
          },
        },
        {
          option: {
            xAxis: { nameGap, axisLabel: { rotate: axisLabel.rotate, width: axisLabel.width } },
            grid: { bottom },
          },
        },
      ],
    };
  }
  const tooltip = { renderMode: "richText", confine: true, textStyle: { fontSize: 11 } };
  const base = { animation: false, grid, tooltip, dataZoom: chartDataZoom };
  const lineTime =
    kind === "line" ? temporalTooltipFormatter(data.xOrigin, data.xUnit, xFormat) : undefined;
  const exactPoints = kind === "scatter" && Boolean(data.pointDetails?.length);
  const formatPoint = pointTooltip({
    x: exactPoints || lineTime || xScale !== "linear" ? x : xTitle,
    y: exactPoints || yScale !== "linear" ? (y ?? "Value") : yTitle,
    xFormat: lineTime ?? xFormat,
    yFormat,
    label: scatterLabel,
    details: kind === "scatter" ? data.pointDetails : undefined,
  });
  if (kind === "scatter" || kind === "line") {
    const evidence = kind === "scatter" ? data.scatterTiles : data.lineBuckets;
    const bucketGaps = kind === "line" && data.sampled ? data.lineBuckets : undefined;
    const evidenceSeries = evidence?.length
      ? kind === "scatter"
        ? scatterTileSeries(evidence)
        : lineBucketSeries(evidence)
      : null;
    return {
      ...base,
      xAxis: valueAxis(xTitle, xFormatter, data.xUnit),
      yAxis: valueAxis(yTitle, yFormatter, data.yUnit),
      tooltip: {
        ...tooltip,
        ...(kind === "scatter"
          ? {
              renderMode: "html",
              className: "chart-point-tooltip",
              backgroundColor: "rgba(255, 255, 255, 0.85)",
              enterable: false,
              extraCssText:
                "z-index:2;white-space:pre-line;max-width:calc(100% - 16px);overflow-wrap:anywhere",
            }
          : {}),
        trigger: kind === "line" ? "axis" : "item",
        formatter: (params: Parameters<typeof formatPoint>[0]) => {
          const items = Array.isArray(params) ? params : [params];
          const mark = items.find((item) => item.seriesIndex === 1);
          const point = items.find((item) => item.seriesIndex === 0);
          const content = evidenceSeries
            ? [
                point ? formatPoint(point) : "",
                mark ? extentTooltip(evidence?.[mark.dataIndex], xFormat, yFormat) : "",
              ]
                .filter(Boolean)
                .join("\n")
            : formatPoint(params);
          return kind === "scatter" ? format.encodeHTML(content) : content;
        },
      },
      series: [
        kind === "scatter"
          ? {
              type: "scatter",
              name: y ?? "Value",
              dimensions: [xTitle, yTitle],
              data: data.points ?? [],
              symbolSize: markSize,
              itemStyle: { color: TEAL, opacity: 0.64 },
              large: false,
              progressive: 1600,
              progressiveThreshold: 4000,
              progressiveChunkMode: "mod",
              emphasis: { disabled: true },
              z: 3,
            }
          : {
              type: "line",
              name: y ?? "Value",
              dimensions: [xTitle, yTitle],
              data: lineCoordinates(data.points ?? [], options.lineGap, data.xUnit, bucketGaps),
              connectNulls: false,
              showSymbol: (data.points?.length ?? 0) < 80,
              symbolSize: 4,
              lineStyle: { color: BLUE, width: markSize },
              itemStyle: { color: BLUE },
              // Dense, jagged lines make a costly filled polygon. Keep every
              // point and gap in the stroke and exact hover data.
              ...((data.points?.length ?? 0) <= MAX_FILLED_LINE_POINTS
                ? { areaStyle: { color: "#e8f0f6" } }
                : {}),
            },
        ...(evidenceSeries ? [evidenceSeries] : []),
      ],
    };
  }
  if (kind === "histogram") {
    const histogram = histogramSeries(
      data.bins ?? [],
      options.histogramNormalization ?? "count",
      xFormat,
    );
    return {
      ...base,
      xAxis: valueAxis(xTitle, xFormatter, data.xUnit),
      yAxis: {
        ...valueAxis(histogram.name),
        scale: false,
        minInterval: histogram.name === "Count" ? 1 : undefined,
        axisLabel: {
          ...axis(histogram.name).axisLabel,
          formatter: histogram.name === "Percent" ? "{value}%" : undefined,
        },
      },
      tooltip: { ...tooltip, formatter: histogram.tooltip },
      series: [histogram.series],
    };
  }
  if (kind === "bar") {
    const aggregate = barAggregate ?? (y ? "sum" : "count");
    const measure =
      aggregate === "count"
        ? "Count"
        : `${aggregate === "sum" ? "Sum" : "Mean"} of ${y ?? "Value"}`;
    const vertical = options.barOrientation === "vertical";
    const category = categoryAxis(
      xTitle,
      groups.map((group) => group.label),
      !vertical,
    );
    const value = {
      ...valueAxis(measure),
      scale: false,
      minInterval: aggregate === "count" ? 1 : undefined,
    };
    const showValues = options.barShowValues ?? false;
    const showShare = (options.barShowShare ?? false) && aggregate !== "mean";
    const bars = barDisplay(groups, aggregate, data.barTotal, showValues, showShare);
    const layout = categoryLayout(category);
    return {
      ...base,
      ...(vertical ? layout : {}),
      grid: vertical
        ? { ...layout.grid, top: showValues || showShare ? 24 : grid.top }
        : { ...grid, left: 110, right: showValues || showShare ? 76 : grid.right },
      xAxis: vertical ? category : value,
      yAxis: vertical ? value : { ...category, inverse: true },
      tooltip: { ...tooltip, formatter: bars.tooltip },
      series: [
        {
          type: "bar",
          name: measure,
          barWidth: `${markSize ?? 60}%`,
          data: bars.values,
          itemStyle: { color: TEAL },
          label: {
            show: showValues || showShare,
            position: vertical ? "top" : "right",
            formatter: bars.label,
            fontSize: 10,
          },
        },
        sparseBarSeries(bars.values, vertical),
      ],
    };
  }
  const ordered = sortGroups(groups, options.groupOrder);
  const outliers = distributionOutliers(ordered);
  const showOutliers = options.showOutliers ?? true;
  const observations = groupObservations(ordered);
  const outlierSeries = showOutliers && outliers.values.length > 0;
  const category = categoryAxis(
    xTitle,
    ordered.map((group) => group.label),
  );
  const tooltipDistribution = distributionTooltip(
    ordered,
    outliers.values,
    yFormat,
    showOutliers,
    kind === "box" ? (options.whiskers ?? "iqr") : "iqr",
  );
  return {
    ...base,
    ...categoryLayout(category),
    xAxis: category,
    yAxis: valueAxis(yTitle, yFormatter, data.yUnit),
    tooltip: {
      ...tooltip,
      formatter: (params: Parameters<typeof tooltipDistribution>[0]) => {
        const item = firstDatum(params);
        if (item?.seriesIndex === (outlierSeries ? 2 : 1) && observations.values.length)
          return observations.tooltip(item.dataIndex, yFormat);
        return tooltipDistribution(params);
      },
    },
    series: [
      kind === "violin"
        ? violinSeries(ordered, yTitle, options.violinWidth)
        : {
            type: "boxplot",
            name: yTitle,
            boxWidth: [`${markSize ?? 55}%`, `${markSize ?? 55}%`],
            data: ordered.map((group) => {
              if (!group.summary) return [];
              const [min, q1, median, q3, max] = group.summary;
              return [group.whiskers?.[0] ?? min, q1, median, q3, group.whiskers?.[1] ?? max];
            }),
            itemStyle: { color: "#e6ddef", borderColor: PURPLE },
          },
      ...(outlierSeries ? [outliers.series] : []),
      ...(observations.values.length ? [observations.series] : []),
    ],
  };
}

export default function ChartPlot({
  data,
  kind,
  title,
  x,
  y,
  xScale,
  yScale,
  markSize,
  options,
  zoomCache,
  cardId,
  viewKey,
  scatterLabel,
  barAggregate,
  imageRequest,
  overview,
  backend,
  scheduler,
  detailCache,
  inspectRanges,
  captureImage,
  onCaptureReady,
  onExactScatterDetail,
}: ChartPlotProps) {
  const surface = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const exportTitle = useRef(title);
  const fullDomain = useRef<{ key: string; extent: ChartExtent } | null>(null);
  const [range, setRange] = useState<{
    key: string;
    value: Extract<ChartDetailRequest, { kind: "range" }>;
  } | null>(null);
  const [error, setError] = useState(false);
  const zoomKey = JSON.stringify([
    viewKey ?? kind,
    kind === "bar" ? (options?.barOrientation ?? "horizontal") : null,
    kind === "histogram" ? (options?.histogramNormalization ?? "count") : null,
    kind === "violin" || kind === "box" ? (options?.groupOrder ?? "label") : null,
  ]);
  const refine =
    inspectRanges &&
    (((kind === "scatter" || kind === "line") && data.sampled) ||
      (kind === "histogram" && imageRequest.histogram?.mode !== "width"));
  const onViewChange = useCallback(
    (view: PlotView | null) => {
      const domain = fullDomain.current;
      const value =
        view && domain?.key === zoomKey
          ? chartDetailRange(view, domain.extent, kind === "scatter")
          : null;
      setRange((old) => {
        if (!value) return null;
        if (old?.key === zoomKey && JSON.stringify(old.value) === JSON.stringify(value)) return old;
        return { key: zoomKey, value };
      });
    },
    [kind, zoomKey],
  );
  const zoom = usePlotZoom(chart, zoomCache, cardId, zoomKey, onViewChange);
  const { onNativeZoom, restore, currentView } = zoom;
  const detail = useChartDetail({
    detail: refine && range?.key === zoomKey ? range.value : null,
    overview,
    active: refine,
    backend,
    scheduler,
    cache: detailCache,
  });
  const exactScatterDetail =
    kind === "scatter" && detail.data !== undefined && !detail.data.scatterTiles?.length;

  useEffect(() => {
    onExactScatterDetail?.(exactScatterDetail);
    return () => onExactScatterDetail?.(false);
  }, [exactScatterDetail, onExactScatterDetail]);

  useLayoutEffect(() => {
    exportTitle.current = title;
  }, [title]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    try {
      const instance = init(element, undefined, { renderer: "canvas" });
      chart.current = instance;
      instance.on("datazoom", onNativeZoom);
      const observer = new ResizeObserver(() => {
        const { clientWidth: width, clientHeight: height } = element;
        if (
          width > 0 &&
          height > 0 &&
          (width !== instance.getWidth() || height !== instance.getHeight())
        )
          instance.resize({ width, height });
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
        instance.dispose();
        chart.current = null;
      };
    } catch {
      chart.current?.dispose();
      chart.current = null;
      setError(true);
    }
  }, [onNativeZoom]);

  useEffect(() => {
    try {
      const instance = chart.current;
      if (!instance) return;
      const plot = (plotData: ChartData) =>
        plotOption({
          data: plotData,
          kind,
          x,
          y,
          xScale,
          yScale,
          markSize,
          options,
          scatterLabel,
          barAggregate,
        });
      const withDomain = (option: EChartsCoreOption, extent: ChartExtent, refined = false) => {
        const axisDomain = (value: unknown, min: number, max: number) => {
          const axis = value as { axisLabel?: object };
          return {
            ...axis,
            min,
            max,
            ...(refined && {
              axisLabel: { ...axis.axisLabel, showMinLabel: false, showMaxLabel: false },
            }),
          };
        };
        return {
          ...option,
          xAxis: axisDomain(option.xAxis, extent[0], extent[1]),
          yAxis: axisDomain(option.yAxis, extent[2], extent[3]),
        };
      };
      let overviewOption = plot(data);
      let option = detail.data ? plot(detail.data) : overviewOption;
      const domain = fullDomain.current;
      if (refine && domain?.key === zoomKey) {
        option = withDomain(option, domain.extent, detail.data !== undefined);
        overviewOption = withDomain(overviewOption, domain.extent);
      }
      instance.setOption(option, { notMerge: true });
      if (refine && domain?.key !== zoomKey) {
        try {
          const extent = readNumericPlotGrid(instance).extent;
          fullDomain.current = { key: zoomKey, extent };
          option = withDomain(option, extent, detail.data !== undefined);
          overviewOption = withDomain(overviewOption, extent);
          instance.setOption({ xAxis: option.xAxis, yAxis: option.yAxis });
        } catch {
          // A temporarily undersized plot can still render its overview.
        }
      }
      restore(instance);
      if (captureImage) {
        captureImage.current = () => {
          const width = instance.getWidth();
          const height = instance.getHeight();
          if (width <= 0 || height <= 0)
            throw new Error("The chart has no visible area to export.");
          const view = currentView();
          return {
            title: exportTitle.current,
            kind,
            request: imageRequest,
            width,
            height,
            totalRows: data.totalRows,
            option,
            overviewOption,
            view,
            scatterExtent: data.scatterExtent,
            scatterView:
              kind === "scatter" && view ? readNumericPlotGrid(instance).extent : undefined,
            radius: (markSize ?? 5) / 2,
          };
        };
        onCaptureReady?.(true);
      }
      return () => {
        if (captureImage) captureImage.current = null;
        onCaptureReady?.(false);
      };
    } catch {
      setError(true);
    }
  }, [
    data,
    kind,
    x,
    y,
    xScale,
    yScale,
    markSize,
    options,
    scatterLabel,
    barAggregate,
    restore,
    imageRequest,
    captureImage,
    onCaptureReady,
    currentView,
    detail.data,
    refine,
    zoomKey,
  ]);

  return (
    <div
      className="chart-zoom-layout"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !zoom.selection) return;
        event.preventDefault();
        event.stopPropagation();
        zoom.cancel();
      }}
    >
      <div className="chart-zoom-toolbar" role="group" aria-label="Chart zoom">
        {detail.status ? (
          <span className="chart-zoom-hint" role="status" title={detail.error}>
            {detail.status === "loading"
              ? "Preparing detail…"
              : detail.status === "cancelled"
                ? "Detail cancelled · Showing overview"
                : detail.status === "error"
                  ? "Detail unavailable · Showing overview"
                  : detail.data?.validRows === 0
                    ? "No observations in view"
                    : `${numberFormat.format(detail.data?.validRows ?? 0)} ${detail.data?.validRows === 1 ? "row" : "rows"} in view${detail.data?.sampled ? " · Aggregated" : ""}`}
          </span>
        ) : (
          <span className="chart-zoom-hint" title="Drag to zoom · Shift+drag to pan">
            Drag to zoom · Shift+drag to pan
          </span>
        )}
        {detail.status === "loading" && (
          <button
            type="button"
            aria-label="Cancel detail"
            title="Cancel detail"
            onClick={detail.cancel}
          >
            <X aria-hidden="true" />
          </button>
        )}
        {(detail.status === "cancelled" || detail.status === "error") && (
          <button
            type="button"
            aria-label="Retry detail"
            title="Retry detail"
            onClick={detail.retry}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoom.zoomBy(0.75)}
        >
          <ZoomIn aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!zoom.zoomed}
          onClick={() => zoom.zoomBy(1 / 0.75)}
        >
          <ZoomOut aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Undo zoom"
          title="Undo zoom"
          disabled={!zoom.canUndo}
          onClick={zoom.undo}
        >
          <Undo2 aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          title="Fit entire chart"
          disabled={!zoom.zoomed}
          onClick={zoom.reset}
        >
          <Maximize aria-hidden="true" />
        </button>
      </div>
      <div
        className="chart-zoom-surface"
        tabIndex={0}
        role="group"
        aria-label="Plot interaction"
        data-zoom-selecting={Boolean(zoom.selection)}
        onPointerDownCapture={zoom.onPointerDownCapture}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerCancel}
        onLostPointerCapture={zoom.onPointerCancel}
      >
        <div
          ref={surface}
          className="chart-plot"
          role="img"
          aria-label={`${title} plot`}
          data-x-scale={xScale}
          data-y-scale={yScale}
          data-mark-size={markSize}
        />
        {zoom.selection && (
          <div
            aria-hidden="true"
            data-zoom-selection
            className="chart-zoom-selection"
            style={{
              left: zoom.selection.left,
              top: zoom.selection.top,
              width: zoom.selection.right - zoom.selection.left,
              height: zoom.selection.bottom - zoom.selection.top,
            }}
          />
        )}
      </div>
      {error && (
        <span className="chart-plot-error" role="alert">
          The chart could not be rendered.
        </span>
      )}
    </div>
  );
}
