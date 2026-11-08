// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EMPTY_QUERY_PLAN } from "../query/model";
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  createSqlWorkspaceTransport,
  parseSqlStatus,
  parseSqlTable,
  validateSqlAlias,
  validateSqlPage,
  validateSqlRequest,
  type SqlStatus,
  type StartSqlRequest,
} from "./backend";

const request = (): StartSqlRequest => ({
  runId: "sql-run",
  sql: "SELECT 1",
  action: "execute",
  tables: [{ documentId: "d", sessionId: "s", alias: "orders", columnMode: "name" }],
});
const status = (): SqlStatus => ({
  runId: "sql-run",
  state: "complete",
  phase: "complete",
  elapsedMs: 3,
  rowsProduced: 1,
  resultId: "result-1",
  columns: [
    { id: "r0", name: "value", logicalType: "BIGINT", nullable: false },
    { id: "r1", name: "value", logicalType: "BIGINT", nullable: false },
  ],
  rowCount: 1,
  planText: null,
  planJson: null,
  warnings: [],
  error: null,
});
describe("SQL DTO boundaries and transport", () => {
  const pageRequest = {
    runId: "sql-run",
    resultId: "result-1",
    offset: 0,
    limit: 100,
    columns: ["r0"],
  };
  const nativePage = () => ({
    offset: 0,
    limit: 100,
    totalRows: 3,
    hasMore: false,
    columns: ["r0"],
    rows: ["0", "1", "2"].map((display) => [{ kind: "int", display }]),
  });
  it("adapts the actual native SQL DataPage without a wire sessionId", async () => {
    const wire = nativePage();
    expect(wire).not.toHaveProperty("sessionId");
    invokeMock.mockResolvedValueOnce(wire);
    const page = await createSqlWorkspaceTransport().readPage(pageRequest);
    expect(page).toEqual({ ...wire, sessionId: "result-1" });
    expect(invokeMock).toHaveBeenLastCalledWith("read_sql_query_page", { request: pageRequest });
  });
  it("binds view status, pages and find results to the selected SQL result", async () => {
    const api = createSqlWorkspaceTransport();
    const viewId = "view-1";
    const ids = { runId: "sql-run", resultId: "result-1", viewId };
    const identity = { documentId: "sql-workspace", sessionId: "result-1", queryId: viewId };
    const wireStatus = {
      ...identity,
      taskId: viewId,
      state: "complete",
      progress: { rowsScanned: 3, totalRows: 3, resultRows: 3 },
      columns: ["r0"],
      elapsedMs: 1,
      findMatchCount: 1,
      error: null,
    };
    invokeMock.mockResolvedValueOnce(wireStatus);
    await expect(
      api.resultView!.start(ids.runId, ids.resultId, viewId, EMPTY_QUERY_PLAN),
    ).resolves.toEqual(wireStatus);
    expect(invokeMock).toHaveBeenLastCalledWith("start_sql_result_view", {
      ...ids,
      plan: EMPTY_QUERY_PLAN,
    });
    invokeMock.mockResolvedValueOnce({ ...wireStatus, taskId: "wrong" });
    await expect(api.resultView!.status(ids.runId, ids.resultId, viewId)).rejects.toThrow(
      /task identity/,
    );

    invokeMock.mockResolvedValueOnce(nativePage());
    await api.readPage({ ...pageRequest, viewId });
    expect(invokeMock).toHaveBeenLastCalledWith("read_sql_query_page", {
      request: pageRequest,
      viewId,
    });

    const findRequest = {
      ...identity,
      fromResultOffset: 0,
      direction: "next" as const,
      wrap: true,
    };
    invokeMock.mockResolvedValueOnce({ ...identity, queryId: "other", match: null });
    await expect(
      api.resultView!.find(ids.runId, ids.resultId, viewId, findRequest),
    ).rejects.toThrow(/view identity/);
  });
  it.each([
    { offset: 1 },
    { limit: 99 },
    { columns: ["r1"] },
    { totalRows: 2 },
    { rows: [] },
    { rows: [[{ kind: "int", display: 9007199254740992 }]] },
    { sessionId: null },
    { sessionId: "different-result" },
  ])("still rejects a malformed native SQL page %j", async (override) => {
    invokeMock.mockResolvedValueOnce({ ...nativePage(), ...override });
    await expect(createSqlWorkspaceTransport().readPage(pageRequest)).rejects.toThrow();
  });
  it.each(["", " ", "a\0b", "x".repeat(129), "🙂".repeat(129)])(
    "rejects invalid aliases %j",
    (alias) => expect(validateSqlAlias(alias)).not.toBeNull(),
  );
  it("accepts Unicode scalar and UTF-8 alias boundaries without UTF-16 counting", () => {
    expect(validateSqlAlias("🙂".repeat(128))).toBeNull();
    expect(validateSqlAlias("x".repeat(128))).toBeNull();
    expect(validateSqlAlias("Orders", ["orders"])).not.toBeNull();
    expect(validateSqlAlias("\u0085")).not.toBeNull();
    expect(validateSqlAlias("\uFEFF")).not.toBeNull();
    expect(validateSqlAlias("\ud800")).not.toBeNull();
    expect(validateSqlAlias("\udfff")).not.toBeNull();
  });
  it("validates SQL text in UTF-8 bytes and preserves user SQL verbatim", () => {
    const input = { ...request(), sql: "x".repeat(65_536) };
    expect(validateSqlRequest(input).sql).toBe(input.sql);
    expect(() => validateSqlRequest({ ...input, sql: "x".repeat(65_537) })).toThrow();
    expect(() => validateSqlRequest({ ...input, sql: "🙂".repeat(16_385) })).toThrow();
    expect(() => validateSqlRequest({ ...input, sql: "SELECT '\0'" })).toThrow();
    expect(() => validateSqlRequest({ ...input, sql: "\u0085\uFEFF" })).toThrow();
    expect(() => validateSqlRequest({ ...input, sql: "SELECT '\ud800'" })).toThrow();
  });
  it("enforces source count, identity, alias and mode combinations", () => {
    const r = request();
    expect(() => validateSqlRequest({ ...r, tables: [] })).toThrow();
    const tables = Array.from({ length: 32 }, (_, i) => ({
      ...r.tables[0],
      documentId: `d${i}`,
      sessionId: `s${i}`,
      alias: `t${i}`,
    }));
    expect(validateSqlRequest({ ...r, tables }).tables).toHaveLength(32);
    expect(() =>
      validateSqlRequest({
        ...r,
        tables: [...tables, { ...tables[0], documentId: "new", alias: "new" }],
      }),
    ).toThrow();
    expect(() =>
      validateSqlRequest({ ...r, tables: [r.tables[0], { ...r.tables[0], alias: "other" }] }),
    ).toThrow();
    expect(() =>
      validateSqlRequest({ ...r, tables: [{ ...r.tables[0], documentId: "x".repeat(129) }] }),
    ).toThrow();
    expect(() =>
      validateSqlRequest({ ...r, tables: [{ ...r.tables[0], columnMode: "both" as "name" }] }),
    ).toThrow();
  });
  it("accepts duplicate output labels but enforces canonical result column IDs", () => {
    expect(parseSqlStatus(status()).columns.map((c) => c.name)).toEqual(["value", "value"]);
    for (const id of ["r+1", "r01", "r00", "r2", "r0"])
      expect(() =>
        parseSqlStatus({
          ...status(),
          columns: [status().columns[0], { ...status().columns[1], id }],
        }),
      ).toThrow();
    expect(() => parseSqlStatus({ ...status(), rowCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    const { planJson: _omitted, ...missing } = status();
    void _omitted;
    expect(() => parseSqlStatus(missing)).toThrow();
    expect(() => parseSqlStatus(status(), "different-run")).toThrow();
  });
  it("requires backend-authoritative name eligibility and unique original source ordinals", () => {
    const t = {
      documentId: "d",
      sessionId: "s",
      fileName: "x.csv",
      path: "x",
      defaultColumnMode: "ordinal",
      nameModeAllowed: false,
      nameModeReason: "duplicate",
      columns: [
        { id: "s7", sourceIndex: 7, originalName: "x", sqlType: "VARCHAR", nullable: false },
      ],
    };
    expect(parseSqlTable(t).columns[0].sourceIndex).toBe(7);
    expect(() => parseSqlTable({ ...t, defaultColumnMode: "name" })).toThrow();
    expect(() =>
      parseSqlTable({ ...t, columns: [t.columns[0], { ...t.columns[0], id: "other" }] }),
    ).toThrow();
  });
  it("enforces 200x64 projected pages and canonical IDs", () => {
    const p = {
      runId: "run",
      resultId: "result",
      offset: 1_000_000,
      limit: 200,
      columns: Array.from({ length: 64 }, (_, i) => `r${i}`),
    };
    expect(validateSqlPage(p)).toEqual(p);
    for (const change of [
      { limit: 201 },
      { limit: 0 },
      { columns: [...p.columns, "r64"] },
      { columns: ["r01"] },
      { columns: ["r+1"] },
      { columns: ["r4096"] },
      { columns: ["r0", "r0"] },
    ])
      expect(() => validateSqlPage({ ...p, ...change })).toThrow();
  });
  it("uses exact IPC commands and rejects mismatched response identities", async () => {
    const api = createSqlWorkspaceTransport();
    invokeMock.mockResolvedValueOnce(status());
    await api.startQuery(request());
    expect(invokeMock).toHaveBeenLastCalledWith("start_sql_query", { request: request() });
    invokeMock.mockResolvedValueOnce({ ...status(), runId: "another" });
    await expect(api.getStatus("sql-run")).rejects.toThrow(/another run/);
    invokeMock.mockResolvedValueOnce({
      sessionId: "other-result",
      offset: 0,
      limit: 1,
      totalRows: 1,
      hasMore: false,
      columns: ["r0"],
      rows: [[{ kind: "int", display: "1" }]],
    });
    await expect(
      api.readPage({
        runId: "sql-run",
        resultId: "result-1",
        offset: 0,
        limit: 1,
        columns: ["r0"],
      }),
    ).rejects.toThrow(/another result/);
  });
});
