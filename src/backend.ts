import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { defaultAppSettings, parseAppSettings, type AppSettings } from "./settings/model";
import type { QueryPlan } from "./query/model";

export interface HealthCheckResponse {
  status: "ok";
  appVersion: string;
}

export type DataValueKind =
  | "null"
  | "string"
  | "int"
  | "float"
  | "boolean"
  | "binary"
  | "decimal"
  | "date"
  | "timestamp"
  | "list"
  | "struct"
  | "map"
  | "unsupported";

const dataValueKinds: readonly DataValueKind[] = [
  "null",
  "string",
  "int",
  "float",
  "boolean",
  "binary",
  "decimal",
  "date",
  "timestamp",
  "list",
  "struct",
  "map",
  "unsupported",
];

export interface DataValue {
  kind: DataValueKind;
  display: string | null;
  state?: DataValueState;
  sourceDisplay?: string | null;
  unit?: string | null;
  timezone?: string | null;
  rawDisplay?: string | null;
  diagnostic?: CellDiagnostic | null;
}

export type DataValueState = "valid" | "null" | "empty" | "invalid";

export interface CellDiagnostic {
  code: string;
  message: string;
}

export type CsvProfileMode = "auto" | "allText" | "custom";
export type CsvTargetType =
  | "auto"
  | "text"
  | "boolean"
  | "int64"
  | "uint64"
  | "float64"
  | "decimal"
  | "date"
  | "timestamp"
  | "skip";
export type CsvConversionFailurePolicy = "preserveInvalid" | "fail" | "asNull";
export type CsvTimezonePolicy = "preserve" | "assumeUtc" | "fixedOffset";

export interface CsvColumnProfileWire {
  sourceIndex: number;
  sourceName: string;
  targetType: CsvTargetType;
  trim: boolean;
  nullTokens: string[];
  trueTokens: string[];
  falseTokens: string[];
  decimalSeparator: string;
  thousandSeparator: string | null;
  temporalFormats: string[];
  timezonePolicy: CsvTimezonePolicy;
  timezoneOffsetMinutes: number | null;
  failurePolicy: CsvConversionFailurePolicy;
}

export interface CsvParsingProfileWire {
  mode: CsvProfileMode;
  generation: number;
  columns: CsvColumnProfileWire[];
}

export interface CsvProfileResponse {
  documentId: string;
  sessionId: string;
  profile: CsvParsingProfileWire;
}

export interface CsvProfilePreviewRequest {
  documentId: string;
  sessionId: string;
  generation: number;
  profile: CsvParsingProfileWire;
}

export interface CsvProfilePreviewColumnWire {
  sourceIndex: number;
  sourceName: string;
  recommendedType: CsvTargetType;
  confidence: number;
  targetType: CsvTargetType;
  successCount: number;
  nullCount: number;
  invalidCount: number;
}

export interface CsvProfilePreviewWire {
  generation: number;
  stage: "leading" | "distributed";
  profile: CsvParsingProfileWire;
  columns: CsvProfilePreviewColumnWire[];
  rows: { sourceRow: number; cells: { raw: string; converted: DataValue }[] }[];
}

export interface CsvProfilePreviewResponse {
  documentId: string;
  sessionId: string;
  preview: CsvProfilePreviewWire;
}

export interface CsvProfileValidationRequest extends CsvProfilePreviewRequest {
  taskId: string;
}

export type CsvValidationState = "queued" | "running" | "complete" | "cancelled" | "failed";

export interface CsvValidationStatusWire {
  taskId: string;
  documentId: string;
  sessionId: string;
  generation: number;
  state: CsvValidationState;
  rowsScanned: number;
  totalRows: number | null;
  columns: {
    sourceIndex: number;
    sourceName: string;
    successCount: number;
    nullCount: number;
    invalidCount: number;
    firstErrorRow: number | null;
    errorSamples: { sourceRow: number; raw: string; message: string }[];
  }[];
  error: { code: string; message: string } | null;
}

export interface ApplyCsvProfileRequest {
  documentId: string;
  sessionId: string;
  profile: CsvParsingProfileWire;
}

export interface ExecuteQueryRequest {
  documentId: string;
  sessionId: string;
  queryId: string;
  taskId: string;
  plan: QueryPlan;
}

export type QueryTaskState =
  "queued" | "running" | "complete" | "cancelling" | "cancelled" | "failed";

export interface QueryStatusResponse {
  documentId: string;
  sessionId: string;
  queryId: string;
  taskId: string;
  state: QueryTaskState;
  progress: { rowsScanned: number; totalRows: number | null; resultRows: number };
  columns: string[];
  elapsedMs: number;
  findMatchCount: number | null;
  error: { code: string; message: string } | null;
}

export interface ReadQueryPageRequest {
  documentId: string;
  sessionId: string;
  queryId: string;
  offset: number;
  limit: number;
}

export interface ReadQueryPageResponse {
  documentId: string;
  sessionId: string;
  queryId: string;
  page: DataPage;
}

export interface DistinctValuesRequest {
  documentId: string;
  sessionId: string;
  queryId: string | null;
  columnId: string;
  search: string | null;
  offset: number;
  limit: number;
}

export interface DistinctValue {
  value: string | null;
  isNull: boolean;
  isInvalid: boolean;
  count: number;
}

export interface DistinctValuesResponse {
  documentId: string;
  sessionId: string;
  queryId: string | null;
  columnId: string;
  values: DistinctValue[];
  hasMore: boolean;
}

export interface FindQueryMatchRequest {
  documentId: string;
  sessionId: string;
  queryId: string;
  fromResultOffset: number;
  fromMatchIndex?: number | null;
  direction: "next" | "previous";
  wrap: boolean;
}

export interface FindQueryMatchResponse {
  documentId: string;
  sessionId: string;
  queryId: string;
  match: {
    rowOffset: number;
    columnId: string;
    matchIndex: number;
    totalMatches: number;
    wrapped: boolean;
  } | null;
}

export interface QueryTempUsage {
  processBytes: number;
  limitBytes: number;
  availableBytes: number;
  activeQueries: number;
  estimatedTempBytes: number | null;
  safetyReserveBytes: number;
  hardCapBytes: number;
  freeBytes: number;
}

export interface QueryTempCleanupResult {
  deletedBytes: number;
  orphanFailureCount: number;
  cleanupFailures: string[];
  remainingUsage: QueryTempUsage;
}

export interface ColumnSchema {
  name: string;
  logicalType: string;
  nullable: boolean;
  physicalType: string;
}

export interface RowGroupSummary {
  index: number;
  rowCount: number;
  totalByteSize: number;
  compressedSize: number;
  compression: string[];
  statisticsColumnCount: number;
}

export type DataFormat = string;
export type SourceCapability = string;

export interface FormatDescriptor {
  id: DataFormat;
  displayName: string;
  extensions: string[];
  mimeTypes: string[];
  capabilities: SourceCapability[];
}

export interface MetadataEntry {
  label: string;
  value: string;
}

export type FormatDetailsSection =
  | {
      id: string;
      title: string;
      kind: "keyValue";
      entries: MetadataEntry[];
    }
  | {
      id: string;
      title: string;
      kind: "table";
      columns: string[];
      rows: string[][];
      truncated: boolean;
    };
export type CsvHeaderMode = "auto" | "present" | "absent";
export type RowCountState = "calculating" | "complete" | "cancelled" | "failed";

export interface RowCountStatus {
  state: RowCountState;
  rowsScanned: number;
  bytesScanned: number;
  totalBytes: number;
  generation: number;
  message: string | null;
}

export interface CsvStructureIssue {
  row: number;
  expectedColumns: number;
  actualColumns: number;
}

export type CsvHeaderIssueReason = "blank" | "duplicate";

export interface CsvHeaderIssue {
  columnIndex: number;
  rawName: string;
  resolvedName: string;
  reason: CsvHeaderIssueReason;
}

export interface CsvMetadata {
  delimiter: string;
  encoding: "utf-8" | "utf-8-bom";
  headerMode: CsvHeaderMode;
  suggestedHeader: boolean | null;
  headerUsed: boolean;
  structureIssueCount: number;
  structureIssues: CsvStructureIssue[];
  rawHeaderCount: number;
  rawHeaders: string[];
  rawHeadersTruncated: boolean;
  headerIssueCount: number;
  headerIssues: CsvHeaderIssue[];
}

export interface FileSummary {
  sessionId: string;
  fileName: string;
  path: string;
  format: DataFormat;
  formatDescriptor?: FormatDescriptor;
  fileSize: number;
  rowCount: number | null;
  rowCountStatus: RowCountStatus;
  columnCount: number;
  rowGroupCount: number;
  columns: ColumnSchema[];
  rowGroups: RowGroupSummary[];
  csvMetadata: CsvMetadata | null;
  formatDetails?: FormatDetailsSection[];
}

export interface DataPage {
  sessionId: string;
  offset: number;
  limit: number;
  totalRows: number | null;
  hasMore: boolean;
  columns: string[];
  rows: DataValue[][];
}

export interface ReadPageRequest {
  documentId?: string;
  sessionId: string;
  offset: number;
  limit: number;
  columns?: string[];
}

export interface ReadCellValueRequest {
  documentId: string;
  sessionId: string;
  queryId?: string;
  row: number;
  columnId: string;
}

export type DataBoundaryDirection = "up" | "down" | "left" | "right";
export type DataBoundaryMode = "dataBoundary" | "tableBoundary";

export interface FindBoundaryRequest {
  navigationId: string;
  documentId: string;
  sessionId: string;
  queryId?: string;
  row: number;
  columnId: string;
  visibleColumnIds: string[];
  direction: DataBoundaryDirection;
  mode: DataBoundaryMode;
}

export interface FindBoundaryResponse {
  navigationId: string;
  documentId: string;
  sessionId: string;
  queryId?: string;
  targetRow: number;
  targetColumnId: string;
  resolvedRowCount: number | null;
}

export interface CancelDataBoundaryNavigationRequest {
  navigationId: string;
  documentId: string;
  sessionId: string;
  queryId?: string;
}

export type OpenOrigin = "dialog" | "dragDrop" | "startupArg" | "fileAssociation";

const openOrigins: readonly OpenOrigin[] = ["dialog", "dragDrop", "startupArg", "fileAssociation"];

export interface OpenDataRequest {
  requestId: string;
  origin: OpenOrigin;
  paths: string[];
}

export interface OpenedDataFile {
  itemIndex: number;
  path: string;
  disposition: "opened" | "existing";
  documentId: string;
  sessionId: string;
  summary: FileSummary;
  initialPage: DataPage;
}

export interface OpenDataFailure {
  itemIndex: number;
  path: string;
  error: { code: string; message: string };
}

export interface OpenDataResponse {
  requestId: string;
  origin: OpenOrigin;
  opened: OpenedDataFile[];
  failures: OpenDataFailure[];
  activeDocumentId: string | null;
}

export interface OpenFileResponse {
  documentId: string;
  sessionId: string;
  summary: FileSummary;
  initialPage: DataPage;
}

export interface DocumentSummaryResponse {
  documentId: string;
  sessionId: string;
  summary: FileSummary;
}

/** Test/adapter compatibility during the Phase 8 IPC migration. Tauri never returns this shape. */
export interface LegacyOpenedDataFile {
  requestId: string;
  origin: OpenOrigin;
  summary: FileSummary;
  initialPage: DataPage;
}

export type OpenRequestHandler = (request: OpenDataRequest) => void;
export type OpenRequestErrorHandler = (error: DataViewerError) => void;

export interface BackendAdapter {
  healthCheck(): Promise<HealthCheckResponse>;
  listSupportedFormats(): Promise<FormatDescriptor[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  selectDataFile(): Promise<FileSummary | null>;
  selectDataFilePath(requestId: string): Promise<OpenDataResponse | LegacyOpenedDataFile | null>;
  openDataFile(request: OpenDataRequest): Promise<OpenDataResponse | LegacyOpenedDataFile>;
  cancelOpenRequest(requestId: string): Promise<void>;
  takePendingOpenRequests(): Promise<OpenDataRequest[]>;
  onOpenDataRequest(
    handler: OpenRequestHandler,
    onError: OpenRequestErrorHandler,
  ): Promise<UnlistenFn>;
  readPage(request: ReadPageRequest): Promise<DataPage>;
  readCellValue(request: ReadCellValueRequest): Promise<DataValue>;
  findDataBoundary(request: FindBoundaryRequest): Promise<FindBoundaryResponse>;
  cancelDataBoundaryNavigation(request: CancelDataBoundaryNavigationRequest): Promise<void>;
  configureCsv(
    documentId: string,
    sessionId: string,
    headerMode: CsvHeaderMode,
  ): Promise<DocumentSummaryResponse | FileSummary>;
  getCsvProfile(documentId: string, sessionId: string): Promise<CsvProfileResponse>;
  previewCsvProfile(request: CsvProfilePreviewRequest): Promise<CsvProfilePreviewResponse>;
  validateCsvProfile(request: CsvProfileValidationRequest): Promise<CsvValidationStatusWire>;
  getCsvProfileValidationStatus(
    documentId: string,
    sessionId: string,
    taskId: string,
  ): Promise<CsvValidationStatusWire>;
  cancelCsvProfileValidation(
    documentId: string,
    sessionId: string,
    taskId: string,
  ): Promise<CsvValidationStatusWire>;
  applyCsvProfile(request: ApplyCsvProfileRequest): Promise<DocumentSummaryResponse>;
  executeQuery(request: ExecuteQueryRequest): Promise<QueryStatusResponse>;
  getQueryStatus(
    documentId: string,
    sessionId: string,
    queryId: string,
    taskId: string,
  ): Promise<QueryStatusResponse>;
  readQueryPage(request: ReadQueryPageRequest): Promise<ReadQueryPageResponse>;
  listDistinctValues(request: DistinctValuesRequest): Promise<DistinctValuesResponse>;
  findQueryMatch(request: FindQueryMatchRequest): Promise<FindQueryMatchResponse>;
  cancelQuery(
    documentId: string,
    sessionId: string,
    queryId: string,
    taskId: string,
  ): Promise<QueryStatusResponse>;
  getQueryTempUsage(): Promise<QueryTempUsage>;
  clearQueryTemp(): Promise<QueryTempCleanupResult>;
  getDataFileStatus(
    documentId: string,
    sessionId: string,
  ): Promise<DocumentSummaryResponse | FileSummary>;
  cancelDataFileTask(
    documentId: string,
    sessionId: string,
    generation: number,
  ): Promise<DocumentSummaryResponse | FileSummary>;
  closeDataFile(documentId: string, sessionId: string): Promise<void>;
}

export class DataViewerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DataViewerError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const csvProfileModes: readonly CsvProfileMode[] = ["auto", "allText", "custom"];
const csvTargetTypes: readonly CsvTargetType[] = [
  "auto",
  "text",
  "boolean",
  "int64",
  "uint64",
  "float64",
  "decimal",
  "date",
  "timestamp",
  "skip",
];
const csvFailurePolicies: readonly CsvConversionFailurePolicy[] = [
  "preserveInvalid",
  "fail",
  "asNull",
];
const csvTimezonePolicies: readonly CsvTimezonePolicy[] = ["preserve", "assumeUtc", "fixedOffset"];
const csvValidationStates: readonly CsvValidationState[] = [
  "queued",
  "running",
  "complete",
  "cancelled",
  "failed",
];

function oneUnicodeCharacter(value: string): boolean {
  return [...value].length === 1 && value !== "\r" && value !== "\n" && value !== "\0";
}

function parseCsvColumnProfile(value: unknown, expectedIndex: number): CsvColumnProfileWire {
  const item = record(value);
  const nullTokens = stringArray(item?.nullTokens);
  const trueTokens = stringArray(item?.trueTokens);
  const falseTokens = stringArray(item?.falseTokens);
  const temporalFormats = stringArray(item?.temporalFormats);
  const timezoneOffset = item?.timezoneOffsetMinutes;
  if (
    !item ||
    !exactObjectKeys(item, [
      "sourceIndex",
      "sourceName",
      "targetType",
      "trim",
      "nullTokens",
      "trueTokens",
      "falseTokens",
      "decimalSeparator",
      "thousandSeparator",
      "temporalFormats",
      "timezonePolicy",
      "timezoneOffsetMinutes",
      "failurePolicy",
    ]) ||
    item.sourceIndex !== expectedIndex ||
    !isNonEmptyString(item.sourceName) ||
    !csvTargetTypes.includes(item.targetType as CsvTargetType) ||
    typeof item.trim !== "boolean" ||
    !nullTokens ||
    !trueTokens ||
    !falseTokens ||
    !temporalFormats ||
    !hasUniqueValues(nullTokens) ||
    !hasUniqueValues(trueTokens) ||
    !hasUniqueValues(falseTokens) ||
    typeof item.decimalSeparator !== "string" ||
    !oneUnicodeCharacter(item.decimalSeparator) ||
    (item.thousandSeparator !== null &&
      (typeof item.thousandSeparator !== "string" ||
        !oneUnicodeCharacter(item.thousandSeparator))) ||
    ((item.targetType === "float64" || item.targetType === "decimal") &&
      item.thousandSeparator === item.decimalSeparator) ||
    !csvTimezonePolicies.includes(item.timezonePolicy as CsvTimezonePolicy) ||
    (timezoneOffset !== null &&
      (typeof timezoneOffset !== "number" ||
        !Number.isInteger(timezoneOffset) ||
        timezoneOffset < -1_439 ||
        timezoneOffset > 1_439)) ||
    (item.timezonePolicy === "fixedOffset" ? timezoneOffset === null : timezoneOffset !== null) ||
    !csvFailurePolicies.includes(item.failurePolicy as CsvConversionFailurePolicy)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV profile.");
  }
  return {
    sourceIndex: item.sourceIndex,
    sourceName: item.sourceName,
    targetType: item.targetType as CsvTargetType,
    trim: item.trim,
    nullTokens,
    trueTokens,
    falseTokens,
    decimalSeparator: item.decimalSeparator,
    thousandSeparator: item.thousandSeparator as string | null,
    temporalFormats,
    timezonePolicy: item.timezonePolicy as CsvTimezonePolicy,
    timezoneOffsetMinutes: timezoneOffset as number | null,
    failurePolicy: item.failurePolicy as CsvConversionFailurePolicy,
  };
}

export function parseCsvParsingProfile(value: unknown): CsvParsingProfileWire {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, ["mode", "generation", "columns"]) ||
    !csvProfileModes.includes(item.mode as CsvProfileMode) ||
    !isNonNegativeInteger(item.generation) ||
    item.generation === 0 ||
    !Array.isArray(item.columns) ||
    item.columns.length === 0
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV profile.");
  }
  const columns = item.columns.map(parseCsvColumnProfile);
  if (!hasUniqueValues(columns.map((column) => column.sourceName))) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV profile.");
  }
  return { mode: item.mode as CsvProfileMode, generation: item.generation, columns };
}

export function parseCsvProfileResponse(value: unknown): CsvProfileResponse {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, ["documentId", "sessionId", "profile"]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid CSV profile response.",
    );
  }
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    profile: parseCsvParsingProfile(item.profile),
  };
}

function parseCsvPreviewColumn(value: unknown, expectedIndex: number): CsvProfilePreviewColumnWire {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, [
      "sourceIndex",
      "sourceName",
      "recommendedType",
      "confidence",
      "targetType",
      "successCount",
      "nullCount",
      "invalidCount",
    ]) ||
    item.sourceIndex !== expectedIndex ||
    !isNonEmptyString(item.sourceName) ||
    !csvTargetTypes.includes(item.recommendedType as CsvTargetType) ||
    typeof item.confidence !== "number" ||
    !Number.isFinite(item.confidence) ||
    item.confidence < 0 ||
    item.confidence > 1 ||
    !csvTargetTypes.includes(item.targetType as CsvTargetType) ||
    !isNonNegativeInteger(item.successCount) ||
    !isNonNegativeInteger(item.nullCount) ||
    !isNonNegativeInteger(item.invalidCount)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV preview.");
  }
  return item as unknown as CsvProfilePreviewColumnWire;
}

export function parseCsvProfilePreviewResponse(value: unknown): CsvProfilePreviewResponse {
  const item = record(value);
  const preview = record(item?.preview);
  if (
    !item ||
    !exactObjectKeys(item, ["documentId", "sessionId", "preview"]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    !preview ||
    !exactObjectKeys(preview, ["generation", "stage", "profile", "columns", "rows"]) ||
    !isNonNegativeInteger(preview.generation) ||
    preview.generation === 0 ||
    (preview.stage !== "leading" && preview.stage !== "distributed") ||
    !Array.isArray(preview.columns) ||
    !Array.isArray(preview.rows)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV preview.");
  }
  const profile = parseCsvParsingProfile(preview.profile);
  const columns = preview.columns.map(parseCsvPreviewColumn);
  const rows = preview.rows.map((rowValue) => {
    const row = record(rowValue);
    if (
      !row ||
      !exactObjectKeys(row, ["sourceRow", "cells"]) ||
      !isNonNegativeInteger(row.sourceRow) ||
      !Array.isArray(row.cells) ||
      row.cells.length !== columns.length
    ) {
      throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV preview.");
    }
    const cells = row.cells.map((cellValue) => {
      const cell = record(cellValue);
      const converted = parseDataValue(cell?.converted);
      if (
        !cell ||
        !exactObjectKeys(cell, ["raw", "converted"]) ||
        typeof cell.raw !== "string" ||
        !converted
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned an invalid CSV preview.",
        );
      }
      return { raw: cell.raw, converted };
    });
    return { sourceRow: row.sourceRow as number, cells };
  });
  if (
    profile.generation !== preview.generation ||
    profile.columns.length !== columns.length ||
    columns.some((column, index) => column.sourceName !== profile.columns[index]?.sourceName)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid CSV preview.");
  }
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    preview: {
      generation: preview.generation,
      stage: preview.stage,
      profile,
      columns,
      rows,
    },
  };
}

export function parseCsvValidationStatus(value: unknown): CsvValidationStatusWire {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, [
      "taskId",
      "documentId",
      "sessionId",
      "generation",
      "state",
      "rowsScanned",
      "totalRows",
      "columns",
      "error",
    ]) ||
    !isNonEmptyString(item.taskId) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    !isNonNegativeInteger(item.generation) ||
    item.generation === 0 ||
    !csvValidationStates.includes(item.state as CsvValidationState) ||
    !isNonNegativeInteger(item.rowsScanned) ||
    (item.totalRows !== null && !isNonNegativeInteger(item.totalRows)) ||
    (isNonNegativeInteger(item.totalRows) && item.rowsScanned > item.totalRows) ||
    !Array.isArray(item.columns)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid CSV validation status.",
    );
  }
  const columns = item.columns.map((columnValue, index) => {
    const column = record(columnValue);
    if (
      !column ||
      !exactObjectKeys(column, [
        "sourceIndex",
        "sourceName",
        "successCount",
        "nullCount",
        "invalidCount",
        "firstErrorRow",
        "errorSamples",
      ]) ||
      column.sourceIndex !== index ||
      !isNonEmptyString(column.sourceName) ||
      !isNonNegativeInteger(column.successCount) ||
      !isNonNegativeInteger(column.nullCount) ||
      !isNonNegativeInteger(column.invalidCount) ||
      (column.firstErrorRow !== null && !isNonNegativeInteger(column.firstErrorRow)) ||
      !Array.isArray(column.errorSamples)
    ) {
      throw new DataViewerError(
        "InvalidResponse",
        "The backend returned an invalid CSV validation status.",
      );
    }
    const errorSamples = column.errorSamples.map((sampleValue) => {
      const sample = record(sampleValue);
      if (
        !sample ||
        !exactObjectKeys(sample, ["sourceRow", "raw", "message"]) ||
        !isNonNegativeInteger(sample.sourceRow) ||
        typeof sample.raw !== "string" ||
        !isNonEmptyString(sample.message)
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned an invalid CSV validation status.",
        );
      }
      return {
        sourceRow: sample.sourceRow as number,
        raw: sample.raw as string,
        message: sample.message as string,
      };
    });
    return {
      sourceIndex: column.sourceIndex as number,
      sourceName: column.sourceName as string,
      successCount: column.successCount as number,
      nullCount: column.nullCount as number,
      invalidCount: column.invalidCount as number,
      firstErrorRow: column.firstErrorRow as number | null,
      errorSamples,
    };
  });
  const errorRecord = record(item.error);
  const error =
    item.error === null
      ? null
      : errorRecord &&
          exactObjectKeys(errorRecord, ["code", "message"]) &&
          isNonEmptyString(errorRecord.code) &&
          isNonEmptyString(errorRecord.message)
        ? { code: errorRecord.code, message: errorRecord.message }
        : undefined;
  if (error === undefined || (item.state === "failed" ? error === null : error !== null)) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid CSV validation status.",
    );
  }
  return {
    taskId: item.taskId,
    documentId: item.documentId,
    sessionId: item.sessionId,
    generation: item.generation,
    state: item.state as CsvValidationState,
    rowsScanned: item.rowsScanned,
    totalRows: item.totalRows as number | null,
    columns,
    error,
  };
}

function validatedCsvPreviewRequest(request: CsvProfilePreviewRequest): CsvProfilePreviewRequest {
  const profile = parseCsvParsingProfile(request.profile);
  if (
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    !isNonNegativeInteger(request.generation) ||
    request.generation === 0 ||
    request.generation !== profile.generation
  ) {
    throw new DataViewerError("InvalidRequest", "The CSV profile request is invalid.");
  }
  return { ...request, profile };
}

function validatedCsvValidationRequest(
  request: CsvProfileValidationRequest,
): CsvProfileValidationRequest {
  const validated = validatedCsvPreviewRequest(request);
  if (!isNonEmptyString(request.taskId) || request.taskId.length > 128) {
    throw new DataViewerError("InvalidRequest", "The CSV validation task ID is invalid.");
  }
  return { ...validated, taskId: request.taskId };
}

const queryScalarTypes = [
  "text",
  "number",
  "decimal",
  "date",
  "timestamp",
  "boolean",
  "other",
] as const;
const queryFilterOperators = [
  "equals",
  "notEquals",
  "contains",
  "startsWith",
  "endsWith",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "between",
  "oneOf",
  "isTrue",
  "isFalse",
  "isNull",
  "isNotNull",
  "isInvalid",
  "isNotInvalid",
] as const;
const queryTaskStates: readonly QueryTaskState[] = [
  "queued",
  "running",
  "complete",
  "cancelling",
  "cancelled",
  "failed",
];

export function parseQueryPlan(value: unknown): QueryPlan {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, ["filters", "search", "sort", "projection"]) ||
    !Array.isArray(item.filters) ||
    item.filters.length > 256 ||
    !Array.isArray(item.sort) ||
    item.sort.length > 64 ||
    !Array.isArray(item.projection) ||
    item.projection.length > 64
  ) {
    throw new DataViewerError("InvalidResponse", "The query plan is invalid.");
  }
  const filters = item.filters.map((value) => {
    const filter = record(value);
    const values = stringArray(filter?.values);
    if (
      !filter ||
      !exactObjectKeys(filter, ["id", "columnId", "scalarType", "operator", "values"]) ||
      !isNonEmptyString(filter.id) ||
      !isNonEmptyString(filter.columnId) ||
      !queryScalarTypes.includes(filter.scalarType as (typeof queryScalarTypes)[number]) ||
      !queryFilterOperators.includes(filter.operator as (typeof queryFilterOperators)[number]) ||
      !values ||
      values.some((value) => !value.trim()) ||
      values.length > 10_000
    ) {
      throw new DataViewerError("InvalidResponse", "The query filter is invalid.");
    }
    const expected = [
      "isTrue",
      "isFalse",
      "isNull",
      "isNotNull",
      "isInvalid",
      "isNotInvalid",
    ].includes(filter.operator as string)
      ? 0
      : filter.operator === "between"
        ? 2
        : filter.operator === "oneOf"
          ? null
          : 1;
    if (
      (expected === null && values.length === 0) ||
      (expected !== null && values.length !== expected)
    ) {
      throw new DataViewerError("InvalidResponse", "The query filter value count is invalid.");
    }
    return {
      id: filter.id as string,
      columnId: filter.columnId as string,
      scalarType: filter.scalarType as QueryPlan["filters"][number]["scalarType"],
      operator: filter.operator as QueryPlan["filters"][number]["operator"],
      values,
    };
  });
  const searchItem = item.search === null ? null : record(item.search);
  const targets = searchItem ? stringArray(searchItem.targetColumnIds) : null;
  if (
    item.search !== null &&
    (!searchItem ||
      !exactObjectKeys(searchItem, ["text", "mode", "caseSensitive", "exact", "targetColumnIds"]) ||
      !isNonEmptyString(searchItem.text) ||
      searchItem.text.length > 16_384 ||
      (searchItem.mode !== "find" && searchItem.mode !== "filter") ||
      typeof searchItem.caseSensitive !== "boolean" ||
      typeof searchItem.exact !== "boolean" ||
      !targets ||
      !hasUniqueValues(targets) ||
      targets.some((target) => !target.trim()))
  ) {
    throw new DataViewerError("InvalidResponse", "The query search is invalid.");
  }
  const sort = item.sort.map((value) => {
    const order = record(value);
    if (
      !order ||
      !exactObjectKeys(order, ["columnId", "direction", "nullsLast"]) ||
      !isNonEmptyString(order.columnId) ||
      (order.direction !== "ascending" && order.direction !== "descending") ||
      order.nullsLast !== true
    ) {
      throw new DataViewerError("InvalidResponse", "The query sort is invalid.");
    }
    return {
      columnId: order.columnId as string,
      direction: order.direction as "ascending" | "descending",
      nullsLast: true as const,
    };
  });
  const projection = stringArray(item.projection);
  if (
    !projection ||
    !hasUniqueValues(projection) ||
    projection.some((column) => !column.trim()) ||
    !hasUniqueValues(filters.map((filter) => filter.id)) ||
    !hasUniqueValues(filters.map((filter) => filter.columnId)) ||
    !hasUniqueValues(sort.map((order) => order.columnId))
  ) {
    throw new DataViewerError("InvalidResponse", "The query plan contains duplicate fields.");
  }
  return {
    filters,
    search: searchItem
      ? {
          text: searchItem.text as string,
          mode: searchItem.mode as "find" | "filter",
          caseSensitive: searchItem.caseSensitive as boolean,
          exact: searchItem.exact as boolean,
          targetColumnIds: targets!,
        }
      : null,
    sort,
    projection,
  };
}

export function parseQueryStatus(value: unknown): QueryStatusResponse {
  const item = record(value);
  const progress = record(item?.progress);
  const columns = stringArray(item?.columns);
  const errorItem = item?.error === null ? null : record(item?.error);
  const error =
    item?.error === null
      ? null
      : errorItem &&
          exactObjectKeys(errorItem, ["code", "message"]) &&
          isNonEmptyString(errorItem.code) &&
          isNonEmptyString(errorItem.message)
        ? { code: errorItem.code, message: errorItem.message }
        : undefined;
  if (
    !item ||
    !exactObjectKeys(item, [
      "documentId",
      "sessionId",
      "queryId",
      "taskId",
      "state",
      "progress",
      "columns",
      "elapsedMs",
      "findMatchCount",
      "error",
    ]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    !isNonEmptyString(item.queryId) ||
    !isNonEmptyString(item.taskId) ||
    !queryTaskStates.includes(item.state as QueryTaskState) ||
    !progress ||
    !exactObjectKeys(progress, ["rowsScanned", "totalRows", "resultRows"]) ||
    !isNonNegativeInteger(progress.rowsScanned) ||
    (progress.totalRows !== null && !isNonNegativeInteger(progress.totalRows)) ||
    !isNonNegativeInteger(progress.resultRows) ||
    (isNonNegativeInteger(progress.totalRows) && progress.rowsScanned > progress.totalRows) ||
    !columns ||
    !hasUniqueValues(columns) ||
    !isNonNegativeInteger(item.elapsedMs) ||
    (item.findMatchCount !== null && !isNonNegativeInteger(item.findMatchCount)) ||
    error === undefined ||
    (item.state === "failed" ? error === null : error !== null)
  ) {
    throw new DataViewerError("InvalidResponse", "The query status is invalid.");
  }
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    queryId: item.queryId,
    taskId: item.taskId,
    state: item.state as QueryTaskState,
    progress: {
      rowsScanned: progress.rowsScanned as number,
      totalRows: progress.totalRows as number | null,
      resultRows: progress.resultRows as number,
    },
    columns,
    elapsedMs: item.elapsedMs,
    findMatchCount: item.findMatchCount as number | null,
    error,
  };
}

export function parseReadQueryPageResponse(value: unknown): ReadQueryPageResponse {
  const item = record(value);
  const page = record(item?.page);
  if (
    !item ||
    !page ||
    !exactObjectKeys(item, ["documentId", "sessionId", "queryId", "page"]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    !isNonEmptyString(item.queryId) ||
    (page.sessionId !== undefined && page.sessionId !== item.sessionId)
  ) {
    throw new DataViewerError("InvalidResponse", "The query page response is invalid.");
  }
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    queryId: item.queryId,
    page: parseDataPage({ ...page, sessionId: item.sessionId }),
  };
}

export function parseDistinctValuesResponse(value: unknown): DistinctValuesResponse {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, [
      "documentId",
      "sessionId",
      "queryId",
      "columnId",
      "values",
      "hasMore",
    ]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    (item.queryId !== null && !isNonEmptyString(item.queryId)) ||
    !isNonEmptyString(item.columnId) ||
    !Array.isArray(item.values) ||
    item.values.length > 200 ||
    typeof item.hasMore !== "boolean"
  ) {
    throw new DataViewerError("InvalidResponse", "The distinct-values response is invalid.");
  }
  const values = item.values.map((value) => {
    const distinct = record(value);
    if (
      !distinct ||
      !exactObjectKeys(distinct, ["value", "isNull", "isInvalid", "count"]) ||
      (distinct.value !== null && typeof distinct.value !== "string") ||
      typeof distinct.isNull !== "boolean" ||
      typeof distinct.isInvalid !== "boolean" ||
      !isNonNegativeInteger(distinct.count) ||
      distinct.count === 0 ||
      (distinct.isNull ? distinct.value !== null || distinct.isInvalid : distinct.value === null)
    ) {
      throw new DataViewerError("InvalidResponse", "A distinct value is invalid.");
    }
    return distinct as unknown as DistinctValue;
  });
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    queryId: item.queryId as string | null,
    columnId: item.columnId,
    values,
    hasMore: item.hasMore,
  };
}

export function parseFindQueryMatchResponse(value: unknown): FindQueryMatchResponse {
  const item = record(value);
  const match = item?.match === null ? null : record(item?.match);
  if (
    !item ||
    !exactObjectKeys(item, ["documentId", "sessionId", "queryId", "match"]) ||
    !isNonEmptyString(item.documentId) ||
    !isNonEmptyString(item.sessionId) ||
    !isNonEmptyString(item.queryId) ||
    (item.match !== null &&
      (!match ||
        !exactObjectKeys(match, [
          "rowOffset",
          "columnId",
          "matchIndex",
          "totalMatches",
          "wrapped",
        ]) ||
        !isNonNegativeInteger(match.rowOffset) ||
        !isNonEmptyString(match.columnId) ||
        !isNonNegativeInteger(match.matchIndex) ||
        !isNonNegativeInteger(match.totalMatches) ||
        match.totalMatches === 0 ||
        match.matchIndex >= match.totalMatches ||
        typeof match.wrapped !== "boolean"))
  ) {
    throw new DataViewerError("InvalidResponse", "The find-match response is invalid.");
  }
  return {
    documentId: item.documentId,
    sessionId: item.sessionId,
    queryId: item.queryId,
    match: match as FindQueryMatchResponse["match"],
  };
}

export function parseQueryTempUsage(value: unknown): QueryTempUsage {
  const item = record(value);
  if (
    !item ||
    !exactObjectKeys(item, [
      "processBytes",
      "limitBytes",
      "availableBytes",
      "activeQueries",
      "estimatedTempBytes",
      "safetyReserveBytes",
      "hardCapBytes",
      "freeBytes",
    ]) ||
    !isNonNegativeInteger(item.processBytes) ||
    !isNonNegativeInteger(item.limitBytes) ||
    item.limitBytes === 0 ||
    !isNonNegativeInteger(item.availableBytes) ||
    !isNonNegativeInteger(item.activeQueries) ||
    (item.estimatedTempBytes !== null && !isNonNegativeInteger(item.estimatedTempBytes)) ||
    !isNonNegativeInteger(item.safetyReserveBytes) ||
    !isNonNegativeInteger(item.hardCapBytes) ||
    !isNonNegativeInteger(item.freeBytes)
  ) {
    throw new DataViewerError("InvalidResponse", "The query temporary-storage usage is invalid.");
  }
  return item as unknown as QueryTempUsage;
}

export function parseQueryTempCleanupResult(value: unknown): QueryTempCleanupResult {
  const item = record(value);
  const cleanupFailures = stringArray(item?.cleanupFailures);
  if (
    !item ||
    !exactObjectKeys(item, [
      "deletedBytes",
      "orphanFailureCount",
      "cleanupFailures",
      "remainingUsage",
    ]) ||
    !isNonNegativeInteger(item.deletedBytes) ||
    !isNonNegativeInteger(item.orphanFailureCount) ||
    !cleanupFailures ||
    item.orphanFailureCount !== cleanupFailures.length
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The temporary-storage cleanup result is invalid.",
    );
  }
  return {
    deletedBytes: item.deletedBytes,
    orphanFailureCount: item.orphanFailureCount,
    cleanupFailures,
    remainingUsage: parseQueryTempUsage(item.remainingUsage),
  };
}

export function parseFormatDescriptor(value: unknown): FormatDescriptor {
  const descriptor = record(value);
  const extensions = stringArray(descriptor?.extensions);
  const mimeTypes = stringArray(descriptor?.mimeTypes);
  const capabilities = stringArray(descriptor?.capabilities);
  if (
    !descriptor ||
    !isNonEmptyString(descriptor.id) ||
    !isNonEmptyString(descriptor.displayName) ||
    !extensions ||
    extensions.length === 0 ||
    extensions.some(
      (extension) =>
        extension.length === 0 ||
        extension !== extension.toLocaleLowerCase() ||
        !/^[a-z0-9]+$/.test(extension),
    ) ||
    !hasUniqueValues(extensions) ||
    !mimeTypes ||
    mimeTypes.some((mimeType) => !isNonEmptyString(mimeType)) ||
    !hasUniqueValues(mimeTypes) ||
    !capabilities ||
    capabilities.some((capability) => !isNonEmptyString(capability)) ||
    !hasUniqueValues(capabilities)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid format descriptor.",
    );
  }
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    extensions,
    mimeTypes,
    capabilities,
  };
}

export function parseSupportedFormats(value: unknown): FormatDescriptor[] {
  if (!Array.isArray(value)) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid format catalog.");
  }
  const descriptors = value.map(parseFormatDescriptor);
  const ids = descriptors.map((descriptor) => descriptor.id);
  const names = descriptors.map((descriptor) => descriptor.displayName);
  const extensions = descriptors.flatMap((descriptor) => descriptor.extensions);
  if (
    descriptors.length === 0 ||
    !hasUniqueValues(ids) ||
    !hasUniqueValues(names) ||
    !hasUniqueValues(extensions)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid format catalog.");
  }
  return descriptors;
}

function parseMetadataEntry(value: unknown): MetadataEntry | null {
  const entry = record(value);
  return entry && isNonEmptyString(entry.label) && typeof entry.value === "string"
    ? { label: entry.label, value: entry.value }
    : null;
}

function parseFormatDetailsSection(value: unknown): FormatDetailsSection | null {
  const section = record(value);
  if (!section || !isNonEmptyString(section.id) || !isNonEmptyString(section.title)) return null;
  if (section.kind === "keyValue") {
    const entries = Array.isArray(section.entries) ? section.entries.map(parseMetadataEntry) : null;
    return entries && entries.every((entry) => entry !== null)
      ? {
          id: section.id,
          title: section.title,
          kind: "keyValue",
          entries: entries as MetadataEntry[],
        }
      : null;
  }
  if (section.kind === "table") {
    const columns = stringArray(section.columns);
    const rows = Array.isArray(section.rows) ? section.rows.map((row) => stringArray(row)) : null;
    return columns &&
      columns.every(isNonEmptyString) &&
      hasUniqueValues(columns) &&
      rows &&
      rows.every((row) => row !== null && row.length === columns.length) &&
      typeof section.truncated === "boolean"
      ? {
          id: section.id,
          title: section.title,
          kind: "table",
          columns,
          rows: rows as string[][],
          truncated: section.truncated,
        }
      : null;
  }
  return null;
}

function isHealthCheckResponse(value: unknown): value is HealthCheckResponse {
  const response = record(value);
  return response?.status === "ok" && typeof response.appVersion === "string";
}

function parseColumnSchema(value: unknown): ColumnSchema | null {
  const column = record(value);
  if (
    !column ||
    typeof column.name !== "string" ||
    typeof column.logicalType !== "string" ||
    typeof column.nullable !== "boolean" ||
    typeof column.physicalType !== "string"
  ) {
    return null;
  }

  return {
    name: column.name,
    logicalType: column.logicalType,
    nullable: column.nullable,
    physicalType: column.physicalType,
  };
}

function parseRowGroupSummary(value: unknown): RowGroupSummary | null {
  const rowGroup = record(value);
  const compression = Array.isArray(rowGroup?.compression) ? rowGroup.compression : null;
  if (
    !rowGroup ||
    !isNonNegativeInteger(rowGroup.index) ||
    !isNonNegativeInteger(rowGroup.rowCount) ||
    !isNonNegativeInteger(rowGroup.totalByteSize) ||
    !isNonNegativeInteger(rowGroup.compressedSize) ||
    !compression ||
    compression.some((codec) => !isNonEmptyString(codec)) ||
    !isNonNegativeInteger(rowGroup.statisticsColumnCount)
  ) {
    return null;
  }

  return {
    index: rowGroup.index,
    rowCount: rowGroup.rowCount,
    totalByteSize: rowGroup.totalByteSize,
    compressedSize: rowGroup.compressedSize,
    compression: compression as string[],
    statisticsColumnCount: rowGroup.statisticsColumnCount,
  };
}

const rowCountStates: readonly RowCountState[] = ["calculating", "complete", "cancelled", "failed"];
const csvHeaderModes: readonly CsvHeaderMode[] = ["auto", "present", "absent"];

function parseRowCountStatus(value: unknown): RowCountStatus | null {
  const status = record(value);
  if (
    !status ||
    !rowCountStates.includes(status.state as RowCountState) ||
    !isNonNegativeInteger(status.rowsScanned) ||
    !isNonNegativeInteger(status.bytesScanned) ||
    !isNonNegativeInteger(status.totalBytes) ||
    status.bytesScanned > status.totalBytes ||
    !isNonNegativeInteger(status.generation) ||
    (status.message !== null && typeof status.message !== "string")
  ) {
    return null;
  }

  return {
    state: status.state as RowCountState,
    rowsScanned: status.rowsScanned,
    bytesScanned: status.bytesScanned,
    totalBytes: status.totalBytes,
    generation: status.generation,
    message: status.message as string | null,
  };
}

function parseCsvStructureIssue(value: unknown): CsvStructureIssue | null {
  const issue = record(value);
  if (
    !issue ||
    !isNonNegativeInteger(issue.row) ||
    issue.row < 1 ||
    !isNonNegativeInteger(issue.expectedColumns) ||
    !isNonNegativeInteger(issue.actualColumns)
  ) {
    return null;
  }
  return {
    row: issue.row,
    expectedColumns: issue.expectedColumns,
    actualColumns: issue.actualColumns,
  };
}

function parseCsvHeaderIssue(value: unknown): CsvHeaderIssue | null {
  const issue = record(value);
  if (
    !issue ||
    !isNonNegativeInteger(issue.columnIndex) ||
    typeof issue.rawName !== "string" ||
    !isNonEmptyString(issue.resolvedName) ||
    (issue.reason !== "blank" && issue.reason !== "duplicate")
  ) {
    return null;
  }
  return issue as unknown as CsvHeaderIssue;
}

function parseCsvMetadata(value: unknown): CsvMetadata | null {
  const metadata = record(value);
  const issues = Array.isArray(metadata?.structureIssues)
    ? metadata.structureIssues.map(parseCsvStructureIssue)
    : null;
  const rawHeaders = Array.isArray(metadata?.rawHeaders) ? metadata.rawHeaders : null;
  const headerIssues = Array.isArray(metadata?.headerIssues)
    ? metadata.headerIssues.map(parseCsvHeaderIssue)
    : null;
  const rawHeaderCount = isNonNegativeInteger(metadata?.rawHeaderCount)
    ? metadata.rawHeaderCount
    : null;
  if (
    !metadata ||
    metadata.delimiter !== "," ||
    (metadata.encoding !== "utf-8" && metadata.encoding !== "utf-8-bom") ||
    !csvHeaderModes.includes(metadata.headerMode as CsvHeaderMode) ||
    (metadata.suggestedHeader !== null && typeof metadata.suggestedHeader !== "boolean") ||
    typeof metadata.headerUsed !== "boolean" ||
    !isNonNegativeInteger(metadata.structureIssueCount) ||
    !issues ||
    issues.some((issue) => issue === null) ||
    issues.length > metadata.structureIssueCount ||
    rawHeaderCount === null ||
    !rawHeaders ||
    rawHeaders.some((header) => typeof header !== "string") ||
    rawHeaders.length > rawHeaderCount ||
    typeof metadata.rawHeadersTruncated !== "boolean" ||
    metadata.rawHeadersTruncated !== rawHeaders.length < rawHeaderCount ||
    !isNonNegativeInteger(metadata.headerIssueCount) ||
    !headerIssues ||
    headerIssues.some((issue) => issue === null || issue.columnIndex >= rawHeaderCount) ||
    headerIssues.length > metadata.headerIssueCount
  ) {
    return null;
  }
  return {
    delimiter: metadata.delimiter,
    encoding: metadata.encoding,
    headerMode: metadata.headerMode as CsvHeaderMode,
    suggestedHeader: metadata.suggestedHeader,
    headerUsed: metadata.headerUsed,
    structureIssueCount: metadata.structureIssueCount,
    structureIssues: issues as CsvStructureIssue[],
    rawHeaderCount,
    rawHeaders: rawHeaders as string[],
    rawHeadersTruncated: metadata.rawHeadersTruncated,
    headerIssueCount: metadata.headerIssueCount,
    headerIssues: headerIssues as CsvHeaderIssue[],
  };
}

export function parseFileSummary(value: unknown): FileSummary {
  const summary = record(value);
  const formatDescriptor = parseFormatDescriptor(summary?.formatDescriptor);
  const columnCount = summary?.columnCount;
  const columns = Array.isArray(summary?.columns) ? summary.columns.map(parseColumnSchema) : null;
  const rowGroups = Array.isArray(summary?.rowGroups)
    ? summary.rowGroups.map(parseRowGroupSummary)
    : null;
  const rowCount = summary?.rowCount;
  const rowCountStatus =
    summary?.rowCountStatus === undefined && isNonNegativeInteger(rowCount)
      ? {
          state: "complete" as const,
          rowsScanned: rowCount,
          bytesScanned: isNonNegativeInteger(summary?.fileSize) ? summary.fileSize : 0,
          totalBytes: isNonNegativeInteger(summary?.fileSize) ? summary.fileSize : 0,
          generation: 0,
          message: null,
        }
      : parseRowCountStatus(summary?.rowCountStatus);
  const hasCsvMetadataPayload = summary?.csvMetadata !== null;
  const csvMetadata = hasCsvMetadataPayload ? parseCsvMetadata(summary?.csvMetadata) : null;
  const formatDetails = Array.isArray(summary?.formatDetails)
    ? summary.formatDetails.map(parseFormatDetailsSection)
    : null;
  const hasRowGroups = formatDescriptor.capabilities.includes("rowGroups");
  const hasLegacyCsvDetails = formatDetails?.some((section) => section?.id === "csv-parsing");

  if (
    !summary ||
    !isNonEmptyString(summary.sessionId) ||
    !isNonEmptyString(summary.fileName) ||
    !isNonEmptyString(summary.path) ||
    !isNonEmptyString(summary.format) ||
    summary.format !== formatDescriptor.id ||
    !isNonNegativeInteger(summary.fileSize) ||
    (rowCount !== null && !isNonNegativeInteger(rowCount)) ||
    !rowCountStatus ||
    (rowCountStatus.state === "complete" && !isNonNegativeInteger(rowCount)) ||
    !isNonNegativeInteger(columnCount) ||
    !isNonNegativeInteger(summary.rowGroupCount) ||
    !columns ||
    columns.some((column) => column === null) ||
    columns.length !== summary.columnCount ||
    !rowGroups ||
    rowGroups.some(
      (rowGroup, index) =>
        rowGroup === null ||
        rowGroup.index !== index ||
        rowGroup.statisticsColumnCount > columnCount,
    ) ||
    rowGroups.length !== summary.rowGroupCount ||
    !formatDetails ||
    formatDetails.some((section) => section === null) ||
    !hasUniqueValues(formatDetails.map((section) => section?.id ?? "")) ||
    (hasRowGroups &&
      rowCount !== null &&
      (summary.rowGroupCount !== rowGroups.length ||
        rowGroups.reduce((total, rowGroup) => total + (rowGroup?.rowCount ?? 0), 0) !==
          rowCount)) ||
    (hasCsvMetadataPayload && !csvMetadata) ||
    (hasLegacyCsvDetails && !csvMetadata) ||
    (csvMetadata && (summary.rowGroupCount !== 0 || rowGroups.length !== 0 || columnCount > 4_096))
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid file summary.");
  }

  return {
    sessionId: summary.sessionId,
    fileName: summary.fileName,
    path: summary.path,
    format: summary.format as DataFormat,
    formatDescriptor,
    fileSize: summary.fileSize,
    rowCount: rowCount as number | null,
    rowCountStatus,
    columnCount,
    rowGroupCount: summary.rowGroupCount,
    columns: columns as ColumnSchema[],
    rowGroups: rowGroups as RowGroupSummary[],
    csvMetadata,
    formatDetails: formatDetails as FormatDetailsSection[],
  };
}

export function parseDataValue(value: unknown): DataValue | null {
  const dataValue = record(value);
  if (!dataValue || !dataValueKinds.includes(dataValue.kind as DataValueKind)) {
    return null;
  }

  const extended = ["state", "sourceDisplay", "unit", "timezone", "rawDisplay", "diagnostic"].some(
    (key) => Object.prototype.hasOwnProperty.call(dataValue, key),
  );
  if (!extended) {
    if (dataValue.kind === "null") {
      return dataValue.display === null ? { kind: "null", display: null } : null;
    }
    return typeof dataValue.display === "string"
      ? { kind: dataValue.kind as Exclude<DataValueKind, "null">, display: dataValue.display }
      : null;
  }

  const state = dataValue.state;
  const sourceDisplay = dataValue.sourceDisplay;
  const unit = dataValue.unit;
  const timezone = dataValue.timezone;
  const rawDisplay = dataValue.rawDisplay;
  const diagnostic = record(dataValue.diagnostic);
  const diagnosticValue =
    dataValue.diagnostic === null
      ? null
      : diagnostic &&
          exactObjectKeys(diagnostic, ["code", "message"]) &&
          isNonEmptyString(diagnostic.code) &&
          isNonEmptyString(diagnostic.message)
        ? { code: diagnostic.code, message: diagnostic.message }
        : undefined;
  const commonValid =
    ["valid", "null", "empty", "invalid"].includes(state as string) &&
    (sourceDisplay === undefined || sourceDisplay === null || typeof sourceDisplay === "string") &&
    (unit === undefined || unit === null || typeof unit === "string") &&
    (timezone === undefined || timezone === null || typeof timezone === "string") &&
    (rawDisplay === null || typeof rawDisplay === "string") &&
    diagnosticValue !== undefined;
  const semanticValid =
    (state === "null" &&
      dataValue.kind === "null" &&
      dataValue.display === null &&
      diagnosticValue === null) ||
    (state === "empty" &&
      dataValue.kind === "string" &&
      dataValue.display === "" &&
      diagnosticValue === null) ||
    (state === "valid" &&
      dataValue.kind !== "null" &&
      typeof dataValue.display === "string" &&
      diagnosticValue === null) ||
    (state === "invalid" &&
      dataValue.kind !== "null" &&
      typeof dataValue.display === "string" &&
      typeof rawDisplay === "string" &&
      diagnosticValue !== null);
  if (!commonValid || !semanticValid) return null;
  return {
    kind: dataValue.kind as DataValueKind,
    display: dataValue.display as string | null,
    state: state as DataValueState,
    sourceDisplay: (sourceDisplay ?? null) as string | null,
    unit: (unit ?? null) as string | null,
    timezone: (timezone ?? null) as string | null,
    rawDisplay: rawDisplay as string | null,
    diagnostic: diagnosticValue,
  };
}

export function parseDataPage(value: unknown): DataPage {
  const page = record(value);
  const totalRows = page?.totalRows;
  const hasMore =
    typeof page?.hasMore === "boolean"
      ? page.hasMore
      : isNonNegativeInteger(totalRows) && Array.isArray(page?.rows)
        ? (page.offset as number) + page.rows.length < totalRows
        : null;
  const columns = Array.isArray(page?.columns) ? page.columns : null;
  const rows = Array.isArray(page?.rows)
    ? page.rows.map((row) => (Array.isArray(row) ? row.map(parseDataValue) : null))
    : null;

  if (
    !page ||
    !isNonEmptyString(page.sessionId) ||
    !isNonNegativeInteger(page.offset) ||
    !isNonNegativeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 200 ||
    (totalRows !== null && !isNonNegativeInteger(totalRows)) ||
    hasMore === null ||
    !columns ||
    columns.some((column) => typeof column !== "string") ||
    !rows ||
    rows.length > page.limit ||
    (isNonNegativeInteger(totalRows) && page.offset < totalRows && rows.length === 0) ||
    (isNonNegativeInteger(totalRows) && rows.length > 0 && page.offset + rows.length > totalRows) ||
    (isNonNegativeInteger(totalRows) && hasMore !== page.offset + rows.length < totalRows) ||
    rows.some(
      (row) =>
        row === null ||
        row.length !== columns.length ||
        row.some((dataValue) => dataValue === null),
    )
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid data page.");
  }

  return {
    sessionId: page.sessionId,
    offset: page.offset,
    limit: page.limit,
    totalRows: totalRows as number | null,
    hasMore,
    columns: columns as string[],
    rows: rows as DataValue[][],
  };
}

function isOpenOrigin(value: unknown): value is OpenOrigin {
  return typeof value === "string" && openOrigins.includes(value as OpenOrigin);
}

export function parseOpenDataRequest(value: unknown): OpenDataRequest {
  const request = record(value);
  const paths = Array.isArray(request?.paths) ? request.paths : null;
  if (
    !request ||
    !isNonEmptyString(request.requestId) ||
    !isOpenOrigin(request.origin) ||
    !paths ||
    paths.some((path) => !isNonEmptyString(path))
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid open request.");
  }
  return {
    requestId: request.requestId,
    origin: request.origin,
    paths: paths as string[],
  };
}

function parseOpenedDataItem(value: unknown): OpenedDataFile {
  const response = record(value);
  if (
    !response ||
    !isNonNegativeInteger(response.itemIndex) ||
    !isNonEmptyString(response.path) ||
    (response.disposition !== "opened" && response.disposition !== "existing") ||
    !isNonEmptyString(response.documentId) ||
    !isNonEmptyString(response.sessionId)
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid open session.");
  }
  const summaryRecord = record(response.summary);
  const pageRecord = record(response.initialPage);
  if (!summaryRecord || !pageRecord) {
    throw new DataViewerError("InvalidResponse", "The backend returned an incomplete open result.");
  }
  const summary = parseFileSummary({ ...summaryRecord, sessionId: response.sessionId });
  const initialPage = parseDataPage({ ...pageRecord, sessionId: response.sessionId });
  if (
    initialPage.offset !== 0 ||
    (summary.rowCount !== null &&
      initialPage.totalRows !== null &&
      initialPage.totalRows !== summary.rowCount)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend initial page does not match the opened file summary.",
    );
  }
  return {
    itemIndex: response.itemIndex,
    path: response.path,
    disposition: response.disposition,
    documentId: response.documentId,
    sessionId: response.sessionId,
    summary,
    initialPage,
  };
}

export function parseOpenedDataFile(
  value: unknown,
  expectedRequest?: OpenDataRequest,
): LegacyOpenedDataFile {
  const response = record(value);
  if (!response || !isNonEmptyString(response.requestId) || !isOpenOrigin(response.origin)) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid open result.");
  }
  if (
    expectedRequest &&
    (response.requestId !== expectedRequest.requestId || response.origin !== expectedRequest.origin)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend open result does not match the requested file operation.",
    );
  }
  if (response.error !== undefined) {
    const error = record(response.error);
    if (!error || !isNonEmptyString(error.code) || !isNonEmptyString(error.message)) {
      throw new DataViewerError("InvalidResponse", "The backend returned an invalid open error.");
    }
    throw new DataViewerError(error.code, error.message);
  }
  if (!isNonEmptyString(response.sessionId)) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid open session.");
  }
  const summaryRecord = record(response.summary);
  const pageRecord = record(response.initialPage);
  if (!summaryRecord || !pageRecord) {
    throw new DataViewerError("InvalidResponse", "The backend returned an incomplete open result.");
  }
  return {
    requestId: response.requestId,
    origin: response.origin,
    summary: parseFileSummary({ ...summaryRecord, sessionId: response.sessionId }),
    initialPage: parseDataPage({ ...pageRecord, sessionId: response.sessionId }),
  };
}

function normalizedOpenPath(path: string): string {
  const windowsPath =
    /^\\\\\?\\/i.test(path) ||
    /^[a-z]:[\\/]/i.test(path) ||
    /^\\\\/.test(path) ||
    /^\/\//.test(path);
  if (!windowsPath) return path.replace(/\/+$/, "");

  let normalized = path.replace(/\//g, "\\");
  if (/^\\\\\?\\UNC\\/i.test(normalized)) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (/^\\\\\?\\/i.test(normalized)) {
    normalized = normalized.slice(4);
  }
  return normalized.replace(/\\+$/, "").toLowerCase();
}

export function parseOpenDataResponse(
  value: unknown,
  expectedRequest?: OpenDataRequest,
): OpenDataResponse {
  const response = record(value);
  if (!response || !isNonEmptyString(response.requestId) || !isOpenOrigin(response.origin)) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid open result.");
  }
  if (
    expectedRequest &&
    (response.requestId !== expectedRequest.requestId || response.origin !== expectedRequest.origin)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend open result does not match the requested file operation.",
    );
  }
  if (!Array.isArray(response.opened) || !Array.isArray(response.failures)) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an incomplete batch result.",
    );
  }
  const opened = response.opened.map(parseOpenedDataItem);
  const failures = response.failures.map((value) => {
    const failure = record(value);
    const error = record(failure?.error);
    if (
      !failure ||
      !isNonNegativeInteger(failure.itemIndex) ||
      !isNonEmptyString(failure.path) ||
      !error ||
      !isNonEmptyString(error.code) ||
      !isNonEmptyString(error.message)
    ) {
      throw new DataViewerError("InvalidResponse", "The backend returned an invalid open failure.");
    }
    return {
      itemIndex: failure.itemIndex,
      path: failure.path,
      error: { code: error.code, message: error.message },
    };
  });
  const itemIndexes = [...opened, ...failures].map((item) => item.itemIndex);
  if (new Set(itemIndexes).size !== itemIndexes.length) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned duplicate results for an open request item.",
    );
  }
  if (expectedRequest && expectedRequest.paths.length > 0) {
    if (itemIndexes.length !== expectedRequest.paths.length) {
      throw new DataViewerError(
        "InvalidResponse",
        "The backend open result does not cover every requested path.",
      );
    }
    for (const item of [...opened, ...failures]) {
      if (
        item.itemIndex >= expectedRequest.paths.length ||
        normalizedOpenPath(item.path) !== normalizedOpenPath(expectedRequest.paths[item.itemIndex])
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend open result does not match its requested path.",
        );
      }
    }
  }
  if (response.activeDocumentId !== null && !isNonEmptyString(response.activeDocumentId)) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid active document.",
    );
  }
  if (
    typeof response.activeDocumentId === "string" &&
    !opened.some((item) => item.documentId === response.activeDocumentId)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend active document is not part of the open result.",
    );
  }
  return {
    requestId: response.requestId,
    origin: response.origin,
    opened,
    failures,
    activeDocumentId: response.activeDocumentId as string | null,
  };
}

export function parseOpenFileResponse(value: unknown): OpenFileResponse {
  const response = record(value);
  const summaryRecord = record(response?.summary);
  const pageRecord = record(response?.initialPage);
  if (
    !response ||
    !isNonEmptyString(response.documentId) ||
    !isNonEmptyString(response.sessionId) ||
    !summaryRecord ||
    !pageRecord
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid selected file response.",
    );
  }
  const summary = parseFileSummary({ ...summaryRecord, sessionId: response.sessionId });
  const initialPage = parseDataPage({ ...pageRecord, sessionId: response.sessionId });
  if (
    initialPage.offset !== 0 ||
    (summary.rowCount !== null &&
      initialPage.totalRows !== null &&
      initialPage.totalRows !== summary.rowCount)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The selected file page does not match its summary.",
    );
  }
  return {
    documentId: response.documentId,
    sessionId: response.sessionId,
    summary,
    initialPage,
  };
}

function parseDocumentSummaryResponse(value: unknown): DocumentSummaryResponse {
  const response = record(value);
  const summary = record(response?.summary);
  if (
    !response ||
    !isNonEmptyString(response.documentId) ||
    !isNonEmptyString(response.sessionId) ||
    !summary
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned an invalid document summary.",
    );
  }
  return {
    documentId: response.documentId,
    sessionId: response.sessionId,
    summary: parseFileSummary({ ...summary, sessionId: response.sessionId }),
  };
}

function parseDocumentPageResponse(value: unknown, request: ReadPageRequest): DataPage {
  const response = record(value);
  const page = record(response?.page);
  if (
    !response ||
    !isNonEmptyString(response.documentId) ||
    !isNonEmptyString(response.sessionId) ||
    response.documentId !== request.documentId ||
    response.sessionId !== request.sessionId ||
    !page
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The backend returned a page for another document.",
    );
  }
  return parseDataPage({ ...page, sessionId: response.sessionId });
}

const dataBoundaryDirections: readonly DataBoundaryDirection[] = ["up", "down", "left", "right"];
const dataBoundaryModes: readonly DataBoundaryMode[] = ["dataBoundary", "tableBoundary"];

function validatedFindBoundaryRequest(request: FindBoundaryRequest): FindBoundaryRequest {
  if (
    !isNonEmptyString(request.navigationId) ||
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    (request.queryId !== undefined && !isNonEmptyString(request.queryId)) ||
    !isNonNegativeInteger(request.row) ||
    !isNonEmptyString(request.columnId) ||
    !Array.isArray(request.visibleColumnIds) ||
    request.visibleColumnIds.length === 0 ||
    !request.visibleColumnIds.every(isNonEmptyString) ||
    !hasUniqueValues(request.visibleColumnIds) ||
    !dataBoundaryDirections.includes(request.direction) ||
    !dataBoundaryModes.includes(request.mode)
  ) {
    throw new DataViewerError("InvalidRequest", "The data-boundary request is invalid.");
  }
  return { ...request, visibleColumnIds: [...request.visibleColumnIds] };
}

export function parseFindBoundaryResponse(value: unknown): FindBoundaryResponse {
  const response = record(value);
  if (
    !response ||
    !isNonEmptyString(response.navigationId) ||
    !isNonEmptyString(response.documentId) ||
    !isNonEmptyString(response.sessionId) ||
    (response.queryId !== undefined &&
      response.queryId !== null &&
      !isNonEmptyString(response.queryId)) ||
    !isNonNegativeInteger(response.targetRow) ||
    !isNonEmptyString(response.targetColumnId) ||
    (response.resolvedRowCount !== null && !isNonNegativeInteger(response.resolvedRowCount))
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid data boundary.");
  }
  return {
    navigationId: response.navigationId,
    documentId: response.documentId,
    sessionId: response.sessionId,
    ...(response.queryId === undefined || response.queryId === null
      ? {}
      : { queryId: response.queryId }),
    targetRow: response.targetRow,
    targetColumnId: response.targetColumnId,
    resolvedRowCount: response.resolvedRowCount,
  };
}

function sameBoundaryIdentity(
  request: FindBoundaryRequest,
  response: FindBoundaryResponse,
): boolean {
  return (
    response.navigationId === request.navigationId &&
    response.documentId === request.documentId &&
    response.sessionId === request.sessionId &&
    response.queryId === request.queryId
  );
}

function validatedExecuteQueryRequest(request: ExecuteQueryRequest): ExecuteQueryRequest {
  const plan = parseQueryPlan(request.plan);
  if (
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    !isNonEmptyString(request.queryId) ||
    !isNonEmptyString(request.taskId) ||
    request.queryId.length > 128 ||
    request.taskId.length > 128
  ) {
    throw new DataViewerError("InvalidRequest", "The query request is invalid.");
  }
  return { ...request, plan };
}

function validatedReadQueryPageRequest(request: ReadQueryPageRequest): ReadQueryPageRequest {
  if (
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    !isNonEmptyString(request.queryId) ||
    !isNonNegativeInteger(request.offset) ||
    !isNonNegativeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 200
  ) {
    throw new DataViewerError("InvalidRequest", "The query page request is invalid.");
  }
  return request;
}

function validatedDistinctValuesRequest(request: DistinctValuesRequest): DistinctValuesRequest {
  if (
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    (request.queryId !== null && !isNonEmptyString(request.queryId)) ||
    !isNonEmptyString(request.columnId) ||
    (request.search !== null &&
      (typeof request.search !== "string" || request.search.length > 4_096)) ||
    !isNonNegativeInteger(request.offset) ||
    !isNonNegativeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 200
  ) {
    throw new DataViewerError("InvalidRequest", "The distinct-values request is invalid.");
  }
  return request;
}

function validatedFindQueryMatchRequest(request: FindQueryMatchRequest): FindQueryMatchRequest {
  if (
    !isNonEmptyString(request.documentId) ||
    !isNonEmptyString(request.sessionId) ||
    !isNonEmptyString(request.queryId) ||
    !isNonNegativeInteger(request.fromResultOffset) ||
    (request.fromMatchIndex !== undefined &&
      request.fromMatchIndex !== null &&
      !isNonNegativeInteger(request.fromMatchIndex)) ||
    (request.direction !== "next" && request.direction !== "previous") ||
    typeof request.wrap !== "boolean"
  ) {
    throw new DataViewerError("InvalidRequest", "The find-match request is invalid.");
  }
  return request;
}

function normalizeBackendError(error: unknown): DataViewerError {
  if (error instanceof DataViewerError) {
    return error;
  }

  const response = record(error);
  if (response && isNonEmptyString(response.code) && isNonEmptyString(response.message)) {
    return new DataViewerError(response.code, response.message);
  }
  const nestedError = record(response?.error);
  if (nestedError && isNonEmptyString(nestedError.code) && isNonEmptyString(nestedError.message)) {
    return new DataViewerError(nestedError.code, nestedError.message);
  }

  if (error instanceof Error && error.message.trim()) {
    return new DataViewerError("BackendError", error.message);
  }

  if (typeof error === "string" && error.trim()) {
    return new DataViewerError("BackendError", error);
  }

  return new DataViewerError("BackendError", "The backend request failed.");
}

async function validatedInvoke<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    const telemetry = (
      globalThis as typeof globalThis & {
        __DATA_VIEWER_IPC_TELEMETRY__?: { counts: Record<string, number> };
      }
    ).__DATA_VIEWER_IPC_TELEMETRY__;
    if (telemetry) telemetry.counts[command] = (telemetry.counts[command] ?? 0) + 1;
    return parse(await invoke(command, args));
  } catch (error) {
    throw normalizeBackendError(error);
  }
}

export const tauriBackend: BackendAdapter = {
  async healthCheck() {
    return validatedInvoke("health_check", undefined, (response) => {
      if (!isHealthCheckResponse(response)) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned an invalid health response.",
        );
      }
      return response;
    });
  },
  async listSupportedFormats() {
    return validatedInvoke("list_supported_formats", undefined, parseSupportedFormats);
  },
  async getSettings() {
    return validatedInvoke("get_settings", undefined, parseAppSettings);
  },
  async updateSettings(settings) {
    const validated = parseAppSettings(settings);
    return validatedInvoke("update_settings", { settings: validated }, parseAppSettings);
  },
  async selectDataFile() {
    return validatedInvoke("select_data_file", undefined, (response) =>
      response === null ? null : parseOpenFileResponse(response).summary,
    );
  },
  async selectDataFilePath(requestId) {
    const request: OpenDataRequest = { requestId, origin: "dialog", paths: [] };
    return validatedInvoke("select_data_file_paths", { requestId }, (response) =>
      response === null ? null : parseOpenDataResponse(response, request),
    );
  },
  async openDataFile(request) {
    return validatedInvoke("open_data_paths", { request }, (response) =>
      parseOpenDataResponse(response, request),
    );
  },
  async cancelOpenRequest(requestId) {
    return validatedInvoke("cancel_open_request", { requestId }, () => undefined);
  },
  async takePendingOpenRequests() {
    return validatedInvoke("take_pending_open_requests", undefined, (response) => {
      if (!Array.isArray(response)) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned an invalid pending open request list.",
        );
      }
      return response.map(parseOpenDataRequest);
    });
  },
  async onOpenDataRequest(handler, onError) {
    return listen<unknown>("open-paths-requested", (event) => {
      try {
        handler(parseOpenDataRequest(event.payload));
      } catch (error) {
        onError(normalizeBackendError(error));
      }
    });
  },
  async readPage(request) {
    return validatedInvoke("read_page", { request }, (response) =>
      request.documentId ? parseDocumentPageResponse(response, request) : parseDataPage(response),
    );
  },
  async readCellValue(request) {
    return validatedInvoke("read_cell_value", { request }, (value) => {
      const response = record(value);
      const parsed = parseDataValue(response?.value);
      if (
        !response ||
        response.documentId !== request.documentId ||
        response.sessionId !== request.sessionId ||
        (response.queryId ?? undefined) !== request.queryId ||
        !parsed
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned a cell value for another document or query.",
        );
      }
      return parsed;
    });
  },
  async findDataBoundary(request) {
    const validated = validatedFindBoundaryRequest(request);
    return validatedInvoke("find_data_boundary", { request: validated }, (value) => {
      const response = parseFindBoundaryResponse(value);
      if (!sameBoundaryIdentity(validated, response)) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned a data boundary for another navigation request.",
        );
      }
      return response;
    });
  },
  async cancelDataBoundaryNavigation(request) {
    if (
      !isNonEmptyString(request.navigationId) ||
      !isNonEmptyString(request.documentId) ||
      !isNonEmptyString(request.sessionId) ||
      (request.queryId !== undefined && !isNonEmptyString(request.queryId))
    ) {
      throw new DataViewerError("InvalidRequest", "The navigation cancellation is invalid.");
    }
    return validatedInvoke("cancel_data_boundary_navigation", { request }, () => undefined);
  },
  async configureCsv(documentId, sessionId, headerMode) {
    return validatedInvoke(
      "configure_csv",
      { documentId, sessionId, headerMode },
      parseDocumentSummaryResponse,
    );
  },
  async getCsvProfile(documentId, sessionId) {
    return validatedInvoke("get_csv_profile", { documentId, sessionId }, (value) => {
      const response = parseCsvProfileResponse(value);
      if (response.documentId !== documentId || response.sessionId !== sessionId) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned a CSV profile for another document.",
        );
      }
      return response;
    });
  },
  async previewCsvProfile(request) {
    const validated = validatedCsvPreviewRequest(request);
    return validatedInvoke("preview_csv_profile", { request: validated }, (value) => {
      const response = parseCsvProfilePreviewResponse(value);
      if (
        response.documentId !== validated.documentId ||
        response.sessionId !== validated.sessionId ||
        response.preview.generation !== validated.generation
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned a CSV preview for another profile generation.",
        );
      }
      return response;
    });
  },
  async validateCsvProfile(request) {
    const validated = validatedCsvValidationRequest(request);
    return validatedInvoke("validate_csv_profile", { request: validated }, (value) => {
      const status = parseCsvValidationStatus(value);
      if (
        status.taskId !== validated.taskId ||
        status.documentId !== validated.documentId ||
        status.sessionId !== validated.sessionId ||
        status.generation !== validated.generation
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend returned a status for another CSV validation task.",
        );
      }
      return status;
    });
  },
  async getCsvProfileValidationStatus(documentId, sessionId, taskId) {
    return validatedInvoke(
      "get_csv_profile_validation_status",
      { documentId, sessionId, taskId },
      (value) => {
        const status = parseCsvValidationStatus(value);
        if (
          status.taskId !== taskId ||
          status.documentId !== documentId ||
          status.sessionId !== sessionId
        ) {
          throw new DataViewerError(
            "InvalidResponse",
            "The backend returned a status for another CSV validation task.",
          );
        }
        return status;
      },
    );
  },
  async cancelCsvProfileValidation(documentId, sessionId, taskId) {
    return validatedInvoke(
      "cancel_csv_profile_validation",
      { documentId, sessionId, taskId },
      (value) => {
        const status = parseCsvValidationStatus(value);
        if (
          status.taskId !== taskId ||
          status.documentId !== documentId ||
          status.sessionId !== sessionId
        ) {
          throw new DataViewerError(
            "InvalidResponse",
            "The backend returned a status for another CSV validation task.",
          );
        }
        return status;
      },
    );
  },
  async applyCsvProfile(request) {
    const profile = parseCsvParsingProfile(request.profile);
    if (!isNonEmptyString(request.documentId) || !isNonEmptyString(request.sessionId)) {
      throw new DataViewerError("InvalidRequest", "The CSV profile apply request is invalid.");
    }
    return validatedInvoke("apply_csv_profile", { request: { ...request, profile } }, (value) => {
      const response = parseDocumentSummaryResponse(value);
      if (response.documentId !== request.documentId || response.sessionId === request.sessionId) {
        throw new DataViewerError(
          "InvalidResponse",
          "The backend did not create a new CSV profile session.",
        );
      }
      return response;
    });
  },
  async executeQuery(request) {
    const validated = validatedExecuteQueryRequest(request);
    return validatedInvoke("execute_query", { request: validated }, (value) => {
      const status = parseQueryStatus(value);
      if (
        status.documentId !== validated.documentId ||
        status.sessionId !== validated.sessionId ||
        status.queryId !== validated.queryId ||
        status.taskId !== validated.taskId
      ) {
        throw new DataViewerError("InvalidResponse", "The query status belongs to another task.");
      }
      return status;
    });
  },
  async getQueryStatus(documentId, sessionId, queryId, taskId) {
    return validatedInvoke(
      "get_query_status",
      { documentId, sessionId, queryId, taskId },
      (value) => {
        const status = parseQueryStatus(value);
        if (
          status.documentId !== documentId ||
          status.sessionId !== sessionId ||
          status.queryId !== queryId ||
          status.taskId !== taskId
        ) {
          throw new DataViewerError("InvalidResponse", "The query status belongs to another task.");
        }
        return status;
      },
    );
  },
  async readQueryPage(request) {
    const validated = validatedReadQueryPageRequest(request);
    return validatedInvoke("read_query_page", { request: validated }, (value) => {
      const response = parseReadQueryPageResponse(value);
      if (
        response.documentId !== validated.documentId ||
        response.sessionId !== validated.sessionId ||
        response.queryId !== validated.queryId ||
        response.page.sessionId !== validated.sessionId ||
        response.page.offset !== validated.offset
      ) {
        throw new DataViewerError("InvalidResponse", "The query page belongs to another result.");
      }
      return response;
    });
  },
  async listDistinctValues(request) {
    const validated = validatedDistinctValuesRequest(request);
    return validatedInvoke("list_distinct_values", { request: validated }, (value) => {
      const response = parseDistinctValuesResponse(value);
      if (
        response.documentId !== validated.documentId ||
        response.sessionId !== validated.sessionId ||
        response.queryId !== validated.queryId ||
        response.columnId !== validated.columnId
      ) {
        throw new DataViewerError(
          "InvalidResponse",
          "The distinct values belong to another query column.",
        );
      }
      return response;
    });
  },
  async findQueryMatch(request) {
    const validated = validatedFindQueryMatchRequest(request);
    return validatedInvoke("find_query_match", { request: validated }, (value) => {
      const response = parseFindQueryMatchResponse(value);
      if (
        response.documentId !== validated.documentId ||
        response.sessionId !== validated.sessionId ||
        response.queryId !== validated.queryId
      ) {
        throw new DataViewerError("InvalidResponse", "The find match belongs to another query.");
      }
      return response;
    });
  },
  async cancelQuery(documentId, sessionId, queryId, taskId) {
    return validatedInvoke("cancel_query", { documentId, sessionId, queryId, taskId }, (value) => {
      const status = parseQueryStatus(value);
      if (
        status.documentId !== documentId ||
        status.sessionId !== sessionId ||
        status.queryId !== queryId ||
        status.taskId !== taskId
      ) {
        throw new DataViewerError("InvalidResponse", "The query status belongs to another task.");
      }
      return status;
    });
  },
  async getQueryTempUsage() {
    return validatedInvoke("get_query_temp_usage", undefined, parseQueryTempUsage);
  },
  async clearQueryTemp() {
    return validatedInvoke("clear_query_temp", undefined, parseQueryTempCleanupResult);
  },
  async getDataFileStatus(documentId, sessionId) {
    return validatedInvoke(
      "get_data_file_status",
      { documentId, sessionId },
      parseDocumentSummaryResponse,
    );
  },
  async cancelDataFileTask(documentId, sessionId, generation) {
    return validatedInvoke(
      "cancel_data_file_task",
      { documentId, sessionId, generation },
      parseDocumentSummaryResponse,
    );
  },
  async closeDataFile(documentId, sessionId) {
    await validatedInvoke("close_document", { documentId, sessionId }, () => undefined);
  },
};

export const browserSupportedFormats: FormatDescriptor[] = [
  {
    id: "csv",
    displayName: "CSV",
    extensions: ["csv"],
    mimeTypes: ["text/csv"],
    capabilities: ["columnProjection", "backgroundRowCount", "parsingProfile", "queryProvider"],
  },
  {
    id: "parquet",
    displayName: "Parquet",
    extensions: ["parquet"],
    mimeTypes: ["application/vnd.apache.parquet"],
    capabilities: ["typedSchema", "columnProjection", "rowGroups", "queryProvider"],
  },
  {
    id: "oesHdf5",
    displayName: "OES HDF5",
    extensions: ["h5", "hdf5"],
    mimeTypes: ["application/x-hdf5"],
    capabilities: ["typedSchema", "columnProjection"],
  },
];

const browserFixtureSummary: FileSummary = {
  sessionId: "browser-parquet-session",
  fileName: "typed-row-groups.parquet",
  path: "C:\\Data\\typed-row-groups.parquet",
  format: "parquet",
  formatDescriptor: browserSupportedFormats[1],
  fileSize: 262_144,
  rowCount: 240,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 240,
    bytesScanned: 262_144,
    totalBytes: 262_144,
    generation: 0,
    message: null,
  },
  columnCount: 7,
  rowGroupCount: 3,
  columns: [
    { name: "id", logicalType: "Int64", nullable: false, physicalType: "INT64" },
    { name: "unsigned_max", logicalType: "UInt64", nullable: false, physicalType: "INT64" },
    {
      name: "amount",
      logicalType: "Decimal128(28, 9)",
      nullable: false,
      physicalType: "FIXED_LEN_BYTE_ARRAY",
    },
    {
      name: "recorded_at",
      logicalType: "Timestamp(Nanosecond, Asia/Seoul)",
      nullable: false,
      physicalType: "INT64",
    },
    { name: "payload", logicalType: "Binary", nullable: true, physicalType: "BYTE_ARRAY" },
    { name: "tags", logicalType: "List(Int64)", nullable: true, physicalType: "GROUP" },
    { name: "detail", logicalType: "Struct", nullable: true, physicalType: "GROUP" },
  ],
  rowGroups: [
    {
      index: 0,
      rowCount: 80,
      totalByteSize: 98_304,
      compressedSize: 38_912,
      compression: ["SNAPPY"],
      statisticsColumnCount: 7,
    },
    {
      index: 1,
      rowCount: 80,
      totalByteSize: 102_400,
      compressedSize: 36_864,
      compression: ["ZSTD", "SNAPPY"],
      statisticsColumnCount: 6,
    },
    {
      index: 2,
      rowCount: 80,
      totalByteSize: 96_256,
      compressedSize: 34_816,
      compression: ["ZSTD"],
      statisticsColumnCount: 6,
    },
  ],
  csvMetadata: null,
  formatDetails: [
    {
      id: "parquet-row-groups",
      title: "Row groups",
      kind: "table",
      columns: ["Index", "Rows", "Compressed bytes", "Total bytes", "Compression"],
      rows: [
        ["0", "80", "38912", "98304", "SNAPPY"],
        ["1", "80", "36864", "102400", "ZSTD, SNAPPY"],
        ["2", "80", "34816", "96256", "ZSTD"],
      ],
      truncated: false,
    },
  ],
};

const browserLargeColumnNames = [
  "row_id",
  "category",
  "label",
  "nullable_value",
  "group_id",
  "amount",
  "recorded_at",
  "flag",
  "int64_a",
  "int64_b",
  "float64_a",
  "float64_b",
  "int32_a",
  "payload",
  "detail",
];

const browserLargeSummary: FileSummary = {
  sessionId: "browser-large-parquet-session",
  fileName: "large-5850000.parquet",
  path: "C:\\Data\\large-5850000.parquet",
  format: "parquet",
  formatDescriptor: browserSupportedFormats[1],
  fileSize: 780_000_000,
  rowCount: 5_850_000,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 5_850_000,
    bytesScanned: 780_000_000,
    totalBytes: 780_000_000,
    generation: 0,
    message: null,
  },
  columnCount: browserLargeColumnNames.length,
  rowGroupCount: 0,
  columns: browserLargeColumnNames.map((name, index) => ({
    name,
    logicalType:
      index === 6
        ? "Timestamp(Nanosecond, UTC)"
        : index === 7
          ? "Boolean"
          : [2, 3, 13, 14].includes(index)
            ? "Utf8"
            : [5, 10, 11].includes(index)
              ? "Float64"
              : "Int64",
    nullable: index === 3,
    physicalType: index === 6 ? "INT64" : [2, 3, 13, 14].includes(index) ? "BYTE_ARRAY" : "INT64",
  })),
  rowGroups: [],
  csvMetadata: null,
  formatDetails: [],
};

function browserLargeValue(row: number, column: number): DataValue {
  if (column === 1) return { kind: "string", display: `category-${row % 17}` };
  if (column === 2) return { kind: "string", display: row % 89 === 0 ? "" : `label-${row}` };
  if (column === 3)
    return row % 97 === 0
      ? { kind: "null", display: null }
      : { kind: "string", display: `optional-${row % 31}` };
  if (column === 5 || column === 10 || column === 11)
    return { kind: "float", display: `${row}.${String(column).padStart(2, "0")}` };
  if (column === 6)
    return {
      kind: "timestamp",
      display: "2025-12-18T01:23:34.111111111Z",
      rawDisplay: "1766021014111111111 [unit=ns, timezone=UTC]",
    };
  if (column === 7) return { kind: "boolean", display: row % 2 === 0 ? "true" : "false" };
  if (column === 13) return { kind: "binary", display: `base64:AAECAwQ= (${row + 5} bytes)` };
  if (column === 14) return { kind: "struct", display: `{"row":${row},"active":${row % 2 === 0}}` };
  return { kind: "int", display: String(row * 100 + column) };
}

function browserLargePage(request: ReadPageRequest): DataPage {
  const columns = request.columns ?? browserLargeColumnNames;
  const ordinals = columns.map((name) => browserLargeColumnNames.indexOf(name));
  if (ordinals.some((ordinal) => ordinal < 0)) {
    throw new DataViewerError("InvalidRequest", "The large mock projection is invalid.");
  }
  const end = Math.min(request.offset + request.limit, browserLargeSummary.rowCount ?? 0);
  return {
    sessionId: request.sessionId,
    offset: request.offset,
    limit: request.limit,
    totalRows: browserLargeSummary.rowCount,
    hasMore: end < (browserLargeSummary.rowCount ?? 0),
    columns: [...columns],
    rows: Array.from({ length: Math.max(0, end - request.offset) }, (_, rowOffset) => {
      const row = request.offset + rowOffset;
      return ordinals.map((ordinal) => browserLargeValue(row, ordinal));
    }),
  };
}

function browserFixturePage(request: ReadPageRequest): DataPage {
  const end = Math.min(request.offset + request.limit, browserFixtureSummary.rowCount ?? 0);
  const rows = Array.from({ length: Math.max(0, end - request.offset) }, (_, rowOffset) => {
    const row = request.offset + rowOffset;
    return [
      { kind: "int", display: (9_007_199_254_740_993n + BigInt(row)).toString() },
      { kind: "int", display: "18446744073709551615" },
      { kind: "decimal", display: `${1_234_567_890 + row}.123456789` },
      { kind: "timestamp", display: "2026-07-14T12:34:56.123456789+09:00" },
      row % 11 === 0
        ? { kind: "null", display: null }
        : { kind: "binary", display: `base64:AAECAwQFBgcICQ== (${10 + row} bytes)` },
      { kind: "list", display: `[${row},null,9223372036854775807]` },
      {
        kind: "struct",
        display: `{"row":${row},"payload":{"active":${row % 2 === 0},"note":"long nested preview"}}`,
      },
    ] as DataValue[];
  });

  return {
    sessionId: request.sessionId,
    offset: request.offset,
    limit: request.limit,
    totalRows: browserFixtureSummary.rowCount,
    hasMore: end < (browserFixtureSummary.rowCount ?? 0),
    columns: browserFixtureSummary.columns.map((column) => column.name),
    rows,
  };
}

const browserOesColumnNames = [
  "time",
  ...Array.from({ length: 64 }, (_, index) => String(400 + index)),
];

const browserOesSummary: FileSummary = {
  sessionId: "browser-oes-session",
  fileName: "spectrometer.oes.h5",
  path: "C:\\Data\\spectrometer.oes.h5",
  format: "oesHdf5",
  formatDescriptor: browserSupportedFormats[2],
  fileSize: 1_048_576,
  rowCount: 480,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 480,
    bytesScanned: 1_048_576,
    totalBytes: 1_048_576,
    generation: 0,
    message: null,
  },
  columnCount: browserOesColumnNames.length,
  rowGroupCount: 0,
  columns: browserOesColumnNames.map((name, index) => ({
    name,
    logicalType: index === 0 ? "Int64" : "Int32",
    nullable: false,
    physicalType: index === 0 ? "HDF5 int64 dataset" : "HDF5 /oes int32",
  })),
  rowGroups: [],
  csvMetadata: null,
  formatDetails: [
    {
      id: "oes-layout",
      title: "OES matrix",
      kind: "keyValue",
      entries: [
        { label: "Logical shape [time, wavelength]", value: "480 x 64" },
        { label: "Physical /oes shape [wavelength, time]", value: "64 x 480" },
        { label: "Chunk shape [wavelength, time]", value: "64 x 128" },
        { label: "Filter", value: "Blosc v1 / Zstd (32001)" },
      ],
    },
  ],
};

function browserOesPage(request: ReadPageRequest): DataPage {
  const columns = request.columns ?? browserOesColumnNames.slice(0, 64);
  const sourceOrdinals = columns.map((column) => browserOesColumnNames.indexOf(column));
  if (sourceOrdinals.some((ordinal) => ordinal < 0)) {
    throw new DataViewerError("InvalidRequest", "The OES projection contains an unknown column.");
  }
  const end = Math.min(request.offset + request.limit, browserOesSummary.rowCount ?? 0);
  return {
    sessionId: request.sessionId,
    offset: request.offset,
    limit: request.limit,
    totalRows: browserOesSummary.rowCount,
    hasMore: end < (browserOesSummary.rowCount ?? 0),
    columns: [...columns],
    rows: Array.from({ length: Math.max(0, end - request.offset) }, (_, rowOffset) => {
      const row = request.offset + rowOffset;
      return sourceOrdinals.map((ordinal) =>
        ordinal === 0
          ? ({ kind: "int", display: String(1_000_000 + row) } as DataValue)
          : ({ kind: "int", display: String(row * 1_000 + ordinal - 1) } as DataValue),
      );
    }),
  };
}

function browserCsvSummary(
  headerMode: CsvHeaderMode = "auto",
  complete = false,
  generation = 1,
): FileSummary {
  return {
    sessionId: "browser-csv-session",
    fileName: "quoted-multiline.csv",
    path: "C:\\Data\\quoted-multiline.csv",
    format: "csv",
    formatDescriptor: browserSupportedFormats[0],
    fileSize: 8_192,
    rowCount: complete ? 3 : null,
    rowCountStatus: {
      state: complete ? "complete" : "calculating",
      rowsScanned: complete ? 3 : 2,
      bytesScanned: complete ? 8_192 : 4_096,
      totalBytes: 8_192,
      generation,
      message: null,
    },
    columnCount: 3,
    rowGroupCount: 0,
    columns: ["name", "note", "empty"].map((name) => ({
      name,
      logicalType: "Utf8",
      nullable: false,
      physicalType: "UTF8",
    })),
    rowGroups: [],
    csvMetadata: {
      delimiter: ",",
      encoding: "utf-8",
      headerMode,
      suggestedHeader: true,
      headerUsed: headerMode !== "absent",
      structureIssueCount: 1,
      structureIssues: [{ row: 4, expectedColumns: 3, actualColumns: 2 }],
      rawHeaderCount: 3,
      rawHeaders: ["name", "note", "empty"],
      rawHeadersTruncated: false,
      headerIssueCount: 0,
      headerIssues: [],
    },
    formatDetails: [
      {
        id: "csv-parsing",
        title: "CSV parsing",
        kind: "keyValue",
        entries: [
          { label: "Delimiter", value: "," },
          { label: "Encoding", value: "utf-8" },
          { label: "Header mode", value: headerMode },
        ],
      },
    ],
  };
}

function browserCsvPage(request: ReadPageRequest): DataPage {
  const rows: DataValue[][] = [
    [
      { kind: "string", display: "Kim, Mina" },
      { kind: "string", display: "line one\nline two" },
      { kind: "string", display: "" },
    ],
    [
      { kind: "string", display: 'Lee "quoted"' },
      { kind: "string", display: "CRLF\r\npreserved" },
      { kind: "string", display: "value" },
    ],
    [
      { kind: "string", display: "Park" },
      { kind: "string", display: "plain" },
      { kind: "string", display: "" },
    ],
  ];
  const pageRows = rows.slice(request.offset, request.offset + request.limit);
  return {
    sessionId: request.sessionId,
    offset: request.offset,
    limit: request.limit,
    totalRows: null,
    hasMore: request.offset + pageRows.length < rows.length,
    columns: ["name", "note", "empty"],
    rows: pageRows,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function browserScenario(): string | null {
  return typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("mock");
}

interface BrowserCsvState {
  headerMode: CsvHeaderMode;
  generation: number;
  profile: CsvParsingProfileWire;
}

const browserCsvStates = new Map<string, BrowserCsvState>();
const browserCsvValidationTasks = new Map<string, CsvValidationStatusWire>();
const browserQueryTasks = new Map<
  string,
  { request: ExecuteQueryRequest; status: QueryStatusResponse }
>();
const browserCancelledOpenRequests = new Set<string>();
const browserCancelledBoundaryNavigations = new Set<string>();
const browserOpenRequestHandlers = new Set<OpenRequestHandler>();
let browserSettings = defaultAppSettings();

function browserCsvProfile(generation = 1, mode: CsvProfileMode = "auto"): CsvParsingProfileWire {
  return {
    mode,
    generation,
    columns: ["name", "note", "empty"].map((sourceName, sourceIndex) => ({
      sourceIndex,
      sourceName,
      targetType: mode === "allText" ? "text" : "auto",
      trim: false,
      nullTokens: ["NULL", "N/A"],
      trueTokens: ["true", "TRUE", "1"],
      falseTokens: ["false", "FALSE", "0"],
      decimalSeparator: ".",
      thousandSeparator: null,
      temporalFormats: [],
      timezonePolicy: "preserve",
      timezoneOffsetMinutes: null,
      failurePolicy: "preserveInvalid",
    })),
  };
}

export function emitBrowserOpenDataRequest(request: OpenDataRequest): void {
  const parsed = parseOpenDataRequest(request);
  browserOpenRequestHandlers.forEach((handler) => handler(parsed));
}

function browserOpenedDataFile(path: string, itemIndex: number): OpenedDataFile {
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  const descriptor = browserSupportedFormats.find((candidate) =>
    candidate.extensions.includes(extension ?? ""),
  );
  if (!descriptor) {
    throw new DataViewerError(
      "UnsupportedFormat",
      `Supported formats: ${browserSupportedFormats.map((format) => format.displayName).join(", ")}.`,
    );
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const identity = `${itemIndex}-${fileName.replace(/[^a-z0-9]/gi, "-")}`;
  const documentId = `browser-document-${identity}`;
  const sessionId =
    fileName === browserLargeSummary.fileName
      ? `browser-large-parquet-session-${identity}`
      : `browser-${extension}-session-${identity}`;
  if (descriptor.id === "csv") {
    browserCsvStates.set(sessionId, {
      headerMode: "auto",
      generation: 1,
      profile: browserCsvProfile(),
    });
    const summary = { ...browserCsvSummary(), sessionId, fileName, path };
    return {
      itemIndex,
      path,
      disposition: "opened",
      documentId,
      sessionId,
      summary,
      initialPage: browserCsvPage({
        sessionId: summary.sessionId,
        offset: 0,
        limit: 200,
      }),
    };
  }
  if (descriptor.id === "oesHdf5") {
    const summary = { ...browserOesSummary, sessionId, fileName, path };
    return {
      itemIndex,
      path,
      disposition: "opened",
      documentId,
      sessionId,
      summary,
      initialPage: browserOesPage({
        sessionId: summary.sessionId,
        offset: 0,
        limit: 200,
        columns: browserOesColumnNames.slice(0, 64),
      }),
    };
  }
  if (fileName === browserLargeSummary.fileName) {
    const summary = { ...browserLargeSummary, sessionId, fileName, path };
    return {
      itemIndex,
      path,
      disposition: "opened",
      documentId,
      sessionId,
      summary,
      initialPage: browserLargePage({ sessionId, offset: 0, limit: 200 }),
    };
  }
  const summary = { ...browserFixtureSummary, sessionId, fileName, path };
  return {
    itemIndex,
    path,
    disposition: "opened",
    documentId,
    sessionId,
    summary,
    initialPage: browserFixturePage({
      sessionId: summary.sessionId,
      offset: 0,
      limit: 200,
    }),
  };
}

export const browserMockBackend: BackendAdapter = {
  async healthCheck() {
    return { status: "ok", appVersion: "browser-mock" };
  },
  async listSupportedFormats() {
    return browserSupportedFormats.map((descriptor) => ({
      ...descriptor,
      extensions: [...descriptor.extensions],
      mimeTypes: [...descriptor.mimeTypes],
      capabilities: [...descriptor.capabilities],
    }));
  },
  async getSettings() {
    return parseAppSettings(browserSettings);
  },
  async updateSettings(settings) {
    const validated = parseAppSettings(settings);
    browserSettings = validated;
    return parseAppSettings(browserSettings);
  },
  async selectDataFile() {
    await wait(220);
    const scenario = browserScenario();
    if (scenario === "cancel") {
      return null;
    }
    if (scenario === "error") {
      throw new DataViewerError("InvalidParquet", "The selected file is not a valid Parquet file.");
    }
    if (scenario === "csv" || scenario === "csv-progress") {
      const summary = browserCsvSummary();
      browserCsvStates.set(summary.sessionId, {
        headerMode: "auto",
        generation: 1,
        profile: browserCsvProfile(),
      });
      return summary;
    }
    if (scenario === "oes") return browserOesSummary;
    if (scenario === "large") return browserLargeSummary;
    return browserFixtureSummary;
  },
  async selectDataFilePath(requestId) {
    const summary = await browserMockBackend.selectDataFile();
    if (summary === null) return null;
    const path = summary.path;
    const opened = browserOpenedDataFile(path, 0);
    return {
      requestId,
      origin: "dialog",
      opened: [opened],
      failures: [],
      activeDocumentId: opened.documentId,
    };
  },
  async openDataFile(request) {
    await wait(request.paths[0]?.includes("slow") ? 260 : 80);
    if (browserCancelledOpenRequests.delete(request.requestId)) {
      return {
        requestId: request.requestId,
        origin: request.origin,
        opened: [],
        failures: request.paths.map((path, itemIndex) => ({
          itemIndex,
          path,
          error: {
            code: "OpenRequestCancelled",
            message: `Open request ${request.requestId} was cancelled.`,
          },
        })),
        activeDocumentId: null,
      };
    }
    const opened: OpenedDataFile[] = [];
    const failures: OpenDataFailure[] = [];
    request.paths.forEach((path, itemIndex) => {
      try {
        opened.push(browserOpenedDataFile(path, itemIndex));
      } catch (error) {
        const normalized = normalizeBackendError(error);
        failures.push({
          itemIndex,
          path,
          error: { code: normalized.code, message: normalized.message },
        });
      }
    });
    return {
      requestId: request.requestId,
      origin: request.origin,
      opened,
      failures,
      activeDocumentId: opened[0]?.documentId ?? null,
    };
  },
  async cancelOpenRequest(requestId) {
    browserCancelledOpenRequests.add(requestId);
  },
  async takePendingOpenRequests() {
    return [];
  },
  async onOpenDataRequest(handler) {
    browserOpenRequestHandlers.add(handler);
    return () => browserOpenRequestHandlers.delete(handler);
  },
  async readPage(request) {
    await wait(request.offset >= 200 ? 240 : 60);
    if (request.sessionId.includes("csv-session")) return browserCsvPage(request);
    if (request.sessionId.includes("large-parquet-session")) return browserLargePage(request);
    if (
      request.sessionId.includes("oes-session") ||
      request.sessionId.includes("-h5-session") ||
      request.sessionId.includes("-hdf5-session")
    )
      return browserOesPage(request);
    return browserFixturePage(request);
  },
  async readCellValue(request) {
    const columnNames = request.sessionId.includes("csv-session")
      ? browserCsvSummary("auto", false, 0).columns.map((column) => column.name)
      : request.sessionId.includes("large-parquet-session")
        ? browserLargeColumnNames
        : request.sessionId.includes("oes-session") ||
            request.sessionId.includes("-h5-session") ||
            request.sessionId.includes("-hdf5-session")
          ? browserOesColumnNames
          : browserFixtureSummary.columns.map((column) => column.name);
    const column = columnNames.indexOf(request.columnId);
    if (column < 0 || request.row < 0) {
      throw new DataViewerError("InvalidRequest", "The requested cell does not exist.");
    }
    if (request.sessionId.includes("large-parquet-session")) {
      return browserLargeValue(request.row, column);
    }
    const page = request.sessionId.includes("csv-session")
      ? browserCsvPage({
          sessionId: request.sessionId,
          offset: request.row,
          limit: 1,
          columns: [request.columnId],
        })
      : request.sessionId.includes("oes-session") ||
          request.sessionId.includes("-h5-session") ||
          request.sessionId.includes("-hdf5-session")
        ? browserOesPage({
            sessionId: request.sessionId,
            offset: request.row,
            limit: 1,
            columns: [request.columnId],
          })
        : browserFixturePage({
            sessionId: request.sessionId,
            offset: request.row,
            limit: 1,
            columns: [request.columnId],
          });
    const value = page.rows[0]?.[0];
    if (!value) throw new DataViewerError("InvalidRequest", "The requested cell does not exist.");
    return value;
  },
  async findDataBoundary(request) {
    const validated = validatedFindBoundaryRequest(request);
    await wait(20);
    if (browserCancelledBoundaryNavigations.delete(validated.navigationId)) {
      throw new DataViewerError(
        "NavigationCancelled",
        "The data-boundary navigation was cancelled.",
      );
    }
    const sourcePage = validated.sessionId.includes("csv-session")
      ? browserCsvPage({ ...validated, offset: 0, limit: 1, columns: [validated.columnId] })
      : validated.sessionId.includes("large-parquet-session")
        ? browserLargePage({ ...validated, offset: 0, limit: 1, columns: [validated.columnId] })
        : validated.sessionId.includes("oes-session") ||
            validated.sessionId.includes("-h5-session") ||
            validated.sessionId.includes("-hdf5-session")
          ? browserOesPage({ ...validated, offset: 0, limit: 1, columns: [validated.columnId] })
          : browserFixturePage({
              ...validated,
              offset: 0,
              limit: 1,
              columns: [validated.columnId],
            });
    const columnIndex = validated.visibleColumnIds.indexOf(validated.columnId);
    const targetColumnIndex =
      validated.direction === "left"
        ? 0
        : validated.direction === "right"
          ? validated.visibleColumnIds.length - 1
          : Math.max(0, columnIndex);
    const totalRows = sourcePage.totalRows ?? sourcePage.rows.length;
    return {
      navigationId: validated.navigationId,
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      ...(validated.queryId ? { queryId: validated.queryId } : {}),
      targetRow:
        validated.direction === "up"
          ? 0
          : validated.direction === "down"
            ? Math.max(0, totalRows - 1)
            : validated.row,
      targetColumnId: validated.visibleColumnIds[targetColumnIndex],
      resolvedRowCount: sourcePage.totalRows,
    };
  },
  async cancelDataBoundaryNavigation(request) {
    browserCancelledBoundaryNavigations.add(request.navigationId);
  },
  async configureCsv(_documentId, sessionId, headerMode) {
    const state = browserCsvStates.get(sessionId);
    if (!state) {
      throw new DataViewerError("UnsupportedFormat", "The current file is not CSV.");
    }
    await wait(80);
    state.headerMode = headerMode;
    state.generation += 1;
    return { ...browserCsvSummary(state.headerMode, false, state.generation), sessionId };
  },
  async getCsvProfile(documentId, sessionId) {
    const state = browserCsvStates.get(sessionId);
    if (!state) throw new DataViewerError("UnsupportedFormat", "The current file is not CSV.");
    return parseCsvProfileResponse({ documentId, sessionId, profile: state.profile });
  },
  async previewCsvProfile(request) {
    const validated = validatedCsvPreviewRequest(request);
    const state = browserCsvStates.get(validated.sessionId);
    if (!state) throw new DataViewerError("StaleSession", "The CSV session is no longer active.");
    await wait(30);
    const rawRows = [
      ["Kim, Mina", "line one\nline two", ""],
      ['Lee "quoted"', "CRLF\r\npreserved", "value"],
      ["Park", "plain", ""],
    ];
    const preview: CsvProfilePreviewWire = {
      generation: validated.generation,
      stage: "leading",
      profile: validated.profile,
      columns: validated.profile.columns.map((column) => ({
        sourceIndex: column.sourceIndex,
        sourceName: column.sourceName,
        recommendedType: "text",
        confidence: 0.99,
        targetType: column.targetType === "auto" ? "text" : column.targetType,
        successCount: rawRows.filter((row) => row[column.sourceIndex] !== "").length,
        nullCount: 0,
        invalidCount: 0,
      })),
      rows: rawRows.map((row, sourceRow) => ({
        sourceRow,
        cells: row.map((raw) => ({
          raw,
          converted: {
            kind: "string" as const,
            display: raw,
            state: raw === "" ? ("empty" as const) : ("valid" as const),
            rawDisplay: raw,
            diagnostic: null,
          },
        })),
      })),
    };
    return parseCsvProfilePreviewResponse({
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      preview,
    });
  },
  async validateCsvProfile(request) {
    const validated = validatedCsvValidationRequest(request);
    if (!browserCsvStates.has(validated.sessionId)) {
      throw new DataViewerError("StaleSession", "The CSV session is no longer active.");
    }
    const status: CsvValidationStatusWire = {
      taskId: validated.taskId,
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      generation: validated.generation,
      state: "queued",
      rowsScanned: 0,
      totalRows: 3,
      columns: validated.profile.columns.map((column) => ({
        sourceIndex: column.sourceIndex,
        sourceName: column.sourceName,
        successCount: 0,
        nullCount: 0,
        invalidCount: 0,
        firstErrorRow: null,
        errorSamples: [],
      })),
      error: null,
    };
    browserCsvValidationTasks.set(status.taskId, status);
    return parseCsvValidationStatus(status);
  },
  async getCsvProfileValidationStatus(documentId, sessionId, taskId) {
    const current = browserCsvValidationTasks.get(taskId);
    if (!current || current.documentId !== documentId || current.sessionId !== sessionId) {
      throw new DataViewerError("InvalidRequest", "CSV validation task was not found.");
    }
    if (current.state === "queued" || current.state === "running") {
      const complete: CsvValidationStatusWire = {
        ...current,
        state: "complete",
        rowsScanned: 3,
        columns: current.columns.map((column) => ({
          ...column,
          successCount: 3,
        })),
      };
      browserCsvValidationTasks.set(taskId, complete);
      return parseCsvValidationStatus(complete);
    }
    return parseCsvValidationStatus(current);
  },
  async cancelCsvProfileValidation(documentId, sessionId, taskId) {
    const current = browserCsvValidationTasks.get(taskId);
    if (!current || current.documentId !== documentId || current.sessionId !== sessionId) {
      throw new DataViewerError("InvalidRequest", "CSV validation task was not found.");
    }
    const cancelled: CsvValidationStatusWire = { ...current, state: "cancelled", error: null };
    browserCsvValidationTasks.set(taskId, cancelled);
    return parseCsvValidationStatus(cancelled);
  },
  async applyCsvProfile(request) {
    const profile = parseCsvParsingProfile(request.profile);
    const state = browserCsvStates.get(request.sessionId);
    if (!state) throw new DataViewerError("StaleSession", "The CSV session is no longer active.");
    await wait(40);
    const sessionId = `${request.sessionId}-profile-${profile.generation}`;
    browserCsvStates.delete(request.sessionId);
    browserCsvStates.set(sessionId, { ...state, generation: profile.generation, profile });
    const summary = {
      ...browserCsvSummary(state.headerMode, true, profile.generation),
      sessionId,
      columns: browserCsvSummary().columns.map((column, index) => ({
        ...column,
        logicalType:
          profile.columns[index]?.targetType === "auto"
            ? "Utf8"
            : (profile.columns[index]?.targetType ?? "Utf8"),
      })),
    };
    return {
      documentId: request.documentId,
      sessionId,
      summary,
    };
  },
  async executeQuery(request) {
    const validated = validatedExecuteQueryRequest(request);
    const columns =
      validated.plan.projection.length > 0
        ? validated.plan.projection
        : validated.sessionId.includes("csv-session")
          ? ["name", "note", "empty"]
          : browserFixtureSummary.columns.map((column) => column.name);
    const totalRows = validated.sessionId.includes("csv-session") ? 3 : 240;
    const status: QueryStatusResponse = {
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      queryId: validated.queryId,
      taskId: validated.taskId,
      state: "queued",
      progress: { rowsScanned: 0, totalRows, resultRows: 0 },
      columns,
      elapsedMs: 0,
      findMatchCount: null,
      error: null,
    };
    browserQueryTasks.set(validated.taskId, { request: validated, status });
    return parseQueryStatus(status);
  },
  async getQueryStatus(documentId, sessionId, queryId, taskId) {
    const task = browserQueryTasks.get(taskId);
    if (
      !task ||
      task.request.documentId !== documentId ||
      task.request.sessionId !== sessionId ||
      task.request.queryId !== queryId
    ) {
      throw new DataViewerError("QueryNotFound", `Query result not found: ${queryId}`);
    }
    if (task.status.state === "queued" || task.status.state === "running") {
      await wait(120);
      const totalRows = task.status.progress.totalRows ?? 0;
      task.status = {
        ...task.status,
        state: "complete",
        progress: { rowsScanned: totalRows, totalRows, resultRows: totalRows },
        elapsedMs: 24,
        findMatchCount: task.request.plan.search?.mode === "find" ? 2 : null,
      };
    }
    return parseQueryStatus(task.status);
  },
  async readQueryPage(request) {
    const validated = validatedReadQueryPageRequest(request);
    const task = [...browserQueryTasks.values()].find(
      (candidate) =>
        candidate.request.documentId === validated.documentId &&
        candidate.request.sessionId === validated.sessionId &&
        candidate.request.queryId === validated.queryId,
    );
    if (!task || task.status.state !== "complete") {
      throw new DataViewerError("QueryNotFound", `Query result not found: ${validated.queryId}`);
    }
    const sourcePage = validated.sessionId.includes("csv-session")
      ? browserCsvPage(validated)
      : browserFixturePage(validated);
    const indexes = task.status.columns.map((column) => sourcePage.columns.indexOf(column));
    const page = {
      ...sourcePage,
      columns: [...task.status.columns],
      rows: sourcePage.rows.map((row) => indexes.map((index) => row[index])),
    };
    return parseReadQueryPageResponse({
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      queryId: validated.queryId,
      page,
    });
  },
  async listDistinctValues(request) {
    const validated = validatedDistinctValuesRequest(request);
    const candidates = validated.columnId === "name" ? ["Kim, Mina", "Park"] : ["alpha", "beta"];
    const filtered = candidates.filter((value) =>
      validated.search
        ? value.toLocaleLowerCase().includes(validated.search.toLocaleLowerCase())
        : true,
    );
    const values = filtered
      .slice(validated.offset, validated.offset + validated.limit)
      .map((value) => ({ value, isNull: false, isInvalid: false, count: 1 }));
    return parseDistinctValuesResponse({
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      queryId: validated.queryId,
      columnId: validated.columnId,
      values,
      hasMore: validated.offset + values.length < filtered.length,
    });
  },
  async findQueryMatch(request) {
    const validated = validatedFindQueryMatchRequest(request);
    const task = [...browserQueryTasks.values()].find(
      (candidate) =>
        candidate.request.documentId === validated.documentId &&
        candidate.request.sessionId === validated.sessionId &&
        candidate.request.queryId === validated.queryId,
    );
    const totalMatches = task?.status.findMatchCount ?? 0;
    return parseFindQueryMatchResponse({
      documentId: validated.documentId,
      sessionId: validated.sessionId,
      queryId: validated.queryId,
      match:
        totalMatches === 0
          ? null
          : {
              rowOffset:
                validated.direction === "next"
                  ? validated.fromResultOffset + 1
                  : Math.max(0, validated.fromResultOffset - 1),
              columnId: task?.status.columns[0] ?? "name",
              matchIndex: 0,
              totalMatches,
              wrapped: false,
            },
    });
  },
  async cancelQuery(documentId, sessionId, queryId, taskId) {
    const task = browserQueryTasks.get(taskId);
    if (
      !task ||
      task.request.documentId !== documentId ||
      task.request.sessionId !== sessionId ||
      task.request.queryId !== queryId
    ) {
      throw new DataViewerError("QueryNotFound", `Query result not found: ${queryId}`);
    }
    task.status = { ...task.status, state: "cancelled" };
    return parseQueryStatus(task.status);
  },
  async getQueryTempUsage() {
    return {
      processBytes: 0,
      limitBytes: browserSettings.queryTempLimitBytes,
      availableBytes: 20 * 1024 ** 3,
      activeQueries: 0,
      estimatedTempBytes: null,
      safetyReserveBytes: 5 * 1024 ** 3,
      hardCapBytes: 10 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3,
    };
  },
  async clearQueryTemp() {
    return {
      deletedBytes: 0,
      orphanFailureCount: 0,
      cleanupFailures: [],
      remainingUsage: await browserMockBackend.getQueryTempUsage(),
    };
  },
  async getDataFileStatus(_documentId, sessionId) {
    await wait(80);
    const state = browserCsvStates.get(sessionId);
    return state
      ? { ...browserCsvSummary(state.headerMode, true, state.generation), sessionId }
      : { ...browserFixtureSummary, sessionId };
  },
  async cancelDataFileTask(_documentId, sessionId, generation) {
    const state = browserCsvStates.get(sessionId);
    if (!state) return { ...browserFixtureSummary, sessionId };
    const summary = browserCsvSummary(state.headerMode, false, generation);
    return {
      ...summary,
      sessionId,
      rowCountStatus: { ...summary.rowCountStatus, state: "cancelled", message: "Cancelled" },
    };
  },
  async closeDataFile(_documentId, sessionId) {
    browserCsvStates.delete(sessionId);
    for (const [taskId, task] of browserCsvValidationTasks) {
      if (task.sessionId === sessionId) browserCsvValidationTasks.delete(taskId);
    }
    for (const [taskId, task] of browserQueryTasks) {
      if (task.request.sessionId === sessionId) browserQueryTasks.delete(taskId);
    }
  },
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createDefaultBackend(): BackendAdapter {
  return isTauriRuntime() ? tauriBackend : browserMockBackend;
}
