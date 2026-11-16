import { expect, it, vi } from "vitest";
import cases from "../fixtures/phase-25/chart-preview-validation.json";
import type { BackendAdapter } from "./backend";
import { createChartTransport } from "./chartTransport";
import { createSqlWorkspaceMock } from "./sql-workspace/mock";
import { EMPTY_QUERY_PLAN } from "./query/model";

it("retains a large SQL selection without reading or copying its cells", async () => {
  const retain = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const read = vi.fn(async (request: { offset: number; limit: number; columns: string[] }) => ({
    sessionId: "result",
    offset: request.offset,
    limit: request.limit,
    totalRows: 2_000_000,
    hasMore: true,
    columns: request.columns,
    rows: Array.from({ length: request.limit }, (_, i) =>
      request.columns.map((id) => ({
        kind: "int" as const,
        display: `${id}-${request.offset + i}`,
      })),
    ),
  }));
  const transport = createChartTransport({
    sqlWorkspace: {
      retainMockChartResult: retain,
      releaseMockChartResult: release,
      readPage: read,
    },
  } as unknown as BackendAdapter);
  const source = { kind: "sql" as const, runId: "run", resultId: "result", viewId: "view" };
  const selection = { rowStart: 1_000_001, rowEndExclusive: 1_500_001, columnIds: ["r2", "r0"] };
  await transport.capture({ requestId: "large", source, selection });
  expect(read).not.toHaveBeenCalled();
  expect(retain).toHaveBeenCalledWith("run", "result", "view", selection);
  selection.columnIds.reverse();
  const preview = await transport.readBlockPreview("large", 6, ["r2", "r0"]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({
    runId: "run",
    resultId: "result",
    viewId: "view",
    offset: 1_000_001,
    limit: 6,
    columns: ["r2", "r0"],
  });
  expect(preview.totalRows).toBe(500_000);
  expect(preview.rows[0][0].display).toBe("r2-1000001");
  await transport.releaseBlock("large");
  await transport.releaseBlock("large");
  expect(release).toHaveBeenCalledTimes(1);
});

it("keeps the selected sorted SQL view after its tab and view are released", async () => {
  vi.useFakeTimers();
  try {
    const sql = createSqlWorkspaceMock(
      () => {},
      async () => {},
    );
    await sql.startQuery({
      runId: "retained",
      sql: "SELECT * FROM data",
      action: "execute",
      tables: [{ documentId: "d", sessionId: "s", alias: "data", columnMode: "name" }],
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await sql.getStatus("retained");
    const id = result.resultId!;
    await sql.resultView!.start("retained", id, "sorted", {
      ...EMPTY_QUERY_PLAN,
      filters: [],
      sort: [{ columnId: "r0", direction: "descending", nullsLast: true }],
      search: null,
    });
    await vi.advanceTimersByTimeAsync(500);
    await sql.resultView!.status("retained", id, "sorted");
    const transport = createChartTransport({ sqlWorkspace: sql } as unknown as BackendAdapter);
    await transport.capture({
      requestId: "range",
      source: { kind: "sql", runId: "retained", resultId: id, viewId: "sorted" },
      selection: { rowStart: 1, rowEndExclusive: 3, columnIds: ["r2", "r0"] },
    });
    await sql.resultView!.release("retained", id, "sorted");
    await sql.releaseResult("retained", id);
    const preview = await transport.readBlockPreview("range", 6, ["r2", "r0"]);
    expect(preview.rows.map((row) => row.map((cell) => cell.display))).toEqual([
      ["300000.25", "3"],
      ["200000.25", "2"],
    ]);
    await transport.releaseBlock("range");
    await expect(
      sql.readPage({ runId: "retained", resultId: id, offset: 0, limit: 1, columns: ["r0"] }),
    ).rejects.toThrow(/unavailable/);
  } finally {
    vi.useRealTimers();
  }
});

it("matches Rust snapshot preview boundaries and reads only the captured cells", async () => {
  const columns = Array.from({ length: 9 }, (_, index) => `c${index}`);
  const readPage = vi.fn(async (request: { columns: string[] }) => ({
    sessionId: "file",
    offset: 4,
    limit: 2,
    totalRows: 6,
    hasMore: false,
    columns: request.columns,
    rows: [4, 5].map((row) =>
      request.columns.map((id) => ({ kind: "int" as const, display: `${id}-${row}` })),
    ),
  }));
  const backend = createChartTransport({ readPage } as unknown as BackendAdapter);
  await backend.capture({
    requestId: "snapshot",
    source: { kind: "file", documentId: "file", sessionId: "session" },
    selection: { rowStart: 4, rowEndExclusive: 6, columnIds: columns },
  });
  readPage.mockRejectedValue(new Error("The original file is closed."));
  for (const entry of cases) {
    const request = backend.readBlockPreview("snapshot", entry.limit, entry.columns);
    if (entry.valid) {
      const preview = await request;
      expect(preview.columns).toEqual(entry.columns);
      expect(preview.rows[0]).toEqual(
        entry.columns.map((id) => ({ kind: "int", display: `${id}-4` })),
      );
      expect(preview.totalRows).toBe(2);
    } else await expect(request).rejects.toThrow();
  }
  expect(readPage).toHaveBeenCalledTimes(1);
  await backend.releaseBlock("snapshot");
  await expect(backend.readBlockPreview("snapshot", 1, ["c0"])).rejects.toThrow();
});
