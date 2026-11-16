import type { ReactNode } from "react";
import type { DataPage } from "../backend";
import type { SqlSourceIdentity } from "../sql-workspace/backend";
import type { ChartNavigationRequest, RelatedChart } from "../workspaceNavigation";
import type { ChartBinding, ResolvedSource } from "./chartModel";

export interface ChartFileSource {
  kind: "file";
  documentId: string;
  sessionId: string;
  queryId?: string;
}

export interface ChartSqlSource {
  kind: "sql";
  runId: string;
  resultId: string;
  viewId?: string;
}

export type ChartLiveSource = ChartFileSource | ChartSqlSource;
export type ChartSource = ChartLiveSource | { kind: "block"; blockId: string };
export type ChartKind = "scatter" | "violin" | "histogram" | "box" | "line" | "bar";
export type ChartScale = "linear" | "log" | "log10" | "log1p";
export type HistogramBinning = { mode: "count"; count: number } | { mode: "width"; width: number };
export type LineAnalysis = { aggregate: "raw" | "mean" | "sum"; bucketSeconds?: number };
export type HistogramRange = { min: number; max: number };
export type BoxWhiskers = "iqr" | "minmax";
export type BarAnalysis = {
  aggregate: "count" | "sum" | "mean";
  sort: "category" | "asc" | "desc";
  limit: number;
};
export const MAX_HISTOGRAM_BINS = 48;

export interface ChartColumn {
  id: string;
  name: string;
  logicalType: string;
}

export interface SqlReference {
  statement: string;
  referencedSources: SqlSourceIdentity[];
  origin?: SqlSourceIdentity;
}

export interface ChartSourceOption {
  id: string;
  name: string;
  kind: "file" | "sql";
  columns: ChartColumn[];
  source: ChartLiveSource | null;
  sqlReference?: SqlReference;
}

export interface ChartSelection {
  rowStart: number;
  rowEndExclusive: number;
  columnIds: string[];
}

export interface ChartBlock {
  blockId: string;
  name: string;
  columns: ChartColumn[];
  rowCount: number;
  origin?: ChartLiveSource;
}

export const MAX_CHART_BLOCK_CELLS = 100_000;
export const MAX_CHART_BLOCK_COLUMNS = 64;

export interface ChartFileSelection {
  sessionId: string;
  columnIds: string[];
  rowCount: number;
}

export interface ChartSeed {
  id: string;
  sourceId?: string;
  block?: ChartBlock;
  fileSelection?: ChartFileSelection;
}

export interface ChartRequest {
  requestId: string;
  source: ChartSource;
  kind: ChartKind;
  x: string;
  y?: string;
  filter?: { columnId: string; equals: string };
  xScale?: ChartScale;
  yScale?: ChartScale;
  histogram?: HistogramBinning;
  violinBandwidth?: number;
  scatterLabel?: string;
  line?: LineAnalysis;
  histogramRange?: HistogramRange;
  whiskers?: BoxWhiskers;
  bar?: BarAnalysis;
  detail?: ChartDetailRequest;
}

export type ChartDetailRequest =
  | { kind: "range"; x: [number, number]; y?: [number, number] }
  | { kind: "groups"; offset: number; search?: string }
  | { kind: "group"; label: string };

export type ChartExtent = [xMin: number, xMax: number, yMin: number, yMax: number];
export type CountedChartExtent = [...ChartExtent, count: number];

export interface ChartData {
  totalRows: number;
  validRows: number;
  excludedRows: number;
  scaleExcludedRows?: number;
  filteredRows: number;
  groupsTruncated: boolean;
  sampled: boolean;
  xOrigin?: string;
  yOrigin?: string;
  xUnit?: string;
  yUnit?: string;
  points?: [number, number][];
  scatterExtent?: ChartExtent;
  scatterTiles?: CountedChartExtent[];
  lineBuckets?: CountedChartExtent[];
  pointDetails?: { row: number; x: string; y: string; label?: string }[];
  bins?: { start: number; end: number; count: number }[];
  histogramOutside?: { below: number; above: number };
  groupCount?: number;
  barTotal?: number;
  groups?: {
    label: string;
    count: number;
    value?: number;
    summary?: [number, number, number, number, number];
    density?: [number, number][];
    sampleCount?: number;
    whiskers?: [number, number];
    outlierCount?: number;
    outliers?: number[];
    observations?: number[];
  }[];
  groupDirectory?: {
    total: number;
    offset: number;
    entries: { label: string; count: number; value?: number }[];
  };
}

export const MAX_CHART_IMAGE_PIXELS = 4_194_304;

export interface ScatterSvgFrame {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

export interface ChartImageProgress {
  scannedRows: number;
  writtenPoints: number;
}

export interface ChartImageCopy {
  width: number;
  height: number;
  rgba: string;
}

export type ChartImage =
  | { kind: "png"; data: string }
  | { kind: "svg"; data: string; scatter?: { chart: ChartRequest; frame: ScatterSvgFrame } };

export interface ChartImageSave {
  title: string;
  image: ChartImage;
}

export interface ChartBackend {
  compute(request: ChartRequest): Promise<ChartData>;
  cancel(requestId: string): Promise<void>;
  releaseBlock(blockId: string): Promise<void>;
  retainResult(source: ChartSqlSource): Promise<void>;
  releaseResult(source: ChartSqlSource): Promise<void>;
  copyImage(request: ChartImageCopy): Promise<void>;
  saveImage(
    request: ChartImageSave,
    onProgress?: (progress: ChartImageProgress) => void,
  ): Promise<boolean>;
}

export interface ChartWorkspaceProps {
  active: boolean;
  sources: readonly ChartSourceOption[];
  seed: ChartSeed | null;
  backend: ChartBackend;
  onSeedHandled(): void;
  navigation?: ChartNavigationRequest | null;
  onNavigationHandled?(id: number): void;
  onRelatedChartsChange?(links: RelatedChart[]): void;
  renderChartReference?(
    binding: ChartBinding,
    resolved: ResolvedSource,
    active: boolean,
    chartColumnIds: readonly string[],
  ): ReactNode;
}

export interface ChartCapture {
  requestId: string;
  source: ChartLiveSource;
  selection: ChartSelection;
}

export interface ChartTransport extends ChartBackend {
  readBlockPreview(blockId: string, limit: number, columns: string[]): Promise<DataPage>;
  capture(request: ChartCapture): Promise<void>;
}
