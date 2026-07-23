import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileSpreadsheet,
  FileUp,
  Files,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createDefaultBackend,
  DataViewerError,
  type BackendAdapter,
  type CsvHeaderMode,
  type CsvParsingProfileWire,
  type CsvPreparationStatus,
  type CsvProfileMode,
  type CsvValidationStatusWire,
  type DataPage,
  type DocumentSummaryResponse,
  type FileSummary,
  type FormatDescriptor,
  type FormatDetailsSection,
  type HealthCheckResponse,
  type QueryStatusResponse,
  type QueryTempUsage,
  type LegacyOpenedDataFile,
  type OpenDataResponse,
  type OpenDataRequest,
  type OpenedDataFile,
} from "./backend";
import {
  createDefaultDragDropAdapter,
  type DragDropAdapter,
  type FileDragDropEvent,
} from "./dragDrop";
import { CopySettingsDialog, type CopySettingsValue } from "./copy/CopySettingsDialog";
import type { CopyOptions, CopyPreset } from "./copy/model";
import { CsvProfileDialog } from "./csv-profile/CsvProfileDialog";
import {
  uiRequestToWireProfile,
  matchesCurrentGeneration,
  wirePreviewToUi,
  wireProfileToColumns,
  wireValidationToUi,
  type CsvColumnProfile,
  type CsvProfilePreview,
  type CsvProfileRequest,
  type CsvProfileValidation,
} from "./csv-profile/model";
import { AppSettingsDialog } from "./settings/AppSettingsDialog";
import {
  activeCopyOptions,
  defaultAppSettings,
  parseAppSettings,
  type AppSettings,
  type CopyLimits,
  type DisplayFormats,
} from "./settings/model";
import { VirtualDataGrid } from "./VirtualDataGrid";
import { EMPTY_QUERY_PLAN, resultKey, type QueryPlan } from "./query/model";
import { inferQueryScalarType } from "./query/scalarType";
import {
  createDocumentQueryState,
  documentQueryReducer,
  type DocumentQueryState,
  type QueryProgress,
} from "./query/state";
import type { DistinctValuesState } from "./query/ColumnFilterPopover";
import type { QueryToolbarStatus } from "./query/QueryToolbar";
import { moveId } from "./gridOrdering";
import { isInternalPointerReorderActive, usePointerReorder } from "./components/usePointerReorder";
import "./App.css";

const defaultBackend = createDefaultBackend();
const defaultDragDropAdapter = createDefaultDragDropAdapter();
const tabs = ["data", "schema", "metadata"] as const;
type WorkspaceTab = (typeof tabs)[number];

const tabLabels: Record<WorkspaceTab, string> = {
  data: "Data",
  schema: "Schema",
  metadata: "Metadata",
};

const emptyStateCopy: Record<WorkspaceTab, { title: string; detail: string }> = {
  data: { title: "No file open", detail: "Open a supported data file to view its data." },
  schema: { title: "No schema available", detail: "Schema details appear after a file is opened." },
  metadata: {
    title: "No metadata available",
    detail: "File details appear after a file is opened.",
  },
};

type BackendState =
  | { kind: "checking" }
  | { kind: "connected"; health: HealthCheckResponse }
  | { kind: "error"; message: string };

interface OpenFileError {
  code: string;
  message: string;
  retry: { kind: "open" } | { kind: "page"; offset: number };
}

export interface AppProps {
  backend?: BackendAdapter;
  dragDropAdapter?: DragDropAdapter;
}

interface DropTargetState {
  paths: string[];
}

function pathExtension(path: string): string {
  const fileName = fileNameFromPath(path);
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLocaleLowerCase();
}

function isSupportedDataPath(path: string, formats: readonly FormatDescriptor[]): boolean {
  const extension = pathExtension(path);
  return formats.some((format) => format.extensions.includes(extension));
}

function joinFormatNames(formats: readonly FormatDescriptor[], conjunction: "and" | "or"): string {
  const names = formats.map((format) => format.displayName);
  if (names.length === 0) return "supported data";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
}

function hasCapability(summary: FileSummary, capability: string): boolean {
  return summary.formatDescriptor?.capabilities.includes(capability) ?? false;
}

function formatDisplayName(summary: FileSummary): string {
  return summary.formatDescriptor?.displayName ?? summary.format;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function canonicalPath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

function documentTabLabel(document: ViewerDocument, documents: ViewerDocument[]): string {
  const duplicates = documents.filter((candidate) => candidate.label === document.label);
  if (duplicates.length <= 1) return document.label;
  const parents = document.path
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(0, -1);
  const parentSuffix = (path: string, depth: number) =>
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .slice(0, -1)
      .slice(-depth)
      .join("\\");
  for (let depth = 1; depth <= parents.length; depth += 1) {
    const suffix = parentSuffix(document.path, depth);
    if (
      suffix &&
      duplicates.every(
        (candidate) => candidate === document || parentSuffix(candidate.path, depth) !== suffix,
      )
    ) {
      return `${document.label} (${suffix})`;
    }
  }
  return `${document.label} (${duplicates.indexOf(document) + 1})`;
}

function DropTarget({
  formats,
  state,
}: {
  formats: readonly FormatDescriptor[];
  state: DropTargetState;
}) {
  const unsupported =
    formats.length > 0 && state.paths.some((path) => !isSupportedDataPath(path, formats));
  const supported = state.paths.length > 0 && state.paths.length <= 32 && !unsupported;
  let title = "Drop data files";
  let detail = `Release ${joinFormatNames(formats, "or")} files to open them in tabs.`;
  let Icon = FileUp;
  if (state.paths.length > 32) {
    title = "Too many files";
    detail = "Open at most 32 files in one operation.";
    Icon = TriangleAlert;
  } else if (unsupported) {
    title = "Unsupported file type";
    detail = `Only ${joinFormatNames(formats, "and")} files can be opened.`;
    Icon = TriangleAlert;
  } else if (state.paths.length === 1) {
    title = `Open ${fileNameFromPath(state.paths[0])}`;
    detail = "Release to add this file as a tab.";
  } else if (state.paths.length > 1) {
    title = `Open ${state.paths.length} files`;
    detail = "Release to add these files as tabs in this window.";
    Icon = Files;
  }

  return (
    <div
      className={`drop-target drop-target--${supported ? "valid" : "invalid"}`}
      data-testid="drop-target"
      role="status"
      aria-live="polite"
    >
      <Icon aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function toOpenFileError(
  error: unknown,
  retry: OpenFileError["retry"] = { kind: "open" },
): OpenFileError {
  if (error instanceof DataViewerError) return { code: error.code, message: error.message, retry };
  if (error instanceof Error && error.message.trim()) {
    return { code: "BackendError", message: error.message, retry };
  }
  return { code: "BackendError", message: "The file could not be opened.", retry };
}

function validateInitialPage(summary: FileSummary, page: DataPage): void {
  if (
    page.sessionId !== summary.sessionId ||
    page.offset !== 0 ||
    (summary.rowCount !== null && page.totalRows !== null && page.totalRows !== summary.rowCount)
  ) {
    throw new DataViewerError(
      "InvalidResponse",
      "The first data page does not match the opened file session and offset.",
    );
  }
}

function formatQueryToolbarStatus(state: QueryUiState): QueryToolbarStatus {
  if (state.status === "failed") {
    return {
      state: "error",
      message: state.errorCode
        ? `${state.errorCode}: ${state.error}`
        : (state.error ?? "Query failed"),
      matchCount: state.findMatchCount,
    };
  }
  if (state.status === "queued" || state.status === "running" || state.status === "cancelling") {
    const progress = state.progress;
    const message =
      state.status === "queued"
        ? "Query queued"
        : state.status === "cancelling"
          ? "Cancelling query"
          : progress?.totalRows
            ? `Scanning ${progress.rowsScanned.toLocaleString()} / ${progress.totalRows.toLocaleString()} rows`
            : `Scanning ${progress?.rowsScanned.toLocaleString() ?? 0} rows`;
    return { state: state.status, message, matchCount: state.findMatchCount };
  }
  return { state: "idle", message: "", matchCount: state.findMatchCount };
}

function BackendStatus({ state }: { state: BackendState }) {
  if (state.kind === "checking") {
    return (
      <>
        <LoaderCircle className="status-icon status-icon--loading" aria-hidden="true" />
        <span>Connecting to backend</span>
      </>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <TriangleAlert className="status-icon status-icon--error" aria-hidden="true" />
        <span className="status-message" title={state.message}>
          Backend unavailable: {state.message}
        </span>
      </>
    );
  }
  return (
    <>
      <CircleCheck className="status-icon status-icon--success" aria-hidden="true" />
      <span>Backend connected</span>
      <span className="status-version">v{state.health.appVersion}</span>
    </>
  );
}

function EmptyState({ formats, tab }: { formats: readonly FormatDescriptor[]; tab: WorkspaceTab }) {
  const content =
    tab === "data" && formats.length > 0
      ? {
          title: emptyStateCopy.data.title,
          detail: `Open a ${joinFormatNames(formats, "or")} file to view its data.`,
        }
      : emptyStateCopy[tab];
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <FileSpreadsheet className="empty-state__icon" aria-hidden="true" />
      <h2 id="empty-state-title">{content.title}</h2>
      <p>{content.detail}</p>
    </section>
  );
}

interface DataViewProps {
  active?: boolean;
  cancelDataBoundaryNavigation: BackendAdapter["cancelDataBoundaryNavigation"];
  copyLimits: CopyLimits;
  copyOptions: CopyOptions;
  displayFormats: DisplayFormats;
  copyPresetError: string | null;
  copyPresetSaving: boolean;
  isLoading: boolean;
  isCancelling: boolean;
  onCancel(): void;
  onOpenCopySettings(): void;
  onCopyPresetChange(preset: CopyPreset): void;
  onPageChange(offset: number): void;
  onReadError(error: unknown, offset: number): void;
  onCancelQuery(): void;
  onFindMatch(direction: "next" | "previous"): void;
  onOpenDistinctValues(columnId: string): void;
  onRetryQuery(): void;
  onQueryPlanChange(plan: QueryPlan): void;
  page: DataPage;
  queryState: QueryUiState | null;
  distinctValuesForColumn(columnId: string): DistinctValuesState | undefined;
  documentId: string;
  findDataBoundary: BackendAdapter["findDataBoundary"];
  startCopy: BackendAdapter["startCopy"];
  getCopyStatus: BackendAdapter["getCopyStatus"];
  cancelCopy: BackendAdapter["cancelCopy"];
  getCopyHistory: BackendAdapter["getCopyHistory"];
  csvPreparation: CsvPreparationUiState | null;
  onCancelCsvPreparation(): void;
  onRetryCsvPreparation(): void;
  onDismissCsvPreparation(): void;
  readPage(request: Parameters<BackendAdapter["readPage"]>[0]): Promise<DataPage>;
  readCellValue: BackendAdapter["readCellValue"];
  summary: FileSummary;
}

function DataView({
  active = true,
  cancelDataBoundaryNavigation,
  copyLimits,
  copyOptions,
  displayFormats,
  copyPresetError,
  copyPresetSaving,
  isCancelling,
  isLoading,
  onCancel,
  onOpenCopySettings,
  onCopyPresetChange,
  onPageChange,
  onReadError,
  onCancelQuery,
  onFindMatch,
  onOpenDistinctValues,
  onRetryQuery,
  onQueryPlanChange,
  page,
  queryState,
  distinctValuesForColumn,
  documentId,
  findDataBoundary,
  startCopy,
  getCopyStatus,
  cancelCopy,
  getCopyHistory,
  csvPreparation,
  onCancelCsvPreparation,
  onRetryCsvPreparation,
  onDismissCsvPreparation,
  readPage,
  readCellValue,
  summary,
}: DataViewProps) {
  const invalidValues = page.rows.flat().filter((value) => value.state === "invalid");
  const visibleCsvPreparation =
    csvPreparation &&
    !csvPreparation.dismissed &&
    (csvPreparation.status?.state === "preparing" ||
      csvPreparation.status?.state === "failed" ||
      csvPreparation.status?.state === "cancelled" ||
      csvPreparation.requestError)
      ? csvPreparation
      : null;
  const hasNotices = summary.rowCountStatus.state === "calculating" || invalidValues.length > 0;
  return (
    <div className={`data-view${hasNotices ? " data-view--notices" : ""}`}>
      {hasNotices && (
        <div className="data-view__notices">
          {summary.rowCountStatus.state === "calculating" && (
            <div className="csv-progress" role="status" aria-live="polite">
              <LoaderCircle aria-hidden="true" />
              <div>
                <strong>Calculating CSV row count</strong>
                <span>
                  {formatBytes(summary.rowCountStatus.bytesScanned)} of{" "}
                  {formatBytes(summary.rowCountStatus.totalBytes)} scanned
                </span>
              </div>
              <progress
                aria-label="CSV scan progress"
                max={summary.rowCountStatus.totalBytes || 1}
                value={summary.rowCountStatus.bytesScanned}
              />
              <button disabled={isCancelling} onClick={onCancel} type="button">
                <X aria-hidden="true" />
                <span>{isCancelling ? "Cancelling..." : "Cancel scan"}</span>
              </button>
            </div>
          )}
          {invalidValues.length > 0 && (
            <div className="data-quality-strip" role="status">
              <TriangleAlert aria-hidden="true" />
              <span>
                {invalidValues.length.toLocaleString()} invalid value
                {invalidValues.length === 1 ? "" : "s"} shown as original text.
              </span>
              {invalidValues[0].diagnostic && (
                <span title={invalidValues[0].diagnostic.message}>
                  {invalidValues[0].diagnostic.message}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {visibleCsvPreparation && (
        <div
          className={`csv-preparation csv-preparation--${visibleCsvPreparation.status?.state ?? "failed"}`}
          role={
            visibleCsvPreparation.status?.state === "failed" || visibleCsvPreparation.requestError
              ? "alert"
              : "status"
          }
        >
          {visibleCsvPreparation.status?.state === "preparing" && (
            <LoaderCircle aria-hidden="true" />
          )}
          <div>
            <strong>
              {visibleCsvPreparation.status?.state === "preparing"
                ? "Preparing CSV for fast queries"
                : visibleCsvPreparation.status?.state === "cancelled"
                  ? "CSV preparation cancelled"
                  : "CSV preparation failed"}
            </strong>
            {visibleCsvPreparation.status?.state === "preparing" ? (
              <span>
                {visibleCsvPreparation.status.rowsScanned.toLocaleString()}
                {visibleCsvPreparation.status.totalRows === null
                  ? " rows"
                  : ` / ${visibleCsvPreparation.status.totalRows.toLocaleString()} rows`}
                {` · ${(visibleCsvPreparation.status.elapsedMs / 1_000).toFixed(1)}s`}
              </span>
            ) : (
              <span>
                {visibleCsvPreparation.requestError ??
                  (visibleCsvPreparation.status?.error
                    ? `${visibleCsvPreparation.status.error.code}: ${visibleCsvPreparation.status.error.message}`
                    : null) ??
                  "The preparation task did not complete."}
              </span>
            )}
          </div>
          {visibleCsvPreparation.status?.state === "preparing" ? (
            <button
              disabled={visibleCsvPreparation.action === "cancelling"}
              onClick={onCancelCsvPreparation}
              type="button"
            >
              {visibleCsvPreparation.action === "cancelling" ? "Cancelling..." : "Cancel"}
            </button>
          ) : (
            <div className="csv-preparation__actions">
              <button
                disabled={visibleCsvPreparation.action === "starting"}
                onClick={onRetryCsvPreparation}
                type="button"
              >
                {visibleCsvPreparation.action === "starting" ? "Retrying..." : "Retry"}
              </button>
              <button onClick={onDismissCsvPreparation} type="button">
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
      <VirtualDataGrid
        active={active}
        cancelDataBoundaryNavigation={cancelDataBoundaryNavigation}
        copyLimits={copyLimits}
        copyOptions={copyOptions}
        displayFormats={displayFormats}
        copyPresetError={copyPresetError}
        copyPresetSaving={copyPresetSaving}
        distinctValuesForColumn={queryState ? distinctValuesForColumn : undefined}
        documentId={documentId}
        findDataBoundary={findDataBoundary}
        startCopy={startCopy}
        getCopyStatus={getCopyStatus}
        cancelCopyOperation={cancelCopy}
        getCopyHistory={getCopyHistory}
        findTarget={queryState?.findTarget ?? undefined}
        isLoading={isLoading}
        logicalColumnNames={queryState?.queryId ? queryState.resultColumns : undefined}
        onCancelQuery={queryState ? onCancelQuery : undefined}
        onFindNext={queryState ? () => onFindMatch("next") : undefined}
        onFindPrevious={queryState ? () => onFindMatch("previous") : undefined}
        onOpenDistinctValues={queryState ? onOpenDistinctValues : undefined}
        onRetryQuery={queryState ? onRetryQuery : undefined}
        onPageChange={onPageChange}
        onCopyPresetChange={onCopyPresetChange}
        onOpenCopySettings={onOpenCopySettings}
        onQueryPlanChange={queryState ? onQueryPlanChange : undefined}
        onReadError={onReadError}
        page={page}
        queryActive={Boolean(queryState?.queryId)}
        queryId={queryState?.queryId ?? undefined}
        queryPlan={queryState?.draftPlan}
        queryStatus={queryState ? formatQueryToolbarStatus(queryState) : undefined}
        readPage={readPage}
        readCellValue={(row, columnId) =>
          readCellValue({
            documentId,
            sessionId: summary.sessionId,
            ...(queryState?.queryId ? { queryId: queryState.queryId } : {}),
            row,
            columnId,
          })
        }
        resultKey={queryState ? resultKey(queryState.sessionId, queryState.queryId) : undefined}
        summary={summary}
      />
    </div>
  );
}

function SchemaView({ summary }: { summary: FileSummary }) {
  return (
    <div className="detail-view">
      <header className="detail-heading">
        <h2>Schema</h2>
        <p>{summary.columnCount.toLocaleString()} columns</p>
      </header>
      <div className="detail-table-scroll">
        <table aria-label="File schema" className="detail-table">
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Logical type</th>
              <th scope="col">Physical type</th>
              <th scope="col">Nullable</th>
            </tr>
          </thead>
          <tbody>
            {summary.columns.map((column) => (
              <tr key={column.name}>
                <th scope="row" title={column.name}>
                  {column.name}
                </th>
                <td>{column.logicalType}</td>
                <td>{column.physicalType}</td>
                <td>
                  <span
                    className={`nullable-label nullable-label--${column.nullable ? "yes" : "no"}`}
                  >
                    {column.nullable ? "Yes" : "No"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetadataItem({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="metadata-item">
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function GenericFormatDetails({ sections }: { sections: readonly FormatDetailsSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section
          aria-labelledby={`format-details-${section.id}`}
          className="format-details"
          key={section.id}
        >
          <div className="row-groups__heading">
            <h3 id={`format-details-${section.id}`}>{section.title}</h3>
            {section.kind === "table" && section.truncated && <span>Preview truncated</span>}
          </div>
          {section.kind === "keyValue" ? (
            <dl className="metadata-grid format-details__grid">
              {section.entries.map((entry, index) => (
                <MetadataItem
                  key={`${entry.label}-${index}`}
                  label={entry.label}
                  title={entry.value}
                >
                  {entry.value}
                </MetadataItem>
              ))}
            </dl>
          ) : (
            <div className="row-groups__scroll">
              <table aria-label={section.title} className="detail-table format-details__table">
                <thead>
                  <tr>
                    {section.columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) =>
                        columnIndex === 0 ? (
                          <th key={columnIndex} scope="row" title={cell}>
                            {cell}
                          </th>
                        ) : (
                          <td key={columnIndex} title={cell}>
                            {cell}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                  {section.rows.length === 0 && (
                    <tr>
                      <td
                        className="row-groups__empty"
                        colSpan={Math.max(1, section.columns.length)}
                      >
                        No details
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function MetadataView({
  isConfiguring,
  onHeaderModeChange,
  summary,
}: {
  isConfiguring: boolean;
  onHeaderModeChange(mode: CsvHeaderMode): void;
  summary: FileSummary;
}) {
  const csv = summary.csvMetadata;
  const showRowGroups = hasCapability(summary, "rowGroups");
  const genericSections = (summary.formatDetails ?? []).filter(
    (section) =>
      !(section.id === "csv-parsing" && csv) &&
      !(section.id === "parquet-row-groups" && showRowGroups),
  );
  return (
    <div className="detail-view metadata-view">
      <header className="detail-heading">
        <h2>Metadata</h2>
        <p>File and {formatDisplayName(summary)} details</p>
      </header>
      <div className="metadata-content">
        <dl className="metadata-grid">
          <MetadataItem label="File name" title={summary.fileName}>
            {summary.fileName}
          </MetadataItem>
          <MetadataItem label="Path" title={summary.path}>
            {summary.path}
          </MetadataItem>
          <MetadataItem label="Format">{formatDisplayName(summary)}</MetadataItem>
          <MetadataItem label="File size">{formatBytes(summary.fileSize)}</MetadataItem>
          <MetadataItem label="Rows">
            {summary.rowCount === null ? "Calculating..." : summary.rowCount.toLocaleString()}
          </MetadataItem>
          <MetadataItem label="Columns">{summary.columnCount.toLocaleString()}</MetadataItem>
          {showRowGroups && (
            <MetadataItem label="Row groups">{summary.rowGroupCount.toLocaleString()}</MetadataItem>
          )}
        </dl>
        {csv && (
          <section className="csv-metadata" aria-labelledby="csv-metadata-heading">
            <div className="row-groups__heading">
              <h3 id="csv-metadata-heading">CSV parsing</h3>
              <span>{summary.rowCountStatus.state}</span>
            </div>
            <dl className="metadata-grid csv-metadata__grid">
              <MetadataItem label="Delimiter">Comma (,)</MetadataItem>
              <MetadataItem label="Encoding">{csv.encoding}</MetadataItem>
              <MetadataItem label="Header suggestion">
                {csv.suggestedHeader === null
                  ? "Undetermined"
                  : csv.suggestedHeader
                    ? "Header likely"
                    : "No header likely"}
              </MetadataItem>
              <MetadataItem label="Header used">{csv.headerUsed ? "Yes" : "No"}</MetadataItem>
              <MetadataItem label="Rows scanned">
                {summary.rowCountStatus.rowsScanned.toLocaleString()}
              </MetadataItem>
              <MetadataItem label="Structure issues">
                {csv.structureIssueCount.toLocaleString()}
              </MetadataItem>
              <MetadataItem label="Raw headers">
                {csv.rawHeaderCount.toLocaleString()}
                {csv.rawHeadersTruncated ? " (preview truncated)" : ""}
              </MetadataItem>
              <MetadataItem label="Header issues">
                {csv.headerIssueCount.toLocaleString()}
              </MetadataItem>
            </dl>
            <fieldset className="header-mode" disabled={isConfiguring}>
              <legend>Header mode</legend>
              <div className="segmented-control">
                {(["auto", "present", "absent"] as const).map((mode) => (
                  <button
                    aria-pressed={csv.headerMode === mode}
                    key={mode}
                    onClick={() => onHeaderModeChange(mode)}
                    type="button"
                  >
                    {mode === "auto" ? "Auto" : mode === "present" ? "Present" : "Absent"}
                  </button>
                ))}
              </div>
              {isConfiguring && (
                <span className="header-mode__pending" role="status">
                  <LoaderCircle aria-hidden="true" /> Updating header mode
                </span>
              )}
            </fieldset>
            {csv.structureIssues.length > 0 && (
              <table aria-label="CSV structure issues" className="detail-table structure-table">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {csv.structureIssues.map((issue, index) => (
                    <tr key={`${issue.row}-${index}`}>
                      <th scope="row">{issue.row.toLocaleString()}</th>
                      <td>{issue.expectedColumns.toLocaleString()}</td>
                      <td>{issue.actualColumns.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {csv.headerIssues.length > 0 && (
              <table aria-label="CSV header issues" className="detail-table structure-table">
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col">Raw header</th>
                    <th scope="col">Resolved header</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {csv.headerIssues.map((issue) => (
                    <tr key={`${issue.columnIndex}-${issue.resolvedName}`}>
                      <th scope="row">{issue.columnIndex + 1}</th>
                      <td title={issue.rawName}>{issue.rawName || "(blank)"}</td>
                      <td title={issue.resolvedName}>{issue.resolvedName}</td>
                      <td>{issue.reason === "blank" ? "Blank" : "Duplicate"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {showRowGroups && (
          <section className="row-groups" aria-labelledby="row-groups-heading">
            <div className="row-groups__heading">
              <h3 id="row-groups-heading">Row groups</h3>
              <span>{summary.rowGroupCount.toLocaleString()} groups</span>
            </div>
            <div className="row-groups__scroll">
              <table aria-label="Parquet row groups" className="detail-table row-groups__table">
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col">Rows</th>
                    <th scope="col">Compressed</th>
                    <th scope="col">Uncompressed</th>
                    <th scope="col">Compression</th>
                    <th scope="col">Statistics</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rowGroups.map((rowGroup) => (
                    <tr key={rowGroup.index}>
                      <th scope="row">{rowGroup.index + 1}</th>
                      <td>{rowGroup.rowCount.toLocaleString()}</td>
                      <td>{formatBytes(rowGroup.compressedSize)}</td>
                      <td>{formatBytes(rowGroup.totalByteSize)}</td>
                      <td title={rowGroup.compression.join(", ")}>
                        {rowGroup.compression.join(", ") || "None"}
                      </td>
                      <td>
                        {rowGroup.statisticsColumnCount.toLocaleString()} /{" "}
                        {summary.columnCount.toLocaleString()} columns
                      </td>
                    </tr>
                  ))}
                  {summary.rowGroups.length === 0 && (
                    <tr>
                      <td className="row-groups__empty" colSpan={6}>
                        No row groups
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <GenericFormatDetails sections={genericSections} />
      </div>
    </div>
  );
}

function PageStatus({ page }: { page: DataPage }) {
  if (page.totalRows === 0) return <span className="page-status">No rows</span>;
  if (page.rows.length === 0) {
    return <span className="page-status">No rows at offset {page.offset.toLocaleString()}</span>;
  }

  if (page.totalRows === null) {
    return (
      <span className="page-status">
        Showing rows {page.offset + 1}-{page.offset + page.rows.length}; total calculating
      </span>
    );
  }
  return (
    <span className="page-status">
      Showing rows {page.offset + 1}-{page.offset + page.rows.length} of{" "}
      {page.totalRows.toLocaleString()}
    </span>
  );
}

type DocumentStatus = "loading" | "ready" | "error";

interface ViewerDocument {
  id: string;
  openRequestId: string | null;
  documentId: string | null;
  sessionId: string | null;
  path: string;
  label: string;
  status: DocumentStatus;
  summary: FileSummary | null;
  page: DataPage | null;
  activeTab: WorkspaceTab;
  isPageLoading: boolean;
  isConfiguringCsv: boolean;
  isCancellingCsv: boolean;
  error: OpenFileError | null;
}

interface CsvProfileUiState {
  identity: { documentId: string; sessionId: string };
  wireProfile: CsvParsingProfileWire;
  columns: readonly CsvColumnProfile[];
  preview: CsvProfilePreview | null;
  validation: CsvProfileValidation | null;
  validationWire: CsvValidationStatusWire | null;
  isApplying: boolean;
  error: string | null;
  structuralError: string | null;
}

interface QueryDistinctState {
  values: { value: string; count: number | null }[];
  search: string;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  requestId: number;
}

interface QueryUiState extends DocumentQueryState {
  pendingQueryId: string | null;
  errorCode: string | null;
  resultColumns: string[];
  findMatchCount: number | null;
  findTarget: { row: number; columnId: string; matchIndex: number; key: string } | null;
  distinct: Record<string, QueryDistinctState>;
}

interface CsvPreparationUiState {
  documentId: string;
  sessionId: string;
  status: CsvPreparationStatus | null;
  action: "starting" | "cancelling" | null;
  requestError: string | null;
  dismissed: boolean;
}

function createQueryUiState(documentId: string, sessionId: string): QueryUiState {
  return {
    ...createDocumentQueryState(documentId, sessionId),
    pendingQueryId: null,
    errorCode: null,
    resultColumns: [],
    findMatchCount: null,
    findTarget: null,
    distinct: {},
  };
}

function queryPageProjection(primary: readonly string[], fallback: readonly string[]): string[] {
  const requested = primary.length > 0 ? primary : fallback;
  const unique = [...new Set(requested.filter((column) => column.length > 0))];
  if (unique.length === 0) {
    throw new Error("The query result does not contain a readable column.");
  }
  return unique.slice(0, 64);
}

function compatibleQueryPlan(
  plan: QueryPlan,
  summary: FileSummary,
): { plan: QueryPlan; adjustmentReason: string | null } {
  const columnTypes = new Map(
    summary.columns.map((column) => [column.name, inferQueryScalarType(summary, column.name)]),
  );
  const removed: string[] = [];
  const filters = plan.filters.filter((filter) => {
    const compatible = columnTypes.get(filter.columnId) === filter.scalarType;
    if (!compatible) removed.push(`filter on ${filter.columnId}`);
    return compatible;
  });
  const sort = plan.sort.filter((entry) => {
    const compatible = columnTypes.has(entry.columnId);
    if (!compatible) removed.push(`sort on ${entry.columnId}`);
    return compatible;
  });
  const projection = plan.projection.filter((columnId) => {
    const compatible = columnTypes.has(columnId);
    if (!compatible) removed.push(`projection ${columnId}`);
    return compatible;
  });
  let search = plan.search;
  if (search) {
    const targetColumnIds = search.targetColumnIds.filter(
      (columnId) => columnTypes.has(columnId) && columnTypes.get(columnId) !== "other",
    );
    const removedTargets = search.targetColumnIds.filter(
      (columnId) => !targetColumnIds.includes(columnId),
    );
    removed.push(...removedTargets.map((columnId) => `search target ${columnId}`));
    if (search.targetColumnIds.length > 0 && targetColumnIds.length === 0) {
      search = null;
    } else if (
      search.targetColumnIds.length === 0 &&
      ![...columnTypes.values()].some((type) => type !== "other")
    ) {
      removed.push("search across all columns");
      search = null;
    } else {
      search = { ...search, targetColumnIds };
    }
  }
  return {
    plan: { filters, search, sort, projection },
    adjustmentReason:
      removed.length > 0
        ? `Removed incompatible query conditions after the CSV profile changed: ${removed.join(", ")}.`
        : null,
  };
}

function queryPlanHasWork(plan: QueryPlan): boolean {
  return Boolean(
    plan.filters.length > 0 ||
    plan.search?.text.trim() ||
    plan.sort.length > 0 ||
    plan.projection.length > 0,
  );
}

function replaceQueryUiSession(
  state: QueryUiState | undefined,
  documentId: string,
  sessionId: string,
  compatiblePlan: QueryPlan,
): QueryUiState {
  const current = state ?? createQueryUiState(documentId, sessionId);
  const replaced = documentQueryReducer(current, {
    type: "replaceSession",
    sessionId,
    compatiblePlan,
  });
  return { ...createQueryUiState(documentId, sessionId), ...replaced };
}

function normalizedOpenResponse(value: OpenDataResponse | LegacyOpenedDataFile): OpenDataResponse {
  if ("opened" in value) return value;
  const documentId = `legacy-${value.summary.sessionId}`;
  return {
    requestId: value.requestId,
    origin: value.origin,
    opened: [
      {
        itemIndex: 0,
        path: value.summary.path,
        disposition: "opened",
        documentId,
        sessionId: value.summary.sessionId,
        summary: value.summary,
        initialPage: value.initialPage,
      },
    ],
    failures: [],
    activeDocumentId: documentId,
  };
}

function normalizedSummaryResponse(
  value: DocumentSummaryResponse | FileSummary,
  documentId: string,
): DocumentSummaryResponse {
  return "summary" in value ? value : { documentId, sessionId: value.sessionId, summary: value };
}

function App({ backend = defaultBackend, dragDropAdapter = defaultDragDropAdapter }: AppProps) {
  const [backendState, setBackendState] = useState<BackendState>({ kind: "checking" });
  const [formatCatalog, setFormatCatalog] = useState<FormatDescriptor[]>([]);
  const [emptyActiveTab, setEmptyActiveTab] = useState<WorkspaceTab>("data");
  const [documents, setDocuments] = useState<ViewerDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [openingCount, setOpeningCount] = useState(0);
  const [globalError, setGlobalError] = useState<OpenFileError | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => defaultAppSettings());
  const [settingsWarning, setSettingsWarning] = useState<string | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [copySettingsOpen, setCopySettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [copyPresetSaveError, setCopyPresetSaveError] = useState<string | null>(null);
  const [copyPresetSaving, setCopyPresetSaving] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [csvProfiles, setCsvProfiles] = useState<Record<string, CsvProfileUiState>>({});
  const [csvProfileDialogDocumentId, setCsvProfileDialogDocumentId] = useState<string | null>(null);
  const [csvProfileLoadingDocumentId, setCsvProfileLoadingDocumentId] = useState<string | null>(
    null,
  );
  const [csvProfileModes, setCsvProfileModes] = useState<Record<string, CsvProfileMode>>({});
  const [queryStates, setQueryStates] = useState<Record<string, QueryUiState>>({});
  const [csvPreparationStates, setCsvPreparationStates] = useState<
    Record<string, CsvPreparationUiState>
  >({});
  const [queryTempUsage, setQueryTempUsage] = useState<QueryTempUsage | null>(null);
  const [queryTempLoading, setQueryTempLoading] = useState(false);
  const [queryTempError, setQueryTempError] = useState<string | null>(null);
  const [queryTempClearMessage, setQueryTempClearMessage] = useState<string | null>(null);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const queryStatesRef = useRef(queryStates);
  queryStatesRef.current = queryStates;
  const pathRequestSequence = useRef(0);
  const consumedPathRequestIds = useRef(new Set<string>());
  const pageRequests = useRef(new Map<string, number>());
  const statusRequests = useRef(new Map<string, number>());
  const pollRequests = useRef(new Map<string, number>());
  const closedPendingIds = useRef(new Set<string>());
  const cancelledOpeningRequestIds = useRef(new Set<string>());
  const pathCloseBarriers = useRef(new Map<string, Promise<void>>());
  const deferredOpenedByPath = useRef(
    new Map<string, { ownerRequestId: string; opened: OpenedDataFile }>(),
  );
  const cleanedOpenedIdentities = useRef(new Set<string>());
  const focusAfterClose = useRef(false);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const externalDragSession = useRef(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const csvProfileButtonRef = useRef<HTMLButtonElement>(null);
  const appSettingsRef = useRef(appSettings);
  const settingsSavingRef = useRef(false);
  appSettingsRef.current = appSettings;
  const csvProfileRequests = useRef(new Map<string, number>());
  const csvValidationPolls = useRef(new Map<string, number>());
  const csvPreparationTokens = useRef(new Map<string, number>());
  const csvPreparationTimers = useRef(new Map<string, number>());
  const csvPreparationIdentities = useRef(new Map<string, string>());
  const csvDefaultsHandled = useRef(new Set<string>());
  const queryRequests = useRef(new Map<string, number>());
  const findRequests = useRef(new Map<string, number>());
  const querySequence = useRef(0);
  const executeDocumentQueryRef = useRef<
    (document: ViewerDocument, plan: QueryPlan, skipPreviousCancel?: boolean) => void
  >(() => undefined);

  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const summary = activeDocument?.summary ?? null;
  const page = activeDocument?.page ?? null;
  const activeTab = activeDocument?.activeTab ?? emptyActiveTab;
  const csvProfileDocument =
    documents.find((document) => document.id === csvProfileDialogDocumentId) ?? null;
  const activeCsvProfile = csvProfileDialogDocumentId
    ? (csvProfiles[csvProfileDialogDocumentId] ?? null)
    : null;

  const updateDocument = useCallback(
    (id: string, update: (document: ViewerDocument) => ViewerDocument) => {
      setDocuments((current) =>
        current.map((document) => (document.id === id ? update(document) : document)),
      );
    },
    [],
  );

  function applyDocumentOrder(nextIds: readonly string[]): void {
    setDocuments((current) => {
      const byId = new Map(current.map((document) => [document.id, document]));
      const ordered = nextIds.flatMap((id) => {
        const document = byId.get(id);
        if (!document) return [];
        byId.delete(id);
        return [document];
      });
      return [...ordered, ...byId.values()];
    });
  }

  const documentReorder = usePointerReorder({
    ids: documents.map((document) => document.id),
    containerRef: tabStripRef,
    orientation: "horizontal",
    onCommit: applyDocumentOrder,
  });

  function moveDocument(documentId: string, direction: -1 | 1): void {
    applyDocumentOrder(
      moveId(
        documentsRef.current.map((document) => document.id),
        documentId,
        direction,
      ),
    );
    window.requestAnimationFrame(() =>
      document.getElementById(`document-tab-${documentId}`)?.focus(),
    );
  }

  const clearCsvPreparationTask = useCallback((viewerDocumentId: string) => {
    const timer = csvPreparationTimers.current.get(viewerDocumentId);
    if (timer !== undefined) window.clearTimeout(timer);
    csvPreparationTimers.current.delete(viewerDocumentId);
    csvPreparationTokens.current.set(
      viewerDocumentId,
      (csvPreparationTokens.current.get(viewerDocumentId) ?? 0) + 1,
    );
  }, []);

  const startCsvPreparation = useCallback(
    (viewerDocumentId: string, documentId: string, sessionId: string) => {
      clearCsvPreparationTask(viewerDocumentId);
      const token = csvPreparationTokens.current.get(viewerDocumentId) ?? 0;
      const identity = `${documentId}\u0000${sessionId}`;
      csvPreparationIdentities.current.set(viewerDocumentId, identity);
      setCsvPreparationStates((current) => ({
        ...current,
        [viewerDocumentId]: {
          documentId,
          sessionId,
          status:
            current[viewerDocumentId]?.sessionId === sessionId
              ? current[viewerDocumentId].status
              : null,
          action: "starting",
          requestError: null,
          dismissed: false,
        },
      }));

      const isCurrent = () => {
        const document = documentsRef.current.find(
          (candidate) => candidate.id === viewerDocumentId,
        );
        return (
          csvPreparationTokens.current.get(viewerDocumentId) === token &&
          csvPreparationIdentities.current.get(viewerDocumentId) === identity &&
          document?.documentId === documentId &&
          document.sessionId === sessionId
        );
      };

      const fail = (error: unknown) => {
        if (!isCurrent()) return;
        setCsvPreparationStates((current) => ({
          ...current,
          [viewerDocumentId]: {
            documentId,
            sessionId,
            status: current[viewerDocumentId]?.status ?? null,
            action: null,
            requestError:
              error instanceof Error ? error.message : "CSV preparation status is unavailable.",
            dismissed: false,
          },
        }));
      };

      const accept = (status: CsvPreparationStatus | null): boolean => {
        if (
          !isCurrent() ||
          !status ||
          status.documentId !== documentId ||
          status.sessionId !== sessionId
        )
          return false;
        setCsvPreparationStates((current) => ({
          ...current,
          [viewerDocumentId]: {
            documentId,
            sessionId,
            status,
            action: null,
            requestError: null,
            dismissed: false,
          },
        }));
        return true;
      };

      const poll = () => {
        if (!isCurrent()) return;
        void backend.getCsvPreparationStatus(documentId, sessionId).then((status) => {
          if (!accept(status)) return;
          if (status?.state === "preparing") {
            csvPreparationTimers.current.set(viewerDocumentId, window.setTimeout(poll, 750));
          }
        }, fail);
      };

      void backend.prepareCsvSession(documentId, sessionId).then((status) => {
        if (!accept(status)) return;
        if (status.state === "preparing") {
          csvPreparationTimers.current.set(viewerDocumentId, window.setTimeout(poll, 750));
        }
      }, fail);
    },
    [backend, clearCsvPreparationTask],
  );

  const csvPreparationIdentityKey = documents
    .filter(
      (document) =>
        document.status === "ready" &&
        document.summary?.format === "csv" &&
        document.documentId &&
        document.sessionId,
    )
    .map((document) => `${document.id}\u0000${document.documentId}\u0000${document.sessionId}`)
    .join("\u0001");

  useEffect(() => {
    const eligible = new Map(
      documentsRef.current
        .filter(
          (document) =>
            document.status === "ready" &&
            document.summary?.format === "csv" &&
            document.documentId &&
            document.sessionId,
        )
        .map((document) => [document.id, `${document.documentId!}\u0000${document.sessionId!}`]),
    );
    for (const [viewerDocumentId, identity] of csvPreparationIdentities.current) {
      if (eligible.get(viewerDocumentId) === identity) continue;
      clearCsvPreparationTask(viewerDocumentId);
      csvPreparationIdentities.current.delete(viewerDocumentId);
    }
    setCsvPreparationStates((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([viewerDocumentId, state]) =>
            eligible.get(viewerDocumentId) === `${state.documentId}\u0000${state.sessionId}`,
        ),
      ),
    );
    for (const document of documentsRef.current) {
      if (
        document.status !== "ready" ||
        document.summary?.format !== "csv" ||
        !document.documentId ||
        !document.sessionId
      )
        continue;
      const identity = `${document.documentId}\u0000${document.sessionId}`;
      if (csvPreparationIdentities.current.get(document.id) !== identity) {
        startCsvPreparation(document.id, document.documentId, document.sessionId);
      }
    }
  }, [clearCsvPreparationTask, csvPreparationIdentityKey, startCsvPreparation]);

  useEffect(
    () => () => {
      for (const timer of csvPreparationTimers.current.values()) window.clearTimeout(timer);
      csvPreparationTimers.current.clear();
      csvPreparationTokens.current.clear();
      csvPreparationIdentities.current.clear();
    },
    [],
  );

  useEffect(() => {
    setQueryStates((current) => {
      const next: Record<string, QueryUiState> = {};
      for (const document of documents) {
        if (
          document.status !== "ready" ||
          !document.documentId ||
          !document.sessionId ||
          !document.summary ||
          !hasCapability(document.summary, "queryProvider")
        )
          continue;
        const existing = current[document.id];
        next[document.id] =
          existing?.documentId === document.documentId && existing.sessionId === document.sessionId
            ? existing
            : createQueryUiState(document.documentId, document.sessionId);
      }
      return next;
    });
  }, [documents]);

  function nextRequest(counter: React.MutableRefObject<Map<string, number>>, id: string): number {
    const next = (counter.current.get(id) ?? 0) + 1;
    counter.current.set(id, next);
    return next;
  }

  const registerPathClose = useCallback((path: string, operation: Promise<unknown>) => {
    const key = canonicalPath(path);
    const previous = pathCloseBarriers.current.get(key) ?? Promise.resolve();
    const barrier = Promise.all([previous, operation.catch(() => undefined)]).then(() => undefined);
    pathCloseBarriers.current.set(key, barrier);
    void barrier.finally(() => {
      if (pathCloseBarriers.current.get(key) === barrier) pathCloseBarriers.current.delete(key);
    });
  }, []);

  const finishPendingClose = useCallback((pendingId: string) => {
    closedPendingIds.current.delete(pendingId);
  }, []);

  const cleanupOpenedFile = useCallback(
    (opened: OpenedDataFile) => {
      const identity = `${opened.documentId}\u0000${opened.sessionId}`;
      if (cleanedOpenedIdentities.current.has(identity)) return;
      cleanedOpenedIdentities.current.add(identity);
      const cleanup = backend.closeDataFile(opened.documentId, opened.sessionId);
      registerPathClose(opened.path, cleanup);
      void cleanup
        .finally(() => cleanedOpenedIdentities.current.delete(identity))
        .catch(() => undefined);
    },
    [backend, registerPathClose],
  );

  const resolveDeferredOpened = useCallback(
    (path: string, ownerRequestId: string, retained?: OpenedDataFile) => {
      const key = canonicalPath(path);
      const deferred = deferredOpenedByPath.current.get(key);
      if (!deferred || deferred.ownerRequestId !== ownerRequestId) return;
      deferredOpenedByPath.current.delete(key);
      if (
        !retained ||
        deferred.opened.documentId !== retained.documentId ||
        deferred.opened.sessionId !== retained.sessionId
      ) {
        cleanupOpenedFile(deferred.opened);
      }
    },
    [cleanupOpenedFile],
  );

  useEffect(() => {
    let active = true;
    Promise.all([backend.healthCheck(), backend.listSupportedFormats()]).then(
      ([health, formats]) => {
        if (!active) return;
        setFormatCatalog(formats);
        setBackendState({ kind: "connected", health });
      },
      (error: unknown) =>
        active && setBackendState({ kind: "error", message: toOpenFileError(error).message }),
    );
    backend.getSettings().then(
      (settings) => {
        if (!active) return;
        setAppSettings(settings);
        setSettingsWarning(null);
        setSettingsLoaded(true);
      },
      (error: unknown) => {
        if (!active) return;
        setAppSettings(defaultAppSettings());
        setSettingsWarning(
          `Settings could not be loaded. Defaults are in use. ${toOpenFileError(error).message}`,
        );
        setSettingsLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, [backend]);

  useEffect(
    () => () => {
      documentsRef.current.forEach((document) => {
        if (document.documentId && document.sessionId) {
          void backend
            .closeDataFile(document.documentId, document.sessionId)
            .catch(() => undefined);
        }
      });
      deferredOpenedByPath.current.forEach(({ opened }) => {
        void backend.closeDataFile(opened.documentId, opened.sessionId).catch(() => undefined);
      });
      deferredOpenedByPath.current.clear();
    },
    [backend],
  );

  useEffect(() => {
    const timers = documents.flatMap((document) => {
      const currentSummary = document.summary;
      if (
        !document.documentId ||
        !document.sessionId ||
        !currentSummary ||
        !hasCapability(currentSummary, "backgroundRowCount") ||
        document.isConfiguringCsv ||
        document.isCancellingCsv ||
        currentSummary.rowCountStatus.state !== "calculating"
      )
        return [];
      const generation = currentSummary.rowCountStatus.generation;
      const requestId = nextRequest(pollRequests, document.id);
      return [
        window.setTimeout(() => {
          void backend.getDataFileStatus(document.documentId!, document.sessionId!).then(
            (raw) => {
              const response = normalizedSummaryResponse(raw, document.documentId!);
              const nextSummary = response.summary;
              if (
                pollRequests.current.get(document.id) === requestId &&
                response.documentId === document.documentId &&
                response.sessionId === document.sessionId &&
                nextSummary.rowCountStatus.generation === generation
              )
                updateDocument(document.id, (current) => ({ ...current, summary: nextSummary }));
            },
            (error: unknown) => {
              if (pollRequests.current.get(document.id) === requestId) {
                updateDocument(document.id, (current) => ({
                  ...current,
                  error: toOpenFileError(error),
                }));
              }
            },
          );
        }, 250),
      ];
    });
    return () => timers.forEach(window.clearTimeout);
  }, [backend, documents, updateDocument]);

  const applyOpenResponse = useCallback(
    (response: OpenDataResponse, request: OpenDataRequest) => {
      if (response.requestId !== request.requestId || response.origin !== request.origin) {
        throw new DataViewerError(
          "InvalidResponse",
          "The open response does not match its request.",
        );
      }
      response.opened.forEach((opened) => validateInitialPage(opened.summary, opened.initialPage));
      const pendingPrefix = `pending:${request.requestId}:`;
      const acceptedOpened = response.opened.filter(
        (opened) => !closedPendingIds.current.has(`${pendingPrefix}${opened.itemIndex}`),
      );
      const discardedFailureIds = new Set(
        response.failures
          .map((failure) => `${pendingPrefix}${failure.itemIndex}`)
          .filter((pendingId) => closedPendingIds.current.has(pendingId)),
      );
      acceptedOpened.forEach((opened) =>
        resolveDeferredOpened(opened.path, request.requestId, opened),
      );
      response.failures.forEach((failure) => {
        if (!discardedFailureIds.has(`${pendingPrefix}${failure.itemIndex}`)) {
          resolveDeferredOpened(failure.path, request.requestId);
        }
      });
      response.opened
        .filter((opened) => closedPendingIds.current.has(`${pendingPrefix}${opened.itemIndex}`))
        .forEach((opened) => {
          const pendingId = `${pendingPrefix}${opened.itemIndex}`;
          const retained = documentsRef.current.some(
            (document) =>
              document.documentId === opened.documentId && document.sessionId === opened.sessionId,
          );
          if (retained) {
            finishPendingClose(pendingId);
            return;
          }
          const reopenOwner = documentsRef.current.find(
            (document) =>
              document.status === "loading" &&
              document.openRequestId !== null &&
              document.openRequestId !== request.requestId &&
              canonicalPath(document.path) === canonicalPath(opened.path),
          );
          if (reopenOwner?.openRequestId) {
            const key = canonicalPath(opened.path);
            const previous = deferredOpenedByPath.current.get(key);
            if (
              previous &&
              (previous.opened.documentId !== opened.documentId ||
                previous.opened.sessionId !== opened.sessionId)
            ) {
              cleanupOpenedFile(previous.opened);
            }
            deferredOpenedByPath.current.set(key, {
              ownerRequestId: reopenOwner.openRequestId,
              opened,
            });
          } else {
            cleanupOpenedFile(opened);
          }
          finishPendingClose(pendingId);
        });
      response.failures.forEach((failure) => {
        const pendingId = `${pendingPrefix}${failure.itemIndex}`;
        if (discardedFailureIds.has(pendingId)) finishPendingClose(pendingId);
      });
      setDocuments((current) => {
        let next = current;
        for (const opened of acceptedOpened) {
          const pendingId = `${pendingPrefix}${opened.itemIndex}`;
          const existing = next.find((document) => document.documentId === opened.documentId);
          if (existing) {
            next = next.filter((document) => document.id !== pendingId);
            continue;
          }
          const ready: ViewerDocument = {
            id: opened.documentId,
            openRequestId: null,
            documentId: opened.documentId,
            sessionId: opened.sessionId,
            path: opened.path,
            label: opened.summary.fileName,
            status: "ready",
            summary: opened.summary,
            page: opened.initialPage,
            activeTab: "data",
            isPageLoading: false,
            isConfiguringCsv: false,
            isCancellingCsv: false,
            error: null,
          };
          const pendingIndex = next.findIndex((document) => document.id === pendingId);
          next =
            pendingIndex >= 0
              ? next.map((document, index) => (index === pendingIndex ? ready : document))
              : [...next, ready];
        }
        for (const failure of response.failures) {
          const pendingId = `${pendingPrefix}${failure.itemIndex}`;
          if (discardedFailureIds.has(pendingId)) continue;
          const failed: ViewerDocument = {
            id: pendingId,
            openRequestId: request.requestId,
            documentId: null,
            sessionId: null,
            path: failure.path,
            label: fileNameFromPath(failure.path),
            status: "error",
            summary: null,
            page: null,
            activeTab: "data",
            isPageLoading: false,
            isConfiguringCsv: false,
            isCancellingCsv: false,
            error: { ...failure.error, retry: { kind: "open" } },
          };
          const pendingIndex = next.findIndex((document) => document.id === pendingId);
          next =
            pendingIndex >= 0
              ? next.map((document, index) => (index === pendingIndex ? failed : document))
              : [...next, failed];
        }
        return next;
      });
      const requestedTarget = acceptedOpened.find(
        (opened) => opened.documentId === response.activeDocumentId,
      );
      const target = requestedTarget?.documentId ?? acceptedOpened[0]?.documentId;
      if (target) setActiveDocumentId(target);
      else if (response.failures.length > 0) {
        const firstVisibleFailure = response.failures.find(
          (failure) => !discardedFailureIds.has(`${pendingPrefix}${failure.itemIndex}`),
        );
        if (firstVisibleFailure)
          setActiveDocumentId(
            (current) => current ?? `${pendingPrefix}${firstVisibleFailure.itemIndex}`,
          );
      }
    },
    [cleanupOpenedFile, finishPendingClose, resolveDeferredOpened],
  );

  const openPaths = useCallback(
    async (request: OpenDataRequest) => {
      if (consumedPathRequestIds.current.has(request.requestId)) return;
      consumedPathRequestIds.current.add(request.requestId);
      if (request.paths.length > 0) {
        const placeholders = request.paths.map<ViewerDocument>((path, itemIndex) => ({
          id: `pending:${request.requestId}:${itemIndex}`,
          openRequestId: request.requestId,
          documentId: null,
          sessionId: null,
          path,
          label: fileNameFromPath(path),
          status: "loading",
          summary: null,
          page: null,
          activeTab: "data",
          isPageLoading: false,
          isConfiguringCsv: false,
          isCancellingCsv: false,
          error: null,
        }));
        setDocuments((current) => [...current, ...placeholders]);
        setActiveDocumentId((current) => current ?? placeholders[0]?.id ?? null);
      }
      setOpeningCount((count) => count + 1);
      setGlobalError(null);
      try {
        const closeBarriers = request.paths.flatMap((path) => {
          const barrier = pathCloseBarriers.current.get(canonicalPath(path));
          return barrier ? [barrier] : [];
        });
        if (closeBarriers.length > 0) await Promise.all(closeBarriers);
        const raw = await backend.openDataFile(request);
        const response = normalizedOpenResponse(raw);
        try {
          applyOpenResponse(response, request);
        } catch (error) {
          response.opened.forEach(
            (opened) =>
              void backend
                .closeDataFile(opened.documentId, opened.sessionId)
                .catch(() => undefined),
          );
          throw error;
        }
      } catch (error) {
        const nextError = toOpenFileError(error);
        request.paths.forEach((path, itemIndex) => {
          resolveDeferredOpened(path, request.requestId);
          const pendingId = `pending:${request.requestId}:${itemIndex}`;
          if (closedPendingIds.current.has(pendingId)) finishPendingClose(pendingId);
        });
        if (request.paths.length > 0) {
          setDocuments((current) =>
            current.map((document) =>
              document.id.startsWith(`pending:${request.requestId}:`)
                ? { ...document, status: "error", error: nextError }
                : document,
            ),
          );
        } else {
          setGlobalError(nextError);
        }
      } finally {
        if (!cancelledOpeningRequestIds.current.delete(request.requestId)) {
          setOpeningCount((count) => Math.max(0, count - 1));
        }
      }
    },
    [applyOpenResponse, backend, finishPendingClose, resolveDeferredOpened],
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    const reportAdapterError = (error: DataViewerError) => {
      if (active) setGlobalError(toOpenFileError(error));
    };
    const subscription = backend.onOpenDataRequest((request) => {
      if (active) void openPaths(request);
    }, reportAdapterError);
    void subscription.then(
      (nextUnlisten) => {
        if (active) unlisten = nextUnlisten;
        else nextUnlisten();
      },
      (error: unknown) => {
        if (active) setGlobalError(toOpenFileError(error));
      },
    );
    queueMicrotask(() => {
      if (!active) return;
      void backend.takePendingOpenRequests().then(
        (requests) => {
          if (!active) return;
          requests.forEach((request) => void openPaths(request));
        },
        (error: unknown) => {
          if (active) setGlobalError(toOpenFileError(error));
        },
      );
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [backend, openPaths]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void dragDropAdapter
      .onDragDropEvent((event: FileDragDropEvent) => {
        if (!active) return;
        if (isInternalPointerReorderActive()) return;
        if (event.type === "enter") {
          if (event.paths.length === 0) return;
          externalDragSession.current = true;
          setDropTarget({ paths: event.paths });
        } else if (event.type === "over") {
          return;
        } else if (event.type === "leave") {
          externalDragSession.current = false;
          setDropTarget(null);
        } else {
          const shouldOpen = event.paths.length > 0;
          externalDragSession.current = false;
          setDropTarget(null);
          if (shouldOpen) {
            void openPaths({
              requestId: `frontend-dragDrop-${++pathRequestSequence.current}`,
              origin: "dragDrop",
              paths: event.paths,
            });
          }
        }
      })
      .then(
        (nextUnlisten) => {
          if (active) unlisten = nextUnlisten;
          else nextUnlisten();
        },
        (error: unknown) => {
          if (active) setGlobalError(toOpenFileError(error));
        },
      );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [dragDropAdapter, openPaths]);

  useEffect(() => {
    if (!dropTarget) return;
    const dismissDropTarget = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDropTarget(null);
    };
    window.addEventListener("keydown", dismissDropTarget);
    return () => window.removeEventListener("keydown", dismissDropTarget);
  }, [dropTarget]);

  async function openFile() {
    const requestId = `frontend-dialog-${++pathRequestSequence.current}`;
    const request: OpenDataRequest = { requestId, origin: "dialog", paths: [] };
    setOpeningCount((count) => count + 1);
    setGlobalError(null);
    try {
      const raw = await backend.selectDataFilePath(requestId);
      if (raw !== null) {
        const response = normalizedOpenResponse(raw);
        try {
          applyOpenResponse(response, request);
        } catch (error) {
          response.opened.forEach(
            (opened) =>
              void backend
                .closeDataFile(opened.documentId, opened.sessionId)
                .catch(() => undefined),
          );
          throw error;
        }
      }
    } catch (error) {
      setGlobalError(toOpenFileError(error));
    } finally {
      setOpeningCount((count) => Math.max(0, count - 1));
    }
  }

  async function loadPage(document: ViewerDocument, offset: number) {
    if (
      !document.documentId ||
      !document.sessionId ||
      !document.summary ||
      !document.page ||
      offset < 0 ||
      offset === document.page.offset
    )
      return;
    const requestId = nextRequest(pageRequests, document.id);
    const query = queryStates[document.id];
    updateDocument(document.id, (current) => ({ ...current, isPageLoading: true, error: null }));
    try {
      const nextPage = query?.queryId
        ? (
            await backend.readQueryPage({
              documentId: document.documentId,
              sessionId: document.sessionId,
              queryId: query.queryId,
              offset,
              limit: document.page.limit,
              columns: queryPageProjection(document.page.columns, query.resultColumns),
            })
          ).page
        : await backend.readPage({
            documentId: document.documentId,
            sessionId: document.sessionId,
            offset,
            limit: document.page.limit,
          });
      if (pageRequests.current.get(document.id) !== requestId) return;
      if (
        nextPage.sessionId !== document.sessionId ||
        nextPage.offset !== offset ||
        (!query?.queryId &&
          document.summary.rowCount !== null &&
          nextPage.totalRows !== null &&
          nextPage.totalRows !== document.summary.rowCount)
      ) {
        throw new DataViewerError("InvalidResponse", "The page does not match its document.");
      }
      updateDocument(document.id, (current) => ({ ...current, page: nextPage }));
    } catch (error) {
      if (pageRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({
          ...current,
          error: toOpenFileError(error, { kind: "page", offset }),
        }));
    } finally {
      if (pageRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({ ...current, isPageLoading: false }));
    }
  }

  async function configureCsv(document: ViewerDocument, headerMode: CsvHeaderMode) {
    if (
      !document.documentId ||
      !document.sessionId ||
      !document.summary ||
      !document.summary.csvMetadata ||
      document.summary.csvMetadata?.headerMode === headerMode
    )
      return;
    const requestId = nextRequest(statusRequests, document.id);
    nextRequest(pageRequests, document.id);
    nextRequest(queryRequests, document.id);
    updateDocument(document.id, (current) => ({ ...current, isConfiguringCsv: true, error: null }));
    try {
      const raw = await backend.configureCsv(document.documentId, document.sessionId, headerMode);
      const response = normalizedSummaryResponse(raw, document.documentId);
      const nextSummary = response.summary;
      if (statusRequests.current.get(document.id) !== requestId) return;
      if (
        response.documentId !== document.documentId ||
        nextSummary.sessionId !== response.sessionId ||
        !nextSummary.csvMetadata ||
        nextSummary.csvMetadata.headerMode !== headerMode
      )
        throw new DataViewerError(
          "InvalidResponse",
          "The CSV configuration does not match its document.",
        );
      updateDocument(document.id, (current) => ({ ...current, sessionId: response.sessionId }));
      const nextPage = await backend.readPage({
        documentId: document.documentId,
        sessionId: response.sessionId,
        offset: 0,
        limit: document.page?.limit ?? 200,
      });
      if (statusRequests.current.get(document.id) !== requestId) return;
      updateDocument(document.id, (current) => ({
        ...current,
        sessionId: response.sessionId,
        summary: nextSummary,
        page: nextPage,
      }));
    } catch (error) {
      if (statusRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({ ...current, error: toOpenFileError(error) }));
    } finally {
      if (statusRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({ ...current, isConfiguringCsv: false }));
    }
  }

  function csvStructuralError(summary: FileSummary): string | null {
    const count = summary.csvMetadata?.structureIssueCount ?? 0;
    return count > 0
      ? `${count.toLocaleString()} structural CSV row issue${count === 1 ? "" : "s"} must be resolved before applying a typed profile.`
      : null;
  }

  async function openCsvProfile(document: ViewerDocument) {
    if (
      !document.documentId ||
      !document.sessionId ||
      !document.summary ||
      !hasCapability(document.summary, "parsingProfile")
    )
      return;
    const requestId = nextRequest(csvProfileRequests, `load:${document.id}`);
    setCsvProfileDialogDocumentId(document.id);
    setCsvProfileLoadingDocumentId(document.id);
    try {
      const response = await backend.getCsvProfile(document.documentId, document.sessionId);
      if (
        csvProfileRequests.current.get(`load:${document.id}`) !== requestId ||
        response.documentId !== document.documentId ||
        response.sessionId !== document.sessionId
      )
        return;
      setCsvProfileModes((current) => ({ ...current, [document.id]: response.profile.mode }));
      setCsvProfiles((current) => ({
        ...current,
        [document.id]: {
          identity: { documentId: response.documentId, sessionId: response.sessionId },
          wireProfile: response.profile,
          columns: wireProfileToColumns(response.profile),
          preview: null,
          validation: null,
          validationWire: null,
          isApplying: false,
          error: null,
          structuralError: csvStructuralError(document.summary!),
        },
      }));
    } catch (error) {
      if (csvProfileRequests.current.get(`load:${document.id}`) === requestId) {
        setCsvProfileDialogDocumentId(null);
        updateDocument(document.id, (current) => ({ ...current, error: toOpenFileError(error) }));
      }
    } finally {
      if (csvProfileRequests.current.get(`load:${document.id}`) === requestId) {
        setCsvProfileLoadingDocumentId(null);
      }
    }
  }

  function closeCsvProfile(documentId: string) {
    csvProfileRequests.current.set(
      `preview:${documentId}`,
      (csvProfileRequests.current.get(`preview:${documentId}`) ?? 0) + 1,
    );
    csvValidationPolls.current.set(
      documentId,
      (csvValidationPolls.current.get(documentId) ?? 0) + 1,
    );
    const profile = csvProfiles[documentId];
    if (
      profile?.validationWire &&
      (profile.validationWire.state === "queued" || profile.validationWire.state === "running")
    ) {
      void backend
        .cancelCsvProfileValidation(
          profile.identity.documentId,
          profile.identity.sessionId,
          profile.validationWire.taskId,
        )
        .catch(() => undefined);
    }
    setCsvProfileDialogDocumentId(null);
    setCsvProfileLoadingDocumentId(null);
    setCsvProfiles((current) => {
      const next = { ...current };
      delete next[documentId];
      return next;
    });
  }

  async function previewCsvProfile(documentId: string, request: CsvProfileRequest) {
    const state = csvProfiles[documentId];
    if (!state || request.sessionId !== state.identity.sessionId) return;
    const requestId = nextRequest(csvProfileRequests, `preview:${documentId}`);
    try {
      const response = await backend.previewCsvProfile({
        documentId: state.identity.documentId,
        sessionId: state.identity.sessionId,
        generation: request.generation,
        profile: uiRequestToWireProfile(request, state.wireProfile),
      });
      if (
        csvProfileRequests.current.get(`preview:${documentId}`) !== requestId ||
        csvProfileDialogDocumentId !== documentId ||
        response.documentId !== state.identity.documentId ||
        response.sessionId !== state.identity.sessionId ||
        response.preview.generation !== request.generation
      )
        return;
      setCsvProfiles((current) => {
        const active = current[documentId];
        if (!active || active.identity.sessionId !== response.sessionId) return current;
        return {
          ...current,
          [documentId]: {
            ...active,
            preview: wirePreviewToUi(response),
            error: null,
          },
        };
      });
    } catch (error) {
      if (csvProfileRequests.current.get(`preview:${documentId}`) === requestId) {
        setCsvProfiles((current) =>
          current[documentId]
            ? {
                ...current,
                [documentId]: {
                  ...current[documentId],
                  error: toOpenFileError(error).message,
                },
              }
            : current,
        );
      }
    }
  }

  function scheduleCsvValidationPoll(
    documentId: string,
    identity: { documentId: string; sessionId: string },
    taskId: string,
    generation: number,
    token: number,
  ) {
    window.setTimeout(() => {
      if (csvValidationPolls.current.get(documentId) !== token) return;
      void backend
        .getCsvProfileValidationStatus(identity.documentId, identity.sessionId, taskId)
        .then(
          (status) => {
            if (
              csvValidationPolls.current.get(documentId) !== token ||
              status.documentId !== identity.documentId ||
              status.sessionId !== identity.sessionId ||
              status.generation !== generation
            )
              return;
            setCsvProfiles((current) =>
              current[documentId]
                ? {
                    ...current,
                    [documentId]: {
                      ...current[documentId],
                      validation: wireValidationToUi(status),
                      validationWire: status,
                    },
                  }
                : current,
            );
            if (status.state === "queued" || status.state === "running") {
              scheduleCsvValidationPoll(documentId, identity, taskId, generation, token);
            }
          },
          (error: unknown) => {
            if (csvValidationPolls.current.get(documentId) !== token) return;
            setCsvProfiles((current) =>
              current[documentId]
                ? {
                    ...current,
                    [documentId]: {
                      ...current[documentId],
                      error: toOpenFileError(error).message,
                    },
                  }
                : current,
            );
          },
        );
    }, 150);
  }

  async function validateCsvProfile(documentId: string, request: CsvProfileRequest) {
    const state = csvProfiles[documentId];
    if (!state || request.sessionId !== state.identity.sessionId) return;
    const taskId = `frontend-csv-validation-${Date.now()}-${++pathRequestSequence.current}`;
    const token = (csvValidationPolls.current.get(documentId) ?? 0) + 1;
    csvValidationPolls.current.set(documentId, token);
    try {
      const status = await backend.validateCsvProfile({
        taskId,
        documentId: state.identity.documentId,
        sessionId: state.identity.sessionId,
        generation: request.generation,
        profile: uiRequestToWireProfile(request, state.wireProfile),
      });
      if (csvValidationPolls.current.get(documentId) !== token) return;
      setCsvProfiles((current) =>
        current[documentId]
          ? {
              ...current,
              [documentId]: {
                ...current[documentId],
                validation: wireValidationToUi(status),
                validationWire: status,
                error: null,
              },
            }
          : current,
      );
      if (status.state === "queued" || status.state === "running") {
        scheduleCsvValidationPoll(documentId, state.identity, taskId, request.generation, token);
      }
    } catch (error) {
      setCsvProfiles((current) =>
        current[documentId]
          ? {
              ...current,
              [documentId]: { ...current[documentId], error: toOpenFileError(error).message },
            }
          : current,
      );
    }
  }

  async function cancelCsvProfileValidation(documentId: string) {
    const state = csvProfiles[documentId];
    const status = state?.validationWire;
    if (!state || !status) return;
    csvValidationPolls.current.set(
      documentId,
      (csvValidationPolls.current.get(documentId) ?? 0) + 1,
    );
    try {
      const cancelled = await backend.cancelCsvProfileValidation(
        state.identity.documentId,
        state.identity.sessionId,
        status.taskId,
      );
      setCsvProfiles((current) =>
        current[documentId]
          ? {
              ...current,
              [documentId]: {
                ...current[documentId],
                validation: wireValidationToUi(cancelled),
                validationWire: cancelled,
              },
            }
          : current,
      );
    } catch (error) {
      setCsvProfiles((current) =>
        current[documentId]
          ? {
              ...current,
              [documentId]: { ...current[documentId], error: toOpenFileError(error).message },
            }
          : current,
      );
    }
  }

  async function commitCsvProfile(
    document: ViewerDocument,
    wireProfile: CsvParsingProfileWire,
    mode: CsvProfileMode,
  ) {
    if (!document.documentId || !document.sessionId) return;
    const previousQuery = queryStatesRef.current[document.id];
    const requestId = nextRequest(statusRequests, document.id);
    nextRequest(pageRequests, document.id);
    nextRequest(queryRequests, document.id);
    setCsvProfiles((current) =>
      current[document.id]
        ? {
            ...current,
            [document.id]: { ...current[document.id], isApplying: true, error: null },
          }
        : current,
    );
    try {
      const response = await backend.applyCsvProfile({
        documentId: document.documentId,
        sessionId: document.sessionId,
        profile: wireProfile,
      });
      if (
        statusRequests.current.get(document.id) !== requestId ||
        response.documentId !== document.documentId ||
        response.sessionId === document.sessionId
      )
        return;
      const nextPage = await backend.readPage({
        documentId: response.documentId,
        sessionId: response.sessionId,
        offset: 0,
        limit: document.page?.limit ?? 200,
      });
      if (statusRequests.current.get(document.id) !== requestId) return;
      validateInitialPage(response.summary, nextPage);
      const compatibility = compatibleQueryPlan(
        previousQuery?.draftPlan ?? EMPTY_QUERY_PLAN,
        response.summary,
      );
      const nextDocument: ViewerDocument = {
        ...document,
        sessionId: response.sessionId,
        summary: response.summary,
        page: nextPage,
        error: compatibility.adjustmentReason
          ? {
              code: "QueryPlanAdjusted",
              message: compatibility.adjustmentReason,
              retry: { kind: "open" },
            }
          : null,
      };
      setQueryStates((current) => ({
        ...current,
        [document.id]: replaceQueryUiSession(
          current[document.id] ?? previousQuery,
          response.documentId,
          response.sessionId,
          compatibility.plan,
        ),
      }));
      updateDocument(document.id, (current) => ({
        ...current,
        sessionId: response.sessionId,
        summary: response.summary,
        page: nextPage,
        error: nextDocument.error,
      }));
      setCsvProfileModes((current) => ({ ...current, [document.id]: mode }));
      setCsvProfileDialogDocumentId(null);
      setCsvProfiles((current) => {
        const next = { ...current };
        delete next[document.id];
        return next;
      });
      if (previousQuery && queryPlanHasWork(compatibility.plan)) {
        window.setTimeout(() => executeDocumentQuery(nextDocument, compatibility.plan, true), 0);
      }
    } catch (error) {
      if (statusRequests.current.get(document.id) === requestId) {
        setCsvProfiles((current) =>
          current[document.id]
            ? {
                ...current,
                [document.id]: {
                  ...current[document.id],
                  isApplying: false,
                  error: toOpenFileError(error).message,
                },
              }
            : current,
        );
        updateDocument(document.id, (current) => ({ ...current, error: toOpenFileError(error) }));
      }
    }
  }

  function applyCsvProfile(document: ViewerDocument, request: CsvProfileRequest) {
    const state = csvProfiles[document.id];
    if (!state) return;
    const validation = state.validation;
    if (
      matchesCurrentGeneration(validation, state.identity, request.generation) &&
      (validation!.state === "running" ||
        (validation!.invalid > 0 && !request.validationAcknowledged))
    ) {
      setCsvProfiles((current) => ({
        ...current,
        [document.id]: {
          ...current[document.id],
          error:
            validation!.state === "running"
              ? "Wait for full-file validation to finish before applying."
              : "Review and acknowledge the full-file validation failures before applying.",
        },
      }));
      return;
    }
    void commitCsvProfile(document, uiRequestToWireProfile(request, state.wireProfile), "custom");
  }

  useEffect(() => {
    if (!settingsLoaded) return;
    for (const document of documents) {
      if (
        document.status !== "ready" ||
        !document.documentId ||
        !document.sessionId ||
        !document.summary ||
        !hasCapability(document.summary, "parsingProfile") ||
        csvDefaultsHandled.current.has(document.id)
      )
        continue;
      csvDefaultsHandled.current.add(document.id);
      const mode = appSettingsRef.current.csvDefaultParsingMode;
      if (mode === "auto") {
        setCsvProfileModes((current) => ({ ...current, [document.id]: "auto" }));
        continue;
      }
      const requestId = nextRequest(statusRequests, document.id);
      if (mode === "askEveryTime") {
        setCsvProfileDialogDocumentId(document.id);
        setCsvProfileLoadingDocumentId(document.id);
        void backend.getCsvProfile(document.documentId, document.sessionId).then(
          (response) => {
            if (
              statusRequests.current.get(document.id) !== requestId ||
              response.documentId !== document.documentId ||
              response.sessionId !== document.sessionId
            )
              return;
            setCsvProfileModes((current) => ({ ...current, [document.id]: "auto" }));
            setCsvProfiles((current) => ({
              ...current,
              [document.id]: {
                identity: { documentId: response.documentId, sessionId: response.sessionId },
                wireProfile: response.profile,
                columns: wireProfileToColumns(response.profile),
                preview: null,
                validation: null,
                validationWire: null,
                isApplying: false,
                error: null,
                structuralError: csvStructuralError(document.summary!),
              },
            }));
            setCsvProfileLoadingDocumentId(null);
          },
          (error: unknown) => {
            if (statusRequests.current.get(document.id) !== requestId) return;
            setCsvProfileDialogDocumentId(null);
            setCsvProfileLoadingDocumentId(null);
            updateDocument(document.id, (current) => ({
              ...current,
              error: toOpenFileError(error),
            }));
          },
        );
        continue;
      }
      nextRequest(pageRequests, document.id);
      void backend
        .getCsvProfile(document.documentId, document.sessionId)
        .then(
          async (response) => {
            if (
              statusRequests.current.get(document.id) !== requestId ||
              response.documentId !== document.documentId ||
              response.sessionId !== document.sessionId
            )
              return;
            const profile: CsvParsingProfileWire = {
              ...response.profile,
              mode: "allText",
              generation: response.profile.generation + 1,
              columns: response.profile.columns.map((column) => ({
                ...column,
                targetType: "text",
              })),
            };
            const applied = await backend.applyCsvProfile({
              documentId: response.documentId,
              sessionId: response.sessionId,
              profile,
            });
            if (
              statusRequests.current.get(document.id) !== requestId ||
              applied.documentId !== document.documentId ||
              applied.sessionId === document.sessionId
            )
              return;
            const nextPage = await backend.readPage({
              documentId: applied.documentId,
              sessionId: applied.sessionId,
              offset: 0,
              limit: document.page?.limit ?? 200,
            });
            if (statusRequests.current.get(document.id) !== requestId) return;
            validateInitialPage(applied.summary, nextPage);
            const previousQuery = queryStatesRef.current[document.id];
            nextRequest(queryRequests, document.id);
            const compatibility = compatibleQueryPlan(
              previousQuery?.draftPlan ?? EMPTY_QUERY_PLAN,
              applied.summary,
            );
            const nextDocument: ViewerDocument = {
              ...document,
              sessionId: applied.sessionId,
              summary: applied.summary,
              page: nextPage,
              error: compatibility.adjustmentReason
                ? {
                    code: "QueryPlanAdjusted",
                    message: compatibility.adjustmentReason,
                    retry: { kind: "open" },
                  }
                : null,
            };
            setQueryStates((current) => ({
              ...current,
              [document.id]: replaceQueryUiSession(
                current[document.id] ?? previousQuery,
                applied.documentId,
                applied.sessionId,
                compatibility.plan,
              ),
            }));
            updateDocument(document.id, (current) => ({
              ...current,
              sessionId: applied.sessionId,
              summary: applied.summary,
              page: nextPage,
              error: nextDocument.error,
            }));
            setCsvProfileModes((current) => ({ ...current, [document.id]: "allText" }));
            if (previousQuery && queryPlanHasWork(compatibility.plan)) {
              window.setTimeout(
                () => executeDocumentQueryRef.current(nextDocument, compatibility.plan, true),
                0,
              );
            }
          },
          (error: unknown) => {
            if (statusRequests.current.get(document.id) === requestId) {
              updateDocument(document.id, (current) => ({
                ...current,
                error: toOpenFileError(error),
              }));
            }
          },
        )
        .catch((error: unknown) => {
          if (statusRequests.current.get(document.id) === requestId) {
            updateDocument(document.id, (current) => ({
              ...current,
              error: toOpenFileError(error),
            }));
          }
        });
    }
  }, [backend, documents, settingsLoaded, updateDocument]);

  function updateQueryState(documentId: string, update: (state: QueryUiState) => QueryUiState) {
    setQueryStates((current) =>
      current[documentId] ? { ...current, [documentId]: update(current[documentId]) } : current,
    );
  }

  function queryProgress(status: QueryStatusResponse): QueryProgress {
    return { ...status.progress };
  }

  function queryResponseIsCurrent(
    documentId: string,
    token: number,
    identity: { documentId: string; sessionId: string },
  ): boolean {
    const document = documentsRef.current.find((candidate) => candidate.id === documentId);
    return Boolean(
      queryRequests.current.get(documentId) === token &&
      document?.documentId === identity.documentId &&
      document.sessionId === identity.sessionId,
    );
  }

  async function handleQueryStatus(
    document: ViewerDocument,
    plan: QueryPlan,
    queryId: string,
    taskId: string,
    token: number,
    status: QueryStatusResponse,
  ) {
    const identity = { documentId: document.documentId!, sessionId: document.sessionId! };
    if (
      !queryResponseIsCurrent(document.id, token, identity) ||
      status.documentId !== identity.documentId ||
      status.sessionId !== identity.sessionId ||
      status.queryId !== queryId ||
      status.taskId !== taskId
    )
      return;
    if (status.state === "queued" || status.state === "running" || status.state === "cancelling") {
      updateQueryState(document.id, (current) => ({
        ...current,
        status:
          status.state === "queued"
            ? "queued"
            : status.state === "cancelling"
              ? "cancelling"
              : "running",
        progress: queryProgress(status),
      }));
      window.setTimeout(() => {
        if (!queryResponseIsCurrent(document.id, token, identity)) return;
        void backend.getQueryStatus(identity.documentId, identity.sessionId, queryId, taskId).then(
          (next) => void handleQueryStatus(document, plan, queryId, taskId, token, next),
          (error: unknown) => {
            if (!queryResponseIsCurrent(document.id, token, identity)) return;
            const normalized = toOpenFileError(error);
            updateQueryState(document.id, (current) => ({
              ...current,
              taskId: null,
              pendingQueryId: null,
              status: "failed",
              progress: null,
              errorCode: normalized.code,
              error: normalized.message,
            }));
          },
        );
      }, 150);
      return;
    }
    if (status.state === "complete") {
      try {
        const response = await backend.readQueryPage({
          ...identity,
          queryId,
          offset: 0,
          limit: document.page?.limit ?? 200,
          columns: queryPageProjection(status.columns, []),
        });
        if (!queryResponseIsCurrent(document.id, token, identity)) return;
        updateDocument(document.id, (current) => ({
          ...current,
          page: response.page,
          error: current.error?.code === "QueryPlanAdjusted" ? current.error : null,
        }));
        updateQueryState(document.id, (current) => ({
          ...current,
          draftPlan: plan,
          committedPlan: plan,
          queryId,
          pendingQueryId: null,
          taskId: null,
          status: "idle",
          progress: null,
          error: null,
          errorCode: null,
          resultColumns: [...status.columns],
          findMatchCount: status.findMatchCount,
          findTarget: null,
          distinct: {},
        }));
      } catch (error) {
        if (!queryResponseIsCurrent(document.id, token, identity)) return;
        const normalized = toOpenFileError(error);
        updateQueryState(document.id, (current) => ({
          ...current,
          taskId: null,
          pendingQueryId: null,
          status: "failed",
          progress: null,
          errorCode: normalized.code,
          error: normalized.message,
        }));
      }
      return;
    }
    if (status.state === "failed") {
      updateQueryState(document.id, (current) => ({
        ...current,
        taskId: null,
        pendingQueryId: null,
        status: "failed",
        progress: null,
        errorCode: status.error?.code ?? "QueryFailed",
        error: status.error?.message ?? "The query failed.",
      }));
      return;
    }
    updateQueryState(document.id, (current) => ({
      ...current,
      taskId: null,
      pendingQueryId: null,
      status: "idle",
      progress: null,
      error: null,
      errorCode: null,
    }));
  }

  function executeDocumentQuery(
    document: ViewerDocument,
    plan: QueryPlan,
    skipPreviousCancel = false,
  ) {
    if (!document.documentId || !document.sessionId || !document.summary) return;
    const current = queryStatesRef.current[document.id];
    if (!current && !skipPreviousCancel) return;
    if (!skipPreviousCancel && current.taskId && current.pendingQueryId) {
      void backend
        .cancelQuery(current.documentId, current.sessionId, current.pendingQueryId, current.taskId)
        .catch(() => undefined);
    }
    const queryId = `frontend-query-${Date.now()}-${++querySequence.current}`;
    const taskId = `frontend-query-task-${Date.now()}-${querySequence.current}`;
    const token = nextRequest(queryRequests, document.id);
    updateQueryState(document.id, (state) => ({
      ...state,
      draftPlan: plan,
      pendingQueryId: queryId,
      taskId,
      status: "queued",
      progress: null,
      error: null,
      errorCode: null,
      findTarget: null,
    }));
    void backend
      .executeQuery({
        documentId: document.documentId,
        sessionId: document.sessionId,
        queryId,
        taskId,
        plan,
      })
      .then(
        (status) => void handleQueryStatus(document, plan, queryId, taskId, token, status),
        (error: unknown) => {
          const identity = { documentId: document.documentId!, sessionId: document.sessionId! };
          if (!queryResponseIsCurrent(document.id, token, identity)) return;
          const normalized = toOpenFileError(error);
          updateQueryState(document.id, (state) => ({
            ...state,
            taskId: null,
            pendingQueryId: null,
            status: "failed",
            progress: null,
            errorCode: normalized.code,
            error: normalized.message,
          }));
        },
      );
  }

  executeDocumentQueryRef.current = executeDocumentQuery;

  function cancelDocumentQuery(document: ViewerDocument) {
    const state = queryStates[document.id];
    if (!state?.taskId || !state.pendingQueryId) return;
    const token = queryRequests.current.get(document.id) ?? 0;
    updateQueryState(document.id, (current) => ({ ...current, status: "cancelling" }));
    void backend
      .cancelQuery(state.documentId, state.sessionId, state.pendingQueryId, state.taskId)
      .then(
        (status) =>
          void handleQueryStatus(
            document,
            state.draftPlan,
            state.pendingQueryId!,
            state.taskId!,
            token,
            status,
          ),
        (error: unknown) => {
          const normalized = toOpenFileError(error);
          updateQueryState(document.id, (current) => ({
            ...current,
            status: "failed",
            taskId: null,
            pendingQueryId: null,
            errorCode: normalized.code,
            error: normalized.message,
          }));
        },
      );
  }

  function loadDistinctValues(
    document: ViewerDocument,
    columnId: string,
    search: string,
    append: boolean,
  ) {
    const state = queryStates[document.id];
    if (!state) return;
    const existing = state.distinct[columnId];
    const offset = append && existing?.search === search ? existing.values.length : 0;
    const requestId = (existing?.requestId ?? 0) + 1;
    updateQueryState(document.id, (current) => ({
      ...current,
      distinct: {
        ...current.distinct,
        [columnId]: {
          values: append && existing?.search === search ? existing.values : [],
          search,
          loading: true,
          error: null,
          hasMore: existing?.hasMore ?? false,
          requestId,
        },
      },
    }));
    void backend
      .listDistinctValues({
        documentId: state.documentId,
        sessionId: state.sessionId,
        queryId: state.queryId,
        columnId,
        search: search.trim() || null,
        offset,
        limit: 100,
      })
      .then(
        (response) => {
          updateQueryState(document.id, (current) => {
            const active = current.distinct[columnId];
            if (
              !active ||
              active.requestId !== requestId ||
              current.sessionId !== response.sessionId ||
              current.queryId !== response.queryId
            )
              return current;
            const nextValues = response.values
              .filter((value) => !value.isNull && !value.isInvalid && value.value !== null)
              .map((value) => ({ value: value.value!, count: value.count }));
            return {
              ...current,
              distinct: {
                ...current.distinct,
                [columnId]: {
                  ...active,
                  values: append ? [...active.values, ...nextValues] : nextValues,
                  loading: false,
                  hasMore: response.hasMore,
                },
              },
            };
          });
        },
        (error: unknown) =>
          updateQueryState(document.id, (current) => {
            const active = current.distinct[columnId];
            return !active || active.requestId !== requestId
              ? current
              : {
                  ...current,
                  distinct: {
                    ...current.distinct,
                    [columnId]: {
                      ...active,
                      loading: false,
                      error: toOpenFileError(error).message,
                    },
                  },
                };
          }),
      );
  }

  function distinctValuesState(document: ViewerDocument, columnId: string): DistinctValuesState {
    const current = queryStates[document.id]?.distinct[columnId];
    return {
      values: current?.values ?? [],
      loading: current?.loading ?? false,
      error: current?.error ?? null,
      hasMore: current?.hasMore ?? false,
      onSearch: (search) => loadDistinctValues(document, columnId, search, false),
      onLoadMore: () => loadDistinctValues(document, columnId, current?.search ?? "", true),
    };
  }

  function findDocumentMatch(document: ViewerDocument, direction: "next" | "previous") {
    const state = queryStates[document.id];
    if (!state?.queryId || state.committedPlan.search?.mode !== "find" || !document.page) return;
    const fromResultOffset = state.findTarget?.row ?? document.page.offset;
    const fromMatchIndex = state.findTarget?.matchIndex ?? null;
    const token = queryRequests.current.get(document.id) ?? 0;
    const findToken = nextRequest(findRequests, document.id);
    const isCurrent = () =>
      queryRequests.current.get(document.id) === token &&
      findRequests.current.get(document.id) === findToken;
    void backend
      .findQueryMatch({
        documentId: state.documentId,
        sessionId: state.sessionId,
        queryId: state.queryId,
        fromResultOffset,
        fromMatchIndex,
        direction,
        wrap: true,
      })
      .then(async (response) => {
        if (!response.match || !isCurrent()) return;
        const offset =
          Math.floor(response.match.rowOffset / document.page!.limit) * document.page!.limit;
        const pageResponse = await backend.readQueryPage({
          documentId: state.documentId,
          sessionId: state.sessionId,
          queryId: state.queryId!,
          offset,
          limit: document.page!.limit,
          columns: queryPageProjection(
            [response.match.columnId, ...document.page!.columns],
            state.resultColumns,
          ),
        });
        if (!isCurrent()) return;
        updateDocument(document.id, (current) => ({ ...current, page: pageResponse.page }));
        updateQueryState(document.id, (current) => ({
          ...current,
          findTarget: {
            row: response.match!.rowOffset,
            columnId: response.match!.columnId,
            matchIndex: response.match!.matchIndex,
            key: `${state.queryId}:${response.match!.matchIndex}:${Date.now()}`,
          },
          findMatchCount: response.match!.totalMatches,
        }));
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const normalized = toOpenFileError(error);
        updateQueryState(document.id, (current) => ({
          ...current,
          status: "failed",
          errorCode: normalized.code,
          error: normalized.message,
        }));
      });
  }

  function cancelPreparedCsv(document: ViewerDocument): void {
    if (!document.documentId || !document.sessionId) return;
    const documentId = document.documentId;
    const sessionId = document.sessionId;
    clearCsvPreparationTask(document.id);
    const token = csvPreparationTokens.current.get(document.id) ?? 0;
    csvPreparationIdentities.current.set(document.id, `${documentId}\u0000${sessionId}`);
    setCsvPreparationStates((current) => {
      const state = current[document.id];
      if (!state || state.documentId !== documentId || state.sessionId !== sessionId)
        return current;
      return { ...current, [document.id]: { ...state, action: "cancelling" } };
    });
    void backend.cancelCsvPreparation(documentId, sessionId).then(
      (status) => {
        const latest = documentsRef.current.find((candidate) => candidate.id === document.id);
        if (
          csvPreparationTokens.current.get(document.id) !== token ||
          latest?.documentId !== documentId ||
          latest.sessionId !== sessionId ||
          (status && (status.documentId !== documentId || status.sessionId !== sessionId))
        )
          return;
        setCsvPreparationStates((current) => {
          const previous = current[document.id];
          if (!previous || previous.sessionId !== sessionId) return current;
          return {
            ...current,
            [document.id]: {
              ...previous,
              status:
                status ??
                ({
                  documentId,
                  sessionId,
                  state: "cancelled",
                  rowsScanned: previous.status?.rowsScanned ?? 0,
                  totalRows: previous.status?.totalRows ?? null,
                  sourceReadBytes: previous.status?.sourceReadBytes ?? 0,
                  totalBytes: previous.status?.totalBytes ?? 0,
                  cacheOutputBytes: previous.status?.cacheOutputBytes ?? 0,
                  navigationFrontierRow: previous.status?.navigationFrontierRow ?? 0,
                  elapsedMs: previous.status?.elapsedMs ?? 0,
                  error: {
                    code: "Cancelled",
                    message: "CSV preparation was cancelled.",
                  },
                } satisfies CsvPreparationStatus),
              action: null,
              requestError: null,
              dismissed: false,
            },
          };
        });
      },
      (error: unknown) => {
        if (csvPreparationTokens.current.get(document.id) !== token) return;
        setCsvPreparationStates((current) => {
          const previous = current[document.id];
          if (!previous || previous.sessionId !== sessionId) return current;
          return {
            ...current,
            [document.id]: {
              ...previous,
              action: null,
              requestError:
                error instanceof Error ? error.message : "CSV preparation cancellation failed.",
            },
          };
        });
      },
    );
  }

  function retryPreparedCsv(document: ViewerDocument): void {
    if (document.documentId && document.sessionId) {
      startCsvPreparation(document.id, document.documentId, document.sessionId);
    }
  }

  function dismissPreparedCsv(document: ViewerDocument): void {
    setCsvPreparationStates((current) => {
      const state = current[document.id];
      if (!state || state.sessionId !== document.sessionId) return current;
      return { ...current, [document.id]: { ...state, dismissed: true } };
    });
  }

  async function cancelCsvScan(document: ViewerDocument) {
    if (
      !document.documentId ||
      !document.sessionId ||
      !document.summary ||
      !hasCapability(document.summary, "backgroundRowCount") ||
      document.summary.rowCountStatus.state !== "calculating"
    )
      return;
    const { generation } = document.summary.rowCountStatus;
    const requestId = nextRequest(statusRequests, document.id);
    updateDocument(document.id, (current) => ({ ...current, isCancellingCsv: true, error: null }));
    try {
      const raw = await backend.cancelDataFileTask(
        document.documentId,
        document.sessionId,
        generation,
      );
      const response = normalizedSummaryResponse(raw, document.documentId);
      if (
        statusRequests.current.get(document.id) === requestId &&
        response.documentId === document.documentId &&
        response.sessionId === document.sessionId
      )
        updateDocument(document.id, (current) => ({ ...current, summary: response.summary }));
    } catch (error) {
      if (statusRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({ ...current, error: toOpenFileError(error) }));
    } finally {
      if (statusRequests.current.get(document.id) === requestId)
        updateDocument(document.id, (current) => ({ ...current, isCancellingCsv: false }));
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentTab: WorkspaceTab) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextTab = tabs[(tabs.indexOf(currentTab) + direction + tabs.length) % tabs.length];
    if (activeDocument)
      updateDocument(activeDocument.id, (document) => ({ ...document, activeTab: nextTab }));
    else setEmptyActiveTab(nextTab);
    document.getElementById(`tab-${nextTab}`)?.focus();
  }

  const closeDocument = useCallback(
    (id: string) => {
      const current = documentsRef.current;
      const index = current.findIndex((document) => document.id === id);
      if (index < 0) return;
      const closing = current[index];
      const closingDocuments =
        closing.status === "loading" && closing.openRequestId
          ? current.filter(
              (document) =>
                document.status === "loading" && document.openRequestId === closing.openRequestId,
            )
          : [closing];
      const closingIds = new Set(closingDocuments.map((document) => document.id));
      closingIds.forEach((documentId) => {
        clearCsvPreparationTask(documentId);
        csvPreparationIdentities.current.delete(documentId);
        csvDefaultsHandled.current.delete(documentId);
        csvValidationPolls.current.set(
          documentId,
          (csvValidationPolls.current.get(documentId) ?? 0) + 1,
        );
      });
      setCsvProfiles((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !closingIds.has(id))),
      );
      setCsvProfileModes((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !closingIds.has(id))),
      );
      setQueryStates((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !closingIds.has(id))),
      );
      setCsvPreparationStates((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !closingIds.has(id))),
      );
      setCsvProfileDialogDocumentId((current) =>
        current && closingIds.has(current) ? null : current,
      );
      for (const document of closingDocuments) {
        pageRequests.current.set(document.id, (pageRequests.current.get(document.id) ?? 0) + 1);
        statusRequests.current.set(document.id, (statusRequests.current.get(document.id) ?? 0) + 1);
        pollRequests.current.set(document.id, (pollRequests.current.get(document.id) ?? 0) + 1);
        queryRequests.current.set(document.id, (queryRequests.current.get(document.id) ?? 0) + 1);
        if (document.status === "loading") closedPendingIds.current.add(document.id);
      }
      if (closing.status === "loading" && closing.openRequestId) {
        let cancellation: Promise<void>;
        try {
          cancellation = backend.cancelOpenRequest(closing.openRequestId);
        } catch (error) {
          cancellation = Promise.reject(error);
        }
        cancelledOpeningRequestIds.current.add(closing.openRequestId);
        setOpeningCount((count) => Math.max(0, count - 1));
        closingDocuments.forEach((document) => {
          resolveDeferredOpened(document.path, closing.openRequestId!);
          registerPathClose(document.path, cancellation);
        });
        void cancellation.catch((error) => setGlobalError(toOpenFileError(error)));
      }
      const remaining = current.filter((document) => !closingIds.has(document.id));
      setDocuments((documents) => documents.filter((document) => !closingIds.has(document.id)));
      if (activeDocumentId !== null && closingIds.has(activeDocumentId)) {
        focusAfterClose.current = true;
        setActiveDocumentId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
      }
      if (closing.documentId && closing.sessionId) {
        const cleanup = backend.closeDataFile(closing.documentId, closing.sessionId);
        registerPathClose(closing.path, cleanup);
        void cleanup.catch((error) => setGlobalError(toOpenFileError(error)));
      }
    },
    [activeDocumentId, backend, clearCsvPreparationTask, registerPathClose, resolveDeferredOpened],
  );

  const switchDocument = useCallback(
    (direction: number) => {
      const current = documentsRef.current;
      if (current.length === 0) return;
      const index = Math.max(
        0,
        current.findIndex((document) => document.id === activeDocumentId),
      );
      setActiveDocumentId(current[(index + direction + current.length) % current.length].id);
    },
    [activeDocumentId],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === "Tab") {
        event.preventDefault();
        switchDocument(event.shiftKey ? -1 : 1);
      } else if (event.key.toLocaleLowerCase() === "w" && activeDocumentId) {
        event.preventDefault();
        closeDocument(activeDocumentId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDocumentId, closeDocument, switchDocument]);

  useEffect(() => {
    document.title = summary ? `${summary.fileName} - Data Viewer` : "Data Viewer";
    const activeTabElement = document.getElementById(`document-tab-${activeDocumentId}`);
    activeTabElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeDocumentId, summary]);

  useEffect(() => {
    if (!focusAfterClose.current) return;
    focusAfterClose.current = false;
    window.requestAnimationFrame(() => {
      const nextTab = document.getElementById(`document-tab-${activeDocumentId}`);
      if (nextTab instanceof HTMLElement) nextTab.focus();
      else openButtonRef.current?.focus();
    });
  }, [activeDocumentId, documents.length]);

  function handleDocumentTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
      if (direction !== null) {
        event.preventDefault();
        moveDocument(documents[index].id, direction);
      }
      return;
    }
    let next = index;
    if (event.key === "ArrowLeft") next = (index - 1 + documents.length) % documents.length;
    else if (event.key === "ArrowRight") next = (index + 1) % documents.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = documents.length - 1;
    else return;
    event.preventDefault();
    const target = documents[next];
    setActiveDocumentId(target.id);
    document.getElementById(`document-tab-${target.id}`)?.focus();
  }

  async function applySettings(nextSettings: AppSettings, source: "app" | "copy" | "preset") {
    if (settingsSavingRef.current) {
      if (source === "preset") {
        setCopyPresetSaveError("Another settings change is still being saved.");
      }
      return;
    }
    settingsSavingRef.current = true;
    setSettingsSaving(true);
    if (source === "preset") {
      setCopyPresetSaving(true);
      setCopyPresetSaveError(null);
    } else {
      setSettingsSaveError(null);
    }
    try {
      const saved = await backend.updateSettings(parseAppSettings(nextSettings));
      setAppSettings(saved);
      setCopyPresetSaveError(null);
      if (source === "app") setSettingsDialogOpen(false);
      else if (source === "copy") setCopySettingsOpen(false);
    } catch (error) {
      const message = toOpenFileError(error).message;
      if (source === "preset") {
        setCopyPresetSaveError(`Copy preset was not changed. ${message}`);
      } else {
        setSettingsSaveError(message);
      }
    } finally {
      settingsSavingRef.current = false;
      setSettingsSaving(false);
      if (source === "preset") setCopyPresetSaving(false);
    }
  }

  function applyCopySettings(value: CopySettingsValue) {
    void applySettings(
      parseAppSettings({
        ...appSettings,
        copyPreset: value.preset,
        copyCustomOptions: value.customOptions,
      }),
      "copy",
    );
  }

  function selectCopyPreset(preset: CopyPreset) {
    void applySettings(
      parseAppSettings({
        ...appSettings,
        copyPreset: preset,
      }),
      "preset",
    );
  }

  function openApplicationSettings() {
    setSettingsSaveError(null);
    setQueryTempLoading(true);
    setQueryTempError(null);
    setQueryTempClearMessage(null);
    void backend.getQueryTempUsage().then(
      (usage) => {
        setQueryTempUsage(usage);
        setQueryTempLoading(false);
      },
      (error: unknown) => {
        setQueryTempError(toOpenFileError(error).message);
        setQueryTempLoading(false);
      },
    );
    setSettingsDialogOpen(true);
  }

  function clearQueryTemp() {
    if (queryTempLoading) return;
    setQueryTempLoading(true);
    setQueryTempError(null);
    setQueryTempClearMessage(null);
    void backend.clearQueryTemp().then(
      (result) => {
        setQueryTempUsage(result.remainingUsage);
        setQueryTempClearMessage(
          `Inactive query data cleared. ${result.deletedBytes.toLocaleString()} bytes deleted; ${result.remainingUsage.processBytes.toLocaleString()} bytes remain in use.`,
        );
        if (result.orphanFailureCount > 0) {
          setQueryTempError(
            `${result.orphanFailureCount.toLocaleString()} inactive item${result.orphanFailureCount === 1 ? "" : "s"} could not be removed. ${result.cleanupFailures.join(" ")}`,
          );
        }
        setQueryTempLoading(false);
      },
      (error: unknown) => {
        setQueryTempError(toOpenFileError(error).message);
        setQueryTempLoading(false);
      },
    );
  }

  function openCopySettings() {
    setSettingsSaveError(null);
    setCopySettingsOpen(true);
  }

  return (
    <div className="app-shell">
      <header className="app-toolbar" data-testid="toolbar">
        <div className="app-brand">
          <FileSpreadsheet className="app-brand__icon" aria-hidden="true" />
          <h1>Data Viewer</h1>
          {summary && (
            <span className="file-chip" title={summary.fileName}>
              {summary.fileName}
            </span>
          )}
        </div>
        <div className="app-toolbar__actions">
          <button
            aria-label="Settings"
            className="toolbar-icon-button"
            onClick={openApplicationSettings}
            ref={settingsButtonRef}
            title="Settings"
            type="button"
          >
            <SettingsIcon aria-hidden="true" />
          </button>
          <button
            className="open-file-button"
            ref={openButtonRef}
            type="button"
            onClick={() => void openFile()}
            disabled={openingCount > 0}
          >
            {openingCount > 0 ? (
              <LoaderCircle className="button-spinner" aria-hidden="true" />
            ) : (
              <FolderOpen aria-hidden="true" />
            )}
            <span>{openingCount > 0 ? "Opening..." : "Open file"}</span>
          </button>
        </div>
      </header>

      <nav className="document-tabs" aria-label="Open files">
        <button
          aria-label="Scroll file tabs left"
          className="document-tabs__scroll"
          disabled={documents.length === 0}
          onClick={() => tabStripRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <div
          className="document-tabs__strip"
          ref={tabStripRef}
          role="tablist"
          aria-label="Open files"
        >
          {documents.map((document, index) => {
            const tabLabel = documentTabLabel(document, documents);
            return (
              <div
                className={`document-tab-shell${documentReorder.state.movingId === document.id ? " is-reordering" : ""}${documentReorder.state.targetId === document.id ? ` is-insert-${documentReorder.state.side}` : ""}`}
                key={document.id}
              >
                <button
                  {...documentReorder.getItemProps(document.id)}
                  aria-controls={`document-panel-${document.id}`}
                  aria-selected={activeDocumentId === document.id}
                  className="document-tab"
                  id={`document-tab-${document.id}`}
                  onClick={() => {
                    if (!documentReorder.consumeSuppressedClick(document.id)) {
                      setActiveDocumentId(document.id);
                    }
                  }}
                  onKeyDown={(event) => handleDocumentTabKey(event, index)}
                  role="tab"
                  tabIndex={activeDocumentId === document.id ? 0 : -1}
                  title={document.path}
                  type="button"
                >
                  {document.status === "loading" && <LoaderCircle aria-hidden="true" />}
                  {document.status === "error" && <TriangleAlert aria-hidden="true" />}
                  <span>{tabLabel}</span>
                </button>
                <button
                  aria-label={`Close ${tabLabel}`}
                  className="document-tab__close"
                  onClick={() => closeDocument(document.id)}
                  title={`Close ${tabLabel}`}
                  type="button"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {documents.length === 0 && <span className="document-tabs__empty">No files open</span>}
        </div>
        <button
          aria-label="Scroll file tabs right"
          className="document-tabs__scroll"
          disabled={documents.length === 0}
          onClick={() => tabStripRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
          type="button"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </nav>

      <nav className="workspace-tabs" aria-label="Viewer sections">
        <div role="tablist" aria-label="File views">
          {tabs.map((tab) => (
            <button
              aria-controls="viewer-panel"
              aria-selected={activeTab === tab}
              className="workspace-tab"
              id={`tab-${tab}`}
              key={tab}
              disabled={Boolean(activeDocument && activeDocument.status !== "ready")}
              onClick={() =>
                activeDocument
                  ? updateDocument(activeDocument.id, (document) => ({
                      ...document,
                      activeTab: tab,
                    }))
                  : setEmptyActiveTab(tab)
              }
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              role="tab"
              tabIndex={activeTab === tab ? 0 : -1}
              type="button"
            >
              {tabLabels[tab]}
            </button>
          ))}
        </div>
        {summary && (
          <div className="file-summary" aria-label="Current file summary">
            <span>{formatDisplayName(summary)}</span>
            <span>
              {summary.rowCount === null
                ? `${summary.rowCountStatus.rowsScanned.toLocaleString()}+ rows`
                : `${summary.rowCount.toLocaleString()} rows`}
            </span>
            <span>{summary.columnCount.toLocaleString()} columns</span>
            {activeDocument && hasCapability(summary, "parsingProfile") && (
              <>
                <span className="csv-profile-mode">
                  CSV:{" "}
                  {csvProfileModes[activeDocument.id] === "allText"
                    ? "All Text"
                    : csvProfileModes[activeDocument.id] === "custom"
                      ? "Custom"
                      : "Auto"}
                  {csvProfileDialogDocumentId === activeDocument.id &&
                  appSettings.csvDefaultParsingMode === "askEveryTime"
                    ? " (choice pending)"
                    : ""}
                </span>
                <button
                  className="csv-profile-command"
                  disabled={csvProfileLoadingDocumentId === activeDocument.id}
                  onClick={() => void openCsvProfile(activeDocument)}
                  ref={csvProfileButtonRef}
                  type="button"
                >
                  <SlidersHorizontal aria-hidden="true" />
                  CSV Parsing Profile
                </button>
              </>
            )}
          </div>
        )}
      </nav>

      <main
        aria-labelledby={`tab-${activeTab}`}
        aria-busy={
          openingCount > 0 ||
          activeDocument?.isPageLoading ||
          activeDocument?.isConfiguringCsv ||
          activeCsvProfile?.isApplying
        }
        className={`workspace${dropTarget ? " workspace--drop-active" : ""}`}
        data-testid="workspace"
        id="viewer-panel"
        role="tabpanel"
        tabIndex={0}
      >
        {settingsWarning && (
          <div className="settings-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            <span>{settingsWarning}</span>
            <button
              aria-label="Dismiss settings warning"
              className="icon-button"
              onClick={() => setSettingsWarning(null)}
              title="Dismiss settings warning"
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}
        {globalError && (
          <div className="error-banner" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="error-banner__content">
              <strong>{globalError.code}</strong>
              <span>{globalError.message}</span>
            </div>
            <button type="button" className="error-action" onClick={() => void openFile()}>
              <RefreshCw aria-hidden="true" />
              <span>Try again</span>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setGlobalError(null)}
              title="Dismiss error"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}
        {documents.length === 0 && <EmptyState formats={formatCatalog} tab={emptyActiveTab} />}
        {openingCount > 0 && (
          <span className="opening-announcement" role="status" aria-live="polite">
            Opening data file
          </span>
        )}
        {documents.map((document) => (
          <section
            aria-labelledby={`document-tab-${document.id}`}
            className="document-panel"
            hidden={activeDocumentId !== document.id}
            id={`document-panel-${document.id}`}
            key={document.id}
            role="tabpanel"
          >
            {document.status === "loading" && (
              <div className="document-state" role="status">
                <LoaderCircle aria-hidden="true" />
                <strong>Opening {document.label}</strong>
                <span>Reading schema and first page...</span>
              </div>
            )}
            {document.status === "error" && document.error && (
              <div className="document-state document-state--error" role="alert">
                <TriangleAlert aria-hidden="true" />
                <strong>{document.error.code}</strong>
                <span>{document.error.message}</span>
                <button
                  onClick={() => {
                    closeDocument(document.id);
                    void openPaths({
                      requestId: `frontend-retry-${++pathRequestSequence.current}`,
                      origin: "dialog",
                      paths: [document.path],
                    });
                  }}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" /> Retry
                </button>
              </div>
            )}
            {document.status === "ready" && document.summary && document.page && (
              <>
                {document.error && (
                  <div className="error-banner" role="alert">
                    <TriangleAlert aria-hidden="true" />
                    <div className="error-banner__content">
                      <strong>{document.error.code}</strong>
                      <span>{document.error.message}</span>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Dismiss error"
                      onClick={() =>
                        updateDocument(document.id, (current) => ({ ...current, error: null }))
                      }
                      type="button"
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div className="document-view" hidden={document.activeTab !== "data"}>
                  <DataView
                    active={activeDocumentId === document.id && document.activeTab === "data"}
                    cancelDataBoundaryNavigation={backend.cancelDataBoundaryNavigation}
                    copyLimits={appSettings.copyLimits}
                    copyOptions={activeCopyOptions(appSettings)}
                    displayFormats={appSettings.displayFormats}
                    copyPresetError={copyPresetSaveError}
                    copyPresetSaving={copyPresetSaving}
                    distinctValuesForColumn={(columnId) => distinctValuesState(document, columnId)}
                    documentId={document.documentId!}
                    findDataBoundary={backend.findDataBoundary}
                    startCopy={backend.startCopy}
                    getCopyStatus={backend.getCopyStatus}
                    cancelCopy={backend.cancelCopy}
                    getCopyHistory={backend.getCopyHistory}
                    csvPreparation={csvPreparationStates[document.id] ?? null}
                    onCancelCsvPreparation={() => cancelPreparedCsv(document)}
                    onRetryCsvPreparation={() => retryPreparedCsv(document)}
                    onDismissCsvPreparation={() => dismissPreparedCsv(document)}
                    isCancelling={document.isCancellingCsv}
                    isLoading={document.isPageLoading}
                    onCancel={() => void cancelCsvScan(document)}
                    onCancelQuery={() => cancelDocumentQuery(document)}
                    onFindMatch={(direction) => findDocumentMatch(document, direction)}
                    onOpenDistinctValues={(columnId) =>
                      loadDistinctValues(document, columnId, "", false)
                    }
                    onRetryQuery={() => {
                      const state = queryStates[document.id];
                      if (state) executeDocumentQuery(document, state.draftPlan);
                    }}
                    onPageChange={(offset) => void loadPage(document, offset)}
                    onCopyPresetChange={selectCopyPreset}
                    onOpenCopySettings={openCopySettings}
                    onQueryPlanChange={(plan) => executeDocumentQuery(document, plan)}
                    onReadError={(error, offset) =>
                      updateDocument(document.id, (current) => ({
                        ...current,
                        error: toOpenFileError(error, { kind: "page", offset }),
                      }))
                    }
                    page={document.page}
                    queryState={queryStates[document.id] ?? null}
                    readPage={(request) => {
                      const query = queryStates[document.id];
                      return query?.queryId
                        ? backend
                            .readQueryPage({
                              documentId: document.documentId!,
                              sessionId: document.sessionId!,
                              queryId: query.queryId,
                              offset: request.offset,
                              limit: request.limit,
                              columns: queryPageProjection(
                                request.columns ?? [],
                                query.resultColumns,
                              ),
                            })
                            .then((response) => response.page)
                        : backend.readPage({
                            ...request,
                            documentId: document.documentId!,
                          });
                    }}
                    readCellValue={backend.readCellValue}
                    summary={document.summary}
                  />
                </div>
                <div className="document-view" hidden={document.activeTab !== "schema"}>
                  <SchemaView summary={document.summary} />
                </div>
                <div className="document-view" hidden={document.activeTab !== "metadata"}>
                  <MetadataView
                    isConfiguring={document.isConfiguringCsv}
                    onHeaderModeChange={(mode) => void configureCsv(document, mode)}
                    summary={document.summary}
                  />
                </div>
              </>
            )}
          </section>
        ))}
        {dropTarget && <DropTarget formats={formatCatalog} state={dropTarget} />}
      </main>

      <footer
        aria-live="polite"
        className={`status-bar status-bar--${backendState.kind}`}
        data-testid="status-bar"
        role="status"
      >
        <BackendStatus state={backendState} />
        {summary && page && activeTab !== "data" && <PageStatus page={page} />}
      </footer>

      {csvProfileDialogDocumentId && csvProfileLoadingDocumentId === csvProfileDialogDocumentId && (
        <div className="dialog-backdrop">
          <div className="csv-profile-loading" role="status">
            <LoaderCircle aria-hidden="true" />
            <strong>Loading CSV parsing profile</strong>
          </div>
        </div>
      )}
      {csvProfileDialogDocumentId &&
        csvProfileDocument &&
        activeCsvProfile &&
        csvProfileLoadingDocumentId !== csvProfileDialogDocumentId && (
          <div className="dialog-backdrop dialog-backdrop--profile">
            <CsvProfileDialog
              columns={activeCsvProfile.columns}
              identity={activeCsvProfile.identity}
              initialGeneration={activeCsvProfile.wireProfile.generation}
              isApplying={activeCsvProfile.isApplying}
              onApply={(request) => applyCsvProfile(csvProfileDocument, request)}
              onCancel={() => closeCsvProfile(csvProfileDialogDocumentId)}
              onCancelValidation={() => void cancelCsvProfileValidation(csvProfileDialogDocumentId)}
              onPreviewRequest={(request) =>
                void previewCsvProfile(csvProfileDialogDocumentId, request)
              }
              onValidate={(request) => void validateCsvProfile(csvProfileDialogDocumentId, request)}
              preview={activeCsvProfile.preview}
              requestError={activeCsvProfile.error}
              restoreFocusTo={csvProfileButtonRef.current}
              structuralError={activeCsvProfile.structuralError}
              validation={activeCsvProfile.validation}
            />
          </div>
        )}

      {settingsDialogOpen && (
        <AppSettingsDialog
          initialSettings={appSettings}
          isObscured={copySettingsOpen}
          isSaving={settingsSaving}
          onApply={(nextSettings) => void applySettings(nextSettings, "app")}
          onCancel={() => {
            setSettingsDialogOpen(false);
            setSettingsSaveError(null);
          }}
          onOpenCopySettings={openCopySettings}
          saveError={settingsSaveError}
          tempUsage={queryTempUsage}
          tempUsageError={queryTempError}
          tempClearMessage={queryTempClearMessage}
          tempUsageLoading={queryTempLoading}
          onClearTemp={clearQueryTemp}
        />
      )}
      {copySettingsOpen && (
        <CopySettingsDialog
          applyError={settingsSaveError}
          headers={page?.columns}
          initialCustomOptions={appSettings.copyCustomOptions}
          initialPreset={appSettings.copyPreset}
          isApplying={settingsSaving}
          onApply={applyCopySettings}
          onCancel={() => {
            setCopySettingsOpen(false);
            setSettingsSaveError(null);
          }}
          sampleRows={page?.rows ?? []}
        />
      )}
    </div>
  );
}

export default App;
