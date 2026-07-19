import { StrictMode, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DataPage,
  DataValue,
  FileSummary,
  FindBoundaryRequest,
  FindBoundaryResponse,
  ReadPageRequest,
} from "./backend";
import {
  GRID_COLUMN_OVERSCAN,
  GRID_MAX_COLUMN_WIDTH,
  GRID_MIN_COLUMN_WIDTH,
  GRID_ROW_OVERSCAN,
  VirtualDataGrid,
  type VirtualDataGridProps,
} from "./VirtualDataGrid";
import {
  GRID_PAGE_COLUMN_LIMIT,
  compatiblePageFor,
  orderedProjectionForWindow,
} from "./gridProjection";
import { COPY_PRESETS } from "./copy/presets";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "./query/model";
import type { DistinctValuesState } from "./query/ColumnFilterPopover";

const columns = Array.from({ length: 120 }, (_, index) => `column_${index}`);

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

function renderGrid(
  readPage = vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
  writeClipboardText = vi.fn(async () => undefined),
  summaryValue = summary,
  pageValue = makePage(),
  extraProps: Partial<VirtualDataGridProps> = {},
) {
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
        {...extraProps}
      />
    </div>,
  );
  return {
    grid: screen.getByRole("grid", { name: "Data preview" }),
    readPage,
    writeClipboardText,
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
            {...extraProps}
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
    const writeClipboardText = vi.fn(async () => undefined);
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
            writeClipboardText={writeClipboardText}
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
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("0:64"));
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
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: "Data preview" });
      fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
      fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

      await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1));
      expect(readPage).toHaveBeenCalledTimes(Math.ceil(columnCount / 64));
      for (const [request] of readPage.mock.calls) {
        expect(request.columns!.length).toBeLessThanOrEqual(64);
      }
      const copied = writeClipboardText.mock.calls[0]![0];
      const lines = copied.split("\r\n");
      expect(lines).toHaveLength(2);
      expect(lines[0].split("\t")).toHaveLength(columnCount);
      expect(lines[0]).toMatch(new RegExp(`^R0C0\\t.*R0C${columnCount - 1}$`));
      expect(lines[1]).toMatch(new RegExp(`^R1C0\\t.*R1C${columnCount - 1}$`));
    },
  );

  it("uses configured cell and byte limits without a partial clipboard write", async () => {
    const fixture = makeWideCopyFixture(2);
    const writeClipboardText = vi.fn(async () => undefined);
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
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("configured 1-cell");
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
        />
      </div>,
    );
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("5-byte"));
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("rejects a mismatched projection response without writing the clipboard", async () => {
    const fixture = makeWideCopyFixture(65);
    const writeClipboardText = vi.fn(async () => undefined);
    const readPage = vi.fn(async (request: ReadPageRequest) => ({
      ...fixture.pageFor(request.offset, request.columns),
      columns: ["wrong-column"],
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
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("did not match the requested range"),
    );
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("rejects a short projection response when the selected row count is known", async () => {
    const fixture = makeWideCopyFixture(65);
    const writeClipboardText = vi.fn(async () => undefined);
    const readPage = vi.fn(async (request: ReadPageRequest) => {
      const response = fixture.pageFor(request.offset, request.columns);
      return { ...response, rows: response.rows.slice(0, 1) };
    });
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
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("did not match the requested range"),
    );
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
      450,
      (row) => occupiedValue(String(row)),
      null,
    );
    const resolver = vi.fn(async (request: FindBoundaryRequest) =>
      boundaryResponse(request, 449, "a", 450),
    );
    const readPage = vi.fn(async (request: ReadPageRequest) =>
      makeNavigationPage(request, names, 450, (row) => occupiedValue(String(row)), 450),
    );
    const { grid } = renderGrid(readPage, undefined, navigationSummary, initial, {
      findDataBoundary: resolver,
    });
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(grid).toHaveAttribute("data-active-row", "449"));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(readPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 400 }));
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

    await waitFor(() => expect(grid).toHaveAttribute("data-active-row", "0"));
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ row: 1, direction: "up" }));
    expect(grid).toHaveAttribute("data-selection-top", "0");
    expect(grid).toHaveAttribute("data-selection-bottom", "1");
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

  it("cycles stable multi-column sorts and exposes their priorities", () => {
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
      "2",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sort column_0: ascending, priority 1" }), {
      shiftKey: true,
    });
    expect(
      screen.getByRole("button", { name: "Sort column_0: descending, priority 2" }),
    ).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}").sort).toEqual([
      { columnId: "column_1", direction: "ascending", nullsLast: true },
      { columnId: "column_0", direction: "descending", nullsLast: true },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sort column_0: descending, priority 2" }), {
      shiftKey: true,
    });
    expect(JSON.parse(screen.getByTestId("query-plan").textContent ?? "{}").sort).toEqual([
      { columnId: "column_1", direction: "ascending", nullsLast: true },
    ]);
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

    fireEvent.click(within(chooser).getByRole("button", { name: "Show all" }));
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

  it("opens the full-value inspector and returns focus to the logical grid owner", async () => {
    const { grid } = renderGrid();
    fireEvent.doubleClick(within(grid).getByText("R0C0"));
    const inspector = screen.getByRole("dialog", { name: "Full cell value" });
    expect(within(inspector).getByText("R0C0")).toBeInTheDocument();
    fireEvent.keyDown(inspector, { key: "Escape" });
    await waitFor(() => expect(inspector).not.toBeInTheDocument());
    await waitFor(() => expect(grid).toHaveFocus());
    expect(grid).toHaveAttribute("data-active-row", "0");
    expect(grid).toHaveAttribute("data-active-column", "0");
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

  it("copies the logical selection once as exact TSV", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, writeClipboardText);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R2C1"), { shiftKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1));
    expect(writeClipboardText).toHaveBeenCalledWith("R0C0\tR0C1\r\nR1C0\tR1C1\r\nR2C0\tR2C1");
    expect(screen.getByRole("status")).toHaveTextContent("Copied 3 rows");
  });

  it("uses the active copy preset for shortcuts and opens copy settings", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const onOpenCopySettings = vi.fn();
    const onCopyPresetChange = vi.fn();
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
        />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R0C1"), { shiftKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1));
    expect(writeClipboardText).toHaveBeenCalledWith("column_0,column_1\r\nR0C0,R0C1");
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
    expect(writeClipboardText).toHaveBeenCalledTimes(1);

    fireEvent.click(options);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Copy options" }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Copy settings" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Copy options" }), { key: "Escape" });
    expect(options).toHaveFocus();
  });

  it("CPY-009 keeps an immutable preset snapshot for an in-flight copy", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const writeClipboardText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const props = {
      isLoading: false,
      onPageChange: vi.fn(),
      onReadError: vi.fn(),
      page: makePage(),
      readPage: vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
      summary,
      writeClipboardText,
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
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("R0C0\tR0C1"));

    rendered.rerender(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} copyOptions={COPY_PRESETS.csv} />
      </div>,
    );
    releaseFirstWrite?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied 1 rows"));
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(2));
    expect(writeClipboardText).toHaveBeenLastCalledWith("R0C0,R0C1");
  });

  it("preserves an in-range selection on right click and exposes accessible cell actions", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid } = renderGrid(undefined, writeClipboardText);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(within(grid).getByText("R2C1"), { shiftKey: true });
    fireEvent.contextMenu(within(grid).getByText("R1C1"), { clientX: 100, clientY: 120 });

    const menu = screen.getByRole("menu", { name: "Cell actions" });
    expect(grid).toHaveAttribute("data-selection-bottom", "2");
    expect(grid).toHaveAttribute("data-selection-right", "1");
    expect(within(menu).getByRole("menuitem", { name: /Copy Ctrl\+C/ })).toHaveFocus();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy with column headers" }));

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1));
    expect(writeClipboardText).toHaveBeenCalledWith(
      "column_0\tcolumn_1\r\nR0C0\tR0C1\r\nR1C0\tR1C1\r\nR2C0\tR2C1",
    );
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
    let release: ((page: DataPage) => void) | undefined;
    const readPage = vi.fn(
      (request: ReadPageRequest) =>
        new Promise<DataPage>((resolve) => {
          void request;
          release = resolve;
        }),
    );
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid } = renderGrid(readPage, writeClipboardText);
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(readPage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    release?.(makePage(200));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copy cancelled"));
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("disables cancellation after the atomic clipboard commit starts", async () => {
    let finishWrite: (() => void) | undefined;
    const writeClipboardText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { grid } = renderGrid(undefined, writeClipboardText);
    fireEvent.click(within(grid).getByText("R0C0"));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Cancel copy" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finishing copy" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Writing clipboard");

    finishWrite?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied 1 rows"));
  });

  it("discards a pending copy when its grid unmounts", async () => {
    let release: ((page: DataPage) => void) | undefined;
    const readPage = vi.fn(
      () =>
        new Promise<DataPage>((resolve) => {
          release = resolve;
        }),
    );
    const writeClipboardText = vi.fn(async () => undefined);
    const { grid, unmount } = renderGrid(readPage, writeClipboardText);
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(readPage).toHaveBeenCalled());

    unmount();
    release?.(makePage(200));
    await Promise.resolve();

    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("resets selection and pending copy when the query result key changes", async () => {
    let release: ((page: DataPage) => void) | undefined;
    const readPage = vi.fn(
      () =>
        new Promise<DataPage>((resolve) => {
          release = resolve;
        }),
    );
    const writeClipboardText = vi.fn(async () => undefined);
    const props = {
      isLoading: false,
      onPageChange: vi.fn(),
      onReadError: vi.fn(),
      page: makePage(),
      readPage,
      summary,
      writeClipboardText,
    };
    const rendered = render(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} resultKey="wide-session:query-1" />
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Data preview" });
    fireEvent.click(within(grid).getByText("R3C2"));
    expect(grid).toHaveAttribute("data-selection-top", "3");
    fireEvent.click(within(grid).getByRole("columnheader", { name: "column_0" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    await waitFor(() => expect(readPage).toHaveBeenCalled());

    rendered.rerender(
      <div style={{ width: 1024, height: 600 }}>
        <VirtualDataGrid {...props} resultKey="wide-session:query-2" />
      </div>,
    );
    expect(grid).toHaveAttribute("data-selection-top", "0");
    expect(grid).toHaveAttribute("data-selection-left", "0");
    release?.(makePage(200));
    await Promise.resolve();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });
});
