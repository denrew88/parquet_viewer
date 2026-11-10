import { useCallback, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { EChartsType } from "echarts/core";

type Point = [number, number];
type Axis = "x" | "y";
type PercentRange = { start: number; end: number };
type ZoomRange = PercentRange | { startValue: number; endValue: number };
export type PlotView = Record<Axis, ZoomRange>;
type View = PlotView;
type Box = { left: number; top: number; right: number; bottom: number };
type ViewState = { key: string; current: View; history: View[] };
type Drag = { id: number; start: Point; bounds: Box; target: HTMLDivElement };
type ZoomEvent = Partial<PercentRange> & { dataZoomId?: string; batch?: ZoomEvent[] };

export type PlotZoomCache = Map<string, ViewState>;

const axisIds = { x: "chart-x", y: "chart-y" };
const axes = ["x", "y"] as const;
const finder = { gridIndex: 0 };
const fullRange = { start: 0, end: 100 };
const fullView: View = { x: fullRange, y: fullRange };
const historyLimit = 24;

export const chartDataZoom = axes.map((axis) => ({
  id: axisIds[axis],
  type: "inside",
  ...(axis === "x" ? { xAxisIndex: 0 } : { yAxisIndex: 0 }),
  filterMode: "none",
  zoomOnMouseWheel: "ctrl",
  moveOnMouseMove: "shift",
  moveOnMouseWheel: false,
  cursorGrab: "crosshair",
}));

function isFull(view: View) {
  return axes.every((axis) => {
    const range = view[axis];
    return "start" in range && range.start === 0 && range.end === 100;
  });
}

export function sendPlotView(chart: EChartsType, view: PlotView) {
  chart.dispatchAction(
    {
      type: "dataZoom",
      batch: axes.map((axis) => ({ dataZoomId: axisIds[axis], ...view[axis] })),
    },
    { silent: true },
  );
}

function gridBounds(chart: EChartsType, at: Point, precision = 15): Box | null {
  if (!chart.containPixel(finder, at)) return null;

  function edge(index: 0 | 1, outside: number) {
    let inside = at[index];
    for (let iteration = 0; iteration < precision; iteration++) {
      const middle = (inside + outside) / 2;
      const pixel: Point = [...at];
      pixel[index] = middle;
      if (chart.containPixel(finder, pixel)) inside = middle;
      else outside = middle;
    }
    return inside;
  }

  return {
    left: edge(0, 0),
    right: edge(0, chart.getWidth()),
    top: edge(1, 0),
    bottom: edge(1, chart.getHeight()),
  };
}

export function readNumericPlotGrid(chart: EChartsType) {
  const width = chart.getWidth();
  const height = chart.getHeight();
  // ECharts can move the grid to fit labels. Measure the rendered coordinate
  // system, including a few ULPs so searching from the inside keeps edge points.
  const grid = gridBounds(chart, [width / 2, height / 2], 48);
  if (!grid || grid.right - grid.left < 1 || grid.bottom - grid.top < 1)
    throw new Error("The scatter plot is too small to export.");
  const epsilon = 16 * Number.EPSILON * Math.max(width, height);
  const lower = chart.convertFromPixel(finder, [grid.left - epsilon, grid.bottom + epsilon]);
  const upper = chart.convertFromPixel(finder, [grid.right + epsilon, grid.top - epsilon]);
  if (
    !Array.isArray(lower) ||
    !Array.isArray(upper) ||
    ![...lower, ...upper].every(Number.isFinite)
  )
    throw new Error("The scatter plot axis range is unavailable.");
  const extent: [number, number, number, number] = [lower[0], upper[0], lower[1], upper[1]];
  if (extent[0] >= extent[1] || extent[2] >= extent[3])
    throw new Error("The scatter plot axis range is unavailable.");
  return { grid, extent };
}

function pointerPoint(event: PointerEvent<HTMLDivElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return [event.clientX - bounds.left, event.clientY - bounds.top];
}

function dragBox(drag: Drag, at: Point): Box {
  const x = Math.max(drag.bounds.left, Math.min(drag.bounds.right, at[0]));
  const y = Math.max(drag.bounds.top, Math.min(drag.bounds.bottom, at[1]));
  return {
    left: Math.min(x, drag.start[0]),
    right: Math.max(x, drag.start[0]),
    top: Math.min(y, drag.start[1]),
    bottom: Math.max(y, drag.start[1]),
  };
}

function valueRange(first: number, second: number): ZoomRange {
  return { startValue: Math.min(first, second), endValue: Math.max(first, second) };
}

function readPercentRanges(chart: EChartsType) {
  type AxisOption = { type?: string; data?: unknown[] };
  const options = chart.getOption() as {
    dataZoom?: (ZoomEvent & { id?: string })[];
    xAxis?: AxisOption[];
    yAxis?: AxisOption[];
  };
  const ranges = options.dataZoom ?? [];
  return axes.map((axis) => {
    const range = ranges.find((option) => option.id === axisIds[axis]);
    const option = options[`${axis}Axis`]?.[0];
    const categories = option?.type === "category" ? (option.data?.length ?? 0) : 0;
    return { start: range?.start ?? 0, end: range?.end ?? 100, categories };
  });
}

export function usePlotZoom(
  chart: RefObject<EChartsType | null>,
  cache: PlotZoomCache | undefined,
  cardId: string | undefined,
  viewKey: string,
) {
  const state = useRef<ViewState>({ key: viewKey, current: fullView, history: [] });
  const drag = useRef<Drag | null>(null);
  const lastNative = useRef(-Infinity);
  const [selection, setSelection] = useState<Box | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const refresh = useCallback(() => {
    setCanUndo(state.current.history.length > 0);
    setZoomed(!isFull(state.current.current));
  }, []);
  const currentView = useCallback(() => {
    const view = state.current.current;
    return isFull(view) ? null : view;
  }, []);

  const finishDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.id)) {
      current.target.releasePointerCapture(current.id);
    }
    setSelection(null);
  }, []);

  const restore = useCallback(
    (instance: EChartsType) => {
      if (drag.current) finishDrag();
      const remembered = (cardId && cache?.get(cardId)) || state.current;
      if (remembered.key !== viewKey) {
        state.current = { key: viewKey, current: fullView, history: [] };
      } else {
        state.current = remembered;
      }
      if (cardId) cache?.set(cardId, state.current);
      if (!isFull(state.current.current)) sendPlotView(instance, state.current.current);
      refresh();
    },
    [cache, cardId, finishDrag, refresh, viewKey],
  );

  const remember = useCallback(() => {
    const view = state.current;
    if (view.history.length === historyLimit) view.history.shift();
    view.history.push(view.current);
  }, []);

  const onNativeZoom = useCallback(
    (payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as ZoomEvent;
      const next = { ...state.current.current };
      for (const zoom of event.batch ?? [event]) {
        const axis = axes.find((candidate) => axisIds[candidate] === zoom.dataZoomId);
        if (axis && typeof zoom.start === "number" && typeof zoom.end === "number") {
          next[axis] = { start: zoom.start, end: zoom.end };
        }
      }
      if (next.x === state.current.current.x && next.y === state.current.current.y) return;
      const now = performance.now();
      if (now - lastNative.current > 250) remember();
      lastNative.current = now;
      state.current.current = next;
      refresh();
    },
    [refresh, remember],
  );

  function apply(view: View) {
    const instance = chart.current;
    if (!instance) return;
    remember();
    lastNative.current = -Infinity;
    state.current.current = view;
    sendPlotView(instance, view);
    refresh();
  }

  function zoomBy(factor: number) {
    if (!chart.current) return;
    const [x, y] = readPercentRanges(chart.current).map(({ start, end, categories }) => {
      const singleCategorySpan = factor > 1 && categories > 1 ? 200 / (categories - 1) : 0;
      const span = Math.min(100, (end - start || singleCategorySpan) * factor);
      const left = Math.max(0, Math.min(100 - span, (start + end - span) / 2));
      return { start: left, end: left + span };
    });
    if (x && y) apply({ x, y });
  }

  return {
    selection,
    zoomed,
    canUndo,
    restore,
    onNativeZoom,
    zoomBy,
    currentView,
    cancel: finishDrag,
    undo() {
      const previous = state.current.history.pop();
      if (!previous || !chart.current) return;
      lastNative.current = -Infinity;
      state.current.current = previous;
      sendPlotView(chart.current, previous);
      refresh();
    },
    reset() {
      if (!isFull(state.current.current)) apply(fullView);
    },
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      if (
        event.shiftKey ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        !event.isPrimary ||
        !chart.current
      ) {
        return;
      }
      const start = pointerPoint(event);
      const bounds = gridBounds(chart.current, start);
      if (!bounds) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.focus({ preventScroll: true });
      target.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, start, bounds, target };
      chart.current.dispatchAction({ type: "hideTip" });
      setSelection(dragBox(drag.current, start));
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const current = drag.current;
      if (current?.id === event.pointerId) setSelection(dragBox(current, pointerPoint(event)));
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const current = drag.current;
      if (current?.id !== event.pointerId || !chart.current) return;
      const box = dragBox(current, pointerPoint(event));
      finishDrag();
      if (box.right - box.left < 6 || box.bottom - box.top < 6) return;

      const first = chart.current.convertFromPixel(finder, [box.left, box.bottom]);
      const second = chart.current.convertFromPixel(finder, [box.right, box.top]);
      if (
        !Array.isArray(first) ||
        !Array.isArray(second) ||
        ![...first, ...second].every(Number.isFinite)
      ) {
        return;
      }
      apply({ x: valueRange(first[0]!, second[0]!), y: valueRange(first[1]!, second[1]!) });
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) {
      if (drag.current?.id === event.pointerId) finishDrag();
    },
  };
}
