// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  DataViewerError,
  type BackendAdapter,
  type DataPage,
  type FileSummary,
  type OpenDataRequest,
  type OpenDataResponse,
} from "./backend";
import { type DragDropAdapter, type FileDragDropEvent, type FileDragDropHandler } from "./dragDrop";

const summary: FileSummary = {
  sessionId: "session-1",
  fileName: "primitive-null.parquet",
  path: "C:\\fixtures\\primitive-null.parquet",
  format: "parquet",
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

function backend(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  const adapter: BackendAdapter = {
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", appVersion: "0.1.0" }),
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
    configureCsv: vi.fn().mockRejectedValue(new Error("not csv")),
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
    columns: ["id"],
    rows: Array.from({ length: count }, (_, index) => [
      { kind: "int" as const, display: `${prefix}-${offset + index}` },
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
    await openFile();

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
    render(
      <App
        backend={backend({
          selectDataFile: vi.fn().mockResolvedValue(summaryWithRows(1)),
          readPage: vi.fn().mockResolvedValue(typedPage),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));

    for (const display of typedPage.rows[0].map((value) => value.display as string)) {
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
    expect(screen.getByText("Kim, Mina")).toBeInTheDocument();
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
});
