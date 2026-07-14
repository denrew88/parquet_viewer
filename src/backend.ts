import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export type DataFormat = "parquet" | "csv";
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
  fileSize: number;
  rowCount: number | null;
  rowCountStatus: RowCountStatus;
  columnCount: number;
  rowGroupCount: number;
  columns: ColumnSchema[];
  rowGroups: RowGroupSummary[];
  csvMetadata: CsvMetadata | null;
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
  configureCsv(
    documentId: string,
    sessionId: string,
    headerMode: CsvHeaderMode,
  ): Promise<DocumentSummaryResponse | FileSummary>;
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
  const columnCount = summary?.columnCount;
  const columns = Array.isArray(summary?.columns) ? summary.columns.map(parseColumnSchema) : null;
  const rowGroups = Array.isArray(summary?.rowGroups)
    ? summary.rowGroups.map(parseRowGroupSummary)
    : null;
  const isParquet = summary?.format === "parquet";
  const isCsv = summary?.format === "csv";
  const rowCount = summary?.rowCount;
  const rowCountStatus =
    summary?.rowCountStatus === undefined && isParquet && isNonNegativeInteger(rowCount)
      ? {
          state: "complete" as const,
          rowsScanned: rowCount,
          bytesScanned: isNonNegativeInteger(summary.fileSize) ? summary.fileSize : 0,
          totalBytes: isNonNegativeInteger(summary.fileSize) ? summary.fileSize : 0,
          generation: 0,
          message: null,
        }
      : parseRowCountStatus(summary?.rowCountStatus);
  const csvMetadata = isCsv ? parseCsvMetadata(summary?.csvMetadata) : null;

  if (
    !summary ||
    !isNonEmptyString(summary.sessionId) ||
    !isNonEmptyString(summary.fileName) ||
    !isNonEmptyString(summary.path) ||
    (!isParquet && !isCsv) ||
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
    (isParquet &&
      (summary.rowGroupCount !== rowGroups.length ||
        rowGroups.reduce((total, rowGroup) => total + (rowGroup?.rowCount ?? 0), 0) !==
          rowCount)) ||
    (isCsv &&
      (!csvMetadata ||
        summary.rowGroupCount !== 0 ||
        rowGroups.length !== 0 ||
        columnCount > 4_096))
  ) {
    throw new DataViewerError("InvalidResponse", "The backend returned an invalid file summary.");
  }

  return {
    sessionId: summary.sessionId,
    fileName: summary.fileName,
    path: summary.path,
    format: summary.format as DataFormat,
    fileSize: summary.fileSize,
    rowCount: rowCount as number | null,
    rowCountStatus,
    columnCount,
    rowGroupCount: summary.rowGroupCount,
    columns: columns as ColumnSchema[],
    rowGroups: rowGroups as RowGroupSummary[],
    csvMetadata,
  };
}

function parseDataValue(value: unknown): DataValue | null {
  const dataValue = record(value);
  if (!dataValue || !dataValueKinds.includes(dataValue.kind as DataValueKind)) {
    return null;
  }

  if (dataValue.kind === "null") {
    return dataValue.display === null ? { kind: "null", display: null } : null;
  }

  return typeof dataValue.display === "string"
    ? { kind: dataValue.kind as Exclude<DataValueKind, "null">, display: dataValue.display }
    : null;
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
  async configureCsv(documentId, sessionId, headerMode) {
    return validatedInvoke(
      "configure_csv",
      { documentId, sessionId, headerMode },
      parseDocumentSummaryResponse,
    );
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

const browserFixtureSummary: FileSummary = {
  sessionId: "browser-parquet-session",
  fileName: "typed-row-groups.parquet",
  path: "C:\\Data\\typed-row-groups.parquet",
  format: "parquet",
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
};

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
}

const browserCsvStates = new Map<string, BrowserCsvState>();
const browserCancelledOpenRequests = new Set<string>();
const browserOpenRequestHandlers = new Set<OpenRequestHandler>();

export function emitBrowserOpenDataRequest(request: OpenDataRequest): void {
  const parsed = parseOpenDataRequest(request);
  browserOpenRequestHandlers.forEach((handler) => handler(parsed));
}

function browserOpenedDataFile(path: string, itemIndex: number): OpenedDataFile {
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  if (extension !== "csv" && extension !== "parquet") {
    throw new DataViewerError("UnsupportedFormat", "Only CSV and Parquet files are supported.");
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const identity = `${itemIndex}-${fileName.replace(/[^a-z0-9]/gi, "-")}`;
  const documentId = `browser-document-${identity}`;
  const sessionId = `browser-${extension}-session-${identity}`;
  if (extension === "csv") {
    browserCsvStates.set(sessionId, { headerMode: "auto", generation: 1 });
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
      browserCsvStates.set(summary.sessionId, { headerMode: "auto", generation: 1 });
      return summary;
    }
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
    return request.sessionId.includes("csv-session")
      ? browserCsvPage(request)
      : browserFixturePage(request);
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
  },
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createDefaultBackend(): BackendAdapter {
  return isTauriRuntime() ? tauriBackend : browserMockBackend;
}
