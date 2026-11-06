// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnValuesPanel } from "./ColumnValuesPanel";
import type {
  ColumnValuesBackend,
  ColumnValuesPageResponse,
  ColumnValuesStatus,
  StartColumnValuesRequest,
} from "./backend";

function backend(): ColumnValuesBackend {
  const statuses = new Map<string, ColumnValuesStatus>();
  return {
    startColumnValues: vi.fn(async (request) => {
      const value = {
        ...request,
        state: "ready" as const,
        stage: "complete",
        totalCount: 237,
        matchedCount: 237,
        error: null,
      };
      statuses.set(request.operationId, value);
      return value;
    }),
    getColumnValuesStatus: vi.fn(async (request) => statuses.get(request.operationId)!),
    cancelColumnValues: vi.fn(async (request) => ({
      ...statuses.get(request.operationId)!,
      state: "cancelled" as const,
    })),
    releaseColumnValues: vi.fn(async () => {}),
    readColumnValuesPage: vi.fn(
      async (request) =>
        ({
          ...statuses.get(request.operationId)!,
          totalCount: 237,
          matchedCount: request.search ? 2 : 237,
          hasMore: !request.search && request.offset === 0,
          nextCursor: !request.search && request.offset === 0 ? "next-100" : null,
          previousCursor: request.offset > 0 ? "previous-0" : null,
          values:
            request.offset === 0
              ? [
                  {
                    value: "alpha",
                    isNull: false,
                    isEmpty: false,
                    isInvalid: false,
                    count: 100,
                    truncated: false,
                  },
                  {
                    value: null,
                    isNull: true,
                    isEmpty: false,
                    isInvalid: false,
                    count: 5,
                    truncated: false,
                  },
                  {
                    value: "",
                    isNull: false,
                    isEmpty: true,
                    isInvalid: false,
                    count: 4,
                    truncated: false,
                  },
                  {
                    value: "bad",
                    isNull: false,
                    isEmpty: false,
                    isInvalid: true,
                    count: 2,
                    truncated: true,
                  },
                ]
              : [
                  {
                    value: "last",
                    isNull: false,
                    isEmpty: false,
                    isInvalid: false,
                    count: 1,
                    truncated: false,
                  },
                ],
        }) as ColumnValuesPageResponse,
    ),
    startColumnValuesCopy: vi.fn().mockResolvedValue({
      operationId: "copy-1",
      state: "complete",
      progress: { totalRows: 237, rowsProcessed: 237 },
      failure: null,
    }),
    getCopyStatus: vi.fn(),
    cancelCopy: vi.fn(),
  };
}
describe("Phase 21 column values", () => {
  it("repairs focus after cancellation so Escape closes and restores the opener", async () => {
    const api = backend();
    vi.mocked(api.startColumnValues).mockImplementationOnce(async (request) => ({
      ...request,
      state: "running",
      stage: "grouping",
      totalCount: null,
      matchedCount: null,
      error: null,
    }));
    vi.mocked(api.cancelColumnValues).mockImplementationOnce(async (request) => ({
      ...request,
      queryId: null,
      columnId: "label",
      state: "cancelled",
      stage: "cancelled",
      totalCount: null,
      matchedCount: null,
      error: null,
    }));
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="label"
        onClose={onClose}
      />,
    );
    const cancel = await screen.findByRole("button", { name: "Cancel calculation" });
    cancel.focus();
    fireEvent.click(cancel);
    await screen.findByRole("button", { name: "Retry calculation" });
    expect(screen.getByRole("button", { name: "Close column values" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
  it("shows exact total, explicit categories and bounded pages, copying the entire snapshot", async () => {
    const api = backend();
    render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="label"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("237 distinct values")).toBeInTheDocument();
    expect(await screen.findByText("NULL")).toBeInTheDocument();
    expect(screen.getByText("Empty string")).toBeInTheDocument();
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText(/Preview truncated/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("last");
    expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 100, limit: 100, cursor: "next-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy values and counts" }));
    await waitFor(() =>
      expect(api.startColumnValuesCopy).toHaveBeenCalledWith(
        expect.objectContaining({ includeCounts: true, search: null, order: "countDescending" }),
      ),
    );
    expect(await screen.findByText("Copied 237 values.")).toBeInTheDocument();
  });
  it("uses reply cursors for Next and Previous without retaining page history", async () => {
    const api = backend();
    render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="label"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("alpha");
    expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, cursor: null }),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("last");
    expect(screen.getByText("101–101 of 237")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("alpha");
    expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, cursor: "previous-0" }),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
  it("keeps the committed page after an error and retries with the same cursor", async () => {
    const api = backend();
    render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="label"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("alpha");
    vi.mocked(api.readColumnValuesPage).mockRejectedValueOnce(new Error("Temporary page failure"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("alert");
    expect(screen.getByText("1–4 of 237")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("last");
    expect(
      vi
        .mocked(api.readColumnValuesPage)
        .mock.calls.slice(-2)
        .map(([request]) => [request.offset, request.cursor]),
    ).toEqual([
      [100, "next-100"],
      [100, "next-100"],
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("resets cursor paging on sorting and searching and ignores a delayed page", async () => {
    const api = backend();
    const read = vi.mocked(api.readColumnValuesPage).getMockImplementation()!;
    let resolve: ((page: ColumnValuesPageResponse) => void) | undefined;
    let pending: Promise<ColumnValuesPageResponse> | undefined;
    vi.mocked(api.readColumnValuesPage).mockImplementation((request) => {
      if (request.cursor === "next-100" && request.order === "countDescending") {
        pending = read(request);
        return new Promise((done) => {
          resolve = done;
        });
      }
      return read(request);
    });
    render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="label"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.change(screen.getByRole("combobox", { name: "Distinct value order" }), {
      target: { value: "valueAscending" },
    });
    await waitFor(() =>
      expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, cursor: null, order: "valueAscending" }),
      ),
    );
    await screen.findByText("alpha");
    await act(async () => resolve?.(await pending!));
    expect(screen.queryByText("last")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("last");
    fireEvent.change(screen.getByRole("textbox", { name: "Search column values" }), {
      target: { value: "al" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, cursor: null, search: "al" }),
      ),
    );
    await screen.findByText("alpha");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
  it("changes source scope and forwards committed search and order to full-result copy", async () => {
    const api = backend();
    render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId="query-1"
        columnId="label"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("alpha");
    expect(api.startColumnValues).toHaveBeenCalledWith(
      expect.objectContaining({ queryId: "query-1" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Distinct value scope" }), {
      target: { value: "source" },
    });
    await waitFor(() =>
      expect(api.startColumnValues).toHaveBeenLastCalledWith(
        expect.objectContaining({ queryId: null }),
      ),
    );
    await screen.findByText("alpha");
    fireEvent.change(screen.getByRole("textbox", { name: "Search column values" }), {
      target: { value: "al" },
    });
    expect(api.readColumnValuesPage).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "al" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "al", offset: 0 }),
      ),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Distinct value order" }), {
      target: { value: "valueAscending" },
    });
    await waitFor(() =>
      expect(api.readColumnValuesPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "al", order: "valueAscending" }),
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy values" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Copy values" }));
    await waitFor(() =>
      expect(api.startColumnValuesCopy).toHaveBeenCalledWith(
        expect.objectContaining({ search: "al", order: "valueAscending", includeCounts: false }),
      ),
    );
  });
  it("releases the old operation and ignores delayed previous-column responses", async () => {
    const api = backend();
    let resolve: ((value: ColumnValuesStatus) => void) | undefined;
    let old: StartColumnValuesRequest | undefined;
    vi.mocked(api.startColumnValues).mockImplementationOnce((request) => {
      old = request;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const { rerender, unmount } = render(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="old"
        onClose={vi.fn()}
      />,
    );
    rerender(
      <ColumnValuesPanel
        backend={api}
        documentId="doc"
        sessionId="session"
        queryId={null}
        columnId="new"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("237 distinct values");
    await act(async () =>
      resolve?.({
        ...old!,
        state: "ready",
        stage: "complete",
        totalCount: 999,
        matchedCount: 999,
        error: null,
      }),
    );
    expect(screen.queryByText("999 distinct values")).not.toBeInTheDocument();
    expect(api.releaseColumnValues).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: old!.operationId }),
    );
    unmount();
    expect(api.releaseColumnValues).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(api.releaseColumnValues)
        .mock.calls.filter(([identity]) => identity.operationId === old!.operationId),
    ).toHaveLength(2);
  });
});
