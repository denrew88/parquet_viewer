import { StrictMode, useMemo, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DataPage,
  DataValue,
  FileSummary,
  FindBoundaryRequest,
  FindBoundaryResponse,
  CopyOperationStatus,
  ReadPageRequest,
  StartCopyRequest,
} from "./backend";
import {
  VirtualDataGrid as ProductionVirtualDataGrid,
  type VirtualDataGridProps,
} from "./VirtualDataGrid";
import {
  GRID_COLUMN_OVERSCAN,
  GRID_MAX_COLUMN_WIDTH,
  GRID_MAX_SEGMENT_ROWS,
  GRID_MIN_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  GRID_ROW_OVERSCAN,
  autoFitColumnWidth,
  segmentStartForRow,
} from "./gridSizing";
import {
  GRID_PAGE_COLUMN_LIMIT,
  compatiblePageFor,
  orderedProjectionForWindow,
} from "./gridProjection";
import { COPY_PRESETS } from "./copy/presets";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "./query/model";
import type { DistinctValuesState } from "./query/ColumnFilterPopover";
import { DEFAULT_COPY_LIMITS, DEFAULT_DISPLAY_FORMATS } from "./settings/model";

const columns = Array.from({ length: 120 }, (_, index) => `column_${index}`);

describe("Phase 11 grid sizing primitives", () => {
  it("maps huge logical rows into a bounded segment", () => {
    expect(segmentStartForRow(0, 5_850_000)).toBe(0);
    const middle = segmentStartForRow(986_803, 5_850_000);
    expect(middle).toBeGreaterThan(0);
    expect(986_803 - middle).toBeLessThan(GRID_MAX_SEGMENT_ROWS);
    expect(segmentStartForRow(5_849_999, 5_850_000)).toBe(5_850_000 - GRID_MAX_SEGMENT_ROWS);
  });

  it("auto fits the longest logical line and clamps the result", () => {
    const measure = (value: string) => value.length * 10;
    expect(autoFitColumnWidth("name", ["short", "longest\nline"], measure, 20)).toBe(90);
    expect(autoFitColumnWidth("x", ["y"], () => 1, 0)).toBe(GRID_MIN_COLUMN_WIDTH);
    expect(autoFitColumnWidth("x", ["z".repeat(1000)], measure, 20)).toBe(GRID_MAX_COLUMN_WIDTH);
  });
});

function makePage(offset = 0): DataPage {
  return {
    sessionId: "wide-session",
    offset,
    limit: 200,
    totalRows: 10_240,
    hasMore: offset + 200 < 10_240,
    columns,
    rows: Array.from({ length: 200 }, (_, rowOffset) =>
      columns.map(
        (_, column) =>
          ({ kind: "string", display: `R${offset + rowOffset}C${column}` }) as DataValue,
      ),
    ),
  };
}

const oesColumns = ["time", ...Array.from({ length: 64 }, (_, index) => String(400 + index))];
const oesInitialColumns = oesColumns.slice(0, GRID_PAGE_COLUMN_LIMIT);

function makeOesPage(
  offset = 0,
  projectedColumns: readonly string[] = oesInitialColumns,
): DataPage {
  return {
    sessionId: "oes-wide-session",
    offset,
    limit: 200,
    totalRows: 400,
    hasMore: offset + 200 < 400,
    columns: [...projectedColumns],
    rows: Array.from({ length: 200 }, (_, rowOffset) =>
      projectedColumns.map((column) => ({
        kind: "int",
        display: `${offset + rowOffset}:${oesColumns.indexOf(column)}`,
      })),
    ),
  };
}

function makeWideCopyFixture(columnCount: number, totalRows = 2) {
  const columnNames = Array.from({ length: columnCount }, (_, index) => `wide_${index}`);
  const fixtureSummary: FileSummary = {
    ...summary,
    sessionId: `copy-${columnCount}`,
    rowCount: totalRows,
    rowCountStatus: {
      ...summary.rowCountStatus,
      rowsScanned: totalRows,
    },
    columnCount,
    columns: columnNames.map((name) => ({
      name,
      logicalType: "Utf8",
      physicalType: "BYTE_ARRAY",
      nullable: false,
    })),
  };
  const pageFor = (offset = 0, projectedColumns: readonly string[] = columnNames.slice(0, 64)) => ({
    sessionId: fixtureSummary.sessionId,
    offset,
    limit: Math.min(200, totalRows - offset),
    totalRows,
    hasMore: false,
    columns: [...projectedColumns],
    rows: Array.from({ length: Math.max(0, totalRows - offset) }, (_, rowOffset) =>
      projectedColumns.map((column) => ({
        kind: "string" as const,
        display: `R${offset + rowOffset}C${columnNames.indexOf(column)}`,
      })),
    ),
  });
  return { columnNames, fixtureSummary, pageFor };
}

const summary: FileSummary = {
  sessionId: "wide-session",
  fileName: "wide.parquet",
  path: "C:\\fixtures\\wide.parquet",
  format: "parquet",
  fileSize: 1_000_000,
  rowCount: 10_240,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 10_240,
    bytesScanned: 1_000_000,
    totalBytes: 1_000_000,
    generation: 0,
    message: null,
  },
  columnCount: columns.length,
  rowGroupCount: 1,
  columns: columns.map((name) => ({
    name,
    logicalType: "Utf8",
    physicalType: "BYTE_ARRAY",
    nullable: false,
  })),
  rowGroups: [
    {
      index: 0,
      rowCount: 10_240,
      totalByteSize: 1_000_000,
      compressedSize: 500_000,
      compression: ["ZSTD"],
      statisticsColumnCount: 120,
    },
  ],
  csvMetadata: null,
};

const oesSummary: FileSummary = {
  ...summary,
  sessionId: "oes-wide-session",
  fileName: "wide.oes.h5",
  path: "C:\\fixtures\\wide.oes.h5",
  format: "oesHdf5",
  formatDescriptor: {
    id: "oesHdf5",
    displayName: "OES HDF5",
    extensions: ["h5", "hdf5"],
    mimeTypes: ["application/x-hdf5"],
    capabilities: ["typedSchema", "columnProjection"],
  },
  columnCount: oesColumns.length,
  columns: oesColumns.map((name, index) => ({
    name,
    logicalType: index === 0 ? "Int64" : "Int32",
    physicalType: index === 0 ? "HDF5 int64 attribute" : "HDF5 int32",
    nullable: false,
  })),
};

const queryColumns = columns.slice(0, 4);
const queryPage: DataPage = {
  ...makePage(),
  limit: 8,
  totalRows: 8,
  hasMore: false,
  columns: queryColumns,
  rows: Array.from({ length: 8 }, (_, row) =>
    queryColumns.map(
      (_, column) => ({ kind: "string", display: `R${row}C${column}` }) as DataValue,
    ),
  ),
};
const querySummary: FileSummary = {
  ...summary,
  rowCount: 8,
  columnCount: queryColumns.length,
  columns: summary.columns.slice(0, queryColumns.length),
};

const occupiedValue = (display = "value"): DataValue => ({
  kind: "string",
  display,
  state: "valid",
});
function makeNavigationSummary(
  columnNames: readonly string[],
  rowCount: number | null,
  sessionId = "navigation-session",
): FileSummary {
  return {
    ...summary,
    sessionId,
    fileName: "navigation.parquet",
    path: "C:\\fixtures\\navigation.parquet",
    rowCount,
    rowCountStatus:
      rowCount === null
        ? { ...summary.rowCountStatus, state: "calculating", rowsScanned: 0 }
        : { ...summary.rowCountStatus, state: "complete", rowsScanned: rowCount },
    columnCount: columnNames.length,
    columns: columnNames.map((name) => ({
      name,
      logicalType: "Utf8",
      physicalType: "BYTE_ARRAY",
      nullable: true,
    })),
  };
}

function makeNavigationPage(
  request: ReadPageRequest,
  columnNames: readonly string[],
  actualRowCount: number,
  valueAt: (row: number, column: number) => DataValue,
  reportedRowCount: number | null = actualRowCount,
): DataPage {
  const projectedColumns = request.columns ?? [...columnNames];
  const rowLength = Math.max(0, Math.min(request.limit, actualRowCount - request.offset));
  return {
    sessionId: request.sessionId,
    offset: request.offset,
    limit: request.limit,
    totalRows: reportedRowCount,
    hasMore: request.offset + rowLength < actualRowCount,
    columns: [...projectedColumns],
    rows: Array.from({ length: rowLength }, (_, rowOffset) =>
      projectedColumns.map((columnName) =>
        valueAt(request.offset + rowOffset, columnNames.indexOf(columnName)),
      ),
    ),
  };
}

function completedCopy(request: StartCopyRequest): CopyOperationStatus {
  const totalRows = request.selection.rowEndExclusive - request.selection.rowStart;
  return {
    ...request,
    startedAt: "2026-07-21T12:00:00.000Z",
    state: "complete",
    stage: "complete",
    progress: {
      rowsProcessed: totalRows,
      totalRows,
      cellsProcessed: totalRows * request.selection.columnIds.length,
      bytesSerialized: 32,
    },
    failure: null,
  };
}

function copyOperationHarness() {
  const startCopy = vi.fn<NonNullable<VirtualDataGridProps["startCopy"]>>(async (request) =>
    completedCopy(request),
  );
  return {
    startCopy,
    getCopyStatus: vi.fn<NonNullable<VirtualDataGridProps["getCopyStatus"]>>(async () => {
      throw new Error("A completed copy must not be polled.");
    }),
    cancelCopyOperation: vi.fn<NonNullable<VirtualDataGridProps["cancelCopyOperation"]>>(
      async () => {
        throw new Error("A completed copy cannot be cancelled.");
      },
    ),
    getCopyHistory: vi.fn<NonNullable<VirtualDataGridProps["getCopyHistory"]>>(async () => ({
      current: null,
      previous: [],
    })),
  } satisfies Partial<VirtualDataGridProps>;
}

type TestVirtualDataGridProps = Omit<
  VirtualDataGridProps,
  "documentId" | "startCopy" | "getCopyStatus" | "cancelCopyOperation" | "getCopyHistory"
> &
  Partial<
    Pick<
      VirtualDataGridProps,
      "documentId" | "startCopy" | "getCopyStatus" | "cancelCopyOperation" | "getCopyHistory"
    >
  >;

function VirtualDataGrid(props: TestVirtualDataGridProps) {
  const copyOperations = useMemo(copyOperationHarness, []);
  return (
    <ProductionVirtualDataGrid
      documentId={props.documentId ?? "test-document"}
      {...copyOperations}
      {...props}
    />
  );
}

function renderGrid(
  readPage = vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
  writeClipboardText = vi.fn(async () => undefined),
  summaryValue = summary,
  pageValue = makePage(),
  extraProps: Partial<VirtualDataGridProps> = {},
) {
  const copyOperations = copyOperationHarness();
  const rendered = render(
    <div style={{ width: 1024, height: 600 }}>
      <VirtualDataGrid
        isLoading={false}
        onPageChange={vi.fn()}
        onReadError={vi.fn()}
        page={pageValue}
        readPage={readPage}
        summary={summaryValue}
        writeClipboardText={writeClipboardText}
        {...copyOperations}
        {...extraProps}
      />
    </div>,
  );
  return {
    grid: screen.getByRole("grid", { name: "Data preview" }),
    readPage,
    writeClipboardText,
    ...copyOperations,
    rerenderSummary(nextSummary: FileSummary) {
      rendered.rerender(
        <div style={{ width: 1024, height: 600 }}>
          <VirtualDataGrid
            isLoading={false}
            onPageChange={vi.fn()}
            onReadError={vi.fn()}
            page={pageValue}
            readPage={readPage}
            summary={nextSummary}
            writeClipboardText={writeClipboardText}
            {...copyOperations}
            {...extraProps}
          />
        </div>,
      );
    },
    rerenderProps(nextProps: Partial<VirtualDataGridProps>) {
      rendered.rerender(
        <div style={{ width: 1024, height: 600 }}>
          <VirtualDataGrid
            isLoading={false}
            onPageChange={vi.fn()}
            onReadError={vi.fn()}
            page={pageValue}
            readPage={readPage}
            summary={summaryValue}
            writeClipboardText={writeClipboardText}
            {...copyOperations}
            {...extraProps}
            {...nextProps}
          />
        </div>,
      );
    },
    unmount: rendered.unmount,
  };
}

function QueryGridHarness({
  initialPlan = EMPTY_QUERY_PLAN,
  distinct,
  page = queryPage,
  summaryValue = querySummary,
}: {
  initialPlan?: QueryPlan;
  distinct?: DistinctValuesState;
  page?: DataPage;
  summaryValue?: FileSummary;
}) {
  const [plan, setPlan] = useState(initialPlan);
  return (
    <div style={{ width: 1024, height: 600 }}>
      <output data-testid="query-plan">{JSON.stringify(plan)}</output>
      <VirtualDataGrid
        distinctValuesForColumn={(columnId) => (columnId === "column_0" ? distinct : undefined)}
        isLoading={false}
        onPageChange={vi.fn()}
        onQueryPlanChange={setPlan}
        onReadError={vi.fn()}
        page={page}
        queryActive
        queryPlan={plan}
        readPage={vi.fn(async () => page)}
        summary={summaryValue}
      />
    </div>
  );
}

describe("VirtualDataGrid", () => {
  it("builds a bounded ordered projection that reaches the final logical column", () => {
    expect(orderedProjectionForWindow(oesColumns, [0, 1, 2], oesInitialColumns)).toEqual(
      oesInitialColumns,
    );
    expect(orderedProjectionForWindow(oesColumns, [62, 63, 64], oesInitialColumns)).toEqual(
      oesColumns.slice(1),
    );
    const sparseProjection = orderedProjectionForWindow(oesColumns, [0, 64], oesInitialColumns);
    expect(sparseProjection).toHaveLength(GRID_PAGE_COLUMN_LIMIT);
    expect(sparseProjection).toContain("time");
    expect(sparseProjection).toContain("463");
  });

  it("uses the summary schema for OES selection and requests the final wavelength projection", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) =>
      makeOesPage(request.offset, request.columns),
    );
    render(
      <StrictMode>
        <div style={{ width: 1024, height: 600 }}>
          <VirtualDataGrid
            isLoading={false}
            onPageChange={vi.fn()}
            onReadError={vi.fn()}
            page={makeOesPage()}
            readPage={readPage}
            summary={oesSummary}
          />
        </div>
      </StrictMode>,
    );

    expect(screen.getByText("65 / 65 columns")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search data" })).not.toBeInTheDocument();
    const grid = screen.getByRole("grid", { name: "Data preview" });
    grid.scrollLeft = 20_000;
    fireEvent.scroll(grid);
    fireEvent.keyDown(grid, { key: "End" });

    await waitFor(() =>
      expect(readPage).toHaveBeenCalledWith({
        sessionId: oesSummary.sessionId,
        offset: 0,
        limit: 200,
        columns: oesColumns.slice(1),
      }),
    );
    expect(grid).toHaveAttribute("data-active-column", "64");
  });

  it.each([65, 129])(
    "copies all %i logical columns through projections of at most 64 columns",
    async (columnCount) => {
      const fixture = makeWideCopyFixture(columnCount);
      const readPage = vi.fn(async (request: ReadPageRequest) =>
        fixture.pageFor(request.offset, request.columns),
      );
      const writeClipboardText = vi.fn(async (text: string) => {
        void text;
      });
      const copyOperations = copyOperationHarness();
      render(
        <div style={{ width: 1024, height: 600 }}>
          <VirtualDataGrid
            isLoading={false}
            onPageChange={vi.fn()}
            onReadError={vi.fn()}
            page={fixture.pageFor()}
            readPage={readPage}
            summary={fixture.fixtureSummary}
            writeClipboardText={writeClipboardText}
            {...copyOperations}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: "Data preview" });
      fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
      fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

      await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
      expect(copyOperations.startCopy.mock.calls[0]![0].selection).toEqual({
        rowStart: 0,
        rowEndExclusive: 2,
        columnIds: fixture.columnNames,
      });
      expect(readPage).not.toHaveBeenCalled();
      expect(writeClipboardText).not.toHaveBeenCalled();
    },
  );

  it("uses configured cell and byte limits without a partial clipboard write", async () => {
    const fixture = makeWideCopyFixture(2);
    const writeClipboardText = vi.fn(async () => undefined);
    const copyOperations = copyOperationHarness();
    const rendered = render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          copyLimits={{ maxCells: 1, maxBytes: 64 * 1024 * 1024 }}
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={fixture.pageFor()}
          readPage={vi.fn(async (request: ReadPageRequest) =>
            fixture.pageFor(request.offset, request.columns),
          )}
          summary={fixture.fixtureSummary}
          writeClipboardText={writeClipboardText}
          {...copyOperations}
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    expect(copyOperations.startCopy.mock.calls[0]![0]).toMatchObject({ maxCells: 1 });
    expect(writeClipboardText).not.toHaveBeenCalled();

    rendered.rerender(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          copyLimits={{ maxCells: 10, maxBytes: 5 }}
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={fixture.pageFor()}
          readPage={vi.fn(async (request: ReadPageRequest) =>
            fixture.pageFor(request.offset, request.columns),
          )}
          summary={fixture.fixtureSummary}
          writeClipboardText={writeClipboardText}
          {...copyOperations}
        />
      </div>,
    );
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(2));
    expect(copyOperations.startCopy.mock.calls[1]![0]).toMatchObject({ maxBytes: 5 });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("shows the backend stage and reason for a typed copy failure", async () => {
    const fixture = makeWideCopyFixture(65);
    const writeClipboardText = vi.fn(async () => undefined);
    const readPage = vi.fn(async (request: ReadPageRequest) => ({
      ...fixture.pageFor(request.offset, request.columns),
      columns: ["wrong-column"],
    }));
    const copyOperations = copyOperationHarness();
    let failedStatus: CopyOperationStatus | null = null;
    copyOperations.startCopy.mockImplementation(async (request) => {
      failedStatus = {
        ...completedCopy(request),
        state: "failed",
        stage: "sourceRead",
        progress: { rowsProcessed: 0, totalRows: 2, cellsProcessed: 0, bytesSerialized: 0 },
        failure: { reason: "sourceRead", message: "The source page became unavailable." },
      };
      return failedStatus;
    });
    copyOperations.getCopyHistory.mockImplementation(async () => ({
      current: failedStatus,
      previous: [],
    }));
    render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={fixture.pageFor()}
          readPage={readPage}
          summary={fixture.fixtureSummary}
          writeClipboardText={writeClipboardText}
          {...copyOperations}
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "failed during sourceRead (sourceRead): The source page became unavailable.",
      ),
    );
    expect(readPage).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
    const historyTrigger = await screen.findByRole("button", { name: "Copy history" });
    fireEvent.click(historyTrigger);
    expect(screen.getByRole("list", { name: "Copy history" })).toHaveTextContent(
      "sourceRead: The source page became unavailable.",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Copy history" })).not.toBeInTheDocument();
    expect(historyTrigger).toHaveFocus();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("passes byte limits atomically to the backend operation", async () => {
    const fixture = makeWideCopyFixture(65);
    const writeClipboardText = vi.fn(async () => undefined);
    const readPage = vi.fn(async (request: ReadPageRequest) => {
      const response = fixture.pageFor(request.offset, request.columns);
      return { ...response, rows: response.rows.slice(0, 1) };
    });
    const copyOperations = copyOperationHarness();
    render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={fixture.pageFor()}
          readPage={readPage}
          summary={fixture.fixtureSummary}
          writeClipboardText={writeClipboardText}
          {...copyOperations}
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    expect(copyOperations.startCopy.mock.calls[0]![0]).toMatchObject({
      maxCells: DEFAULT_COPY_LIMITS.maxCells,
      maxBytes: DEFAULT_COPY_LIMITS.maxBytes,
    });
    expect(readPage).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("discards a late horizontal projection instead of caching it for the active window", async () => {
    let releaseLate: ((page: DataPage) => void) | undefined;
    const readPage = vi.fn(
      (request: ReadPageRequest) =>
        new Promise<DataPage>((resolve) => {
          if (!releaseLate) releaseLate = resolve;
          else resolve(makeOesPage(request.offset, request.columns));
        }),
    );
    render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={makeOesPage()}
          readPage={readPage}
          summary={oesSummary}
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    grid.scrollLeft = 20_000;
    fireEvent.scroll(grid);
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(1));

    grid.scrollLeft = 0;
    fireEvent.scroll(grid);
    await waitFor(() =>
      expect(within(grid).getByRole("columnheader", { name: "time" })).toBeInTheDocument(),
    );
    releaseLate?.(makeOesPage(0, oesColumns.slice(1)));
    await Promise.resolve();

    grid.scrollLeft = 20_000;
    fireEvent.scroll(grid);
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
  });

  it("virtualizes a 10k x 120 dataset within the fixed DOM budget", () => {
    const { grid } = renderGrid();
    const mountedRows = Number(grid.dataset.mountedRows);
    const mountedColumns = Number(grid.dataset.mountedColumns);
    const mountedCells = Number(grid.dataset.mountedCells);

    expect(mountedRows).toBeLessThanOrEqual(60);
    expect(mountedColumns).toBeLessThanOrEqual(32);
    expect(mountedCells).toBeLessThanOrEqual(1_500);
    expect(mountedRows).toBeGreaterThan(GRID_ROW_OVERSCAN);
    expect(mountedColumns).toBeGreaterThan(GRID_COLUMN_OVERSCAN);
    expect(grid).toHaveAttribute("aria-rowcount", "10240");
    expect(within(grid).getByText("R0C0")).toHaveAttribute("data-grid-row", "0");
    expect(screen.queryByLabelText("Query tools")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filter column_0" })).not.toBeInTheDocument();
  });

  function boundaryResponse(
    request: FindBoundaryRequest,
    targetRow: number,
    targetColumnId = request.columnId,
    resolvedRowCount: number | null = null,
  ): FindBoundaryResponse {
    return {
      navigationId: request.navigationId,
      documentId: request.documentId,
      sessionId: request.sessionId,
      ...(request.queryId ? { queryId: request.queryId } : {}),
      targetRow,
      targetColumnId,
      resolvedRowCount,
    };
  }

  it("NAV-RPC-001 resolves once without intermediate page reads when the target is cached", async () => {
    const names = ["a", "b", "c"];
    const navigationSummary = makeNavigationSummary(names, 6);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      6,
      (row, column) => occupiedValue(`${row}:${column}`),
    );
    const readPage = vi.fn(async () => initial);
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 0, "b", 6),
    );
    const { grid } = renderGrid(readPage, undefined, navigationSummary, initial, {
      documentId: "document-1",
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowRight", ctrlKey: true });
    await waitFor(() => expect(grid).toHaveAttribute("data-active-column", "1"));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toMatchObject({
      documentId: "document-1",
      sessionId: navigationSummary.sessionId,
      row: 0,
      columnId: "a",
      visibleColumnIds: names,
      direction: "right",
      mode: "dataBoundary",
    });
    expect(readPage).not.toHaveBeenCalled();
  });

  it("NAV-RPC-002 reads only the resolved target page for unknown EOF", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, null);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      250_000,
      (row) => occupiedValue(String(row)),
      null,
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 249_999, "a", 250_000),
    );
    const readPage = vi.fn(async (request: ReadPageRequest) =>
      makeNavigationPage(request, names, 250_000, (row) => occupiedValue(String(row)), 250_000),
    );
    const { grid } = renderGrid(readPage, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(grid).toHaveAttribute("data-active-row", "249999"));
    await waitFor(() =>
      expect(grid.querySelector('[data-grid-row="249999"][data-grid-column="0"]')).toBeVisible(),
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(readPage.mock.calls.map(([request]) => request.offset)).toEqual([249_800]);
  });

  it("NAV-RPC-002 keeps selection and scroll unchanged when the target page fails", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, null);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      450,
      (row) => occupiedValue(String(row)),
      null,
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 449, "a", 450),
    );
    const readPage = vi.fn(async () => {
      throw new Error("target page failed");
    });
    const onReadError = vi.fn();
    const { grid } = renderGrid(readPage, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
      onReadError,
    });

    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });

    await waitFor(() => expect(onReadError).toHaveBeenCalledTimes(1));
    expect(grid).toHaveAttribute("data-active-row", "0");
    expect(grid).toHaveAttribute("data-selection-bottom", "0");
    expect(grid.scrollTop).toBe(0);
  });

  it("NAV-RPC-003 sends visible order without hidden columns", async () => {
    const names = ["a", "b", "c"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      (row, column) => occupiedValue(`${row}:${column}`),
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 0, "c", 2),
    );
    const { grid } = renderGrid(undefined, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    fireEvent.keyDown(grid, { key: "ArrowRight", ctrlKey: true });
    await waitFor(() => expect(grid).toHaveAttribute("data-active-column", "2"));
    expect(resolver.mock.calls[0][0].visibleColumnIds).toEqual(["a", "c"]);
  });

  it("NAV-RPC-004 preserves the Shift anchor", async () => {
    const names = ["a", "b", "c"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      () => occupiedValue(),
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 0, "c", 2),
    );
    const { grid } = renderGrid(undefined, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(grid).toHaveAttribute("data-selection-left", "0");
      expect(grid).toHaveAttribute("data-selection-right", "2");
    });
  });

  it("NAV-RPC-004 serializes consecutive absolute and Shift boundary keys", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      () => occupiedValue(),
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, request.direction === "down" ? 1 : 0, "a", 2),
    );
    const { grid } = renderGrid(undefined, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
    });

    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true, altKey: true });
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ row: 1, direction: "up" }));
      expect(grid).toHaveAttribute("data-active-row", "0");
      expect(grid).toHaveAttribute("data-selection-top", "0");
      expect(grid).toHaveAttribute("data-selection-bottom", "1");
    });
  });

  it("NAV-RPC-005 cancels on selection and discards late response", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      () => occupiedValue(),
    );
    let resolveBoundary: ((response: FindBoundaryResponse) => void) | undefined;
    let request: FindBoundaryRequest | undefined;
    const resolver = vi.fn(
      (next: FindBoundaryRequest) =>
        new Promise<FindBoundaryResponse>((resolve) => {
          request = next;
          resolveBoundary = resolve;
        }),
    );
    const cancel = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, undefined, navigationSummary, initial, {
      cancelDataBoundaryNavigation: cancel,
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    const selectedCell = grid.querySelector<HTMLElement>(
      '[data-grid-row="1"][data-grid-column="0"]',
    )!;
    fireEvent.pointerDown(selectedCell, { button: 0 });
    fireEvent.click(selectedCell);
    resolveBoundary?.(boundaryResponse(request!, 1, "a", 2));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(grid).toHaveAttribute("data-active-row", "1");
  });

  it("NAV-RPC-006 cancels on result change and discards stale identity", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      () => occupiedValue(),
    );
    let resolveBoundary: ((response: FindBoundaryResponse) => void) | undefined;
    let request: FindBoundaryRequest | undefined;
    const resolver = vi.fn(
      (next: FindBoundaryRequest) =>
        new Promise<FindBoundaryResponse>((resolve) => {
          request = next;
          resolveBoundary = resolve;
        }),
    );
    const cancel = vi.fn(async () => undefined);
    const { grid, rerenderSummary } = renderGrid(undefined, undefined, navigationSummary, initial, {
      cancelDataBoundaryNavigation: cancel,
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    rerenderSummary(makeNavigationSummary(names, 2, "replacement-session"));
    resolveBoundary?.({ ...boundaryResponse(request!, 1, "a", 2), navigationId: "stale" });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(grid).toHaveAttribute("data-active-row", "0");
  });

  it("NAV-RPC-007 cancels on focus loss and never steals focus", async () => {
    const names = ["a"];
    const navigationSummary = makeNavigationSummary(names, 2);
    const initial = makeNavigationPage(
      { sessionId: navigationSummary.sessionId, offset: 0, limit: 200, columns: names },
      names,
      2,
      () => occupiedValue(),
    );
    let resolveBoundary: ((response: FindBoundaryResponse) => void) | undefined;
    let request: FindBoundaryRequest | undefined;
    const resolver = vi.fn(
      (next: FindBoundaryRequest) =>
        new Promise<FindBoundaryResponse>((resolve) => {
          request = next;
          resolveBoundary = resolve;
        }),
    );
    const cancel = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, undefined, navigationSummary, initial, {
      cancelDataBoundaryNavigation: cancel,
      findDataBoundary: resolver,
    });
    const input = document.createElement("input");
    document.body.append(input);
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    input.focus();
    resolveBoundary?.(boundaryResponse(request!, 1, "a", 2));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(input).toHaveFocus();
    expect(grid).toHaveAttribute("data-active-row", "0");
    input.remove();
  });

  it("reuses the initial prop page after the bounded page cache evicts it", () => {
    const propPage = makePage(0);
    const cachedPages = [makePage(200), makePage(400), makePage(600)];

    expect(compatiblePageFor(cachedPages, propPage, 0, ["column_0"])).toBe(propPage);
    expect(compatiblePageFor(cachedPages, propPage, 600, ["column_0"])).toBe(cachedPages[2]);
  });

  it("treats Shift+header as the same single-column sort cycle", () => {
    render(<QueryGridHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Sort column_0: not sorted" }));
    expect(
      screen.getByRole("button", { name: "Sort column_0: ascending, priority 1" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Sort priority 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sort column_1: not sorted" }), {
      shiftKey: true,
    });
    expect(screen.getAllByLabelText(/Sort priority/).map((item) => item.textContent)).toEqual([
      "1",
    ]);
    expect(
      screen.queryByRole("button", { name: /Sort column_0: ascending/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sort column_1: ascending, priority 1" }), {
      shiftKey: true,
    });
    expect(
      screen.getByRole("button", { name: "Sort column_1: descending, priority 1" }),
    ).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}").sort).toEqual([
      { columnId: "column_1", direction: "descending", nullsLast: true },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sort column_1: descending, priority 1" }), {
      shiftKey: true,
    });
    expect(JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}").sort).toEqual([]);
  });

  it("reorders columns by stable ID with Alt+Shift+Arrow", () => {
    const { grid } = renderGrid();
    fireEvent.keyDown(within(grid).getByRole("columnheader", { name: "column_1" }), {
      altKey: true,
      shiftKey: true,
      key: "ArrowLeft",
    });

    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label?.startsWith("column_")));
    expect(headers.slice(0, 2)).toEqual(["column_1", "column_0"]);
    fireEvent.click(within(grid).getByText("R0C1"));
    expect(grid).toHaveAttribute("data-active-column", "0");
  });

  it("keeps new sort choices in immutable source schema order after column reorder", () => {
    render(<QueryGridHarness />);
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(within(grid).getByRole("columnheader", { name: "column_1" }), {
      altKey: true,
      shiftKey: true,
      key: "ArrowLeft",
    });
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((header) => header.getAttribute("aria-label"))
        .filter((label): label is string => Boolean(label?.startsWith("column_")))
        .slice(0, 2),
    ).toEqual(["column_1", "column_0"]);

    fireEvent.click(screen.getByRole("button", { name: "Sorts (0)" }));
    fireEvent.click(screen.getByRole("button", { name: "Add level" }));
    const listbox = screen.getByRole("listbox", { name: "Columns for sort priority 1" });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["column_0", "column_1", "column_2", "column_3"]);
  });

  it("restores source column order while preserving the active column identity", () => {
    const { grid } = renderGrid();
    fireEvent.keyDown(within(grid).getByRole("columnheader", { name: "column_1" }), {
      altKey: true,
      shiftKey: true,
      key: "ArrowLeft",
    });
    fireEvent.click(within(grid).getByText("R0C1"));
    const restore = screen.getByRole("button", { name: "Restore source column order" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label?.startsWith("column_")));
    expect(headers.slice(0, 2)).toEqual(["column_0", "column_1"]);
    expect(grid).toHaveAttribute("data-active-column", "1");
    expect(restore).toBeDisabled();
  });

  it("lifts the mounted column into a non-interactive strip during pointer reorder", () => {
    const { grid, readPage } = renderGrid();
    readPage.mockClear();
    grid.getBoundingClientRect = () =>
      ({ left: 0, right: 1024, top: 0, bottom: 600, width: 1024, height: 600 }) as DOMRect;
    const source = within(grid).getByRole("columnheader", { name: "column_1" });
    Object.assign(source, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    const pointerEvent = (type: string, clientX: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY: 18,
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 7 },
      });
      return event;
    };
    fireEvent(source, pointerEvent("pointerdown", 120));
    fireEvent(source, pointerEvent("pointermove", 150));
    const overlay = screen.getByTestId("column-drag-overlay");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveTextContent("column_1");
    const liftedCells = Array.from(overlay.querySelectorAll<HTMLElement>(".virtual-grid__cell"));
    expect(liftedCells.length).toBeGreaterThan(1);
    expect(liftedCells.length).toBeLessThanOrEqual(Number(grid.dataset.mountedRows));
    expect(liftedCells[0]).toHaveStyle({ height: `${GRID_ROW_HEIGHT}px`, top: "36px" });
    expect(Number.parseFloat(liftedCells[1]!.style.top)).toBe(
      Number.parseFloat(liftedCells[0]!.style.top) + GRID_ROW_HEIGHT,
    );
    expect(source).toHaveClass("is-reordering");
    expect(source.className).not.toContain("is-insert-");
    expect(screen.getByRole("button", { name: "Restore source column order" })).toBeDisabled();
    expect(readPage).not.toHaveBeenCalled();
    fireEvent(source, pointerEvent("pointercancel", 150));
    expect(screen.queryByTestId("column-drag-overlay")).not.toBeInTheDocument();
  });

  it("freezes projection reads during drag and resumes the latest projection after drop", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) =>
      makeOesPage(request.offset, request.columns),
    );
    const { grid } = renderGrid(readPage, undefined, oesSummary, makeOesPage());
    await waitFor(() =>
      expect(within(grid).getByRole("columnheader", { name: "400" })).toBeInTheDocument(),
    );
    readPage.mockClear();
    const source = within(grid).getByRole("columnheader", { name: "400" });
    Object.assign(source, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    const pointerEvent = (type: string, clientX: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY: 18,
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 17 },
      });
      return event;
    };
    fireEvent(source, pointerEvent("pointerdown", 120));
    fireEvent(source, pointerEvent("pointermove", 160));
    grid.scrollLeft = 20_000;
    fireEvent.scroll(grid);
    fireEvent.keyDown(grid, { key: "End" });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(readPage).not.toHaveBeenCalled();

    fireEvent(window, pointerEvent("pointerup", 160));
    expect(screen.queryByTestId("column-drag-overlay")).not.toBeInTheDocument();
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(1));
    expect(readPage.mock.calls[0]?.[0].columns).toContain("463");
  });

  it("locks every vertical wheel delta during column drag and retains horizontal edge scroll", async () => {
    const { grid } = renderGrid();
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 1024 });
    Object.defineProperty(grid, "scrollWidth", { configurable: true, value: 20_000 });
    grid.getBoundingClientRect = () =>
      ({ left: 0, right: 1024, top: 0, bottom: 600, width: 1024, height: 600 }) as DOMRect;
    const source = within(grid).getByRole("columnheader", { name: "column_1" });
    Object.assign(source, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    const pointerEvent = (type: string, clientX: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY: 18,
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 19 },
      });
      return event;
    };
    fireEvent(source, pointerEvent("pointerdown", 120));
    fireEvent(source, pointerEvent("pointermove", 1010));
    const beforeTop = grid.scrollTop;
    const diagonalWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 120,
      deltaY: 1,
    });
    fireEvent(grid, diagonalWheel);
    expect(diagonalWheel.defaultPrevented).toBe(true);
    expect(grid.scrollTop).toBe(beforeTop);
    await waitFor(() => expect(grid.scrollLeft).toBeGreaterThan(0));
    fireEvent(source, pointerEvent("pointercancel", 1010));
  });

  it("pauses page requests while its document tab is inactive", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) => makePage(request.offset));
    const { grid } = renderGrid(readPage, undefined, summary, makePage(), { active: false });
    Object.defineProperty(grid, "scrollTop", { configurable: true, writable: true, value: 4_000 });
    fireEvent.scroll(grid);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(readPage).not.toHaveBeenCalled();
  });

  it("does not restart adjacent prefetch when a cached tab becomes active", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) => makePage(request.offset));
    const cachedPage = {
      ...makePage(),
      limit: 10,
      rows: makePage().rows.slice(0, 10),
      hasMore: true,
    };
    const rendered = renderGrid(readPage, undefined, summary, cachedPage, { active: false });

    rendered.rerenderProps({ active: true });
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(readPage).not.toHaveBeenCalled();
  });

  it("builds one OR filter from multiple distinct values", async () => {
    const distinct: DistinctValuesState = {
      values: [
        { value: "alpha", count: 4 },
        { value: "beta", count: 3 },
      ],
      loading: false,
      error: null,
      hasMore: false,
      onSearch: vi.fn(),
      onLoadMore: vi.fn(),
    };
    render(<QueryGridHarness distinct={distinct} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter column_0" }));
    const dialog = screen.getByRole("dialog", { name: "Filter column_0" });
    fireEvent.click(within(dialog).getByRole("button", { name: /alpha/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /beta/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}").filters).toEqual([
      {
        id: "filter:column_0",
        columnId: "column_0",
        scalarType: "text",
        operator: "oneOf",
        values: ["alpha", "beta"],
      },
    ]);
    expect(screen.getByRole("button", { name: "Filter column_0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clamps the filter popover and restores trigger focus on Escape", async () => {
    render(<QueryGridHarness />);
    const trigger = screen.getByRole("button", { name: "Filter column_0" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: window.innerWidth + 100,
      y: window.innerHeight + 100,
      left: window.innerWidth + 100,
      right: window.innerWidth + 122,
      top: window.innerHeight + 100,
      bottom: window.innerHeight + 122,
      width: 22,
      height: 22,
      toJSON: () => ({}),
    });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Filter column_0" });
    const host = dialog.parentElement;
    await waitFor(() =>
      expect(Number.parseFloat(host?.style.left ?? "Infinity")).toBeLessThan(window.innerWidth),
    );
    expect(Number.parseFloat(host?.style.top ?? "Infinity")).toBeLessThan(window.innerHeight);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows a query-aware empty state and clears only filter/search conditions", () => {
    const emptyPage = { ...queryPage, totalRows: 0, rows: [] };
    const initialPlan: QueryPlan = {
      filters: [
        {
          id: "filter:column_0",
          columnId: "column_0",
          scalarType: "text",
          operator: "equals",
          values: ["missing"],
        },
      ],
      search: null,
      sort: [{ columnId: "column_1", direction: "ascending", nullsLast: true }],
      projection: ["column_0", "column_1"],
    };
    render(
      <QueryGridHarness initialPlan={initialPlan} page={emptyPage} summaryValue={querySummary} />,
    );

    expect(screen.getByText("No rows match the current query")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear query" }));
    const next = JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}") as QueryPlan;
    expect(next.filters).toEqual([]);
    expect(next.search).toBeNull();
    expect(next.sort).toEqual(initialPlan.sort);
    expect(next.projection).toEqual(initialPlan.projection);
    expect(screen.getByText("No rows in file")).toBeInTheDocument();
  });

  it("searches, hides, and restores columns without changing the data mapping", async () => {
    const { grid } = renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    const chooser = screen.getByRole("dialog", { name: "Column chooser" });
    const search = screen.getByRole("searchbox", { name: "Search columns" });
    fireEvent.change(search, { target: { value: "COLUMN_119" } });

    await waitFor(() =>
      expect(within(chooser).queryByRole("button", { name: "column_0" })).not.toBeInTheDocument(),
    );
    const target = within(chooser).getByRole("button", { name: "column_119" });
    fireEvent.click(target);
    expect(screen.getByText("119 / 120 columns")).toBeInTheDocument();
    expect(within(grid).getByText("R0C0")).toBeInTheDocument();

    if (!screen.queryByRole("dialog", { name: "Column chooser" })) {
      fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    }
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Column chooser" })).getByRole("button", {
        name: "Show all",
      }),
    );
    expect(screen.getByText("120 / 120 columns")).toBeInTheDocument();
  });

  it("clamps keyboard column resize and exposes its accessible value", () => {
    renderGrid();
    const separator = screen.getByRole("separator", { name: "Resize column_0" });
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", String(GRID_MIN_COLUMN_WIDTH));
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", String(GRID_MAX_COLUMN_WIDTH));
  });

  it("auto fits a column from the separator and the accessible column chooser action", () => {
    renderGrid();
    const separator = screen.getByRole("separator", { name: "Resize column_0" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", String(GRID_MAX_COLUMN_WIDTH));
    fireEvent.doubleClick(separator);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
      GRID_MIN_COLUMN_WIDTH,
    );
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeLessThan(GRID_MAX_COLUMN_WIDTH);

    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto fit column_0" }));
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
      GRID_MIN_COLUMN_WIDTH,
    );
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeLessThan(GRID_MAX_COLUMN_WIDTH);
  });

  it("opens the full-value inspector and returns focus to the logical grid owner", async () => {
    const { grid } = renderGrid();
    fireEvent.doubleClick(within(grid).getByText("R0C0"));
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    expect(within(inspector).getAllByText("R0C0")).toHaveLength(2);
    fireEvent.keyDown(inspector, { key: "Escape" });
    await waitFor(() => expect(inspector).not.toBeInTheDocument());
    await waitFor(() => expect(grid).toHaveFocus());
    expect(grid).toHaveAttribute("data-active-row", "0");
    expect(grid).toHaveAttribute("data-active-column", "0");
  });

  it("exposes timestamp display, raw metadata, and explicit copy representations", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const timestampPage = makePage();
    timestampPage.rows[0][0] = {
      kind: "timestamp",
      display: "2025-12-18 10:23:34.111111111",
      sourceDisplay: "1766021014111111111",
      rawDisplay: "1766021014111111111 [unit=ns, timezone=Asia/Seoul]",
      state: "valid",
    };
    const { grid } = renderGrid(undefined, writeClipboardText, summary, timestampPage);
    fireEvent.doubleClick(within(grid).getByText("2025-12-18 10:23:34.111111111"));
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    expect(within(inspector).getByText("Unit: ns")).toBeInTheDocument();
    expect(within(inspector).getByText("Timezone: Asia/Seoul")).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "Copy raw value" }));
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        "1766021014111111111 [unit=ns, timezone=Asia/Seoul]",
      ),
    );
  });

  it("reformats an open inspector when display settings change", () => {
    const timestampPage = makePage();
    timestampPage.rows[0][0] = {
      kind: "timestamp",
      display: "2025-12-18T10:23:34.111111111+09:00",
      sourceDisplay: "1766021014111111111",
      unit: "ns",
      timezone: "+09:00",
      rawDisplay: "1766021014111111111 [unit=ns, timezone=+09:00]",
      state: "valid",
    };
    const { grid, rerenderProps } = renderGrid(undefined, undefined, summary, timestampPage);
    fireEvent.doubleClick(
      grid.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]')!,
    );
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    expect(within(inspector).getAllByText("2025-12-18 10:23:34.111111111")).not.toHaveLength(0);
    rerenderProps({
      displayFormats: {
        ...DEFAULT_DISPLAY_FORMATS,
        timestamp: {
          ...DEFAULT_DISPLAY_FORMATS.timestamp,
          dateTimeSeparator: "t",
          timezoneSuffix: "offset",
        },
      },
    });
    expect(within(inspector).getAllByText("2025-12-18T10:23:34.111111111+09:00")).not.toHaveLength(
      0,
    );
  });

  it("does not commit a late single-cell copy after its grid becomes inactive", async () => {
    let resolveValue!: (value: DataValue) => void;
    const readCellValue = vi.fn(
      () =>
        new Promise<DataValue>((resolve) => {
          resolveValue = resolve;
        }),
    );
    const writeClipboardText = vi.fn(async () => undefined);
    const timestampPage = makePage();
    timestampPage.rows[0][0] = {
      kind: "timestamp",
      display: "2025-12-18T10:23:34Z",
      sourceDisplay: "1",
      unit: "ns",
      timezone: "UTC",
      rawDisplay: "1 [unit=ns, timezone=UTC]",
      state: "valid",
    };
    const { grid, rerenderProps } = renderGrid(
      undefined,
      writeClipboardText,
      summary,
      timestampPage,
      { readCellValue },
    );
    fireEvent.doubleClick(
      grid.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]')!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy raw value" }));
    rerenderProps({ active: false });
    resolveValue({
      kind: "timestamp",
      display: "2025-12-18T10:23:34Z",
      sourceDisplay: "1",
      unit: "ns",
      timezone: "UTC",
      rawDisplay: "1 [unit=ns, timezone=UTC]",
      state: "valid",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("loads an explicit full binary value only when the inspector opens", async () => {
    const binaryPage = makePage();
    binaryPage.rows[0][0] = {
      kind: "binary",
      display: "base64:AQIDBA== (4096 bytes)",
      sourceDisplay: "base64:AQIDBA== (4096 bytes)",
      state: "valid",
    };
    const readCellValue = vi.fn(async () => ({
      kind: "binary" as const,
      display: "base64:AQIDBAUGBwg= (8 bytes)",
      sourceDisplay: "base64:AQIDBAUGBwg= (8 bytes)",
      state: "valid" as const,
    }));
    const { grid } = renderGrid(undefined, undefined, summary, binaryPage, { readCellValue });
    expect(readCellValue).not.toHaveBeenCalled();
    const binaryCell = grid.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(binaryCell).not.toBeNull();
    fireEvent.doubleClick(binaryCell!);
    await waitFor(() => expect(readCellValue).toHaveBeenCalledWith(0, "column_0"));
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    await waitFor(() =>
      expect(within(inspector).getAllByText(/AQIDBAUGBwg=/).length).toBeGreaterThan(0),
    );
  });

  it("keeps a late full-value response from overwriting a newer inspector", async () => {
    let resolveFirst!: (value: DataValue) => void;
    const first = new Promise<DataValue>((resolve) => {
      resolveFirst = resolve;
    });
    const readCellValue = vi.fn((row: number) =>
      row === 0
        ? first
        : Promise.resolve({
            kind: "string" as const,
            display: "full-second",
            sourceDisplay: "full-second",
            state: "valid" as const,
          }),
    );
    const { grid } = renderGrid(undefined, undefined, summary, makePage(), { readCellValue });
    fireEvent.doubleClick(
      grid.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]')!,
    );
    fireEvent.doubleClick(
      grid.querySelector<HTMLElement>('[data-grid-row="1"][data-grid-column="0"]')!,
    );
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    await waitFor(() =>
      expect(within(inspector).getAllByText("full-second").length).toBeGreaterThan(0),
    );
    resolveFirst({
      kind: "string",
      display: "late-first",
      sourceDisplay: "late-first",
      state: "valid",
    });
    await waitFor(() =>
      expect(within(inspector).queryByText("late-first")).not.toBeInTheDocument(),
    );
    expect(within(inspector).getByText(/Row 2,/)).toBeInTheDocument();
  });

  it("does not reopen a closed inspector when its full value arrives", async () => {
    let resolveValue!: (value: DataValue) => void;
    const readCellValue = vi.fn(
      () =>
        new Promise<DataValue>((resolve) => {
          resolveValue = resolve;
        }),
    );
    const { grid } = renderGrid(undefined, undefined, summary, makePage(), { readCellValue });
    fireEvent.doubleClick(
      grid.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]')!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close value inspector" }));
    resolveValue({
      kind: "string",
      display: "late-value",
      sourceDisplay: "late-value",
      state: "valid",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Full cell value" })).not.toBeInTheDocument(),
    );
  });

  it("keeps logical range selection across keyboard movement", () => {
    const { grid } = renderGrid();
    fireEvent.click(within(grid).getByText("R2C2"));
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });

    expect(grid).toHaveAttribute("data-active-row", "3");
    expect(grid).toHaveAttribute("data-active-column", "3");
    expect(grid).toHaveAttribute("data-selection-top", "2");
    expect(grid).toHaveAttribute("data-selection-left", "2");
    expect(grid).toHaveAttribute("data-selection-bottom", "3");
    expect(grid).toHaveAttribute("data-selection-right", "3");
    expect(within(grid).getByText("R2C2")).toHaveAttribute("aria-selected", "true");
    expect(within(grid).getByText("R3C3")).toHaveClass("is-active");
  });

  it("does not intercept spreadsheet shortcuts owned by search and resize controls", () => {
    const { grid } = renderGrid();
    const search = screen.getByRole("searchbox", { name: "Search columns" });
    fireEvent.change(search, { target: { value: "column" } });
    fireEvent.keyDown(search, { key: "a", ctrlKey: true });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveValue("column");
    expect(grid).toHaveAttribute("data-selection-kind", "cell");

    const separator = screen.getByRole("separator", { name: "Resize column_0" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(grid).toHaveAttribute("data-active-column", "0");
  });

  it("closes copy options on scroll and resize", () => {
    renderGrid();
    const trigger = screen.getByRole("button", { name: "Copy options" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Copy options" })).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu", { name: "Copy options" })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Copy options" })).toBeInTheDocument();
    fireEvent.resize(window);
    expect(screen.queryByRole("menu", { name: "Copy options" })).not.toBeInTheDocument();
  });

  it("copies the logical selection once as exact TSV", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid, startCopy } = renderGrid(undefined, writeClipboardText);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R2C1"), { shiftKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() => expect(startCopy).toHaveBeenCalledTimes(1));
    expect(startCopy.mock.calls[0]![0]).toMatchObject({
      selection: { rowStart: 0, rowEndExclusive: 3, columnIds: ["column_0", "column_1"] },
      options: { delimiter: "\t", includeHeaders: false, representation: "display" },
    });
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("3 rows copied");
  });

  it("warns above the Excel worksheet row limit without truncating the copy selection", async () => {
    const totalRows = 1_048_577;
    const largeSummary: FileSummary = {
      ...summary,
      rowCount: totalRows,
      rowCountStatus: { ...summary.rowCountStatus, rowsScanned: totalRows },
      columnCount: 1,
      columns: summary.columns.slice(0, 1),
    };
    const largePage: DataPage = {
      ...makePage(),
      totalRows,
      hasMore: true,
      columns: ["column_0"],
      rows: Array.from({ length: 200 }, (_, row) => [{ kind: "string", display: `R${row}C0` }]),
    };
    const copyOperations = copyOperationHarness();
    render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          copyOptions={COPY_PRESETS.excel}
          isLoading={false}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={largePage}
          readPage={vi.fn(async () => largePage)}
          summary={largeSummary}
          {...copyOperations}
        />
      </div>,
    );

    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    expect(screen.getByText(/Excel limit:/)).toHaveTextContent(
      "Excel limit: 1,048,577 rows exceed 1,048,576; copy is not truncated.",
    );
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    expect(copyOperations.startCopy.mock.calls[0]![0].selection).toMatchObject({
      rowStart: 0,
      rowEndExclusive: totalRows,
    });
  });

  it("uses the active copy preset for shortcuts and opens copy settings", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const onOpenCopySettings = vi.fn();
    const onCopyPresetChange = vi.fn();
    const copyOperations = copyOperationHarness();
    render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid
          copyOptions={{ ...COPY_PRESETS.csv, includeHeaders: true }}
          isLoading={false}
          onCopyPresetChange={onCopyPresetChange}
          onOpenCopySettings={onOpenCopySettings}
          onPageChange={vi.fn()}
          onReadError={vi.fn()}
          page={makePage()}
          readPage={vi.fn(async (request: ReadPageRequest) => makePage(request.offset))}
          summary={summary}
          writeClipboardText={writeClipboardText}
          {...copyOperations}
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R0C1"), { shiftKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    expect(copyOperations.startCopy.mock.calls[0]![0].options).toMatchObject({
      delimiter: ",",
      includeHeaders: true,
    });
    expect(writeClipboardText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    expect(onOpenCopySettings).toHaveBeenCalledTimes(1);

    const options = screen.getByRole("button", { name: "Copy options" });
    fireEvent.click(options);
    expect(screen.getByRole("menuitem", { name: "Copy with column headers" })).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "CSV" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "TSV" }));
    expect(onCopyPresetChange).toHaveBeenCalledWith("tsv");
    expect(copyOperations.startCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(options);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Copy options" }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Copy settings" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Copy options" }), { key: "Escape" });
    expect(options).toHaveFocus();
  });

  it("CPY-009 keeps an immutable preset snapshot for an in-flight copy", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const copyOperations = copyOperationHarness();
    const props = {
      isLoading: false,
      onPageChange: vi.fn(),
      onReadError: vi.fn(),
      page: makePage(),
      readPage: vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
      summary,
      writeClipboardText,
      ...copyOperations,
    };
    const rendered = render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} copyOptions={COPY_PRESETS.excel} />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R0C1"), { shiftKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    const firstSnapshot = structuredClone(copyOperations.startCopy.mock.calls[0]![0]);

    rendered.rerender(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} copyOptions={COPY_PRESETS.csv} />
      </div>,
    );
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(2));
    expect(firstSnapshot.options.delimiter).toBe("\t");
    expect(copyOperations.startCopy.mock.calls[0]![0]).toEqual(firstSnapshot);
    expect(copyOperations.startCopy.mock.calls[1]![0].options.delimiter).toBe(",");
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("preserves an in-range selection on right click and exposes accessible cell actions", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid, startCopy } = renderGrid(undefined, writeClipboardText);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R2C1"), { shiftKey: true });
    fireEvent.contextMenu(within(grid).getByText("R1C1"), { clientX: 100, clientY: 120 });

    const menu = screen.getByRole("menu", { name: "Cell actions" });
    expect(grid).toHaveAttribute("data-selection-bottom", "2");
    expect(grid).toHaveAttribute("data-selection-right", "1");
    expect(within(menu).getByRole("menuitem", { name: /Copy Ctrl\+C/ })).toHaveFocus();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy with column headers" }));

    await waitFor(() => expect(startCopy).toHaveBeenCalledTimes(1));
    expect(startCopy.mock.calls[0]![0]).toMatchObject({
      selection: { rowStart: 0, rowEndExclusive: 3, columnIds: ["column_0", "column_1"] },
      options: { includeHeaders: true },
    });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("selects an out-of-range context target and supports keyboard menu invocation", async () => {
    const { grid } = renderGrid();
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.contextMenu(within(grid).getByText("R3C2"), { clientX: 9_999, clientY: 9_999 });
    expect(grid).toHaveAttribute("data-selection-top", "3");
    expect(grid).toHaveAttribute("data-selection-left", "2");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(grid).toHaveFocus());

    fireEvent.keyDown(grid, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Cell actions" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "View full value" })).toHaveFocus();
  });

  it("cancels a chunked copy without a partial clipboard write", async () => {
    const copyOperations = copyOperationHarness();
    copyOperations.startCopy.mockImplementation(async (request) => ({
      ...completedCopy(request),
      state: "running",
      stage: "sourceRead",
    }));
    copyOperations.getCopyStatus.mockImplementation(async (request) => ({
      ...completedCopy(copyOperations.startCopy.mock.calls[0]![0]),
      ...request,
      state: "running",
      stage: "sourceRead",
    }));
    copyOperations.cancelCopyOperation.mockImplementation(async (request) => ({
      ...completedCopy(copyOperations.startCopy.mock.calls[0]![0]),
      ...request,
      state: "cancelled",
      stage: "sourceRead",
      failure: { reason: "cancelled", message: "Cancelled by user." },
    }));
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, writeClipboardText, summary, makePage(), copyOperations);
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));

    await waitFor(() => expect(copyOperations.cancelCopyOperation).toHaveBeenCalledTimes(1));
    expect(copyOperations.cancelCopyOperation.mock.calls[0]![0].operationId).toBe(
      copyOperations.startCopy.mock.calls[0]![0].operationId,
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("cancelled"));
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("disables cancellation after the atomic clipboard commit starts", async () => {
    const copyOperations = copyOperationHarness();
    copyOperations.startCopy.mockImplementation(async (request) => ({
      ...completedCopy(request),
      state: "committing",
      stage: "clipboardWrite",
    }));
    copyOperations.getCopyStatus.mockImplementation(async () => ({
      ...completedCopy(copyOperations.startCopy.mock.calls[0]![0]),
      state: "committing",
      stage: "clipboardWrite",
    }));
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, writeClipboardText, summary, makePage(), copyOperations);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));

    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Cancel copy" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finishing copy" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("committing / clipboardWrite");
    expect(copyOperations.cancelCopyOperation).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("discards a pending copy when its grid unmounts", async () => {
    let release: ((status: CopyOperationStatus) => void) | undefined;
    const copyOperations = copyOperationHarness();
    copyOperations.startCopy.mockImplementation(
      () => new Promise<CopyOperationStatus>((resolve) => (release = resolve)),
    );
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid, unmount } = renderGrid(
      undefined,
      writeClipboardText,
      summary,
      makePage(),
      copyOperations,
    );
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));

    unmount();
    release?.(completedCopy(copyOperations.startCopy.mock.calls[0]![0]));
    await Promise.resolve();

    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("preserves and collapses the logical active cell while cancelling pending copy", async () => {
    const copyOperations = copyOperationHarness();
    copyOperations.startCopy.mockImplementation(async (request) => ({
      ...completedCopy(request),
      state: "running",
      stage: "sourceRead",
    }));
    copyOperations.getCopyStatus.mockImplementation(async () => ({
      ...completedCopy(copyOperations.startCopy.mock.calls[0]![0]),
      state: "running",
      stage: "sourceRead",
    }));
    const writeClipboardText = vi.fn(async () => undefined);
    const props = {
      isLoading: false,
      onPageChange: vi.fn(),
      onReadError: vi.fn(),
      page: makePage(),
      readPage: vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
      summary,
      writeClipboardText,
      ...copyOperations,
    };
    const rendered = render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} resultKey="wide-session:query-1" />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    const resizedColumn = screen.getByRole("separator", { name: "Resize column_0" });
    fireEvent.keyDown(resizedColumn, { key: "End" });
    expect(resizedColumn).toHaveAttribute("aria-valuenow", String(GRID_MAX_COLUMN_WIDTH));
    fireEvent.click(within(grid).getByText("R3C2"));
    expect(grid).toHaveAttribute("data-selection-top", "3");
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(copyOperations.startCopy).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} resultKey="wide-session:query-2" />
      </div>,
    );
    expect(grid).toHaveAttribute("data-selection-top", "10239");
    expect(grid).toHaveAttribute("data-selection-bottom", "10239");
    expect(grid).toHaveAttribute("data-selection-left", "0");
    expect(grid).toHaveAttribute("data-selection-kind", "cell");
    expect(screen.getByRole("separator", { name: "Resize column_0" })).toHaveAttribute(
      "aria-valuenow",
      String(GRID_MAX_COLUMN_WIDTH),
    );
    expect(copyOperations.cancelCopyOperation).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });
});
