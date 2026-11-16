// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  browserMockBackend,
  type DataPage,
  type FileSummary,
  type ReadPageRequest,
} from "../backend";
import type { VirtualDataGridProps } from "../VirtualDataGrid";
import { defaultAppSettings } from "../settings/model";
import { SqlSourceData } from "./SqlSourceData";

vi.mock("../VirtualDataGrid", () => ({
  VirtualDataGrid: (props: VirtualDataGridProps) => (
    <div>
      <span>{props.page.rows[0]?.[0]?.display}</span>
      <span data-testid="source-offset">{props.page.offset}</span>
      <button type="button" onClick={() => props.onPageChange(1_000_200)}>
        Last source page
      </button>
      <button
        type="button"
        onClick={() =>
          void props.readPage({
            sessionId: props.summary.sessionId,
            offset: 0,
            limit: 200,
            columns: [props.logicalColumnNames![props.logicalColumnNames!.length - 1]],
          })
        }
      >
        Project last column
      </button>
    </div>
  ),
}));

function summary(sessionId = "source-a"): FileSummary {
  return {
    sessionId,
    fileName: `${sessionId}.parquet`,
    path: `C:/${sessionId}.parquet`,
    format: "parquet",
    fileSize: 42,
    rowCount: 1_000_257,
    columnCount: 12,
    rowGroupCount: 1,
    rowGroups: [],
    csvMetadata: null,
    rowCountStatus: {
      state: "complete",
      rowsScanned: 1_000_257,
      bytesScanned: 42,
      totalBytes: 42,
      generation: 0,
      message: null,
    },
    columns: Array.from({ length: 12 }, (_, i) => ({
      name: `column_${i}`,
      logicalType: "Int64",
      valueLogicalType: "Int64",
      physicalType: "INT64",
      nullable: false,
    })),
  };
}
function page(sessionId: string, offset = 0): DataPage {
  return {
    sessionId,
    offset,
    limit: 200,
    totalRows: 1_000_257,
    hasMore: offset < 1_000_200,
    columns: ["column_0"],
    rows: [[{ kind: "int", display: `${sessionId}:${offset}`, rawDisplay: `${offset}` }]],
  };
}
describe("SQL full source browser", () => {
  it("keeps the latest source view while a foreground page request is pending", async () => {
    let finish!: (next: DataPage) => void;
    const pending = new Promise<DataPage>((resolve) => {
      finish = resolve;
    });
    const readPage = vi.fn((request: ReadPageRequest) =>
      request.offset ? pending : Promise.resolve(page(request.sessionId)),
    );
    render(
      <SqlSourceData
        active
        source={{ documentId: "a", sessionId: "source-a" }}
        summary={summary()}
        settings={defaultAppSettings()}
        backend={{ ...browserMockBackend, readPage }}
      />,
    );
    await screen.findByText("source-a:0");
    fireEvent.click(screen.getByRole("button", { name: "Last source page" }));
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    await act(async () => {
      finish(page("source-a", 1_000_200));
      await pending;
    });
    expect(screen.getByRole("tab", { name: "Schema" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    expect(screen.getByTestId("source-offset").textContent).toBe("1000200");
  });
  it("loads data after a preparing source was viewed as schema and preserves a pending view change", async () => {
    let finish!: (next: DataPage) => void;
    const pending = new Promise<DataPage>((resolve) => {
      finish = resolve;
    });
    const readPage = vi.fn(() => pending);
    const props = {
      active: true,
      source: { documentId: "a", sessionId: "source-a" },
      summary: summary(),
      settings: defaultAppSettings(),
      backend: { ...browserMockBackend, readPage },
    };
    const view = render(<SqlSourceData {...props} blocked />);
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    view.rerender(<SqlSourceData {...props} />);
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    await act(async () => {
      finish(page("source-a"));
      await pending;
    });
    expect(screen.getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("source-a:0")).toBeTruthy();
  });
  it("reads bounded pages beyond one million and exposes columns after the eighth", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) =>
      page(request.sessionId, request.offset),
    );
    render(
      <SqlSourceData
        active
        source={{ documentId: "document-a", sessionId: "source-a" }}
        summary={summary()}
        settings={defaultAppSettings()}
        backend={{ ...browserMockBackend, readPage }}
      />,
    );
    await screen.findByText("source-a:0");
    fireEvent.click(screen.getByRole("button", { name: "Last source page" }));
    await screen.findByText("source-a:1000200");
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    expect(screen.getByText("column_11")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    expect(screen.getByTestId("source-offset").textContent).toBe("1000200");
    fireEvent.click(screen.getByRole("button", { name: "Project last column" }));
    await waitFor(() =>
      expect(readPage).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: ["column_11"],
          documentId: "document-a",
          sessionId: "source-a",
          limit: 200,
        }),
      ),
    );
  });
  it("ignores a delayed response after switching source identity", async () => {
    let finishA!: (next: DataPage) => void;
    const pending = new Promise<DataPage>((resolve) => {
      finishA = resolve;
    });
    const readPage = vi.fn((request: ReadPageRequest) =>
      request.sessionId === "source-a" ? pending : Promise.resolve(page(request.sessionId)),
    );
    const backend = { ...browserMockBackend, readPage };
    const props = { active: true, settings: defaultAppSettings(), backend };
    const view = render(
      <SqlSourceData
        {...props}
        source={{ documentId: "a", sessionId: "source-a" }}
        summary={summary()}
      />,
    );
    view.rerender(
      <SqlSourceData
        {...props}
        source={{ documentId: "b", sessionId: "source-b" }}
        summary={summary("source-b")}
      />,
    );
    await screen.findByText("source-b:0");
    await act(async () => {
      finishA(page("source-a"));
      await pending;
    });
    expect(screen.queryByText("source-a:0")).toBeNull();
    expect(screen.getByText("source-b:0")).toBeTruthy();
  });
  it("does not read an inactive or preparing source", async () => {
    const readPage = vi.fn(async (request: ReadPageRequest) => page(request.sessionId));
    const props = {
      source: { documentId: "a", sessionId: "source-a" },
      summary: summary(),
      settings: defaultAppSettings(),
      backend: { ...browserMockBackend, readPage },
    };
    const view = render(<SqlSourceData {...props} active={false} />);
    expect(readPage).not.toHaveBeenCalled();
    view.rerender(<SqlSourceData {...props} active blocked />);
    expect(readPage).not.toHaveBeenCalled();
    view.rerender(<SqlSourceData {...props} active />);
    await screen.findByText("source-a:0");
    expect(readPage).toHaveBeenCalledTimes(1);
  });
});
