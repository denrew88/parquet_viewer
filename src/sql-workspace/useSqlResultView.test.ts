import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataPage, QueryStatusResponse } from "../backend";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "../query/model";
import type { SqlResultViewBackend, SqlWorkspaceBackend } from "./backend";
import { useSqlResultView } from "./useSqlResultView";

const BASE: DataPage = {
  sessionId: "result",
  offset: 0,
  limit: 100,
  totalRows: 3,
  hasMore: false,
  columns: ["r0"],
  rows: [],
};
const SORTED: QueryPlan = {
  ...EMPTY_QUERY_PLAN,
  sort: [{ columnId: "r0", direction: "ascending", nullsLast: true }],
};
const FILTERED: QueryPlan = {
  ...SORTED,
  filters: [
    { id: "filter", columnId: "r0", scalarType: "number", operator: "equals", values: ["1"] },
  ],
};

function status(viewId: string): QueryStatusResponse {
  return {
    documentId: "sql-workspace",
    sessionId: "result",
    queryId: viewId,
    taskId: viewId,
    state: "complete",
    progress: { rowsScanned: 3, totalRows: 3, resultRows: 1 },
    columns: ["r0"],
    elapsedMs: 0,
    findMatchCount: null,
    error: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const view = {
    start: vi.fn<SqlResultViewBackend["start"]>(async (_run, _result, id) => status(id)),
    status: vi.fn<SqlResultViewBackend["status"]>(),
    cancel: vi.fn<SqlResultViewBackend["cancel"]>(async (_run, _result, id) => status(id)),
    release: vi.fn<SqlResultViewBackend["release"]>(async () => {}),
    find: vi.fn<SqlResultViewBackend["find"]>(),
  };
  const readPage = vi.fn<SqlWorkspaceBackend["readPage"]>(async () => ({
    ...BASE,
    totalRows: 1,
  }));
  const api = { resultView: view, readPage };
  const hook = renderHook(() => useSqlResultView(api, "run", "result", BASE));
  return { ...hook, readPage, view };
}

describe("SQL Results view lifecycle", () => {
  it("keeps the last committed page and scope through a failed first-page read", async () => {
    const { result, view, readPage } = setup();
    await act(() => result.current.apply(SORTED));
    const applied = result.current.viewId;
    expect(result.current.page.totalRows).toBe(1);
    expect(result.current.draftDiffers).toBe(false);

    const later = deferred<DataPage>();
    readPage.mockImplementationOnce(() => later.promise);
    act(() => {
      void result.current.apply(FILTERED);
    });
    await waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
    expect(result.current.applying).toBe(true);
    expect(result.current.viewId).toBe(applied);
    expect(result.current.draftDiffers).toBe(true);
    await act(async () => {
      later.reject(new Error("First page failed"));
    });
    expect(result.current.toolbar).toMatchObject({ state: "error", message: "First page failed" });
    expect(result.current.viewId).toBe(applied);
    const failed = view.start.mock.calls[1][2];
    expect(view.release).toHaveBeenCalledWith("run", "result", failed);
  });

  it("releases an admitted superseded view before applying its replacement", async () => {
    const { result, view, readPage } = setup();
    const earlier = deferred<QueryStatusResponse>();
    view.start.mockImplementationOnce(() => earlier.promise);
    act(() => {
      void result.current.apply(SORTED);
    });
    await waitFor(() => expect(view.start).toHaveBeenCalledTimes(1));
    const retired = view.start.mock.calls[0][2];
    act(() => {
      void result.current.apply(FILTERED);
    });
    expect(view.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      earlier.resolve(status(retired));
    });
    const current = view.start.mock.calls[1][2];
    expect(view.cancel).toHaveBeenCalledWith("run", "result", retired);
    expect(view.release).toHaveBeenCalledWith("run", "result", retired);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(result.current.viewId).toBe(current);
  });

  it("restores the base view and releases the applied view when conditions clear", async () => {
    const { result, view } = setup();
    await act(() => result.current.apply(FILTERED));
    const applied = result.current.viewId;
    await act(() => result.current.apply(EMPTY_QUERY_PLAN));
    expect(result.current.page).toBe(BASE);
    expect(result.current.viewId).toBeUndefined();
    expect(result.current.draftDiffers).toBe(false);
    expect(view.release).toHaveBeenCalledWith("run", "result", applied);
  });

  it("routes footer navigation to the committed view and discards its superseded page", async () => {
    const { result, readPage } = setup();
    await act(() => result.current.apply(SORTED));
    const viewId = result.current.viewId;
    const later = deferred<DataPage>();
    readPage.mockImplementationOnce(() => later.promise);
    const onError = vi.fn();
    act(() => {
      void result.current.goToPage(100, onError);
    });
    expect(readPage).toHaveBeenLastCalledWith(expect.objectContaining({ viewId, offset: 100 }));
    await act(() => result.current.apply(FILTERED));
    await act(async () => {
      later.resolve({ ...BASE, offset: 100 });
    });
    expect(result.current.viewId).not.toBe(viewId);
    expect(result.current.page.offset).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });
});
