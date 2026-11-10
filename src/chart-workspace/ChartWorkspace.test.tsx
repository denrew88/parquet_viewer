// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChartWorkspace from "./ChartWorkspace";
import type { ChartBackend, ChartData, ChartSeed, ChartSourceOption } from "./contract";

vi.mock("./ChartPlot", () => ({
  default: ({ title, markSize }: { title: string; markSize?: number }) => (
    <div role="img" aria-label={`${title} plot`} data-mark-size={markSize} />
  ),
}));

const rows = (validRows: number): ChartData => ({
  totalRows: validRows,
  validRows,
  excludedRows: 0,
  filteredRows: 0,
  groupsTruncated: false,
  sampled: false,
});

function backendMock(): ChartBackend {
  return {
    compute: vi.fn().mockResolvedValue(rows(10)),
    cancel: vi.fn().mockResolvedValue(undefined),
    retainResult: vi.fn().mockResolvedValue(undefined),
    releaseResult: vi.fn().mockResolvedValue(undefined),
    releaseBlock: vi.fn().mockResolvedValue(undefined),
    copyImage: vi.fn().mockResolvedValue(undefined),
    saveImage: vi.fn().mockResolvedValue(true),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { resolve, promise };
}

function sql(resultId: string): ChartSourceOption {
  return {
    id: "query-1",
    name: "Orders",
    kind: "sql",
    source: { kind: "sql", runId: resultId, resultId },
    columns: [
      { id: "r0", name: "category", logicalType: "VARCHAR" },
      { id: "r1", name: "amount", logicalType: "DOUBLE" },
    ],
  };
}

describe("chart workspace lifecycle", () => {
  it("shows the latest SQL result when an obsolete request finishes afterward", async () => {
    const backend = backendMock();
    const first = deferred<ChartData>();
    const second = deferred<ChartData>();
    vi.mocked(backend.compute)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSeedHandled = vi.fn();
    const view = render(
      <ChartWorkspace
        active
        sources={[sql("first")]}
        seed={null}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add chart" }));
    expect(screen.getByRole("article", { name: "New chart" })).toHaveTextContent(
      "Choose a chart type in Chart settings.",
    );
    expect(backend.compute).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "violin" } });
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(1));

    view.rerender(
      <ChartWorkspace
        active
        sources={[sql("second")]}
        seed={null}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(2));
    expect(backend.cancel).toHaveBeenCalledWith(
      vi.mocked(backend.compute).mock.calls[0][0].requestId,
    );
    await act(async () => {
      second.resolve(rows(25));
    });
    const chart = screen.getByRole("article", { name: "Violin chart" });
    expect(chart).toHaveAttribute("data-result-id", "second");
    expect(within(chart).getByText(/25 valid rows/)).toBeInTheDocument();
    await act(async () => {
      first.resolve(rows(55));
    });
    expect(chart).toHaveAttribute("data-result-id", "second");
    expect(within(chart).queryByText(/55 valid rows/)).not.toBeInTheDocument();
  });

  it("retains the pinned run through a newer successful run and releases it on removal", async () => {
    const backend = backendMock();
    const onSeedHandled = vi.fn();
    const view = render(
      <ChartWorkspace
        active
        sources={[sql("first")]}
        seed={null}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add chart" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "violin" } });
    await waitFor(() =>
      expect(screen.getByRole("article")).toHaveAttribute("data-result-id", "first"),
    );
    fireEvent.change(screen.getByLabelText("Refresh mode"), { target: { value: "pin" } });
    await waitFor(() => expect(screen.getByLabelText("Refresh mode")).toHaveValue("pin"));
    view.rerender(
      <ChartWorkspace
        active
        sources={[sql("next")]}
        seed={null}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    expect(screen.getByRole("article", { name: "Violin chart" })).toHaveAttribute(
      "data-result-id",
      "first",
    );
    expect(backend.retainResult).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove chart" }));
    expect(backend.releaseResult).toHaveBeenCalledWith(sql("first").source);
  });

  it("streams only the selected full-file columns after the chart type is chosen", async () => {
    const backend = backendMock();
    const source = { kind: "file", documentId: "doc", sessionId: "session" } as const;
    render(
      <ChartWorkspace
        active
        sources={[
          {
            id: "file:doc",
            name: "order_items.parquet",
            kind: "file",
            source,
            columns: sql("a").columns,
          },
        ]}
        seed={{
          id: "selection",
          sourceId: "file:doc",
          fileSelection: { sessionId: "session", columnIds: ["r0"], rowCount: 3_999_997 },
        }}
        backend={backend}
        onSeedHandled={() => {}}
      />,
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add chart" }));
    expect(backend.compute).not.toHaveBeenCalled();
    expect(screen.getByRole("article")).toHaveTextContent("3,999,997 rows · 1 column");
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "bar" } });
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(1));
    const request = vi.mocked(backend.compute).mock.calls[0][0];
    expect(request).toMatchObject({ kind: "bar", source, x: "r0" });
    expect(request).not.toHaveProperty("y");
  });

  it("routes a captured block to a new sheet and releases it after the last card is removed", async () => {
    const backend = backendMock();
    const seed: ChartSeed = {
      id: "selection",
      block: { blockId: "block", name: "Orders", columns: sql("a").columns, rowCount: 10 },
    };
    const onSeedHandled = vi.fn();
    const view = render(
      <ChartWorkspace
        active
        sources={[]}
        seed={seed}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    fireEvent.change(screen.getByLabelText("Destination sheet"), { target: { value: "new" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add chart" }));
    expect(onSeedHandled).toHaveBeenCalledTimes(1);
    view.rerender(
      <ChartWorkspace
        active
        sources={[]}
        seed={null}
        backend={backend}
        onSeedHandled={onSeedHandled}
      />,
    );
    expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate chart" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove chart" }));
    expect(backend.releaseBlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove chart" }));
    expect(backend.releaseBlock).toHaveBeenCalledExactlyOnceWith("block");
    await waitFor(() => expect(screen.getByText("No charts in this sheet")).toBeInTheDocument());
  });
});

describe("chart parameters", () => {
  function makeChart(backend: ChartBackend, kind: string) {
    render(
      <ChartWorkspace
        active
        sources={[sql("first")]}
        seed={null}
        backend={backend}
        onSeedHandled={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add chart" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: kind } });
  }

  it("applies valid histogram parameters and does not scan for drafts or invalid input", async () => {
    const backend = backendMock();
    makeChart(backend, "histogram");
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Histogram bins"), { target: { value: "count" } });
    fireEvent.change(screen.getByLabelText("Bin count"), { target: { value: "49" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply histogram bins" }));
    expect(screen.getByRole("alert")).toHaveTextContent("from 1 to 48");
    expect(backend.compute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Bin count"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply histogram bins" }));
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(2));
    expect(backend.compute).toHaveBeenLastCalledWith(
      expect.objectContaining({ histogram: { mode: "count", count: 3 } }),
    );
  });

  it("retains the previous scale on a displayed result until the new data succeeds", async () => {
    const backend = backendMock();
    const fresh = deferred<ChartData>();
    vi.mocked(backend.compute).mockResolvedValueOnce(rows(10)).mockReturnValueOnce(fresh.promise);
    makeChart(backend, "violin");
    const chart = screen.getByRole("article");
    await waitFor(() => expect(chart).toHaveAttribute("data-y-scale", "linear"));
    fireEvent.change(screen.getByLabelText("Y scale"), { target: { value: "log1p" } });
    await waitFor(() => expect(backend.compute).toHaveBeenCalledTimes(2));
    expect(backend.compute).toHaveBeenLastCalledWith(expect.objectContaining({ yScale: "log1p" }));
    expect(chart).toHaveAttribute("data-y-scale", "linear");
    await act(async () => {
      fresh.resolve({ ...rows(8), totalRows: 10, excludedRows: 2, scaleExcludedRows: 2 });
    });
    expect(chart).toHaveAttribute("data-y-scale", "log1p");
    expect(chart).toHaveTextContent("2 excluded by scale");
  });

  it("changes bar appearance without recomputing the data", async () => {
    const backend = backendMock();
    makeChart(backend, "bar");
    const plot = await screen.findByRole("img", { name: "Bar chart plot" });
    expect(plot).toHaveAttribute("data-mark-size", "60");
    fireEvent.change(screen.getByLabelText("Bar width"), { target: { value: "80" } });
    expect(plot).toHaveAttribute("data-mark-size", "80");
    expect(backend.compute).toHaveBeenCalledTimes(1);
  });
});
