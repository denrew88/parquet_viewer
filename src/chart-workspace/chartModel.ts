import type {
  ChartColumn,
  ChartFileSelection,
  ChartRequest,
  ChartScale,
  ChartSeed,
  ChartSourceOption,
  ChartSqlSource,
} from "./contract";

export type ChartKind = ChartRequest["kind"];
export const chartKinds: Record<ChartKind, string> = {
  scatter: "Scatter",
  violin: "Violin",
  histogram: "Histogram",
  box: "Box plot",
  line: "Line",
  bar: "Bar",
};

export const chartScales: Record<ChartScale, string> = {
  linear: "Linear",
  log: "Log (ln)",
  log10: "Log10",
  log1p: "Log1p",
};

export const appearanceSettings = {
  scatter: { label: "Scatter point size", unit: "px", min: 2, max: 14, initial: 5 },
  line: { label: "Line thickness", unit: "px", min: 1, max: 8, initial: 2 },
  box: { label: "Box width", unit: "%", min: 20, max: 85, initial: 55 },
  bar: { label: "Bar width", unit: "%", min: 20, max: 90, initial: 60 },
};

export type AppearanceKind = keyof typeof appearanceSettings;

export function hasAppearance(kind: ChartKind): kind is AppearanceKind {
  return kind in appearanceSettings;
}

export interface ChartOptions {
  xScale?: ChartScale;
  yScale?: ChartScale;
  histogram?: ChartRequest["histogram"];
  histogramRange?: ChartRequest["histogramRange"];
  histogramNormalization?: "count" | "percent" | "density";
  scatterLabel?: ColumnBinding | null;
  line?: ChartRequest["line"];
  lineGap?: number;
  violinBandwidth?: number;
  violinWidth?: "peak" | "area" | "count";
  groupOrder?: "label" | "median" | "count";
  categoryLabels?: "auto" | "all";
  showOutliers?: boolean;
  whiskers?: ChartRequest["whiskers"];
  bar?: Partial<NonNullable<ChartRequest["bar"]>>;
  barOrientation?: "horizontal" | "vertical";
  barShowValues?: boolean;
  barShowShare?: boolean;
  appearance?: Partial<Record<AppearanceKind, number>>;
}

type Block = NonNullable<ChartSeed["block"]>;

export type ChartBinding =
  | {
      kind: "file";
      sourceId: string;
      name: string;
      sessionId: string;
      selection?: ChartFileSelection;
    }
  | { kind: "follow"; sourceId: string; name: string }
  | {
      kind: "pinned";
      sourceId: string;
      name: string;
      source: ChartSqlSource;
      columns: ChartColumn[];
    }
  | { kind: "block"; block: Block };

export interface ColumnBinding {
  column: ChartColumn;
  generation: string;
}

export interface ChartCardModel {
  id: string;
  title: string;
  kind: ChartKind | null;
  binding: ChartBinding | null;
  x: ColumnBinding | null;
  y: ColumnBinding | null;
  filter: { column: ColumnBinding; equals: string } | null;
  options: ChartOptions;
  width: number | null;
  height: number;
}

export interface ChartSheet {
  id: string;
  name: string;
  cards: ChartCardModel[];
}

export type ResolvedSource =
  | { status: "ready"; name: string; source: ChartRequest["source"]; columns: ChartColumn[] }
  | { status: "waiting" | "disconnected"; name: string; columns: ChartColumn[] };

export function sourceIdentity(source: ChartRequest["source"]): string {
  switch (source.kind) {
    case "file":
      return JSON.stringify([source.kind, source.documentId, source.sessionId, source.queryId]);
    case "sql":
      return JSON.stringify([source.kind, source.runId, source.resultId, source.viewId]);
    case "block":
      return JSON.stringify([source.kind, source.blockId]);
  }
}

export function bindSource(option: ChartSourceOption): ChartBinding | null {
  if (option.kind === "sql") return { kind: "follow", sourceId: option.id, name: option.name };
  if (option.source?.kind !== "file") return null;
  return {
    kind: "file",
    sourceId: option.id,
    name: option.name,
    sessionId: option.source.sessionId,
  };
}

export function resolveSource(
  binding: ChartBinding | null,
  sources: readonly ChartSourceOption[],
): ResolvedSource {
  if (!binding) return { status: "waiting", name: "", columns: [] };
  if (binding.kind === "block")
    return {
      status: "ready",
      name: binding.block.name,
      source: { kind: "block", blockId: binding.block.blockId },
      columns: binding.block.columns,
    };
  if (binding.kind === "pinned") return { status: "ready", ...binding };

  const option = sources.find((candidate) => candidate.id === binding.sourceId);
  if (
    !option ||
    (binding.kind === "file" &&
      (option.source?.kind !== "file" || option.source.sessionId !== binding.sessionId))
  ) {
    return { status: "disconnected", name: binding.name, columns: [] };
  }
  if (!option.source) return { status: "waiting", name: option.name, columns: option.columns };
  const columns =
    binding.kind === "file" && binding.selection
      ? binding.selection.columnIds.flatMap(
          (id) => option.columns.find((column) => column.id === id) ?? [],
        )
      : option.columns;
  return { status: "ready", name: option.name, source: option.source, columns };
}

export function columnBinding(column: ChartColumn, source: ChartRequest["source"]): ColumnBinding {
  return { column, generation: sourceIdentity(source) };
}

export function resolveColumn(
  binding: ColumnBinding | null,
  source: ResolvedSource,
): ChartColumn | null {
  if (!binding || source.status !== "ready") return null;
  const { column, generation } = binding;
  if (generation === sourceIdentity(source.source)) {
    return (
      source.columns.find(
        (candidate) =>
          candidate.id === column.id &&
          candidate.name === column.name &&
          candidate.logicalType === column.logicalType,
      ) ?? null
    );
  }

  // SQL assigns IDs by position per result. Follow a stable, unambiguous label and
  // exact logical type rather than silently reading the old column ordinal.
  const named = source.columns.filter((candidate) => candidate.name === column.name);
  return named.length === 1 && named[0].logicalType === column.logicalType ? named[0] : null;
}

export type AxisRole = "number" | "ordered" | "category";
type AxisConfig = { label: string; role: AxisRole; optional?: boolean };

function axisRole(column: ChartColumn): AxisRole | "unsupported" {
  const type = column.logicalType
    .toLowerCase()
    .trim()
    .replace(/[(<].*$/, "")
    .trim();
  if (
    /^(?:u?int\d*|u?(?:tiny|small|big|huge)int|integer|utinyint|usmallint|uinteger|ubigint|decimal(?:128|256)?|numeric|float\d*|double(?: precision)?|real)$/.test(
      type,
    )
  ) {
    return "number";
  }
  if (/^(?:date|time|timestamp|datetime|duration|interval)/.test(type)) return "ordered";
  if (/^(?:utf8|largeutf8|string|varchar|char|text|bool|enum)/.test(type)) return "category";
  return "unsupported";
}

export function acceptsColumn(column: ChartColumn, role: AxisRole): boolean {
  const found = axisRole(column);
  if (role === "category") return found === "category" || found === "number";
  if (role === "ordered") return found === "number" || found === "ordered";
  return found === "number";
}

export function isBucketable(column: ChartColumn | null): boolean {
  return Boolean(column && /^(?:date|timestamp|datetime|duration)/i.test(column.logicalType));
}

export function barSettings(
  options: ChartOptions,
  y: ChartColumn | ColumnBinding | null,
): NonNullable<ChartRequest["bar"]> {
  return {
    aggregate: options.bar?.aggregate ?? (y ? "sum" : "count"),
    sort: options.bar?.sort ?? "category",
    limit: options.bar?.limit ?? 32,
  };
}

export function axesFor(kind: ChartKind): {
  x: AxisConfig;
  y?: AxisConfig;
} {
  switch (kind) {
    case "histogram":
      return { x: { label: "Value", role: "number" } };
    case "violin":
    case "box":
      return { x: { label: "Group", role: "category" }, y: { label: "Value", role: "number" } };
    case "bar":
      return {
        x: { label: "Group", role: "category" },
        y: { label: "Value", role: "number", optional: true },
      };
    case "scatter":
    case "line":
      return {
        x: { label: "X axis", role: "ordered" },
        y: { label: "Y axis", role: "number" },
      };
  }
}

export function hasScaleControl(kind: ChartKind, axis: "x" | "y"): boolean {
  if (kind === "scatter" || kind === "line") return true;
  return axis === "x" ? kind === "histogram" : kind === "violin" || kind === "box";
}

export function supportsNonlinearScale(
  kind: ChartKind,
  axis: "x" | "y",
  column: ChartColumn | null,
): boolean {
  return Boolean(column && hasScaleControl(kind, axis) && acceptsColumn(column, "number"));
}

export function parseChartNumber(
  text: string,
  min: number,
  max: number,
  integer = false,
): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value))
    ? value
    : null;
}

export function defaultAxes(
  kind: ChartKind,
  columns: ChartColumn[],
  source: ChartRequest["source"],
): Pick<ChartCardModel, "x" | "y"> {
  const axes = axesFor(kind);
  const xChoices = columns.filter((column) => acceptsColumn(column, axes.x.role));
  const preferred =
    axes.x.role === "category"
      ? xChoices.find((column) => axisRole(column) === "category")
      : kind === "line"
        ? xChoices.find((column) => axisRole(column) === "ordered")
        : undefined;
  const x = preferred ?? xChoices[0];
  const y = axes.y
    ? columns.find((column) => column.id !== x?.id && acceptsColumn(column, axes.y!.role))
    : undefined;
  return { x: x ? columnBinding(x, source) : null, y: y ? columnBinding(y, source) : null };
}

export function suggestedAxes(
  card: ChartCardModel,
  source: ResolvedSource,
): Pick<ChartCardModel, "x" | "y"> {
  if (!card.kind || source.status !== "ready") return { x: card.x, y: card.y };
  if (card.x || card.y) return { x: card.x, y: card.y };
  return defaultAxes(card.kind, source.columns, source.source);
}

export function defaultChartTitle(kind: ChartKind | null): string {
  return kind ? `${chartKinds[kind]} chart` : "New chart";
}

export function newChart(id: string, binding: ChartBinding | null): ChartCardModel {
  return {
    id,
    title: defaultChartTitle(null),
    kind: null,
    binding,
    x: null,
    y: null,
    filter: null,
    options: {},
    width: null,
    height: 220,
  };
}

export function configureChartKind(
  card: ChartCardModel,
  kind: ChartKind,
  source: ResolvedSource,
): ChartCardModel {
  const axes =
    source.status === "ready"
      ? defaultAxes(kind, source.columns, source.source)
      : { x: null, y: null };
  const title = card.title === defaultChartTitle(card.kind) ? defaultChartTitle(kind) : card.title;
  return { ...card, kind, title, ...axes };
}

export type ChartPlan =
  | { message: string }
  | {
      request: Omit<ChartRequest, "requestId">;
      x: ChartColumn;
      y: ChartColumn | null;
      scatterLabel?: ChartColumn;
    };

export function planChart(card: ChartCardModel, source: ResolvedSource): ChartPlan {
  if (source.status === "disconnected") return { message: "Reconnect data source." };
  if (!card.kind) return { message: "Choose a chart type in Chart settings." };
  if (source.status !== "ready") {
    return {
      message: card.binding ? "Waiting for a successful SQL result." : "Choose a data source.",
    };
  }
  const configured = suggestedAxes(card, source);
  const x = resolveColumn(configured.x, source);
  const bar = card.kind === "bar" ? barSettings(card.options, configured.y) : undefined;
  const requiresY = bar ? bar.aggregate !== "count" : card.kind !== "histogram";
  const y = requiresY ? resolveColumn(configured.y, source) : null;
  if (!x || (requiresY && !y)) {
    return {
      message:
        (configured.x && !x) || (configured.y && !y)
          ? "Select axis columns again. The result schema changed."
          : "Choose columns to draw this chart.",
    };
  }
  const filterColumn = card.filter ? resolveColumn(card.filter.column, source) : null;
  if (card.filter && !filterColumn) return { message: "Select the filter column again." };
  const { xScale, yScale, histogram, histogramRange, line, violinBandwidth, whiskers } =
    card.options;
  const labelBinding = card.kind === "scatter" ? card.options.scatterLabel : null;
  const scatterLabel = labelBinding && resolveColumn(labelBinding, source);
  if (labelBinding && !scatterLabel) return { message: "Select the point label column again." };
  return {
    request: {
      source: source.source,
      kind: card.kind,
      x: x.id,
      ...(y ? { y: y.id } : {}),
      ...(xScale && xScale !== "linear" && supportsNonlinearScale(card.kind, "x", x)
        ? { xScale }
        : {}),
      ...(yScale && yScale !== "linear" && supportsNonlinearScale(card.kind, "y", y)
        ? { yScale }
        : {}),
      ...(card.kind === "histogram" && histogram ? { histogram } : {}),
      ...(card.kind === "histogram" && histogramRange ? { histogramRange } : {}),
      ...(scatterLabel ? { scatterLabel: scatterLabel.id } : {}),
      ...(card.kind === "line" && line && line.aggregate !== "raw"
        ? {
            line: {
              aggregate: line.aggregate,
              ...(isBucketable(x) && line.bucketSeconds
                ? { bucketSeconds: line.bucketSeconds }
                : {}),
            },
          }
        : {}),
      ...(card.kind === "box" ? { whiskers: whiskers ?? "iqr" } : {}),
      ...(bar ? { bar } : {}),
      ...(card.kind === "violin" && violinBandwidth !== undefined && violinBandwidth !== 1
        ? { violinBandwidth }
        : {}),
      ...(filterColumn && card.filter
        ? { filter: { columnId: filterColumn.id, equals: card.filter.equals } }
        : {}),
    },
    x,
    y,
    ...(scatterLabel ? { scatterLabel } : {}),
  };
}

export function rebindAxes(card: ChartCardModel, source: ResolvedSource): ChartCardModel {
  if (source.status !== "ready") return card;
  const configured = suggestedAxes(card, source);
  const x = resolveColumn(configured.x, source);
  const y = resolveColumn(configured.y, source);
  const filter = card.filter && resolveColumn(card.filter.column, source);
  return {
    ...card,
    x: x ? columnBinding(x, source.source) : configured.x,
    y: y ? columnBinding(y, source.source) : configured.y,
    filter:
      filter && card.filter
        ? { ...card.filter, column: columnBinding(filter, source.source) }
        : card.filter,
  };
}
