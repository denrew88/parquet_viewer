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
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createDefaultBackend,
  DataViewerError,
  type BackendAdapter,
  type CsvHeaderMode,
  type DataPage,
  type DocumentSummaryResponse,
  type FileSummary,
  type HealthCheckResponse,
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
import { VirtualDataGrid } from "./VirtualDataGrid";
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
  data: { title: "No file open", detail: "Open a CSV or Parquet file to view its data." },
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

function isSupportedDataPath(path: string): boolean {
  return /\.(csv|parquet)$/i.test(path);
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

function DropTarget({ state }: { state: DropTargetState }) {
  const supported =
    state.paths.length > 0 && state.paths.length <= 32 && state.paths.every(isSupportedDataPath);
  let title = "Drop data files";
  let detail = "Release CSV or Parquet files to open them in tabs.";
  let Icon = FileUp;
  if (state.paths.length > 32) {
    title = "Too many files";
    detail = "Open at most 32 files in one operation.";
    Icon = TriangleAlert;
  } else if (state.paths.some((path) => !isSupportedDataPath(path))) {
    title = "Unsupported file type";
    detail = "Only CSV and Parquet files can be opened.";
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

function EmptyState({ tab }: { tab: WorkspaceTab }) {
  const content = emptyStateCopy[tab];
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
  isLoading: boolean;
  isCancelling: boolean;
  onCancel(): void;
  onPageChange(offset: number): void;
  onReadError(error: unknown, offset: number): void;
  page: DataPage;
  readPage(request: Parameters<BackendAdapter["readPage"]>[0]): Promise<DataPage>;
  summary: FileSummary;
}

function DataView({
  active = true,
  isCancelling,
  isLoading,
  onCancel,
  onPageChange,
  onReadError,
  page,
  readPage,
  summary,
}: DataViewProps) {
  return (
    <div
      className={`data-view${summary.rowCountStatus.state === "calculating" ? " data-view--scanning" : ""}`}
    >
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
      <VirtualDataGrid
        active={active}
        isLoading={isLoading}
        onPageChange={onPageChange}
        onReadError={onReadError}
        page={page}
        readPage={readPage}
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
  return (
    <div className="detail-view metadata-view">
      <header className="detail-heading">
        <h2>Metadata</h2>
        <p>File and {summary.format === "csv" ? "CSV parsing" : "Parquet structure"}</p>
      </header>
      <div className="metadata-content">
        <dl className="metadata-grid">
          <MetadataItem label="File name" title={summary.fileName}>
            {summary.fileName}
          </MetadataItem>
          <MetadataItem label="Path" title={summary.path}>
            {summary.path}
          </MetadataItem>
          <MetadataItem label="Format">{summary.format === "csv" ? "CSV" : "Parquet"}</MetadataItem>
          <MetadataItem label="File size">{formatBytes(summary.fileSize)}</MetadataItem>
          <MetadataItem label="Rows">
            {summary.rowCount === null ? "Calculating..." : summary.rowCount.toLocaleString()}
          </MetadataItem>
          <MetadataItem label="Columns">{summary.columnCount.toLocaleString()}</MetadataItem>
          {summary.format === "parquet" && (
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
        {summary.format === "parquet" && (
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
  const [emptyActiveTab, setEmptyActiveTab] = useState<WorkspaceTab>("data");
  const [documents, setDocuments] = useState<ViewerDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [openingCount, setOpeningCount] = useState(0);
  const [globalError, setGlobalError] = useState<OpenFileError | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
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
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const summary = activeDocument?.summary ?? null;
  const page = activeDocument?.page ?? null;
  const activeTab = activeDocument?.activeTab ?? emptyActiveTab;

  const updateDocument = useCallback(
    (id: string, update: (document: ViewerDocument) => ViewerDocument) => {
      setDocuments((current) =>
        current.map((document) => (document.id === id ? update(document) : document)),
      );
    },
    [],
  );

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
    backend.healthCheck().then(
      (health) => active && setBackendState({ kind: "connected", health }),
      (error: unknown) =>
        active && setBackendState({ kind: "error", message: toOpenFileError(error).message }),
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
        currentSummary.format !== "csv" ||
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
    void backend.takePendingOpenRequests().then(
      (requests) => {
        if (!active) return;
        requests.forEach((request) => void openPaths(request));
      },
      (error: unknown) => {
        if (active) setGlobalError(toOpenFileError(error));
      },
    );
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
        if (event.type === "enter") {
          setDropTarget({ paths: event.paths });
        } else if (event.type === "over") {
          setDropTarget((current) => current ?? { paths: [] });
        } else if (event.type === "leave") {
          setDropTarget(null);
        } else {
          setDropTarget(null);
          void openPaths({
            requestId: `frontend-dragDrop-${++pathRequestSequence.current}`,
            origin: "dragDrop",
            paths: event.paths,
          });
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
    updateDocument(document.id, (current) => ({ ...current, isPageLoading: true, error: null }));
    try {
      const nextPage = await backend.readPage({
        documentId: document.documentId,
        sessionId: document.sessionId,
        offset,
        limit: document.page.limit,
      });
      if (pageRequests.current.get(document.id) !== requestId) return;
      if (
        nextPage.sessionId !== document.sessionId ||
        nextPage.offset !== offset ||
        (document.summary.rowCount !== null &&
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
      document.summary.format !== "csv" ||
      document.summary.csvMetadata?.headerMode === headerMode
    )
      return;
    const requestId = nextRequest(statusRequests, document.id);
    nextRequest(pageRequests, document.id);
    updateDocument(document.id, (current) => ({ ...current, isConfiguringCsv: true, error: null }));
    try {
      const raw = await backend.configureCsv(document.documentId, document.sessionId, headerMode);
      const response = normalizedSummaryResponse(raw, document.documentId);
      const nextSummary = response.summary;
      if (statusRequests.current.get(document.id) !== requestId) return;
      if (
        response.documentId !== document.documentId ||
        nextSummary.sessionId !== response.sessionId ||
        nextSummary.format !== "csv" ||
        nextSummary.csvMetadata?.headerMode !== headerMode
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

  async function cancelCsvScan(document: ViewerDocument) {
    if (
      !document.documentId ||
      !document.sessionId ||
      !document.summary ||
      document.summary.format !== "csv" ||
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
      for (const document of closingDocuments) {
        pageRequests.current.set(document.id, (pageRequests.current.get(document.id) ?? 0) + 1);
        statusRequests.current.set(document.id, (statusRequests.current.get(document.id) ?? 0) + 1);
        pollRequests.current.set(document.id, (pollRequests.current.get(document.id) ?? 0) + 1);
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
    [activeDocumentId, backend, registerPathClose, resolveDeferredOpened],
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
              <div className="document-tab-shell" key={document.id}>
                <button
                  aria-controls={`document-panel-${document.id}`}
                  aria-selected={activeDocumentId === document.id}
                  className="document-tab"
                  id={`document-tab-${document.id}`}
                  onClick={() => setActiveDocumentId(document.id)}
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
            <span>{summary.format === "csv" ? "CSV" : "Parquet"}</span>
            <span>
              {summary.rowCount === null
                ? `${summary.rowCountStatus.rowsScanned.toLocaleString()}+ rows`
                : `${summary.rowCount.toLocaleString()} rows`}
            </span>
            <span>{summary.columnCount.toLocaleString()} columns</span>
          </div>
        )}
      </nav>

      <main
        aria-labelledby={`tab-${activeTab}`}
        aria-busy={
          openingCount > 0 || activeDocument?.isPageLoading || activeDocument?.isConfiguringCsv
        }
        className={`workspace${dropTarget ? " workspace--drop-active" : ""}`}
        data-testid="workspace"
        id="viewer-panel"
        role="tabpanel"
        tabIndex={0}
      >
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
        {documents.length === 0 && <EmptyState tab={emptyActiveTab} />}
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
                    isCancelling={document.isCancellingCsv}
                    isLoading={document.isPageLoading}
                    onCancel={() => void cancelCsvScan(document)}
                    onPageChange={(offset) => void loadPage(document, offset)}
                    onReadError={(error, offset) =>
                      updateDocument(document.id, (current) => ({
                        ...current,
                        error: toOpenFileError(error, { kind: "page", offset }),
                      }))
                    }
                    page={document.page}
                    readPage={(request) =>
                      backend.readPage({ ...request, documentId: document.documentId! })
                    }
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
        {dropTarget && <DropTarget state={dropTarget} />}
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
    </div>
  );
}

export default App;
