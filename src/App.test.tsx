// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  DataViewerError,
  type BackendAdapter,
  type DataPage,
  type FileSummary,
  type FormatDescriptor,
  type CsvParsingProfileWire,
  type OpenDataRequest,
  type OpenDataResponse,
} from "./backend";
import { type DragDropAdapter, type FileDragDropEvent, type FileDragDropHandler } from "./dragDrop";
import { COPY_PRESETS } from "./copy/presets";
import { defaultAppSettings, type AppSettings } from "./settings/model";

const csvDescriptor: FormatDescriptor = {
  id: "csv",
  displayName: "CSV",
  extensions: ["csv"],
  mimeTypes: ["text/csv"],
  capabilities: ["columnProjection", "backgroundRowCount", "queryProvider"],
};
const parquetDescriptor: FormatDescriptor = {
  id: "parquet",
  displayName: "Parquet",
  extensions: ["parquet"],
  mimeTypes: ["application/vnd.apache.parquet"],
  capabilities: ["typedSchema", "columnProjection", "rowGroups"],
};
const supportedFormats = [csvDescriptor, parquetDescriptor];

const summary: FileSummary = {
  sessionId: "session-1",
  fileName: "primitive-null.parquet",
  path: "C:\\fixtures\\primitive-null.parquet",
  format: "parquet",
  formatDescriptor: parquetDescriptor,
  fileSize: 4096,
  rowCount: 4,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 4,
    bytesScanned: 4096,
    totalBytes: 4096,
    generation: 0,
    message: null,
  },
  columnCount: 4,
  rowGroupCount: 2,
  columns: [
    { name: "id", logicalType: "Int32", nullable: false, physicalType: "INT32" },
    { name: "label", logicalType: "Utf8", nullable: true, physicalType: "BYTE_ARRAY" },
    { name: "score", logicalType: "Float64", nullable: true, physicalType: "DOUBLE" },
    { name: "active", logicalType: "Boolean", nullable: true, physicalType: "BOOLEAN" },
  ],
  rowGroups: [
    {
      index: 0,
      rowCount: 2,
      totalByteSize: 300,
      compressedSize: 180,
      compression: ["SNAPPY"],
      statisticsColumnCount: 4,
    },
    {
      index: 1,
      rowCount: 2,
      totalByteSize: 260,
      compressedSize: 150,
      compression: ["ZSTD", "SNAPPY"],
      statisticsColumnCount: 3,
    },
  ],
  csvMetadata: null,
  formatDetails: [
    {
      id: "parquet-row-groups",
      title: "Row groups",
      kind: "table",
      columns: ["Index", "Rows"],
      rows: [
        ["0", "2"],
        ["1", "2"],
      ],
      truncated: false,
    },
  ],
};

const page: DataPage = {
  sessionId: "session-1",
  offset: 0,
  limit: 200,
  totalRows: 4,
  hasMore: false,
  columns: ["id", "label", "score", "active"],
  rows: [
    [
      { kind: "int", display: "1" },
      { kind: "string", display: "alpha" },
      { kind: "float", display: "98.5" },
      { kind: "boolean", display: "true" },
    ],
    [
      { kind: "int", display: "2" },
      { kind: "string", display: "" },
      { kind: "null", display: null },
      { kind: "boolean", display: "false" },
    ],
    [
      { kind: "int", display: "3" },
      { kind: "string", display: "A deliberately long value for truncation" },
      { kind: "float", display: "72.25" },
      { kind: "null", display: null },
    ],
    [
      { kind: "int", display: "4" },
      { kind: "null", display: null },
      { kind: "float", display: "0" },
      { kind: "boolean", display: "true" },
    ],
  ],
};

function csvSummary(headerMode: "auto" | "present" | "absent" = "auto"): FileSummary {
  return {
    sessionId: "csv-session",
    fileName: "quoted.csv",
    path: "C:\\fixtures\\quoted.csv",
    format: "csv",
    formatDescriptor: csvDescriptor,
    fileSize: 100,
    rowCount: null,
    rowCountStatus: {
      state: "calculating",
      rowsScanned: 2,
      bytesScanned: 50,
      totalBytes: 100,
      generation: headerMode === "auto" ? 1 : 2,
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
        entries: [{ label: "Encoding", value: "utf-8" }],
      },
    ],
  };
}

const csvPage: DataPage = {
  sessionId: "csv-session",
  offset: 0,
  limit: 200,
  totalRows: null,
  hasMore: true,
  columns: ["name", "note", "empty"],
  rows: [
    [
      { kind: "string", display: "Kim, Mina" },
      { kind: "string", display: "line one\nline two" },
      { kind: "string", display: "" },
    ],
  ],
};

const csvProfile: CsvParsingProfileWire = {
  mode: "auto",
  generation: 3,
  columns: ["name", "note", "empty"].map((sourceName, sourceIndex) => ({
    sourceIndex,
    sourceName,
    targetType: "auto",
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

function profileCsvSummary(sessionId = "csv-session", structuralIssues = false): FileSummary {
  const base = csvSummary();
  return {
    ...base,
    sessionId,
    formatDescriptor: {
      ...csvDescriptor,
      capabilities: [...csvDescriptor.capabilities, "parsingProfile"],
    },
    csvMetadata: {
      ...base.csvMetadata!,
      structureIssueCount: structuralIssues ? 1 : 0,
      structureIssues: structuralIssues ? [{ row: 4, expectedColumns: 3, actualColumns: 2 }] : [],
    },
  };
}

function csvProfileResponse() {
  return { documentId: "legacy-csv-session", sessionId: "csv-session", profile: csvProfile };
}

function profilePreviewResponse(generation = csvProfile.generation) {
  return {
    documentId: "legacy-csv-session",
    sessionId: "csv-session",
    preview: {
      generation,
      stage: "leading" as const,
      profile: { ...csvProfile, generation },
      columns: csvProfile.columns.map((column) => ({
        sourceIndex: column.sourceIndex,
        sourceName: column.sourceName,
        recommendedType: "text" as const,
        confidence: 0.99,
        targetType: "text" as const,
        successCount: 1,
        nullCount: 0,
        invalidCount: 0,
      })),
      rows: [
        {
          sourceRow: 0,
          cells: ["Kim, Mina", "line one\nline two", ""].map((raw) => ({
            raw,
            converted: {
              kind: "string" as const,
              display: raw,
              state: raw === "" ? ("empty" as const) : ("valid" as const),
              rawDisplay: raw,
              diagnostic: null,
            },
          })),
        },
      ],
    },
  };
}

function appliedCsvPage(sessionId = "csv-session-profile-4"): DataPage {
  return {
    sessionId,
    offset: 0,
    limit: 200,
    totalRows: null,
    hasMore: true,
    columns: ["name", "note", "empty"],
    rows: [
      [
        {
          kind: "int",
          display: "7",
          state: "valid",
          rawDisplay: "0007",
          diagnostic: null,
        },
        { kind: "string", display: "typed" },
        { kind: "null", display: null },
      ],
    ],
  };
}

function querySummary(sessionId = "session-1"): FileSummary {
  return {
    ...summary,
    sessionId,
    formatDescriptor: {
      ...parquetDescriptor,
      capabilities: [...parquetDescriptor.capabilities, "queryProvider"],
    },
  };
}

function queryProfileCsvSummary(sessionId = "csv-session"): FileSummary {
  return profileCsvSummary(sessionId);
}

function completedQueryProfileCsvSummary(sessionId = "csv-session"): FileSummary {
  const result = queryProfileCsvSummary(sessionId);
  return {
    ...result,
    rowCount: 1,
    rowCountStatus: {
      ...result.rowCountStatus,
      state: "complete",
      rowsScanned: 1,
      bytesScanned: result.fileSize,
    },
  };
}

function queryStatus(
  request: { documentId: string; sessionId: string; queryId: string; taskId: string },
  state: "queued" | "running" | "complete" | "cancelled" | "failed" = "queued",
) {
  return {
    ...request,
    state,
    progress: {
      rowsScanned: state === "complete" ? 4 : 0,
      totalRows: 4,
      resultRows: state === "complete" ? 1 : 0,
    },
    columns: ["id", "label", "score", "active"],
    elapsedMs: state === "complete" ? 12 : 0,
    findMatchCount: null,
    error:
      state === "failed"
        ? { code: "QueryTempLimitExceeded", message: "Disk limit reached." }
        : null,
  };
}

function queryResultPage(display = "filtered"): DataPage {
  return {
    ...page,
    totalRows: 1,
    rows: [
      [
        { kind: "int", display: "1" },
        { kind: "string", display },
        { kind: "float", display: "98.5" },
        { kind: "boolean", display: "true" },
      ],
    ],
  };
}

function backend(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  const adapter: BackendAdapter = {
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", appVersion: "0.1.0" }),
    listSupportedFormats: vi.fn().mockResolvedValue(supportedFormats),
    getSettings: vi.fn().mockResolvedValue(defaultAppSettings()),
    updateSettings: vi.fn(async (settings) => settings),
    selectDataFile: vi.fn().mockResolvedValue(summary),
    selectDataFilePath: vi.fn(),
    openDataFile: vi.fn(async (request: OpenDataRequest) => ({
      requestId: request.requestId,
      origin: request.origin,
      summary,
      initialPage: page,
    })),
    cancelOpenRequest: vi.fn().mockResolvedValue(undefined),
    takePendingOpenRequests: vi.fn().mockResolvedValue([]),
    onOpenDataRequest: vi.fn().mockResolvedValue(() => undefined),
    readPage: vi.fn().mockResolvedValue(page),
    readCellValue: vi.fn(async (request) => {
      const column = summary.columns.findIndex((candidate) => candidate.name === request.columnId);
      return page.rows[request.row]?.[column] ?? { kind: "null", display: null };
    }),
    findDataBoundary: vi.fn(async (request) => ({
      ...request,
      targetRow: request.row,
      targetColumnId: request.columnId,
      resolvedRowCount: page.totalRows,
    })),
    cancelDataBoundaryNavigation: vi.fn().mockResolvedValue(undefined),
    configureCsv: vi.fn().mockRejectedValue(new Error("not csv")),
    getCsvProfile: vi.fn().mockRejectedValue(new Error("not csv")),
    previewCsvProfile: vi.fn().mockRejectedValue(new Error("not csv")),
    validateCsvProfile: vi.fn().mockRejectedValue(new Error("not csv")),
    getCsvProfileValidationStatus: vi.fn().mockRejectedValue(new Error("not csv")),
    cancelCsvProfileValidation: vi.fn().mockRejectedValue(new Error("not csv")),
    applyCsvProfile: vi.fn().mockRejectedValue(new Error("not csv")),
    executeQuery: vi.fn().mockRejectedValue(new Error("query unavailable")),
    getQueryStatus: vi.fn().mockRejectedValue(new Error("query unavailable")),
    readQueryPage: vi.fn().mockRejectedValue(new Error("query unavailable")),
    listDistinctValues: vi.fn().mockRejectedValue(new Error("query unavailable")),
    findQueryMatch: vi.fn().mockRejectedValue(new Error("query unavailable")),
    cancelQuery: vi.fn().mockRejectedValue(new Error("query unavailable")),
    getQueryTempUsage: vi.fn().mockResolvedValue({
      processBytes: 0,
      limitBytes: defaultAppSettings().queryTempLimitBytes,
      availableBytes: 20 * 1024 ** 3,
      activeQueries: 0,
      estimatedTempBytes: null,
      safetyReserveBytes: 5 * 1024 ** 3,
      hardCapBytes: 10 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3,
    }),
    clearQueryTemp: vi.fn().mockResolvedValue({
      deletedBytes: 0,
      orphanFailureCount: 0,
      cleanupFailures: [],
      remainingUsage: {
        processBytes: 0,
        limitBytes: defaultAppSettings().queryTempLimitBytes,
        availableBytes: 20 * 1024 ** 3,
        activeQueries: 0,
        estimatedTempBytes: null,
        safetyReserveBytes: 5 * 1024 ** 3,
        hardCapBytes: 10 * 1024 ** 3,
        freeBytes: 20 * 1024 ** 3,
      },
    }),
    getDataFileStatus: vi.fn().mockResolvedValue(summary),
    cancelDataFileTask: vi.fn().mockResolvedValue(summary),
    closeDataFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  if (!overrides.selectDataFilePath) {
    adapter.selectDataFilePath = vi.fn(async (requestId: string) => {
      const nextSummary = await adapter.selectDataFile();
      if (nextSummary === null) return null;
      return {
        requestId,
        origin: "dialog" as const,
        summary: nextSummary,
        initialPage: await adapter.readPage({
          sessionId: nextSummary.sessionId,
          offset: 0,
          limit: 200,
        }),
      };
    });
  }
  return adapter;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function dragDropHarness() {
  let handler: FileDragDropHandler | null = null;
  const unlisten = vi.fn();
  const adapter: DragDropAdapter = {
    onDragDropEvent: vi.fn(async (nextHandler) => {
      handler = nextHandler;
      return unlisten;
    }),
  };
  return {
    adapter,
    emit(event: FileDragDropEvent) {
      if (!handler) throw new Error("Drag-drop listener has not been installed.");
      handler(event);
    },
    unlisten,
  };
}

function enter(paths: string[]): FileDragDropEvent {
  return { type: "enter", paths, position: { x: 10, y: 10 } } as unknown as FileDragDropEvent;
}

function over(): FileDragDropEvent {
  return { type: "over", position: { x: 12, y: 12 } } as unknown as FileDragDropEvent;
}

function drop(paths: string[]): FileDragDropEvent {
  return { type: "drop", paths, position: { x: 12, y: 12 } } as unknown as FileDragDropEvent;
}

function openedFile(
  request: OpenDataRequest,
  sessionId: string,
  fileName: string,
  firstValue: string,
) {
  const nextSummary: FileSummary = {
    ...summary,
    sessionId,
    fileName,
    path: `C:\\fixtures\\${fileName}`,
  };
  const nextPage: DataPage = {
    ...page,
    sessionId,
    rows: page.rows.map((row, rowIndex) =>
      row.map((value, columnIndex) =>
        rowIndex === 0 && columnIndex === 0 ? { kind: "string", display: firstValue } : value,
      ),
    ),
  };
  return {
    requestId: request.requestId,
    origin: request.origin,
    summary: nextSummary,
    initialPage: nextPage,
  };
}

function pageAt(offset: number, count: number, totalRows: number, prefix: string): DataPage {
  return {
    sessionId: summary.sessionId,
    offset,
    limit: 200,
    totalRows,
    hasMore: offset + count < totalRows,
    columns: summary.columns.map((column) => column.name),
    rows: Array.from({ length: count }, (_, index) => [
      { kind: "int" as const, display: `${prefix}-${offset + index}` },
      { kind: "string" as const, display: `label-${offset + index}` },
      { kind: "float" as const, display: String(offset + index) },
      { kind: "boolean" as const, display: index % 2 === 0 ? "true" : "false" },
    ]),
  };
}

function summaryWithRows(rowCount: number): FileSummary {
  return {
    ...summary,
    rowCount,
    rowCountStatus: { ...summary.rowCountStatus, rowsScanned: rowCount },
    rowGroupCount: rowCount === 0 ? 0 : 1,
    rowGroups:
      rowCount === 0
        ? []
        : [
            {
              ...summary.rowGroups[0],
              rowCount,
            },
          ],
  };
}

async function openFile() {
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await screen.findByText("alpha");
}

describe("App", () => {
  it("renders loading and then the first 200-row-capped data page", async () => {
    const selected = deferred<FileSummary | null>();
    const adapter = backend({ selectDataFile: vi.fn(() => selected.promise) });
    render(<App backend={adapter} />);

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(screen.getByRole("button", { name: "Opening..." })).toBeDisabled();
    expect(screen.getByText("Opening data file")).toBeInTheDocument();

    selected.resolve(summary);
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(adapter.readPage).toHaveBeenCalledWith({
      sessionId: "session-1",
      offset: 0,
      limit: 200,
    });
    expect(screen.getByRole("grid", { name: "Data preview" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getAllByLabelText("null value").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("empty string")).toHaveTextContent('""');
    expect(screen.getByText("A deliberately long value for truncation")).toHaveAttribute(
      "title",
      "A deliberately long value for truncation",
    );
  });

  it("shows schema and metadata for the selected file", async () => {
    render(<App backend={backend()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("alpha");

    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    const schemaTable = screen.getByRole("table");
    expect(within(schemaTable).getByText("Logical type")).toBeInTheDocument();
    expect(within(schemaTable).getByText("Utf8")).toBeInTheDocument();
    expect(within(schemaTable).getAllByText("Yes")).toHaveLength(3);

    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
    expect(screen.getByRole("heading", { name: "Metadata" })).toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
    expect(screen.getAllByText("Row groups")).toHaveLength(2);
    const rowGroupTable = screen.getByRole("table", { name: "Parquet row groups" });
    expect(within(rowGroupTable).getByText("180 B")).toBeInTheDocument();
    expect(within(rowGroupTable).getByText("ZSTD, SNAPPY")).toBeInTheDocument();
    expect(within(rowGroupTable).getByText("3 / 4 columns")).toBeInTheDocument();
  });

  it("preserves the existing view when file selection is cancelled", async () => {
    const selectDataFile = vi.fn().mockResolvedValueOnce(summary).mockResolvedValueOnce(null);
    render(<App backend={backend({ selectDataFile })} />);
    await openFile();

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled());

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the empty workspace unchanged when initial selection is cancelled", async () => {
    render(<App backend={backend({ selectDataFile: vi.fn().mockResolvedValue(null) })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled());

    expect(screen.getByRole("heading", { name: "No file open" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders typed file errors and can retry without losing the shell", async () => {
    const selectDataFile = vi
      .fn()
      .mockRejectedValueOnce(new DataViewerError("InvalidParquet", "Footer is damaged."))
      .mockResolvedValueOnce(summary);
    render(<App backend={backend({ selectDataFile })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("InvalidParquet");
    expect(alert).toHaveTextContent("Footer is damaged.");
    expect(screen.getByRole("heading", { name: "No file open" })).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the workspace operable when the health check fails", async () => {
    render(
      <App
        backend={backend({ healthCheck: vi.fn().mockRejectedValue(new Error("IPC unavailable")) })}
      />,
    );
    expect(await screen.findByText(/Backend unavailable: IPC unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No file open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled();
  });

  it("supports focus and arrow-key navigation between tabs", () => {
    render(<App backend={backend()} />);
    const openButton = screen.getByRole("button", { name: "Open file" });
    openButton.focus();
    expect(openButton).toHaveFocus();

    const dataTab = screen.getByRole("tab", { name: "Data" });
    dataTab.focus();
    fireEvent.keyDown(dataTab, { key: "ArrowRight" });
    const schemaTab = screen.getByRole("tab", { name: "Schema" });
    expect(schemaTab).toHaveFocus();
    expect(screen.getByRole("heading", { name: "No schema available" })).toBeInTheDocument();
    expect(schemaTab).toHaveAttribute("aria-controls", "viewer-panel");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-schema");
  });

  it("shows an explicit empty-file result without an invalid row range", async () => {
    const emptySummary = summaryWithRows(0);
    const emptyPage: DataPage = { ...page, totalRows: 0, rows: [] };
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(emptySummary),
          readPage: vi.fn().mockResolvedValue(emptyPage),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));

    expect(await screen.findByText("No rows in file")).toBeInTheDocument();
    expect(screen.getByText("No rows", { selector: ".page-status" })).toBeInTheDocument();
    expect(screen.queryByText(/Showing rows/)).not.toBeInTheDocument();
  });

  it("rejects a mismatched page session and preserves the previous data", async () => {
    const replacement = { ...summary, sessionId: "session-2", fileName: "replacement.parquet" };
    const mismatchedPage = { ...page, sessionId: "wrong-session" };
    const selectDataFile = vi
      .fn()
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce(replacement);
    const readPage = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(mismatchedPage);
    const closeDataFile = vi.fn().mockResolvedValue(undefined);
    render(<App backend={backend({ selectDataFile, readPage, closeDataFile })} />);
    await openFile();

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("InvalidResponse");
    expect(screen.getByText("alpha")).toBeInTheDocument();
    await waitFor(() =>
      expect(closeDataFile).toHaveBeenCalledWith("legacy-session-2", "session-2"),
    );
  });

  it("pages through first, middle, and last ranges with correct disabled controls", async () => {
    const firstPage = pageAt(0, 200, 440, "first");
    const middlePage = pageAt(200, 200, 440, "middle");
    const lastPage = pageAt(400, 40, 440, "last");
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(middlePage)
      .mockResolvedValueOnce(lastPage)
      .mockResolvedValueOnce(middlePage);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(summaryWithRows(440)),
          readPage,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("first-0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(screen.getByText("Showing rows 1-200 of 440")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("middle-200")).toBeInTheDocument();
    expect(readPage).toHaveBeenLastCalledWith({
      documentId: "legacy-session-1",
      sessionId: "session-1",
      offset: 200,
      limit: 200,
    });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("last-400")).toBeInTheDocument();
    expect(screen.getByText("Showing rows 401-440 of 440")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("middle-200")).toBeInTheDocument();
    expect(readPage).toHaveBeenLastCalledWith({
      documentId: "legacy-session-1",
      sessionId: "session-1",
      offset: 200,
      limit: 200,
    });
  });

  it("keeps the current grid while loading and ignores a stale successful response", async () => {
    const older = deferred<DataPage>();
    const latest = deferred<DataPage>();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(pageAt(0, 200, 600, "current"))
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(summaryWithRows(600)),
          readPage,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("current-0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getByText("current-0")).toBeInTheDocument();
    expect(screen.getByText("Loading page")).toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toHaveAttribute("aria-busy", "true");

    latest.resolve(pageAt(200, 200, 600, "latest"));
    expect(await screen.findByText("latest-200")).toBeInTheDocument();
    older.resolve(pageAt(200, 200, 600, "stale"));
    await waitFor(() => expect(screen.queryByText("stale-200")).not.toBeInTheDocument());
    expect(screen.getByText("latest-200")).toBeInTheDocument();
  });

  it("ignores a stale page failure without showing an error banner", async () => {
    const older = deferred<DataPage>();
    const latest = deferred<DataPage>();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(pageAt(0, 200, 600, "current"))
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(summaryWithRows(600)),
          readPage,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("current-0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    latest.resolve(pageAt(200, 200, 600, "latest"));
    expect(await screen.findByText("latest-200")).toBeInTheDocument();

    older.reject(new DataViewerError("Io", "Stale read failed."));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("latest-200")).toBeInTheDocument();
  });

  it("renders precision, binary, and nested values as exact truncatable strings", async () => {
    const typedPage: DataPage = {
      sessionId: summary.sessionId,
      offset: 0,
      limit: 200,
      totalRows: 1,
      hasMore: false,
      columns: ["int64", "uint64", "decimal", "timestamp", "binary", "list", "struct"],
      rows: [
        [
          { kind: "int", display: "9223372036854775807" },
          { kind: "int", display: "18446744073709551615" },
          { kind: "decimal", display: "1234567890.123456789" },
          { kind: "timestamp", display: "2026-07-14T12:34:56.123456789+09:00" },
          { kind: "binary", display: "base64:AAECAwQ= (5 bytes)" },
          { kind: "list", display: "[1, null, 9223372036854775807]" },
          { kind: "struct", display: '{"id":1,"payload":{"active":true}}' },
        ],
      ],
    };
    const typedSummary: FileSummary = {
      ...summaryWithRows(1),
      columnCount: typedPage.columns.length,
      columns: typedPage.columns.map((name) => ({
        name,
        logicalType: name,
        nullable: true,
        physicalType: name.toLocaleUpperCase(),
      })),
    };
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(typedSummary),
          readPage: vi.fn().mockResolvedValue(typedPage),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));

    const expectedDisplays = [
      "9223372036854775807",
      "18446744073709551615",
      "1234567890.123456789",
      "2026-07-14 12:34:56.123456789",
      "hex:0001020304 (5 bytes)",
      "[1, null, 9223372036854775807]",
      '{"id":1,"payload":{"active":true}}',
    ];
    for (const display of expectedDisplays) {
      expect(await screen.findByText(display)).toHaveAttribute("title", display);
    }
  });

  it("renders CSV preview, progress, metadata issues, and atomically changes header mode", async () => {
    const configureCsv = vi.fn().mockResolvedValue(csvSummary("present"));
    const readPage = vi.fn().mockResolvedValue(csvPage);
    const auditedCsv = csvSummary();
    auditedCsv.csvMetadata = {
      ...auditedCsv.csvMetadata!,
      rawHeaderCount: 5,
      rawHeaders: ["name", "", "name"],
      rawHeadersTruncated: true,
      headerIssueCount: 2,
      headerIssues: [
        { columnIndex: 1, rawName: "", resolvedName: "column_2", reason: "blank" },
        { columnIndex: 2, rawName: "name", resolvedName: "name_2", reason: "duplicate" },
      ],
    };
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(auditedCsv),
          readPage,
          configureCsv,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("Kim, Mina")).toHaveAttribute("title", "Kim, Mina");
    const csvCells = within(screen.getByRole("grid", { name: "Data preview" })).getAllByRole(
      "gridcell",
    );
    expect(csvCells[1]).toHaveAttribute("title", "line one\nline two");
    expect(screen.getByLabelText("empty string")).toHaveTextContent('""');
    expect(screen.getByText("Calculating CSV row count")).toBeInTheDocument();
    expect(screen.getByText("Showing rows 1-1; total calculating")).toBeInTheDocument();
    expect(screen.getByLabelText("Current file summary")).toHaveTextContent("CSV");

    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
    expect(screen.getByRole("heading", { name: "CSV parsing" })).toBeInTheDocument();
    expect(screen.getByText("Comma (,)")).toBeInTheDocument();
    expect(screen.getByText("Header likely")).toBeInTheDocument();
    expect(screen.getByText("5 (preview truncated)")).toBeInTheDocument();
    const headerIssues = screen.getByRole("table", { name: "CSV header issues" });
    expect(within(headerIssues).getByText("column_2")).toBeInTheDocument();
    expect(within(headerIssues).getByText("name_2")).toBeInTheDocument();
    const issues = screen.getByRole("table", { name: "CSV structure issues" });
    expect(within(issues).getByText("4")).toBeInTheDocument();
    expect(within(issues).getByText("2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Present" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(configureCsv).toHaveBeenCalledWith("legacy-csv-session", "csv-session", "present");
    expect(readPage).toHaveBeenCalledWith({
      documentId: "legacy-csv-session",
      sessionId: "csv-session",
      offset: 0,
      limit: 200,
    });
  });

  it("cancels only the active CSV scan and keeps the preview visible", async () => {
    const cancelled = csvSummary();
    cancelled.rowCountStatus = {
      ...cancelled.rowCountStatus,
      state: "cancelled",
      message: "Cancelled",
    };
    const cancelDataFileTask = vi.fn().mockResolvedValue(cancelled);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(csvSummary()),
          readPage: vi.fn().mockResolvedValue(csvPage),
          cancelDataFileTask,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("Kim, Mina")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
    await waitFor(() =>
      expect(screen.queryByText("Calculating CSV row count")).not.toBeInTheDocument(),
    );
    expect(cancelDataFileTask).toHaveBeenCalledWith("legacy-csv-session", "csv-session", 1);
    expect(
      within(screen.getByRole("grid", { name: "Data preview" })).getByText("Kim, Mina"),
    ).toBeInTheDocument();
  });

  it("shows a stable workspace drop target and dismisses it on leave or Escape", async () => {
    const drag = dragDropHarness();
    const { unmount } = render(<App backend={backend()} dragDropAdapter={drag.adapter} />);
    const openButton = screen.getByRole("button", { name: "Open file" });
    openButton.focus();

    act(() => drag.emit(enter(["C:\\fixtures\\sample.parquet"])));
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Open sample.parquet");
    act(() => drag.emit(over()));
    expect(screen.getAllByTestId("drop-target")).toHaveLength(1);
    act(() => drag.emit({ type: "leave" }));
    expect(screen.queryByTestId("drop-target")).not.toBeInTheDocument();

    act(() => drag.emit(enter(["C:\\fixtures\\sample.csv"])));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("drop-target")).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();

    unmount();
    await waitFor(() => expect(drag.unlisten).toHaveBeenCalledTimes(1));
  });

  it("FMT-007 derives drop support and labels from the runtime format catalog", async () => {
    const drag = dragDropHarness();
    const arrowDescriptor: FormatDescriptor = {
      id: "arrow-ipc",
      displayName: "Arrow IPC",
      extensions: ["arrow", "feather"],
      mimeTypes: ["application/vnd.apache.arrow.file"],
      capabilities: ["typedSchema", "columnProjection"],
    };
    render(
      <App
        backend={backend({ listSupportedFormats: vi.fn().mockResolvedValue([arrowDescriptor]) })}
        dragDropAdapter={drag.adapter}
      />,
    );
    await screen.findByText("Backend connected");

    act(() => drag.emit(enter(["C:\\fixtures\\sample.feather"])));
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Open sample.feather");
    act(() => drag.emit(enter(["C:\\fixtures\\sample.csv"])));
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Unsupported file type");
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Only Arrow IPC files");
  });

  it("FMT-009 renders unknown format details through the generic metadata fallback", async () => {
    const arrowDescriptor: FormatDescriptor = {
      id: "arrow-ipc",
      displayName: "Arrow IPC",
      extensions: ["arrow"],
      mimeTypes: ["application/vnd.apache.arrow.file"],
      capabilities: ["typedSchema", "columnProjection"],
    };
    const arrowSummary: FileSummary = {
      ...summary,
      fileName: "sample.arrow",
      path: "C:\\fixtures\\sample.arrow",
      format: arrowDescriptor.id,
      formatDescriptor: arrowDescriptor,
      rowGroupCount: 0,
      rowGroups: [],
      formatDetails: [
        {
          id: "arrow-file",
          title: "Arrow file",
          kind: "keyValue",
          entries: [
            { label: "Endianness", value: "Little" },
            { label: "Version", value: "V5" },
          ],
        },
        {
          id: "record-batches",
          title: "Record batches",
          kind: "table",
          columns: ["Batch", "Rows"],
          rows: [["0", "4"]],
          truncated: false,
        },
      ],
    };
    render(
      <App
        backend={backend({
          listSupportedFormats: vi.fn().mockResolvedValue([arrowDescriptor]),
          selectDataFile: vi.fn().mockResolvedValue(arrowSummary),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Current file summary")).toHaveTextContent("Arrow IPC");
    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));

    expect(screen.getByText("Little")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Record batches" })).toHaveTextContent("4");
    expect(screen.queryByRole("heading", { name: "CSV parsing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Row groups" })).not.toBeInTheDocument();
  });

  it("opens one dropped file while retaining the current grid until atomic success", async () => {
    const drag = dragDropHarness();
    const pending = deferred<ReturnType<typeof openedFile>>();
    const openDataFile = vi.fn((request: OpenDataRequest) =>
      pending.promise.then(() => openedFile(request, "session-2", "next.csv", "replacement")),
    );
    render(<App backend={backend({ openDataFile })} dragDropAdapter={drag.adapter} />);
    await openFile();

    act(() => drag.emit(drop(["C:\\fixtures\\next.csv"])));
    expect(openDataFile).toHaveBeenCalledWith({
      requestId: "frontend-dragDrop-2",
      origin: "dragDrop",
      paths: ["C:\\fixtures\\next.csv"],
    });
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Opening data file")).toBeInTheDocument();

    pending.resolve(
      openedFile(
        { requestId: "unused", origin: "dragDrop", paths: ["unused"] },
        "unused",
        "unused.csv",
        "unused",
      ),
    );
    expect(await screen.findByText("replacement")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "next.csv" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "primitive-null.parquet" })).toBeInTheDocument();
  });

  it("opens multiple dropped files and reports unsupported items without losing existing tabs", async () => {
    const drag = dragDropHarness();
    const openDataFile = vi.fn(async (request: OpenDataRequest) => {
      if (request.paths.some((path) => path.endsWith(".txt"))) {
        return {
          requestId: request.requestId,
          origin: request.origin,
          opened: [],
          failures: [
            {
              itemIndex: 0,
              path: request.paths[0],
              error: { code: "UnsupportedFormat", message: "Only CSV and Parquet are supported." },
            },
          ],
          activeDocumentId: null,
        };
      }
      const opened = request.paths.map((path, itemIndex) => {
        const fileName = path.split(/[\\/]/).pop()!;
        const legacy = openedFile(
          request,
          `batch-session-${itemIndex}`,
          fileName,
          `batch-${itemIndex}`,
        );
        return {
          itemIndex,
          path,
          disposition: "opened" as const,
          documentId: `batch-document-${itemIndex}`,
          sessionId: `batch-session-${itemIndex}`,
          summary: legacy.summary,
          initialPage: legacy.initialPage,
        };
      });
      return {
        requestId: request.requestId,
        origin: request.origin,
        opened,
        failures: [],
        activeDocumentId: opened[0]?.documentId ?? null,
      };
    });
    render(<App backend={backend({ openDataFile })} dragDropAdapter={drag.adapter} />);
    await openFile();
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));

    act(() => drag.emit(enter(["C:\\a.csv", "C:\\b.parquet"])));
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Open 2 files");
    act(() => drag.emit(drop(["C:\\a.csv", "C:\\b.parquet"])));
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toContain("a.csv"),
    );
    expect(screen.getByRole("tab", { name: "b.parquet" })).toBeInTheDocument();

    act(() => drag.emit(enter(["C:\\fixtures\\notes.txt"])));
    expect(screen.getByTestId("drop-target")).toHaveTextContent("Unsupported file type");
    act(() => drag.emit(drop(["C:\\fixtures\\notes.txt"])));
    const activeTab = screen.getByRole("tab", { name: "a.csv" });
    await waitFor(() => expect(activeTab).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByText("batch-0")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "notes.txt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("UnsupportedFormat");
  });

  it("ignores late success and failure from older dropped-file generations", async () => {
    const drag = dragDropHarness();
    const first = deferred<ReturnType<typeof openedFile>>();
    const second = deferred<ReturnType<typeof openedFile>>();
    const requests: OpenDataRequest[] = [];
    const openDataFile = vi.fn((request: OpenDataRequest) => {
      requests.push(request);
      return requests.length === 1 ? first.promise : second.promise;
    });
    render(<App backend={backend({ openDataFile })} dragDropAdapter={drag.adapter} />);
    await openFile();

    act(() => drag.emit(drop(["C:\\fixtures\\slow.parquet"])));
    act(() => drag.emit(drop(["C:\\fixtures\\latest.parquet"])));
    second.resolve(openedFile(requests[1], "session-latest", "latest.parquet", "latest"));
    expect(await screen.findByText("latest")).toBeInTheDocument();

    first.reject(new DataViewerError("InvalidParquet", "Late failure."));
    await act(async () => Promise.resolve());
    expect(screen.getByText("latest")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled();
  });

  it("consumes pending and live platform requests and cleans up the event subscription", async () => {
    let liveHandler: ((request: OpenDataRequest) => void) | null = null;
    let adapterError: ((error: DataViewerError) => void) | null = null;
    const unlisten = vi.fn();
    const pendingRequest: OpenDataRequest = {
      requestId: "startup-1",
      origin: "startupArg",
      paths: ["C:\\fixtures\\startup.parquet"],
    };
    const openDataFile = vi.fn(async (request: OpenDataRequest) =>
      openedFile(
        request,
        `session-${request.requestId}`,
        `${request.requestId}.parquet`,
        request.requestId,
      ),
    );
    const adapter = backend({
      openDataFile,
      takePendingOpenRequests: vi.fn().mockResolvedValue([pendingRequest]),
      onOpenDataRequest: vi.fn(async (handler, onError) => {
        liveHandler = handler;
        adapterError = onError;
        return unlisten;
      }),
    });
    const { unmount } = render(<App backend={adapter} />);
    expect(await screen.findByText("startup-1")).toBeInTheDocument();
    act(() => liveHandler?.(pendingRequest));
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(1));

    act(() =>
      liveHandler?.({
        requestId: "second-2",
        origin: "fileAssociation",
        paths: ["C:\\fixtures\\second.parquet"],
      }),
    );
    expect(await screen.findByText("second-2")).toBeInTheDocument();
    act(() => adapterError?.(new DataViewerError("InvalidResponse", "Malformed open event.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Malformed open event.");
    expect(screen.getByText("second-2")).toBeInTheDocument();

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("does not drain and lose a deferred startup request during StrictMode effect replay", async () => {
    const pending = deferred<OpenDataRequest[]>();
    const startupRequest: OpenDataRequest = {
      requestId: "strict-startup-1",
      origin: "startupArg",
      paths: ["C:\\fixtures\\strict-startup.parquet"],
    };
    const takePendingOpenRequests = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce([]);
    const openDataFile = vi.fn(async (request: OpenDataRequest) =>
      openedFile(
        request,
        `session-${request.requestId}`,
        "strict-startup.parquet",
        request.requestId,
      ),
    );

    render(
      <StrictMode>
        <App backend={backend({ openDataFile, takePendingOpenRequests })} />
      </StrictMode>,
    );
    await waitFor(() => expect(takePendingOpenRequests).toHaveBeenCalledTimes(1));
    pending.resolve([startupRequest]);

    expect(await screen.findByText("strict-startup-1")).toBeInTheDocument();
    expect(openDataFile).toHaveBeenCalledTimes(1);
    expect(openDataFile).toHaveBeenCalledWith(startupRequest);
    expect(takePendingOpenRequests).toHaveBeenCalledTimes(1);
  });

  it("keeps view state per document and supports document shortcuts and close", async () => {
    const drag = dragDropHarness();
    const closeDataFile = vi.fn().mockResolvedValue(undefined);
    const openDataFile = vi.fn(async (request: OpenDataRequest) => {
      const opened = request.paths.map((path, itemIndex) => {
        const fileName = path.split(/[\\/]/).pop()!;
        const sessionId = `tab-session-${itemIndex}`;
        const legacy = openedFile(request, sessionId, fileName, `tab-${itemIndex}`);
        return {
          itemIndex,
          path,
          disposition: "opened" as const,
          documentId: `tab-document-${itemIndex}`,
          sessionId,
          summary: legacy.summary,
          initialPage: legacy.initialPage,
        };
      });
      return {
        requestId: request.requestId,
        origin: request.origin,
        opened,
        failures: [],
        activeDocumentId: opened[0]?.documentId ?? null,
      };
    });
    render(
      <App backend={backend({ closeDataFile, openDataFile })} dragDropAdapter={drag.adapter} />,
    );

    act(() => drag.emit(drop(["C:\\fixtures\\first.parquet", "C:\\fixtures\\second.csv"])));
    const first = await screen.findByRole("tab", { name: "first.parquet" });
    const second = screen.getByRole("tab", { name: "second.csv" });
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    fireEvent.click(second);
    expect(screen.getByRole("tab", { name: "Data" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Schema" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(screen.queryByRole("tab", { name: "first.parquet" })).not.toBeInTheDocument();
    expect(second).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(second).toHaveFocus());
    expect(closeDataFile).toHaveBeenCalledWith("tab-document-0", "tab-session-0");
  });

  it("disambiguates duplicate basenames with the minimum unique parent suffix", async () => {
    const drag = dragDropHarness();
    const openDataFile = vi.fn(async (request: OpenDataRequest): Promise<OpenDataResponse> => {
      const opened = request.paths.map((path, itemIndex) => {
        const sessionId = `same-session-${itemIndex}`;
        const legacy = openedFile(request, sessionId, "same.csv", `same-${itemIndex}`);
        return {
          itemIndex,
          path,
          disposition: "opened" as const,
          documentId: `same-document-${itemIndex}`,
          sessionId,
          summary: { ...legacy.summary, path },
          initialPage: legacy.initialPage,
        };
      });
      return {
        requestId: request.requestId,
        origin: request.origin,
        opened,
        failures: [],
        activeDocumentId: opened[0].documentId,
      };
    });
    render(<App backend={backend({ openDataFile })} dragDropAdapter={drag.adapter} />);

    act(() => drag.emit(drop(["C:\\exports\\alpha\\same.csv", "C:\\exports\\beta\\same.csv"])));

    await screen.findByText("same-0");
    expect(screen.getByRole("tab", { name: "same.csv (alpha)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "same.csv (beta)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close same.csv (alpha)" })).toBeInTheDocument();
  });

  it("cancels the whole pending batch and cleans every late session without reviving tabs", async () => {
    const drag = dragDropHarness();
    const pending = deferred<OpenDataResponse>();
    const cancelOpenRequest = vi.fn().mockResolvedValue(undefined);
    const closeDataFile = vi.fn().mockResolvedValue(undefined);
    render(
      <App
        backend={backend({
          cancelOpenRequest,
          closeDataFile,
          openDataFile: vi.fn(() => pending.promise),
        })}
        dragDropAdapter={drag.adapter}
      />,
    );

    const paths = ["C:\\fixtures\\closed.csv", "C:\\fixtures\\kept.parquet"];
    act(() => drag.emit(drop(paths)));
    fireEvent.click(await screen.findByRole("button", { name: "Close closed.csv" }));
    expect(cancelOpenRequest).toHaveBeenCalledWith("frontend-dragDrop-1");
    expect(screen.queryByRole("tab", { name: "closed.csv" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "kept.parquet" })).not.toBeInTheDocument();

    const request = { requestId: "frontend-dragDrop-1", origin: "dragDrop" as const, paths };
    const opened = paths.map((path, itemIndex) => {
      const sessionId = `late-session-${itemIndex}`;
      const fileName = path.split(/[\\/]/).pop()!;
      const legacy = openedFile(request, sessionId, fileName, `late-${itemIndex}`);
      return {
        itemIndex,
        path,
        disposition: "opened" as const,
        documentId: `late-document-${itemIndex}`,
        sessionId,
        summary: { ...legacy.summary, path },
        initialPage: legacy.initialPage,
      };
    });
    pending.resolve({
      requestId: request.requestId,
      origin: request.origin,
      opened,
      failures: [],
      activeDocumentId: opened[0].documentId,
    });

    await waitFor(() => expect(closeDataFile).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("tab", { name: "closed.csv" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "kept.parquet" })).not.toBeInTheDocument();
    expect(closeDataFile).toHaveBeenCalledWith("late-document-0", "late-session-0");
    expect(closeDataFile).toHaveBeenCalledWith("late-document-1", "late-session-1");
  });

  it("waits for pending cancellation before reopening the same path", async () => {
    const drag = dragDropHarness();
    const firstOpen = deferred<OpenDataResponse>();
    const cancellation = deferred<void>();
    const cancelOpenRequest = vi.fn(() => cancellation.promise);
    const closeDataFile = vi.fn().mockResolvedValue(undefined);
    const path = "C:\\fixtures\\pending.csv";
    const openDataFile = vi
      .fn()
      .mockImplementationOnce(() => firstOpen.promise)
      .mockImplementationOnce(async (request: OpenDataRequest): Promise<OpenDataResponse> => {
        const legacy = openedFile(request, "reopened-session", "pending.csv", "reopened pending");
        return {
          requestId: request.requestId,
          origin: request.origin,
          opened: [
            {
              itemIndex: 0,
              path,
              disposition: "opened",
              documentId: "reopened-document",
              sessionId: "reopened-session",
              summary: { ...legacy.summary, path },
              initialPage: legacy.initialPage,
            },
          ],
          failures: [],
          activeDocumentId: "reopened-document",
        };
      });
    render(
      <App
        backend={backend({ cancelOpenRequest, closeDataFile, openDataFile })}
        dragDropAdapter={drag.adapter}
      />,
    );

    act(() => drag.emit(drop([path])));
    fireEvent.click(await screen.findByRole("button", { name: "Close pending.csv" }));
    act(() => drag.emit(drop([path])));
    await Promise.resolve();
    expect(openDataFile).toHaveBeenCalledTimes(1);

    cancellation.resolve();
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("reopened pending")).toBeInTheDocument();

    const firstRequest: OpenDataRequest = {
      requestId: "frontend-dragDrop-1",
      origin: "dragDrop",
      paths: [path],
    };
    const late = openedFile(firstRequest, "late-session", "pending.csv", "late pending");
    firstOpen.resolve({
      requestId: firstRequest.requestId,
      origin: firstRequest.origin,
      opened: [
        {
          itemIndex: 0,
          path,
          disposition: "opened",
          documentId: "late-document",
          sessionId: "late-session",
          summary: { ...late.summary, path },
          initialPage: late.initialPage,
        },
      ],
      failures: [],
      activeDocumentId: "late-document",
    });
    await waitFor(() =>
      expect(closeDataFile).toHaveBeenCalledWith("late-document", "late-session"),
    );
    expect(screen.queryByText("late pending")).not.toBeInTheDocument();
    expect(screen.getByText("reopened pending")).toBeInTheDocument();
  });

  it("hands an early cancelled-open identity to the same-path reopen without closing it", async () => {
    const drag = dragDropHarness();
    const firstOpen = deferred<OpenDataResponse>();
    const secondOpen = deferred<OpenDataResponse>();
    const cancellation = deferred<void>();
    const closeDataFile = vi.fn().mockResolvedValue(undefined);
    const requests: OpenDataRequest[] = [];
    const path = "C:\\fixtures\\shared-race.parquet";
    const openDataFile = vi.fn((request: OpenDataRequest) => {
      requests.push(request);
      return requests.length === 1 ? firstOpen.promise : secondOpen.promise;
    });
    render(
      <App
        backend={backend({
          cancelOpenRequest: vi.fn(() => cancellation.promise),
          closeDataFile,
          openDataFile,
        })}
        dragDropAdapter={drag.adapter}
      />,
    );

    act(() => drag.emit(drop([path])));
    fireEvent.click(await screen.findByRole("button", { name: "Close shared-race.parquet" }));
    act(() => drag.emit(drop([path])));
    cancellation.resolve();
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(2));

    const first = openedFile(requests[0], "shared-session", "shared-race.parquet", "first result");
    firstOpen.resolve({
      requestId: requests[0].requestId,
      origin: requests[0].origin,
      opened: [
        {
          itemIndex: 0,
          path,
          disposition: "opened",
          documentId: "shared-document",
          sessionId: "shared-session",
          summary: { ...first.summary, path },
          initialPage: first.initialPage,
        },
      ],
      failures: [],
      activeDocumentId: "shared-document",
    });
    await act(async () => Promise.resolve());
    expect(closeDataFile).not.toHaveBeenCalled();

    const second = openedFile(
      requests[1],
      "shared-session",
      "shared-race.parquet",
      "reopen result",
    );
    secondOpen.resolve({
      requestId: requests[1].requestId,
      origin: requests[1].origin,
      opened: [
        {
          itemIndex: 0,
          path,
          disposition: "existing",
          documentId: "shared-document",
          sessionId: "shared-session",
          summary: { ...second.summary, path },
          initialPage: second.initialPage,
        },
      ],
      failures: [],
      activeDocumentId: "shared-document",
    });

    expect(await screen.findByText("reopen result")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "shared-race.parquet" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(closeDataFile).not.toHaveBeenCalled();
  });

  it("releases the reopen barrier and reports an error when pending cancellation fails", async () => {
    const drag = dragDropHarness();
    const firstOpen = deferred<OpenDataResponse>();
    const cancellation = deferred<void>();
    const path = "C:\\fixtures\\cancel-failure.parquet";
    const openDataFile = vi
      .fn()
      .mockImplementationOnce(() => firstOpen.promise)
      .mockImplementationOnce((request: OpenDataRequest) =>
        Promise.resolve(openedFile(request, "retry-session", "cancel-failure.parquet", "retried")),
      );
    render(
      <App
        backend={backend({
          cancelOpenRequest: vi.fn(() => cancellation.promise),
          openDataFile,
        })}
        dragDropAdapter={drag.adapter}
      />,
    );

    act(() => drag.emit(drop([path])));
    fireEvent.click(await screen.findByRole("button", { name: "Close cancel-failure.parquet" }));
    act(() => drag.emit(drop([path])));
    expect(openDataFile).toHaveBeenCalledTimes(1);

    cancellation.reject(new DataViewerError("CancelFailed", "Cancellation failed."));
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation failed.");
    expect(await screen.findByText("retried")).toBeInTheDocument();
  });

  it("waits for a closing path before reopening the same file", async () => {
    const drag = dragDropHarness();
    const closing = deferred<void>();
    const closeDataFile = vi.fn(() => closing.promise);
    const openDataFile = vi.fn(async (request: OpenDataRequest) => {
      const reopened = openedFile(request, summary.sessionId, summary.fileName, "reopened");
      return {
        requestId: request.requestId,
        origin: request.origin,
        opened: [
          {
            itemIndex: 0,
            path: request.paths[0],
            disposition: "existing" as const,
            documentId: `legacy-${summary.sessionId}`,
            sessionId: summary.sessionId,
            summary: reopened.summary,
            initialPage: reopened.initialPage,
          },
        ],
        failures: [],
        activeDocumentId: `legacy-${summary.sessionId}`,
      };
    });
    render(
      <App backend={backend({ closeDataFile, openDataFile })} dragDropAdapter={drag.adapter} />,
    );
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: `Close ${summary.fileName}` }));

    act(() => drag.emit(drop([summary.path])));
    await Promise.resolve();
    expect(openDataFile).not.toHaveBeenCalled();

    closing.resolve();
    await waitFor(() => expect(openDataFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("reopened")).toBeInTheDocument();
  });

  it("CPY-008 uses the loaded active preset for shortcut and context-menu copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const customSettings: AppSettings = {
      ...defaultAppSettings(),
      copyPreset: "custom",
      copyCustomOptions: {
        ...COPY_PRESETS.custom,
        delimiter: "|",
        quoteMode: "always",
      },
    };
    try {
      render(<App backend={backend({ getSettings: vi.fn().mockResolvedValue(customSettings) })} />);
      await openFile();
      const grid = screen.getByRole("grid", { name: "Data preview" });
      grid.focus();
      fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('"1"|"alpha"'));

      fireEvent.contextMenu(screen.getByText("alpha"), { clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy configured value" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('"alpha"'));

      fireEvent.contextMenu(screen.getByText("alpha"), { clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy with column headers" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('"id"|"label"\r\n"1"|"alpha"'));
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("CSV-001/004 exposes parsing profiles only for capable CSV documents", async () => {
    const getCsvProfile = vi.fn().mockResolvedValue(csvProfileResponse());
    const previewCsvProfile = vi
      .fn()
      .mockImplementation(async (request) => profilePreviewResponse(request.generation));
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(profileCsvSummary()),
          readPage: vi.fn().mockResolvedValue(csvPage),
          getCsvProfile,
          previewCsvProfile,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    expect(screen.getByText("CSV: Auto")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    expect(await screen.findByRole("dialog", { name: "CSV Parsing Profile" })).toBeInTheDocument();
    await waitFor(() => expect(previewCsvProfile).toHaveBeenCalled());
    expect(getCsvProfile).toHaveBeenCalledWith("legacy-csv-session", "csv-session");
  });

  it("CSV-011 blocks profile apply while structural CSV errors remain", async () => {
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(profileCsvSummary("csv-session", true)),
          readPage: vi.fn().mockResolvedValue(csvPage),
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          previewCsvProfile: vi.fn(async (request) => profilePreviewResponse(request.generation)),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "CSV Parsing Profile" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("structural CSV row issue");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("CSV-012 applies a profile atomically after the new session first page is ready", async () => {
    const applying = deferred<{
      documentId: string;
      sessionId: string;
      summary: FileSummary;
    }>();
    const readingAppliedPage = deferred<DataPage>();
    const nextSessionId = "csv-session-profile-4";
    const readPage = vi.fn((request) =>
      request.sessionId === nextSessionId ? readingAppliedPage.promise : Promise.resolve(csvPage),
    );
    const applyCsvProfile = vi.fn(() => applying.promise);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(profileCsvSummary()),
          readPage,
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          previewCsvProfile: vi.fn(async (request) => profilePreviewResponse(request.generation)),
          applyCsvProfile,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "CSV Parsing Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Kim, Mina")).toBeInTheDocument();

    applying.resolve({
      documentId: "legacy-csv-session",
      sessionId: nextSessionId,
      summary: profileCsvSummary(nextSessionId),
    });
    await waitFor(() =>
      expect(readPage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: nextSessionId })),
    );
    expect(
      within(screen.getByRole("grid", { name: "Data preview" })).getByText("Kim, Mina"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "CSV Parsing Profile" })).toBeInTheDocument();

    readingAppliedPage.resolve(appliedCsvPage());
    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "CSV Parsing Profile" })).not.toBeInTheDocument();
    expect(screen.getByText("CSV: Custom")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort name: not sorted" })).toBeInTheDocument();
  });

  it("CSV-017 reruns a compatible query on the replacement profile session", async () => {
    const nextSessionId = "csv-session-compatible-profile";
    const executeQuery = vi.fn(async (request) => queryStatus(request, "complete"));
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: { ...csvPage, sessionId: request.sessionId },
    }));
    const readPage = vi.fn(async (request) =>
      request.sessionId === nextSessionId ? appliedCsvPage(nextSessionId) : csvPage,
    );
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(completedQueryProfileCsvSummary()),
          readPage,
          executeQuery,
          readQueryPage,
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          previewCsvProfile: vi.fn(async (request) => profilePreviewResponse(request.generation)),
          applyCsvProfile: vi.fn(async (request) => ({
            documentId: request.documentId,
            sessionId: nextSessionId,
            summary: queryProfileCsvSummary(nextSessionId),
          })),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(await screen.findByRole("button", { name: "Filter name" }));
    const filterDialog = await screen.findByRole("dialog", { name: "Filter name" });
    fireEvent.change(within(filterDialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "Kim" },
    });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    const previousQueryId = executeQuery.mock.calls[0][0].queryId;

    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    const profileDialog = await screen.findByRole("dialog", { name: "CSV Parsing Profile" });
    fireEvent.click(within(profileDialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));
    const replacement = executeQuery.mock.calls[1][0];
    expect(replacement).toMatchObject({
      sessionId: nextSessionId,
      plan: { filters: [expect.objectContaining({ columnId: "name" })] },
    });
    expect(replacement.queryId).not.toBe(previousQueryId);
    await waitFor(() =>
      expect(readQueryPage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: nextSessionId, queryId: replacement.queryId }),
      ),
    );
    expect(
      readQueryPage.mock.calls.some(
        ([request]) => request.sessionId === nextSessionId && request.queryId === previousQueryId,
      ),
    ).toBe(false);
  });

  it("CSV-018 clears incompatible query conditions with a visible reason", async () => {
    const nextSessionId = "csv-session-incompatible-profile";
    const executeQuery = vi.fn(async (request) => queryStatus(request, "complete"));
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: { ...csvPage, sessionId: request.sessionId },
    }));
    const incompatibleSummary = queryProfileCsvSummary(nextSessionId);
    incompatibleSummary.columns = incompatibleSummary.columns.map((column, index) =>
      index === 0 ? { ...column, logicalType: "Int64", physicalType: "Int64" } : column,
    );
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(completedQueryProfileCsvSummary()),
          readPage: vi.fn(async (request) =>
            request.sessionId === nextSessionId ? appliedCsvPage(nextSessionId) : csvPage,
          ),
          executeQuery,
          readQueryPage,
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          previewCsvProfile: vi.fn(async (request) => profilePreviewResponse(request.generation)),
          applyCsvProfile: vi.fn(async (request) => ({
            documentId: request.documentId,
            sessionId: nextSessionId,
            summary: incompatibleSummary,
          })),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(await screen.findByRole("button", { name: "Filter name" }));
    const filterDialog = await screen.findByRole("dialog", { name: "Filter name" });
    fireEvent.change(within(filterDialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "Kim" },
    });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Sort note: not sorted" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    const profileDialog = await screen.findByRole("dialog", { name: "CSV Parsing Profile" });
    fireEvent.click(within(profileDialog).getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText(/Removed incompatible query conditions.*filter on name/),
    ).toBeInTheDocument();
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(3));
    expect(executeQuery.mock.calls[2][0]).toMatchObject({
      sessionId: nextSessionId,
      plan: { filters: [], sort: [expect.objectContaining({ columnId: "note" })] },
    });
    expect(
      screen.getByText(/Removed incompatible query conditions.*filter on name/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/name contains Kim/)).not.toBeInTheDocument();
  });

  it("CSV-019 applies the All Text default through a new session", async () => {
    const nextSessionId = "csv-session-all-text";
    const applyCsvProfile = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: nextSessionId,
      summary: profileCsvSummary(nextSessionId),
    }));
    const readPage = vi.fn((request) =>
      Promise.resolve(
        request.sessionId === nextSessionId ? appliedCsvPage(nextSessionId) : csvPage,
      ),
    );
    render(
      <App
        backend={backend({
          getSettings: vi.fn().mockResolvedValue({
            ...defaultAppSettings(),
            csvDefaultParsingMode: "allText",
          }),
          selectDataFile: vi.fn().mockResolvedValue(profileCsvSummary()),
          readPage,
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          applyCsvProfile,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() => expect(applyCsvProfile).toHaveBeenCalled());
    expect(applyCsvProfile.mock.calls[0][0].profile).toMatchObject({
      mode: "allText",
      generation: 4,
    });
    expect(
      applyCsvProfile.mock.calls[0][0].profile.columns.every(
        (column: { targetType: string }) => column.targetType === "text",
      ),
    ).toBe(true);
    expect(await screen.findByText("CSV: All Text")).toBeInTheDocument();
    expect(await screen.findByText("7")).toBeInTheDocument();
  });

  it("CSV-020 preserves a query created while the All Text profile is loading", async () => {
    const nextSessionId = "csv-session-all-text-race";
    const pendingProfile = deferred<ReturnType<typeof csvProfileResponse>>();
    const getCsvProfile = vi.fn(() => pendingProfile.promise);
    const executeQuery = vi.fn(async (request) => queryStatus(request, "complete"));
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: { ...csvPage, sessionId: request.sessionId },
    }));
    render(
      <App
        backend={backend({
          getSettings: vi.fn().mockResolvedValue({
            ...defaultAppSettings(),
            csvDefaultParsingMode: "allText",
          }),
          selectDataFile: vi.fn().mockResolvedValue(completedQueryProfileCsvSummary()),
          readPage: vi.fn(async (request) =>
            request.sessionId === nextSessionId ? appliedCsvPage(nextSessionId) : csvPage,
          ),
          getCsvProfile,
          applyCsvProfile: vi.fn(async (request) => ({
            documentId: request.documentId,
            sessionId: nextSessionId,
            summary: queryProfileCsvSummary(nextSessionId),
          })),
          executeQuery,
          readQueryPage,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() => expect(getCsvProfile).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Filter name" }));
    const filterDialog = await screen.findByRole("dialog", { name: "Filter name" });
    fireEvent.change(within(filterDialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "Kim" },
    });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    const previousQueryId = executeQuery.mock.calls[0][0].queryId;

    pendingProfile.resolve(csvProfileResponse());

    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));
    const replacement = executeQuery.mock.calls[1][0];
    expect(replacement).toMatchObject({
      sessionId: nextSessionId,
      plan: { filters: [expect.objectContaining({ columnId: "name" })] },
    });
    await waitFor(() =>
      expect(readQueryPage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: nextSessionId, queryId: replacement.queryId }),
      ),
    );
    expect(
      readQueryPage.mock.calls.some(
        ([request]) => request.sessionId === nextSessionId && request.queryId === previousQueryId,
      ),
    ).toBe(false);
  });

  it("CSV-021 rejects an All Text profile response for another identity", async () => {
    const applyCsvProfile = vi.fn();
    render(
      <App
        backend={backend({
          getSettings: vi.fn().mockResolvedValue({
            ...defaultAppSettings(),
            csvDefaultParsingMode: "allText",
          }),
          selectDataFile: vi.fn().mockResolvedValue(completedQueryProfileCsvSummary()),
          readPage: vi.fn().mockResolvedValue(csvPage),
          getCsvProfile: vi.fn().mockResolvedValue({
            ...csvProfileResponse(),
            documentId: "another-document",
          }),
          applyCsvProfile,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    await act(async () => Promise.resolve());
    expect(applyCsvProfile).not.toHaveBeenCalled();
    expect(screen.getByText("CSV: Auto")).toBeInTheDocument();
    expect(screen.queryByText("CSV: All Text")).not.toBeInTheDocument();
  });

  it("CSV-022 rejects an All Text apply response for another document", async () => {
    const nextSessionId = "csv-session-wrong-document";
    const readPage = vi.fn().mockResolvedValue(csvPage);
    const applyCsvProfile = vi.fn(async () => ({
      documentId: "another-document",
      sessionId: nextSessionId,
      summary: completedQueryProfileCsvSummary(nextSessionId),
    }));
    render(
      <App
        backend={backend({
          getSettings: vi.fn().mockResolvedValue({
            ...defaultAppSettings(),
            csvDefaultParsingMode: "allText",
          }),
          selectDataFile: vi.fn().mockResolvedValue(completedQueryProfileCsvSummary()),
          readPage,
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          applyCsvProfile,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() => expect(applyCsvProfile).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(readPage.mock.calls.some(([request]) => request.sessionId === nextSessionId)).toBe(
      false,
    );
    expect(screen.getByText("CSV: Auto")).toBeInTheDocument();
    expect(screen.queryByText("CSV: All Text")).not.toBeInTheDocument();
  });

  it("CSV-010 polls and cancels full-file profile validation", async () => {
    const queued = {
      taskId: "task-1",
      documentId: "legacy-csv-session",
      sessionId: "csv-session",
      generation: 3,
      state: "running" as const,
      rowsScanned: 0,
      totalRows: 1,
      columns: csvProfile.columns.map((column) => ({
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
    const validateCsvProfile = vi.fn().mockResolvedValue(queued);
    const getCsvProfileValidationStatus = vi
      .fn()
      .mockResolvedValue({ ...queued, state: "running", rowsScanned: 1 });
    const cancelCsvProfileValidation = vi.fn().mockResolvedValue({ ...queued, state: "cancelled" });
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(profileCsvSummary()),
          readPage: vi.fn().mockResolvedValue(csvPage),
          getCsvProfile: vi.fn().mockResolvedValue(csvProfileResponse()),
          previewCsvProfile: vi.fn(async (request) => profilePreviewResponse(request.generation)),
          validateCsvProfile,
          getCsvProfileValidationStatus,
          cancelCsvProfileValidation,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(screen.getByRole("button", { name: "CSV Parsing Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "CSV Parsing Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Validate entire file/ }));
    expect(
      await within(dialog).findByRole("button", { name: /Cancel validation/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(getCsvProfileValidationStatus).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel validation/ }));
    await waitFor(() => expect(cancelCsvProfileValidation).toHaveBeenCalled());
  });

  it("QRY-003 commits a materialized filter only after its first page is ready", async () => {
    const resultPage = deferred<{
      documentId: string;
      sessionId: string;
      queryId: string;
      page: DataPage;
    }>();
    const executeQuery = vi.fn(async (request) => queryStatus(request));
    const getQueryStatus = vi.fn(async (...args: string[]) =>
      queryStatus(
        { documentId: args[0], sessionId: args[1], queryId: args[2], taskId: args[3] },
        "complete",
      ),
    );
    const readQueryPage = vi.fn(() => resultPage.promise);
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
          getQueryStatus,
          readQueryPage,
        })}
      />,
    );
    await openFile();
    const search = await screen.findByRole("searchbox", { name: "Search data" });
    fireEvent.change(search, { target: { value: "alpha" } });
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readQueryPage).toHaveBeenCalledTimes(1));
    expect(screen.getByText("alpha")).toBeInTheDocument();

    const request = executeQuery.mock.calls[0][0];
    resultPage.resolve({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: queryResultPage(),
    });
    expect(await screen.findByText("filtered")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(getQueryStatus).toHaveBeenCalledWith(
      request.documentId,
      request.sessionId,
      request.queryId,
      request.taskId,
    );
  });

  it("QRY-012 ignores task1 late success after task2 commits", async () => {
    const first = deferred<ReturnType<typeof queryStatus>>();
    const second = deferred<ReturnType<typeof queryStatus>>();
    const executeQuery = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const getQueryStatus = vi.fn(async (...args: string[]) =>
      queryStatus(
        { documentId: args[0], sessionId: args[1], queryId: args[2], taskId: args[3] },
        "complete",
      ),
    );
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: queryResultPage("task2"),
    }));
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
          getQueryStatus,
          readQueryPage,
          cancelQuery: vi.fn().mockResolvedValue(undefined),
        })}
      />,
    );
    await openFile();
    const search = await screen.findByRole("searchbox", { name: "Search data" });
    fireEvent.change(search, { target: { value: "first" } });
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    await screen.findByText("Query queued");
    fireEvent.change(search, { target: { value: "second" } });
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));

    second.resolve(queryStatus(executeQuery.mock.calls[1][0]));
    expect(await screen.findByText("task2")).toBeInTheDocument();
    first.resolve(queryStatus(executeQuery.mock.calls[0][0]));
    await act(async () => Promise.resolve());
    expect(screen.getByText("task2")).toBeInTheDocument();
    expect(getQueryStatus).toHaveBeenCalledTimes(1);
  });

  it("QRY-009 keeps the committed result when a replacement query is cancelled", async () => {
    let run = 0;
    const executeQuery = vi.fn(async (request) => {
      run += 1;
      return queryStatus(request, run === 1 ? "complete" : "running");
    });
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page: queryResultPage("committed"),
    }));
    const cancelQuery = vi.fn(async (...args: string[]) =>
      queryStatus(
        { documentId: args[0], sessionId: args[1], queryId: args[2], taskId: args[3] },
        "cancelled",
      ),
    );
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
          readQueryPage,
          cancelQuery,
          getQueryStatus: vi.fn(() => new Promise<ReturnType<typeof queryStatus>>(() => undefined)),
        })}
      />,
    );
    await openFile();
    const search = await screen.findByRole("searchbox", { name: "Search data" });
    fireEvent.change(search, { target: { value: "first" } });
    expect(await screen.findByText("committed")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "second" } });
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelQuery).toHaveBeenCalled());
    expect(screen.getByText("committed")).toBeInTheDocument();
  });

  it("QRY-010 keeps source data and exposes a typed disk-limit failure", async () => {
    const executeQuery = vi.fn(async (request) => queryStatus(request, "failed"));
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
        })}
      />,
    );
    await openFile();
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search data" }), {
      target: { value: "alpha" },
    });
    expect(
      await screen.findByText(/QueryTempLimitExceeded: Disk limit reached/),
    ).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("QRY-012 drops a late query response after its document closes", async () => {
    const pending = deferred<ReturnType<typeof queryStatus>>();
    const executeQuery = vi.fn((request: Parameters<BackendAdapter["executeQuery"]>[0]) => {
      void request;
      return pending.promise;
    });
    const readQueryPage = vi.fn();
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
          readQueryPage,
        })}
      />,
    );
    await openFile();
    fireEvent.click(await screen.findByRole("button", { name: "Filter label" }));
    const filterDialog = await screen.findByRole("dialog", { name: "Filter label" });
    fireEvent.change(within(filterDialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "late" },
    });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: `Close ${summary.fileName}` }));
    pending.resolve(queryStatus(executeQuery.mock.calls[0][0], "complete"));
    await act(async () => Promise.resolve());
    expect(readQueryPage).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "No file open" })).toBeInTheDocument();
  });

  it("QRY-012 drops a late query response after CSV session replacement", async () => {
    const pending = deferred<ReturnType<typeof queryStatus>>();
    const executeQuery = vi.fn((request: Parameters<BackendAdapter["executeQuery"]>[0]) => {
      void request;
      return pending.promise;
    });
    const readQueryPage = vi.fn();
    const nextSession = "csv-session-reconfigured";
    const configuredSummary = queryProfileCsvSummary(nextSession);
    const configureCsv = vi.fn().mockResolvedValue({
      ...configuredSummary,
      csvMetadata: {
        ...configuredSummary.csvMetadata!,
        headerMode: "present",
        headerUsed: true,
      },
    });
    const getDataFileStatus = vi.fn(async () => queryProfileCsvSummary());
    const readPage = vi.fn(async (request) =>
      request.sessionId === nextSession ? { ...csvPage, sessionId: nextSession } : csvPage,
    );
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(queryProfileCsvSummary()),
          readPage,
          executeQuery,
          readQueryPage,
          configureCsv,
          getDataFileStatus,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Kim, Mina");
    fireEvent.click(await screen.findByRole("button", { name: "Filter name" }));
    const filterDialog = await screen.findByRole("dialog", { name: "Filter name" });
    fireEvent.change(within(filterDialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "late" },
    });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(() => expect(configureCsv).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(readPage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: nextSession })),
    );
    pending.resolve(queryStatus(executeQuery.mock.calls[0][0], "complete"));
    await act(async () => Promise.resolve());
    expect(readQueryPage).not.toHaveBeenCalled();
  });

  it("QRY-007/008 pages distinct values and moves Find to the backend match coordinate", async () => {
    const executeQuery = vi.fn(async (request) => ({
      ...queryStatus(request, "complete"),
      findMatchCount: request.plan.search?.mode === "find" ? 2 : null,
    }));
    const readQueryPage = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      page,
    }));
    const listDistinctValues = vi.fn(async (request) => ({
      ...request,
      values: [{ value: "alpha", isNull: false, isInvalid: false, count: 1 }],
      hasMore: false,
    }));
    const findQueryMatch = vi.fn(async (request) => ({
      documentId: request.documentId,
      sessionId: request.sessionId,
      queryId: request.queryId,
      match: {
        rowOffset: 2,
        columnId: "label",
        matchIndex: 1,
        totalMatches: 2,
        wrapped: false,
      },
    }));
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(querySummary()),
          executeQuery,
          readQueryPage,
          listDistinctValues,
          findQueryMatch,
        })}
      />,
    );
    await openFile();
    fireEvent.click(await screen.findByRole("button", { name: "Filter label" }));
    await waitFor(() => expect(listDistinctValues).toHaveBeenCalled());
    expect(
      within(screen.getByRole("dialog", { name: "Filter label" })).getByText("alpha"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close filter" }));

    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search data" }), {
      target: { value: "alpha" },
    });
    await waitFor(() => expect(executeQuery).toHaveBeenCalled());
    await screen.findByText("2 matches");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(findQueryMatch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
        "data-active-row",
        "2",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(findQueryMatch).toHaveBeenCalledTimes(2));
    expect(findQueryMatch.mock.calls[1][0]).toEqual(
      expect.objectContaining({ fromResultOffset: 2, fromMatchIndex: 1 }),
    );
  });

  it("persists settings before committing them and restores the saved value", async () => {
    const pending = deferred<AppSettings>();
    const updateSettings = vi.fn(() => pending.promise);
    render(<App backend={backend({ updateSettings })} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "All Text" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    const saved = { ...defaultAppSettings(), csvDefaultParsingMode: "allText" as const };
    expect(updateSettings).toHaveBeenCalledWith(saved);

    pending.resolve(saved);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Application settings" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "All Text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("QRY-015 displays and clears process query temporary storage", async () => {
    const getQueryTempUsage = vi.fn().mockResolvedValue({
      processBytes: 128 * 1024 * 1024,
      limitBytes: 10 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      activeQueries: 1,
      estimatedTempBytes: null,
      safetyReserveBytes: 5 * 1024 ** 3,
      hardCapBytes: 10 * 1024 ** 3,
      freeBytes: 20 * 1024 ** 3,
    });
    const clearQueryTemp = vi.fn().mockResolvedValue({
      deletedBytes: 128 * 1024 * 1024,
      orphanFailureCount: 0,
      cleanupFailures: [],
      remainingUsage: {
        processBytes: 0,
        limitBytes: 10 * 1024 ** 3,
        availableBytes: 20 * 1024 ** 3,
        activeQueries: 1,
        estimatedTempBytes: null,
        safetyReserveBytes: 5 * 1024 ** 3,
        hardCapBytes: 10 * 1024 ** 3,
        freeBytes: 20 * 1024 ** 3,
      },
    });
    render(<App backend={backend({ getQueryTempUsage, clearQueryTemp })} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText(/128.0 MiB used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear inactive query data" }));
    await waitFor(() => expect(clearQueryTemp).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/0 B used/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Inactive query data cleared. 134,217,728 bytes deleted; 0 bytes remain in use.",
      ),
    ).toBeInTheDocument();
  });

  it("changes the default copy preset without copying immediately", async () => {
    const pending = deferred<AppSettings>();
    const updateSettings = vi.fn(() => pending.promise);
    render(<App backend={backend({ updateSettings })} />);
    await openFile();

    expect(screen.getByText("Copy (EXCEL)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    expect(screen.getByRole("menuitemradio", { name: "Excel" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "CSV" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ copyPreset: "csv" })),
    );
    expect(screen.getByText("Saving copy preset...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy options" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    expect(updateSettings).toHaveBeenCalledTimes(1);

    pending.resolve({ ...defaultAppSettings(), copyPreset: "csv" });
    expect(await screen.findByText("Copy (CSV)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    expect(screen.getByRole("menuitemradio", { name: "CSV" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps a copy preset save failure visible in the data view and allows retry", async () => {
    const updateSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("Atomic preset write failed."))
      .mockImplementationOnce(async (settings: AppSettings) => settings);
    render(<App backend={backend({ updateSettings })} />);
    await openFile();

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy preset was not changed. Atomic preset write failed.",
    );
    expect(screen.getByText("Copy (EXCEL)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy options" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "CSV" }));
    expect(await screen.findByText("Copy (CSV)")).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Copy preset was not changed. Atomic preset write failed."),
    ).not.toBeInTheDocument();
  });

  it("clears a quick preset error after Copy Settings saves persisted settings", async () => {
    const updateSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("Quick preset write failed."))
      .mockImplementationOnce(async (settings: AppSettings) => settings);
    render(<App backend={backend({ updateSettings })} />);
    await openFile();

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy preset was not changed. Quick preset write failed.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    fireEvent.click(screen.getByRole("button", { name: "TSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("Copy (TSV)")).toBeInTheDocument();
    expect(
      screen.queryByText("Copy preset was not changed. Quick preset write failed."),
    ).not.toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous copy settings when save fails or the draft is cancelled", async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error("Atomic write failed."));
    render(<App backend={backend({ updateSettings })} />);
    await openFile();

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Atomic write failed.");
    expect(screen.getByRole("dialog", { name: "Copy settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    expect(screen.getByRole("button", { name: "Excel" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "TSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    expect(screen.getByRole("button", { name: "Excel" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens Copy settings from application settings and updates its summary after save", async () => {
    const updateSettings = vi.fn(async (settings: AppSettings) => settings);
    render(<App backend={backend({ updateSettings })} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy settings" }));
    expect(screen.getByRole("dialog", { name: "Copy settings" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Application settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("dialog", { name: "Application settings" })).toBeInTheDocument();
    expect(screen.getByText("Comma delimiter, no headers")).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ copyPreset: "csv" }));
  });

  it("CPY-010 recovers settings load failure with defaults and a non-blocking warning", async () => {
    render(
      <App
        backend={backend({ getSettings: vi.fn().mockRejectedValue(new Error("Corrupt JSON")) })}
      />,
    );

    expect(await screen.findByText(/Settings could not be loaded/)).toHaveTextContent(
      "Corrupt JSON",
    );
    expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Excel")).toBeInTheDocument();
  });
});
