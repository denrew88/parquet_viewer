import {
  DataViewerError,
  type CopyOperationStatus,
  type DataPage,
  type DataValue,
  type FileSummary,
  type FindBoundaryRequest,
  type OpenedDataFile,
  type QueryStatusResponse,
  type FindQueryMatchResponse,
} from "../backend";
import { ctrlArrowTarget } from "../gridSelection";
import { serializeCopyRows } from "../copy/serializer";
import type { CopyOptions } from "../copy/model";
import type { QueryFilter, QuerySearch } from "../query/model";
import {
  parseSqlStatus,
  validateSqlBoundary,
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
function boundaryPayload(row: number): string | null {
  if (row < 5) return ["alpha", " ", "omega", null, ""][row];
  if (row < 150) return "next";
  if (row < 220) return row % 2 === 0 ? null : "";
  return row < 259 ? "tail" : null;
}

export function createSqlWorkspaceMock(
  registerCopy: (status: CopyOperationStatus) => void,
  waitForBoundary: (request: FindBoundaryRequest) => Promise<void>,
): SqlWorkspaceBackend {
  type MockResult = SqlStatus & { boundary: boolean };
  const tasks = new Map<
    string,
    {
      status: SqlStatus;
      started: number;
      delay: number;
      fail: boolean;
      action: string;
      boundary: boolean;
    }
  >();
  const results = new Map<string, MockResult>();
  const chartPins = new Map<string, number>();
  const releasedTabs = new Set<string>();
  type Match = NonNullable<FindQueryMatchResponse["match"]>;
  const views = new Map<
    string,
    {
      status: QueryStatusResponse;
      rows: number[];
      matches: Omit<Match, "wrapped" | "matchIndex" | "totalMatches">[];
    }
  >();
  const value = (result: MockResult, row: number, column: string): DataValue => {
    if (result.boundary) {
      const text =
        column === "r1"
          ? boundaryPayload(row)
          : column === "r3"
            ? row < 4
              ? ["  ", null, "", ""][row]
              : "flag"
            : column === "r4"
              ? row === 0
                ? ""
                : row === 2
                  ? null
                  : "note"
              : undefined;
      if (text === null || (column === "r2" && row === 0))
        return { kind: "null", display: null, state: "null" };
      if (text !== undefined)
        return { kind: "string", display: text, state: text === "" ? "empty" : "valid" };
    }
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
  const resultView = (runId: string, resultId: string, viewId: string) => {
    snapshot(runId, resultId);
    const view = views.get(viewId);
    if (view?.status.sessionId !== resultId)
      throw new DataViewerError("QueryStale", "SQL result view is unavailable.");
    return view;
  };
  const rowIndexes = (runId: string, resultId: string, viewId?: string) => {
    const result = snapshot(runId, resultId);
    if (viewId === undefined) return Array.from({ length: result.rowCount ?? 0 }, (_, row) => row);
    const view = resultView(runId, resultId, viewId);
    if (view.status.state !== "complete")
      throw new DataViewerError("QueryStale", "SQL result view is unavailable.");
    return view.rows;
  };
  const matchesFilter = (result: MockResult, row: number, filter: QueryFilter) => {
    const cell = value(result, row, filter.columnId);
    const input = filter.values[0];
    const actual = cell.display ?? "";
    const lhs = filter.scalarType === "text" ? actual : Number(actual);
    const rhs = filter.scalarType === "text" ? input : Number(input);
    switch (filter.operator) {
      case "equals":
        return lhs === rhs;
      case "notEquals":
        return lhs !== rhs;
      case "oneOf":
        return filter.values.includes(actual);
      case "contains":
        return actual.includes(input);
      case "startsWith":
        return actual.startsWith(input);
      case "endsWith":
        return actual.endsWith(input);
      case "greaterThan":
        return lhs > rhs;
      case "greaterThanOrEqual":
        return lhs >= rhs;
      case "lessThan":
        return lhs < rhs;
      case "lessThanOrEqual":
        return lhs <= rhs;
      case "between":
        return Number(lhs) >= Number(rhs) && Number(lhs) <= Number(filter.values[1]);
      case "isNull":
        return cell.state === "null";
      case "isNotNull":
        return cell.state !== "null";
      case "isInvalid":
        return cell.state === "invalid";
      case "isNotInvalid":
        return cell.state !== "invalid";
      case "isTrue":
        return actual === "true";
      case "isFalse":
        return actual === "false";
    }
  };
  const matchesSearch = (result: MockResult, row: number, column: string, search: QuerySearch) => {
    const normalize = (text: string) => (search.caseSensitive ? text : text.toLowerCase());
    const actual = normalize(value(result, row, column).display ?? "");
    const needle = normalize(search.text);
    return search.exact ? actual === needle : actual.includes(needle);
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
          item.status.rowCount = item.boundary ? 260 : 4;
          item.status.rowsProduced = item.status.rowCount;
          item.status.columns = [
            { id: "r0", name: "value", logicalType: "BIGINT", nullable: false },
            { id: "r1", name: "value", logicalType: "VARCHAR", nullable: false },
            { id: "r2", name: "amount", logicalType: "DECIMAL(18,2)", nullable: false },
          ];
          if (item.boundary) {
            item.status.columns[0].name = "row_id";
            item.status.columns[1].name = "payload";
            item.status.columns[1].nullable = true;
            item.status.columns[2].nullable = true;
            item.status.columns.push(
              { id: "r3", name: "flag", logicalType: "VARCHAR", nullable: true },
              { id: "r4", name: "detail", logicalType: "VARCHAR", nullable: true },
            );
          }
          results.set(item.status.resultId, {
            ...structuredClone(item.status),
            boundary: item.boundary,
          });
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
    resultView: {
      async start(runId, resultId, viewId, plan) {
        const result = snapshot(runId, resultId);
        if (views.has(viewId))
          throw new DataViewerError("InvalidRequest", "Duplicate SQL result view.");
        const columns = result.columns.map((column) => column.id);
        const textColumns = new Set(
          result.columns
            .filter((column) => column.logicalType === "VARCHAR")
            .map((column) => column.id),
        );
        const search = plan.search;
        const targets = search?.targetColumnIds.length ? search.targetColumnIds : columns;
        const indexes = rowIndexes(runId, resultId);
        const rows = indexes
          .filter(
            (row) =>
              plan.filters.every((filter) => matchesFilter(result, row, filter)) &&
              (search?.mode !== "filter" ||
                targets.some((column) => matchesSearch(result, row, column, search))),
          )
          .sort((a, b) => {
            for (const sort of plan.sort) {
              const left = value(result, a, sort.columnId).display ?? "";
              const right = value(result, b, sort.columnId).display ?? "";
              const order = textColumns.has(sort.columnId)
                ? left.localeCompare(right)
                : Number(left) - Number(right);
              if (order) return sort.direction === "descending" ? -order : order;
            }
            return a - b;
          });
        const matches =
          search?.mode === "find"
            ? rows.flatMap((row, rowOffset) =>
                targets
                  .filter((column) => matchesSearch(result, row, column, search))
                  .map((columnId) => ({ rowOffset, columnId })),
              )
            : [];
        const status: QueryStatusResponse = {
          documentId: "sql-workspace",
          sessionId: resultId,
          queryId: viewId,
          taskId: viewId,
          state: "queued",
          progress: { rowsScanned: 0, totalRows: indexes.length, resultRows: 0 },
          columns,
          elapsedMs: 0,
          findMatchCount: search?.mode === "find" ? matches.length : null,
          error: null,
        };
        views.set(viewId, { status, rows, matches });
        return structuredClone(status);
      },
      async status(runId, resultId, viewId) {
        const view = resultView(runId, resultId, viewId);
        if (view.status.state === "queued") {
          view.status.state = "complete";
          view.status.progress.rowsScanned = view.status.progress.totalRows ?? 0;
          view.status.progress.resultRows = view.rows.length;
        }
        return structuredClone(view.status);
      },
      async cancel(runId, resultId, viewId) {
        const view = resultView(runId, resultId, viewId);
        if (view.status.state === "queued") view.status.state = "cancelled";
        return structuredClone(view.status);
      },
      async release(runId, resultId, viewId) {
        resultView(runId, resultId, viewId);
        views.delete(viewId);
      },
      async find(runId, resultId, viewId, request) {
        const { matches, status } = resultView(runId, resultId, viewId);
        const { documentId, sessionId, queryId } = status;
        const next = request.direction === "next";
        const ordered = matches.map((item, matchIndex) => ({ ...item, matchIndex }));
        if (!next) ordered.reverse();
        const found = ordered.find((item) => {
          const delta =
            request.fromMatchIndex == null
              ? item.rowOffset - request.fromResultOffset
              : item.matchIndex - request.fromMatchIndex;
          return next ? delta > 0 : delta < 0;
        });
        const match = found ?? (request.wrap ? ordered[0] : undefined);
        return {
          documentId,
          sessionId,
          queryId,
          match: match ? { ...match, totalMatches: matches.length, wrapped: !found } : null,
        };
      },
    },
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
        boundary: /\/\*\s*boundary\s*\*\//i.test(request.sql),
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
      const indexes = rowIndexes(request.runId, request.resultId, request.viewId);
      const rows = indexes
        .slice(request.offset, request.offset + request.limit)
        .map((row) => request.columns.map((id) => value(result, row, id)));
      return {
        sessionId: request.resultId,
        offset: request.offset,
        limit: request.limit,
        totalRows: indexes.length,
        hasMore: request.offset + rows.length < indexes.length,
        columns: request.columns,
        rows,
      };
    },
    async readCell(runId, resultId, row, columnId, viewId) {
      const result = snapshot(runId, resultId);
      const sourceRow = rowIndexes(runId, resultId, viewId)[row];
      if (sourceRow === undefined || !result.columns.some((c) => c.id === columnId))
        throw new DataViewerError("InvalidRequest", "Unknown SQL cell.");
      return value(result, sourceRow, columnId);
    },
    async findBoundary(runId, resultId, request, viewId) {
      const checked = validateSqlBoundary(runId, resultId, request, viewId);
      await waitForBoundary(checked);
      const result = snapshot(runId, resultId);
      const indexes = rowIndexes(runId, resultId, viewId);
      const column = checked.visibleColumnIds.indexOf(checked.columnId);
      const known = new Set(result.columns.map(({ id }) => id));
      if (
        checked.row >= indexes.length ||
        column < 0 ||
        checked.visibleColumnIds.some((id) => !known.has(id))
      ) {
        throw new DataViewerError("InvalidRequest", "The boundary starts outside the SQL result.");
      }
      const start = { row: checked.row, column };
      const bounds = {
        rowCount: indexes.length,
        columnCount: checked.visibleColumnIds.length,
        pageStep: 1,
      };
      const rowDelta = checked.direction === "up" ? -1 : checked.direction === "down" ? 1 : 0;
      const columnDelta = checked.direction === "left" ? -1 : checked.direction === "right" ? 1 : 0;
      const target =
        checked.mode === "tableBoundary"
          ? {
              row: rowDelta < 0 ? 0 : rowDelta > 0 ? bounds.rowCount - 1 : start.row,
              column: columnDelta < 0 ? 0 : columnDelta > 0 ? bounds.columnCount - 1 : start.column,
            }
          : ctrlArrowTarget(start, rowDelta, columnDelta, bounds, ({ row, column }) => {
              const state = value(result, indexes[row], checked.visibleColumnIds[column]).state;
              return state === "null" || state === "empty";
            });
      return {
        navigationId: checked.navigationId,
        documentId: checked.documentId,
        sessionId: checked.sessionId,
        queryId: checked.queryId,
        targetRow: target.row,
        targetColumnId: checked.visibleColumnIds[target.column],
        resolvedRowCount: indexes.length,
      };
    },
    async releaseResult(runId, resultId) {
      snapshot(runId, resultId);
      if (chartPins.has(resultId)) releasedTabs.add(resultId);
      else results.delete(resultId);
      for (const [id, view] of views) if (view.status.sessionId === resultId) views.delete(id);
    },
    async retainMockChartResult(runId, resultId) {
      snapshot(runId, resultId);
      chartPins.set(resultId, (chartPins.get(resultId) ?? 0) + 1);
    },
    async releaseMockChartResult(runId, resultId) {
      snapshot(runId, resultId);
      const remaining = (chartPins.get(resultId) ?? 1) - 1;
      if (remaining > 0) chartPins.set(resultId, remaining);
      else {
        chartPins.delete(resultId);
        if (releasedTabs.delete(resultId)) results.delete(resultId);
      }
    },
    async exportResult({ runId, resultId, viewId }) {
      rowIndexes(runId, resultId, viewId);
      return false;
    },
    async startCopy(runId, resultId, request, viewId) {
      const result = snapshot(runId, resultId),
        selection = request.selection;
      if (
        request.documentId !== "sql-workspace" ||
        request.sessionId !== resultId ||
        request.queryId !== (viewId ?? runId)
      )
        throw new DataViewerError("QueryStale", "Copy belongs to another SQL result.");
      const indexes = rowIndexes(runId, resultId, viewId);
      if (selection.rowEndExclusive > indexes.length)
        throw new DataViewerError("InvalidRequest", "Copy selection is outside the result.");
      const rows = indexes
        .slice(selection.rowStart, selection.rowEndExclusive)
        .map((row) => selection.columnIds.map((id) => value(result, row, id)));
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
