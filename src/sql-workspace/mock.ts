import {
  DataViewerError,
  type CopyOperationStatus,
  type DataPage,
  type DataValue,
  type FileSummary,
  type OpenedDataFile,
} from "../backend";
import { serializeCopyRows } from "../copy/serializer";
import type { CopyOptions } from "../copy/model";
import {
  parseSqlStatus,
  validateSqlPage,
  validateSqlRequest,
  type SqlSourceIdentity,
  type SqlStatus,
  type SqlTableDescriptor,
  type SqlWorkspaceBackend,
} from "./backend";

// Browser-only UI fixtures. SQL semantics/security/performance require native tests.
export const SQL_MOCK_PATHS = [
  "C:\\sales\\orders.csv",
  "D:\\archive\\orders.csv",
  "D:\\reference\\customers.parquet",
];
const columns: [string, string][] = [
  ["주문 번호", "BIGINT"],
  ["고객 번호", "BIGINT"],
  ["결제 금액", "DECIMAL(18,2)"],
  ["주문 일시", "TIMESTAMP_NS"],
  ['상품 "표시명"', "VARCHAR"],
  ["상태", "VARCHAR"],
  ["배송지", "VARCHAR"],
  ["배송 메모", "VARCHAR"],
  ["할인 금액", "DECIMAL(18,2)"],
  ["결제 수단", "VARCHAR"],
  ...Array.from({ length: 28 }, (_, i): [string, string] => [`추가 속성 ${i + 1}`, "VARCHAR"]),
];
const registered = new Map<string, { opened: OpenedDataFile; descriptor: SqlTableDescriptor }>();
export function sqlMockOpened(path: string, itemIndex: number): OpenedDataFile {
  const archived = path.includes("archive"),
    customer = path.endsWith(".parquet");
  const documentId = `browser-sql-document-${itemIndex}`,
    sessionId = `browser-sql-session-${itemIndex}`;
  const raw = customer
    ? [
        ["고객 번호", "BIGINT"],
        ["고객명", "VARCHAR"],
        ["지역", "VARCHAR"],
        ["가입 일자", "DATE"],
        ["이메일", "VARCHAR"],
      ]
    : columns.map((column) => [...column]);
  if (archived) raw[8][0] = "결제 금액";
  const visible = raw.map(([name, sqlType], i) => ({
    name: archived && i === 8 ? `${name} (2)` : name,
    logicalType: sqlType,
    valueLogicalType: sqlType,
    physicalType: sqlType,
    nullable: true,
  }));
  const fileName = path.split(/[\\/]/).pop()!;
  const summary: FileSummary = {
    sessionId,
    fileName,
    path,
    format: customer ? "parquet" : "csv",
    fileSize: 1024,
    rowCount: 4,
    rowCountStatus: {
      state: "complete",
      rowsScanned: 4,
      bytesScanned: 1024,
      totalBytes: 1024,
      generation: 1,
      message: null,
    },
    columns: visible,
    columnCount: visible.length,
    rowGroups: [],
    rowGroupCount: 0,
    csvMetadata: customer
      ? null
      : {
          delimiter: ",",
          encoding: "utf-8",
          headerMode: "present",
          suggestedHeader: true,
          headerUsed: true,
          structureIssueCount: 0,
          structureIssues: [],
          rawHeaderCount: raw.length,
          rawHeaders: raw.map((c) => c[0]),
          rawHeadersTruncated: false,
          headerIssueCount: archived ? 1 : 0,
          headerIssues: archived
            ? [
                {
                  columnIndex: 8,
                  rawName: "결제 금액",
                  resolvedName: "결제 금액 (2)",
                  reason: "duplicate",
                },
              ]
            : [],
        },
  };
  const opened: OpenedDataFile = {
    documentId,
    sessionId,
    itemIndex,
    path,
    disposition: "opened",
    summary,
    initialPage: {
      sessionId,
      offset: 0,
      limit: 200,
      totalRows: 4,
      hasMore: false,
      columns: visible.map((c) => c.name),
      rows: Array.from({ length: 4 }, (_, r) =>
        visible.map((_, c) => ({ kind: "string", display: String(r * 100 + c), state: "valid" })),
      ),
    },
  };
  const descriptor: SqlTableDescriptor = {
    documentId,
    sessionId,
    fileName,
    path,
    defaultColumnMode: archived ? "ordinal" : "name",
    nameModeAllowed: !archived,
    nameModeReason: archived
      ? "Duplicate original name: 결제 금액 (columns 3 and 9). Only c-numbers are available."
      : null,
    columns: raw.map(([originalName, sqlType], sourceIndex) => ({
      id: `s${sourceIndex}`,
      originalName,
      sqlType,
      sourceIndex,
      nullable: true,
    })),
  };
  registered.set(sessionId, { opened, descriptor });
  return opened;
}
export function sqlMockSource(sessionId: string) {
  return registered.get(sessionId);
}
export function sqlMockSourcePage(
  sessionId: string,
  offset: number,
  limit: number,
  projection?: string[],
): DataPage {
  const source = registered.get(sessionId);
  if (!source) throw new DataViewerError("SessionNotFound", "Mock SQL source is closed.");
  const all = source.opened.initialPage,
    selected = projection ?? all.columns;
  const indices = selected.map((column) => all.columns.indexOf(column));
  if (indices.some((i) => i < 0))
    throw new DataViewerError("InvalidRequest", "Unknown mock column.");
  const rows = all.rows.slice(offset, offset + limit).map((row) => indices.map((i) => row[i]));
  return {
    sessionId,
    offset,
    limit,
    totalRows: 4,
    hasMore: offset + rows.length < 4,
    columns: selected,
    rows,
  };
}
export function createSqlWorkspaceMock(
  registerCopy: (status: CopyOperationStatus) => void,
): SqlWorkspaceBackend {
  const tasks = new Map<
    string,
    { status: SqlStatus; started: number; delay: number; fail: boolean; action: string }
  >();
  const results = new Map<string, SqlStatus>();
  const value = (row: number, column: string): DataValue => {
    if (column === "r0")
      return {
        kind: "int",
        display: String(row + 1),
        sourceDisplay: String(row + 1),
        state: "valid",
      };
    if (column === "r1")
      return {
        kind: "string",
        display: ["Seoul", "Busan", "Incheon", "Daegu"][row % 4],
        state: "valid",
      };
    return {
      kind: "decimal",
      display: `${(row + 1) * 100000}.25`,
      sourceDisplay: `${(row + 1) * 100000}.25`,
      state: "valid",
    };
  };
  const snapshot = (runId: string, resultId: string) => {
    const result = results.get(resultId);
    if (!result || result.runId !== runId)
      throw new DataViewerError("QueryStale", "SQL result is unavailable.");
    return result;
  };
  const readStatus = (runId: string) => {
    const item = tasks.get(runId);
    if (!item) throw new DataViewerError("QueryStale", "SQL run is unavailable.");
    if (item.status.state === "running" && performance.now() - item.started >= item.delay) {
      item.status.elapsedMs = Math.round(performance.now() - item.started);
      if (item.fail) {
        item.status.state = "failed";
        item.status.phase = "failed";
        item.status.error = {
          code: "QueryFailed",
          message: "Mock SQL failure requested for UI validation.",
        };
      } else {
        item.status.state = "complete";
        item.status.phase = "complete";
        if (item.action === "execute") {
          item.status.resultId = `sql-result-${runId}`;
          item.status.rowCount = 4;
          item.status.rowsProduced = 4;
          item.status.columns = [
            { id: "r0", name: "value", logicalType: "BIGINT", nullable: false },
            { id: "r1", name: "value", logicalType: "VARCHAR", nullable: false },
            { id: "r2", name: "amount", logicalType: "DECIMAL(18,2)", nullable: false },
          ];
          results.set(item.status.resultId, structuredClone(item.status));
        } else {
          item.status.planText = "HASH_JOIN\n  conditions: a.c1 = b.c1\n  SCAN registered inputs";
          item.status.planJson = {
            name: "HASH_JOIN",
            extra_info: { Conditions: "a.c1 = b.c1", "Estimated Cardinality": "4" },
            children: [
              { name: "PARQUET_SCAN", children: [] },
              { name: "PARQUET_SCAN", children: [] },
            ],
          };
          if (item.action === "analyze") {
            const plan = item.status.planJson as Record<string, unknown>;
            plan.operator_cardinality = 4;
            plan.operator_timing = 0.001;
          }
        }
      }
    }
    return structuredClone(item.status);
  };
  return {
    async describeTables(sources: SqlSourceIdentity[]) {
      return sources.map((source) => {
        const entry = registered.get(source.sessionId);
        if (entry && entry.descriptor.documentId === source.documentId)
          return structuredClone(entry.descriptor);
        return {
          ...source,
          fileName: "fixture.parquet",
          path: "C:\\Data\\fixture.parquet",
          defaultColumnMode: "name" as const,
          nameModeAllowed: true,
          nameModeReason: null,
          columns: [
            { id: "s0", sourceIndex: 0, originalName: "id", sqlType: "BIGINT", nullable: false },
          ],
        };
      });
    },
    async startQuery(request) {
      validateSqlRequest(request);
      if (tasks.has(request.runId))
        throw new DataViewerError("InvalidRequest", "Duplicate SQL run.");
      const status: SqlStatus = {
        runId: request.runId,
        state: "running",
        phase: "executing",
        elapsedMs: 0,
        rowsProduced: 0,
        resultId: null,
        columns: [],
        rowCount: null,
        planText: null,
        planJson: null,
        warnings: [],
        error: null,
      };
      tasks.set(request.runId, {
        status,
        started: performance.now(),
        delay: /\/\*\s*slow\s*\*\//i.test(request.sql) ? 30_000 : 300,
        fail: /\/\*\s*fail\s*\*\//i.test(request.sql),
        action: request.action,
      });
      if (tasks.size > 16) {
        const first = tasks.keys().next().value;
        if (first) tasks.delete(first);
      }
      return structuredClone(status);
    },
    async getStatus(runId) {
      return parseSqlStatus(readStatus(runId), runId);
    },
    async cancelQuery(runId) {
      const current = readStatus(runId),
        task = tasks.get(runId)!;
      if (["queued", "running"].includes(current.state)) {
        task.status.state = "cancelled";
        task.status.phase = "cancelled";
      }
      return structuredClone(task.status);
    },
    async readPage(request) {
      validateSqlPage(request);
      const result = snapshot(request.runId, request.resultId);
      if (request.columns.some((id) => !result.columns.some((c) => c.id === id)))
        throw new DataViewerError("InvalidRequest", "Unknown SQL result column.");
      const rows = Array.from(
        { length: Math.max(0, Math.min(request.limit, 4 - request.offset)) },
        (_, i) => request.columns.map((id) => value(request.offset + i, id)),
      );
      return {
        sessionId: request.resultId,
        offset: request.offset,
        limit: request.limit,
        totalRows: 4,
        hasMore: request.offset + rows.length < 4,
        columns: request.columns,
        rows,
      };
    },
    async readCell(runId, resultId, row, columnId) {
      const result = snapshot(runId, resultId);
      if (row >= 4 || !result.columns.some((c) => c.id === columnId))
        throw new DataViewerError("InvalidRequest", "Unknown SQL cell.");
      return value(row, columnId);
    },
    async releaseResult(runId, resultId) {
      snapshot(runId, resultId);
      results.delete(resultId);
    },
    async exportResult({ runId, resultId }) {
      snapshot(runId, resultId);
      return false;
    },
    async startCopy(runId, resultId, request) {
      const result = snapshot(runId, resultId),
        selection = request.selection;
      if (
        request.documentId !== "sql-workspace" ||
        request.sessionId !== resultId ||
        request.queryId !== runId
      )
        throw new DataViewerError("QueryStale", "Copy belongs to another SQL result.");
      const rows = Array.from({ length: selection.rowEndExclusive - selection.rowStart }, (_, i) =>
        selection.columnIds.map((id) => value(selection.rowStart + i, id)),
      );
      const headers = selection.columnIds.map(
        (id) => result.columns.find((c) => c.id === id)?.name ?? id,
      );
      const options: CopyOptions = { ...request.options, preset: "custom" };
      const text = serializeCopyRows(rows, options, headers),
        bytes = new TextEncoder().encode(text).length;
      let failure: CopyOperationStatus["failure"] =
        rows.length * selection.columnIds.length > request.maxCells || bytes > request.maxBytes
          ? { reason: "selectionLimit", message: "SQL copy exceeds configured limits." }
          : null;
      if (!failure) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          failure = { reason: "clipboardWrite", message: "Clipboard is unavailable." };
        }
      }
      const status: CopyOperationStatus = {
        ...request,
        startedAt: new Date().toISOString(),
        state: failure ? "failed" : "complete",
        stage: "complete",
        progress: {
          rowsProcessed: rows.length,
          totalRows: rows.length,
          cellsProcessed: rows.length * selection.columnIds.length,
          bytesSerialized: bytes,
        },
        failure,
      };
      registerCopy(status);
      return status;
    },
  };
}
