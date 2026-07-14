import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataPage, DataValue, FileSummary, ReadPageRequest } from "./backend";
import {
  GRID_COLUMN_OVERSCAN,
  GRID_MAX_COLUMN_WIDTH,
  GRID_MIN_COLUMN_WIDTH,
  GRID_ROW_OVERSCAN,
  VirtualDataGrid,
} from "./VirtualDataGrid";

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

function renderGrid(
  readPage = vi.fn(async (request: ReadPageRequest) => makePage(request.offset)),
  writeClipboardText = vi.fn(async () => undefined),
) {
  const rendered = render(
    <div style={{ width: 1024, height: 600 }}>
      <VirtualDataGrid
        isLoading={false}
        onPageChange={vi.fn()}
        onReadError={vi.fn()}
        page={makePage()}
        readPage={readPage}
        summary={summary}
        writeClipboardText={writeClipboardText}
      />
    </div>,
  );
  return {
    grid: screen.getByRole("grid", { name: "Data preview" }),
    readPage,
    writeClipboardText,
    unmount: rendered.unmount,
  };
}

describe("VirtualDataGrid", () => {
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
});
