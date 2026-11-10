import { init, use as registerCharts, type EChartsCoreOption } from "echarts/core";
import {
  MAX_CHART_IMAGE_PIXELS,
  type ChartData,
  type ChartImageCopy,
  type ChartKind,
  type ChartRequest,
  type ScatterSvgFrame,
} from "./contract";
import { readNumericPlotGrid, sendPlotView, type PlotView } from "./usePlotZoom";

type Extent = NonNullable<ChartData["scatterExtent"]>;

export interface ChartImageSnapshot {
  title: string;
  kind: ChartKind;
  request: Omit<ChartRequest, "requestId">;
  width: number;
  height: number;
  totalRows: number;
  option: EChartsCoreOption;
  view: PlotView | null;
  scatterExtent?: Extent;
  scatterView?: Extent;
  radius: number;
}

const titleHeight = 32;
const svgNamespace = "http://www.w3.org/2000/svg";
function scatterPointsInRange(data: unknown[], [xMin, xMax, yMin, yMax]: Extent) {
  return data.filter(
    (point) =>
      Array.isArray(point) &&
      point[0] >= xMin &&
      point[0] <= xMax &&
      point[1] >= yMin &&
      point[1] <= yMax,
  );
}

function exportOption(
  snapshot: ChartImageSnapshot,
  extent?: Extent,
  allPoints = false,
): EChartsCoreOption {
  const option = snapshot.option;
  const series = option.series as EChartsCoreOption[] | undefined;
  return {
    ...option,
    animation: false,
    tooltip: { show: false },
    ...(extent
      ? {
          xAxis: { ...(option.xAxis as object), min: extent[0], max: extent[1] },
          yAxis: { ...(option.yAxis as object), min: extent[2], max: extent[3] },
        }
      : {}),
    series: series?.map((item) => ({
      ...item,
      progressive: 0,
      silent: true,
      ...(allPoints
        ? { data: [] }
        : extent && Array.isArray(item.data)
          ? { data: scatterPointsInRange(item.data, extent) }
          : {}),
    })),
  };
}

function padRange(min: number, max: number): [number, number] {
  // Include the point radius at the full-range boundary and give a constant
  // axis a visible span, as the on-screen axis does.
  const margin = min === max ? Math.max(1, Math.abs(min) * 0.02) : (max - min) * 0.02;
  const lower = min - margin;
  const upper = max + margin;
  return [Number.isFinite(lower) ? lower : min, Number.isFinite(upper) ? upper : max];
}

export function fullScatterRange(extent: Extent): Extent {
  return [...padRange(extent[0], extent[1]), ...padRange(extent[2], extent[3])];
}

function bitmapSize(width: number, height: number) {
  const ratio = Math.min(2, Math.sqrt(MAX_CHART_IMAGE_PIXELS / (width * height)));
  return {
    ratio,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
  };
}

export function renderChartPng(snapshot: ChartImageSnapshot): HTMLCanvasElement {
  const { width, height, title } = snapshot;
  const size = bitmapSize(width, height + titleHeight);
  const chart = init(document.createElement("div"), undefined, {
    renderer: "canvas",
    width,
    height,
    devicePixelRatio: 1,
  });
  try {
    chart.setOption(exportOption(snapshot), { silent: true });
    if (snapshot.view) sendPlotView(chart, snapshot.view);
    const plot = chart.renderToCanvas({ backgroundColor: "#ffffff", pixelRatio: size.ratio });
    const image = document.createElement("canvas");
    image.width = size.width;
    image.height = size.height;
    const context = image.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The PNG renderer is unavailable.");
    const top = Math.floor(titleHeight * size.ratio);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(plot, 0, top, image.width, image.height - top);
    context.scale(size.ratio, size.ratio);
    context.font = "600 14px system-ui, sans-serif";
    context.fillStyle = "#243843";
    context.textBaseline = "middle";
    context.fillText(title, 10, titleHeight / 2, Math.max(1, width - 20));
    return image;
  } finally {
    chart.dispose();
  }
}

export function canvasClipboardImage(canvas: HTMLCanvasElement): ChartImageCopy {
  const { width, height } = canvas;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The image clipboard renderer is unavailable.");
  const { data } = context.getImageData(0, 0, width, height);
  // Encode in a multiple of three so only the last chunk has base64 padding.
  const chunkSize = 0x6000;
  let rgba = "";
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    rgba += btoa(String.fromCharCode(...data.subarray(offset, offset + chunkSize)));
  }
  return { width, height, rgba };
}

export function addSvgTitle(
  source: string,
  snapshot: Pick<ChartImageSnapshot, "title" | "width" | "height">,
) {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== svgNamespace)
    throw new Error("The SVG renderer did not produce a valid image.");
  for (const node of root.querySelectorAll("style")) node.remove();
  for (const node of root.querySelectorAll("[class]")) node.removeAttribute("class");
  root.removeAttribute("xmlns:xlink");
  const { title, width, height } = snapshot;
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height + titleHeight));
  root.setAttribute("viewBox", `0 0 ${width} ${height + titleHeight}`);

  const background = parsed.createElementNS(svgNamespace, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height + titleHeight));
  background.setAttribute("fill", "#ffffff");

  const heading = parsed.createElementNS(svgNamespace, "text");
  heading.setAttribute("x", "10");
  heading.setAttribute("y", "21");
  heading.setAttribute("fill", "#243843");
  heading.setAttribute("font-size", "14");
  heading.setAttribute("font-family", "system-ui, sans-serif");
  heading.setAttribute("font-weight", "600");
  heading.textContent = title;

  const plot = parsed.createElementNS(svgNamespace, "g");
  plot.setAttribute("transform", `translate(0 ${titleHeight})`);
  plot.append(...Array.from(root.childNodes));
  root.append(background, heading, plot);
  return new XMLSerializer().serializeToString(root);
}

export async function renderChartSvg(
  snapshot: ChartImageSnapshot,
  view: "current" | "entire",
  allPoints: boolean,
): Promise<{ data: string; frame?: ScatterSvgFrame }> {
  const { install } = await import("echarts/lib/renderer/installSVGRenderer.js");
  registerCharts(install);
  const { width, height } = snapshot;
  let extent = view === "current" && snapshot.kind === "scatter" ? snapshot.scatterView : undefined;
  if (allPoints) {
    if (!snapshot.scatterExtent)
      throw new Error("The full scatter range is unavailable. Retry the chart before saving.");
    extent ??= fullScatterRange(snapshot.scatterExtent);
  }
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width, height });
  try {
    chart.setOption(exportOption(snapshot, extent, allPoints), { silent: true });
    if (!extent && view === "current" && snapshot.view) sendPlotView(chart, snapshot.view);
    const data = addSvgTitle(chart.renderToSVGString({ useViewBox: true }), snapshot);
    if (!allPoints || !extent) return { data };
    const { grid } = readNumericPlotGrid(chart);
    return {
      data,
      frame: {
        xMin: extent[0],
        xMax: extent[1],
        yMin: extent[2],
        yMax: extent[3],
        left: grid.left,
        top: grid.top + titleHeight,
        width: grid.right - grid.left,
        height: grid.bottom - grid.top,
        radius: snapshot.radius,
      },
    };
  } finally {
    chart.dispose();
  }
}
