import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, MoveDiagonal2, SlidersHorizontal } from "lucide-react";
import { ChartImageControls } from "./ChartImageControls";
import type { ChartImageSnapshot } from "./chartImageRender";
import type { ChartBackend } from "./contract";
import {
  appearanceSettings,
  hasAppearance,
  planChart,
  type ChartCardModel,
  type ResolvedSource,
} from "./chartModel";
import { useChartJob, type ChartScheduler, type RenderedChart } from "./useChartJob";
import type { PlotZoomCache } from "./usePlotZoom";

const ChartPlot = lazy(() => import("./ChartPlot"));
const chartDragType = "application/x-data-viewer-chart";
const formatNumber = new Intl.NumberFormat("en-US");

interface Props {
  card: ChartCardModel;
  source: ResolvedSource;
  selected: boolean;
  active: boolean;
  backend: ChartBackend;
  scheduler: ChartScheduler;
  cache: Map<string, RenderedChart>;
  zoomCache: PlotZoomCache;
  onSelect(): void;
  onMove(direction: -1 | 1): void;
  onDrop(movedId: string): void;
  onResize(width: number | null, height: number): void;
}

function clampHeight(height: number) {
  return Math.min(520, Math.max(170, height));
}

const minCardWidth = 290;

function cardWidthLimits(card: HTMLElement | null) {
  const layout = card?.parentElement;
  if (!card || !layout) return null;
  const available = layout.clientWidth;
  if (!available) return null;
  const gap = Number.parseFloat(getComputedStyle(layout).columnGap) || 0;
  const span = available + gap;
  return {
    span,
    width: ((card.getBoundingClientRect().width + gap) / span) * 100,
    minimum: Math.min(100, ((minCardWidth + gap) / span) * 100),
  };
}

function clampWidth(width: number, minimum: number) {
  return Math.min(100, Math.max(minimum, width));
}

export function ChartCard({
  card,
  source,
  selected,
  active,
  backend,
  scheduler,
  cache,
  zoomCache,
  onSelect,
  onMove,
  onDrop,
  onResize,
}: Props) {
  const element = useRef<HTMLElement>(null);
  const captureImage = useRef<(() => ChartImageSnapshot) | null>(null);
  const [captureReady, setCaptureReady] = useState(false);
  const resize = useRef<{
    x: number;
    y: number;
    width: number;
    minimum: number;
    span: number;
    height: number;
    preferred: number | null;
  } | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const plan = planChart(card, source);
  const { display, current, cancel, retry } = useChartJob({
    id: card.id,
    plan,
    active: active && visible,
    backend,
    scheduler,
    cache,
  });

  useEffect(() => {
    if (!element.current || !active || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [active]);

  const data = display?.data;
  const plotOptions = useMemo(
    () =>
      display?.kind === "box" ? { ...card.options, whiskers: display.whiskers } : card.options,
    [card.options, display?.kind, display?.whiskers],
  );
  const renderable = Boolean(
    data && (data.validRows > 0 || (display?.kind === "histogram" && data.bins?.length)),
  );
  const scaleExcludedRows = data?.scaleExcludedRows ?? 0;
  const zeroWidthDensity =
    card.options.histogramNormalization === "density" &&
    Boolean(data?.bins?.some((bin) => bin.count > 0 && bin.end <= bin.start));
  const markSize =
    display && hasAppearance(display.kind)
      ? (card.options.appearance?.[display.kind] ?? appearanceSettings[display.kind].initial)
      : undefined;
  const blocked = "message" in plan ? plan.message : null;
  const status = blocked ? "blocked" : (current?.status ?? "waiting");
  const note = blocked ?? (current?.status === "error" ? current.error : null);
  const selection =
    card.binding?.kind === "block"
      ? { rows: card.binding.block.rowCount, columns: card.binding.block.columns.length }
      : card.binding?.kind === "file" && card.binding.selection
        ? {
            rows: card.binding.selection.rowCount,
            columns: card.binding.selection.columnIds.length,
          }
        : null;

  return (
    <article
      ref={element}
      className="chart-card"
      aria-label={card.title}
      aria-busy={status === "loading"}
      data-card-id={card.id}
      data-selected={selected}
      style={{
        width:
          card.width === null
            ? undefined
            : `calc(${card.width}% - var(--chart-card-gap) * ${1 - card.width / 100})`,
        minWidth: `min(${minCardWidth}px, 100%)`,
      }}
      data-state={status}
      data-result-id={display?.resultId}
      data-x-scale={display?.xScale}
      data-y-scale={display?.yScale}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(chartDragType)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(chartDragType);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(id);
      }}
    >
      <header className="chart-card-heading">
        <button
          type="button"
          draggable
          className="chart-icon-button chart-drag-handle"
          aria-label={`Move ${card.title}`}
          title="Drag to reorder, or use the arrow keys"
          onDragStart={(event) => {
            event.dataTransfer.setData(chartDragType, card.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            onMove(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1);
          }}
        >
          <GripVertical aria-hidden="true" />
        </button>
        <div className="chart-card-title">
          <h3 title={card.title}>{card.title}</h3>
          <p title={source.name}>
            {selection
              ? "Selected cells"
              : card.binding?.kind === "file"
                ? "File"
                : card.binding
                  ? "SQL"
                  : "Source"}
            {" · "}
            {source.name || "Not selected"}
          </p>
        </div>
        <button
          type="button"
          className="chart-icon-button"
          aria-label={`Edit ${card.title}`}
          aria-pressed={selected}
          onClick={onSelect}
        >
          <SlidersHorizontal aria-hidden="true" />
        </button>
        <ChartImageControls
          backend={backend}
          captureImage={captureImage}
          ready={active && renderable && status === "ready" && captureReady}
        />
      </header>
      <div className="chart-plot-frame" style={{ height: card.height }}>
        {data && display && renderable && active ? (
          <Suspense
            fallback={<div className="chart-plot-placeholder">Loading chart renderer…</div>}
          >
            <ChartPlot
              data={data}
              kind={display.kind}
              title={card.title}
              x={display.x}
              y={display.y}
              xScale={display.xScale}
              yScale={display.yScale}
              markSize={markSize}
              scatterLabel={display.scatterLabel}
              barAggregate={display.barAggregate}
              options={plotOptions}
              viewKey={JSON.stringify([
                display.key,
                display.kind === "bar" ? (card.options.barOrientation ?? "horizontal") : undefined,
                display.kind === "violin" || display.kind === "box"
                  ? (card.options.groupOrder ?? "label")
                  : undefined,
              ])}
              cardId={card.id}
              zoomCache={zoomCache}
              imageRequest={display.request}
              captureImage={captureImage}
              onCaptureReady={setCaptureReady}
            />
          </Suspense>
        ) : (
          <div className="chart-plot-placeholder">
            {note
              ? null
              : data
                ? "No plottable rows."
                : status === "loading"
                  ? "Calculating chart…"
                  : status === "waiting"
                    ? "Waiting to calculate…"
                    : null}
          </div>
        )}
        {(note || status === "loading" || status === "cancelled") && (
          <div
            className="chart-job-notice"
            role={status === "error" ? "alert" : "status"}
            data-over-plot={renderable}
          >
            {note ??
              (status === "loading"
                ? data
                  ? "Updating chart…"
                  : "Reading data…"
                : "Chart cancelled.")}
            {status === "loading" && (
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            )}
            {(status === "error" || status === "cancelled") && (
              <button type="button" onClick={retry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="chart-card-footer">
        <div className="chart-metrics" aria-live="polite">
          {selection && (
            <span>
              Selected cells · {formatNumber.format(selection.rows)} rows · {selection.columns}{" "}
              {selection.columns === 1 ? "column" : "columns"}
            </span>
          )}
          {data && (
            <span>
              {formatNumber.format(data.validRows)} valid rows ·{" "}
              {formatNumber.format(data.excludedRows)} excluded
              {data.filteredRows > 0 && ` · ${formatNumber.format(data.filteredRows)} filtered`}
              {scaleExcludedRows > 0 &&
                ` · ${formatNumber.format(scaleExcludedRows)} excluded by scale`}
              {data.bins && ` · ${formatNumber.format(data.bins.length)} bins`}
              {display.kind === "scatter" &&
                data.points &&
                ` · ${formatNumber.format(data.points.length)} points displayed`}
              {data.histogramOutside &&
                (data.histogramOutside.below > 0 || data.histogramOutside.above > 0) &&
                ` · ${formatNumber.format(data.histogramOutside.below)} below range · ${formatNumber.format(data.histogramOutside.above)} above range`}
              {data.groupCount !== undefined &&
                data.groupCount > (data.groups?.length ?? 0) &&
                ` · ${formatNumber.format(data.groups?.length ?? 0)} of ${formatNumber.format(data.groupCount)} categories`}
              {data.sampled && " · Sampled"}
              {data.groupsTruncated && " · Group limit reached"}
              {(display.kind === "violin" || display.kind === "box") && " · Estimated distribution"}
              {status !== "ready" && " · Previous chart"}
            </span>
          )}
          {data?.xOrigin && <span title={data.xOrigin}>X origin · {data.xOrigin}</span>}
          {data?.yOrigin && <span title={data.yOrigin}>Y origin · {data.yOrigin}</span>}
          {zeroWidthDensity && (
            <span>Density needs a nonzero bin width. Set Bin width or a fixed range.</span>
          )}
        </div>
        <div
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${card.title}`}
          aria-orientation="horizontal"
          aria-valuemin={170}
          aria-valuemax={520}
          aria-valuenow={card.height}
          aria-valuetext={`${card.width === null ? "Automatic width" : `${Math.round(card.width)}% width`}, ${card.height} pixels high`}
          className="chart-resize-handle"
          title="Drag to resize, or use the arrow keys"
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              const limits = cardWidthLimits(element.current);
              if (!limits) return;
              onResize(
                clampWidth(limits.width + (event.key === "ArrowRight" ? 5 : -5), limits.minimum),
                card.height,
              );
            } else
              onResize(
                card.width,
                clampHeight(card.height + (event.key === "ArrowDown" ? 30 : -30)),
              );
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const limits = cardWidthLimits(element.current);
            if (!limits) return;
            resize.current = {
              ...limits,
              x: event.clientX,
              y: event.clientY,
              height: card.height,
              preferred: card.width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = resize.current;
            if (!start) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            onResize(
              dx === 0
                ? start.preferred
                : clampWidth(start.width + (dx / start.span) * 100, start.minimum),
              clampHeight(start.height + dy),
            );
          }}
          onPointerUp={() => {
            resize.current = null;
          }}
          onLostPointerCapture={() => {
            resize.current = null;
          }}
          onPointerCancel={() => {
            resize.current = null;
          }}
        >
          <MoveDiagonal2 aria-hidden="true" />
        </div>
      </footer>
    </article>
  );
}
