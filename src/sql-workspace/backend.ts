import { invoke } from "@tauri-apps/api/core";
import {
  DataViewerError,
  parseCopyOperationStatus,
  parseDataPage,
  parseDataValue,
  parseFindQueryMatchResponse,
  parseRequestedBoundaryResponse,
  parseQueryPlan,
  parseQueryStatus,
  validatedFindBoundaryRequest,
  validatedFindQueryMatchRequest,
  type CopyOperationStatus,
  type DataPage,
  type DataValue,
  type FindBoundaryRequest,
  type FindBoundaryResponse,
  type StartCopyRequest,
  type FindQueryMatchRequest,
  type FindQueryMatchResponse,
  type QueryStatusResponse,
} from "../backend";
import type { QueryPlan } from "../query/model";

export type SqlColumnMode = "name" | "ordinal";
export type SqlAction = "execute" | "explain" | "analyze";
export interface SqlSourceIdentity {
  documentId: string;
  sessionId: string;
}
export interface SqlSourceColumn {
  id: string;
  sourceIndex: number;
  originalName: string;
  sqlType: string;
  nullable: boolean;
}
export interface SqlTableDescriptor extends SqlSourceIdentity {
  fileName: string;
  path: string;
  defaultColumnMode: SqlColumnMode;
  nameModeAllowed: boolean;
  nameModeReason: string | null;
  columns: SqlSourceColumn[];
}
export interface SqlTableBinding extends SqlSourceIdentity {
  alias: string;
  columnMode: SqlColumnMode;
}
export interface StartSqlRequest {
  runId: string;
  sql: string;
  action: SqlAction;
  tables: SqlTableBinding[];
}
export interface SqlResultColumn {
  id: string;
  name: string;
  logicalType: string;
  nullable: boolean;
}
export interface SqlStatus {
  runId: string;
  state: "queued" | "running" | "complete" | "cancelled" | "failed";
  phase: string;
  elapsedMs: number;
  rowsProduced: number;
  resultId: string | null;
  columns: SqlResultColumn[];
  rowCount: number | null;
  planText: string | null;
  planJson: unknown;
  warnings: string[];
  error: { code: string; message: string } | null;
}
export interface SqlPageRequest {
  runId: string;
  resultId: string;
  offset: number;
  limit: number;
  columns: string[];
  viewId?: string;
}
export interface SqlExportRequest {
  runId: string;
  resultId: string;
  format: "csv" | "tsv" | "parquet";
  viewId?: string;
}
export interface SqlResultViewBackend {
  start(
    runId: string,
    resultId: string,
    viewId: string,
    plan: QueryPlan,
  ): Promise<QueryStatusResponse>;
  status(runId: string, resultId: string, viewId: string): Promise<QueryStatusResponse>;
  cancel(runId: string, resultId: string, viewId: string): Promise<QueryStatusResponse>;
  release(runId: string, resultId: string, viewId: string): Promise<void>;
  find(
    runId: string,
    resultId: string,
    viewId: string,
    request: FindQueryMatchRequest,
  ): Promise<FindQueryMatchResponse>;
}
export interface SqlWorkspaceBackend {
  resultView?: SqlResultViewBackend;
  retainMockChartResult?(runId: string, resultId: string): Promise<void>;
  releaseMockChartResult?(runId: string, resultId: string): Promise<void>;
  describeTables(sources: SqlSourceIdentity[]): Promise<SqlTableDescriptor[]>;
  startQuery(request: StartSqlRequest): Promise<SqlStatus>;
  getStatus(runId: string): Promise<SqlStatus>;
  cancelQuery(runId: string): Promise<SqlStatus>;
  readPage(request: SqlPageRequest): Promise<DataPage>;
  readCell(
    runId: string,
    resultId: string,
    row: number,
    columnId: string,
    viewId?: string,
  ): Promise<DataValue>;
  findBoundary(
    runId: string,
    resultId: string,
    request: FindBoundaryRequest,
    viewId?: string,
  ): Promise<FindBoundaryResponse>;
  releaseResult(runId: string, resultId: string): Promise<void>;
  exportResult(request: SqlExportRequest): Promise<boolean>;
  startCopy(
    runId: string,
    resultId: string,
    request: StartCopyRequest,
    viewId?: string,
  ): Promise<CopyOperationStatus>;
}

export const SQL_MAX_BYTES = 65_536;
// SQL DTO blank policy is shared with Rust, including both U+0085 and U+FEFF.
export const trimSqlWhitespace = (value: string) =>
  value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, "");
const invalidScalar = (value: string) => /[\uD800-\uDFFF]/u.test(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;
export const foldSqlIdentifier = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
function fail(message = "The backend returned an invalid SQL response."): never {
  throw new DataViewerError("InvalidResponse", message);
}
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string =>
  typeof value === "string" && !invalidScalar(value) ? value : fail();
const bool = (value: unknown): boolean => (typeof value === "boolean" ? value : fail());
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : fail();
const identity = (value: unknown): string => {
  const s = text(value);
  if (!trimSqlWhitespace(s) || s.includes("\0") || bytes(s) > 128) fail("Invalid SQL identity.");
  return s;
};
const mode = (value: unknown): SqlColumnMode =>
  value === "name" || value === "ordinal" ? value : fail();
const nullableText = (value: unknown): string | null => (value === null ? null : text(value));

export function validateSqlAlias(value: string, others: readonly string[] = []): string | null {
  if (
    typeof value !== "string" ||
    !trimSqlWhitespace(value) ||
    invalidScalar(value) ||
    value.includes("\0")
  )
    return "Enter a nonempty table alias without NUL.";
  if ([...value].length > 128 || bytes(value) > 512)
    return "An alias allows at most 128 characters and 512 UTF-8 bytes.";
  if (others.some((other) => foldSqlIdentifier(other) === foldSqlIdentifier(value)))
    return "This table alias is already in use.";
  return null;
}
export function validateSqlRequest(request: StartSqlRequest): StartSqlRequest {
  try {
    identity(request.runId);
    if (
      typeof request.sql !== "string" ||
      !trimSqlWhitespace(request.sql) ||
      invalidScalar(request.sql) ||
      request.sql.includes("\0") ||
      bytes(request.sql) > SQL_MAX_BYTES
    )
      throw new Error("Enter one SQL statement, at most 65,536 UTF-8 bytes, without NUL.");
    if (!["execute", "explain", "analyze"].includes(request.action))
      throw new Error("Invalid SQL action.");
    if (!Array.isArray(request.tables) || request.tables.length < 1 || request.tables.length > 32)
      throw new Error("Choose between 1 and 32 SQL tables.");
    const identities = new Set<string>(),
      aliases: string[] = [];
    request.tables.forEach((table) => {
      identity(table.documentId);
      identity(table.sessionId);
      mode(table.columnMode);
      const key = JSON.stringify([table.documentId, table.sessionId]);
      if (identities.has(key)) throw new Error("A SQL source was registered more than once.");
      identities.add(key);
      const error = validateSqlAlias(table.alias, aliases);
      if (error) throw new Error(error);
      aliases.push(table.alias);
    });
    return request;
  } catch (error) {
    throw new DataViewerError(
      "InvalidRequest",
      error instanceof Error ? error.message : "Invalid SQL request.",
    );
  }
}
export function parseSqlTable(value: unknown): SqlTableDescriptor {
  const o = obj(value);
  if (!Array.isArray(o.columns) || o.columns.length > 16_384) fail();
  const columns = o.columns.map((entry): SqlSourceColumn => {
    const c = obj(entry);
    return {
      id: identity(c.id),
      sourceIndex: integer(c.sourceIndex, 16_383),
      originalName: text(c.originalName),
      sqlType: text(c.sqlType),
      nullable: bool(c.nullable),
    };
  });
  if (
    new Set(columns.map((c) => c.id)).size !== columns.length ||
    new Set(columns.map((c) => c.sourceIndex)).size !== columns.length
  )
    fail();
  const result: SqlTableDescriptor = {
    documentId: identity(o.documentId),
    sessionId: identity(o.sessionId),
    fileName: text(o.fileName),
    path: text(o.path),
    defaultColumnMode: mode(o.defaultColumnMode),
    nameModeAllowed: bool(o.nameModeAllowed),
    nameModeReason: nullableText(o.nameModeReason),
    columns,
  };
  if (!result.nameModeAllowed && result.defaultColumnMode === "name") fail();
  return result;
}
export function parseSqlStatus(value: unknown, runId?: string): SqlStatus {
  const o = obj(value);
  if (
    !Array.isArray(o.columns) ||
    o.columns.length > 4096 ||
    !Array.isArray(o.warnings) ||
    o.warnings.length > 4096
  )
    fail();
  if (!["queued", "running", "complete", "cancelled", "failed"].includes(text(o.state))) fail();
  if (!("planJson" in o)) fail();
  const columns = o.columns.map((entry): SqlResultColumn => {
    const c = obj(entry);
    return {
      id: identity(c.id),
      name: text(c.name),
      logicalType: text(c.logicalType),
      nullable: bool(c.nullable),
    };
  });
  if (columns.some((c, index) => c.id !== `r${index}`)) fail();
  const error =
    o.error === null
      ? null
      : { code: text(obj(o.error).code), message: text(obj(o.error).message) };
  const result: SqlStatus = {
    runId: identity(o.runId),
    state: o.state as SqlStatus["state"],
    phase: text(o.phase),
    elapsedMs: integer(o.elapsedMs),
    rowsProduced: integer(o.rowsProduced, 1_000_000),
    resultId: o.resultId === null ? null : identity(o.resultId),
    columns,
    rowCount: o.rowCount === null ? null : integer(o.rowCount, 1_000_000),
    planText: nullableText(o.planText),
    planJson: o.planJson,
    warnings: o.warnings.map(text),
    error,
  };
  if (runId !== undefined && result.runId !== runId)
    fail("The SQL response belongs to another run.");
  if (
    result.resultId !== null &&
    (result.state !== "complete" || result.rowCount === null || !columns.length)
  )
    fail();
  return result;
}
export function validateSqlPage(request: SqlPageRequest): SqlPageRequest {
  try {
    identity(request.runId);
    identity(request.resultId);
    if (request.viewId !== undefined) identity(request.viewId);
    integer(request.offset, 1_000_000);
    integer(request.limit, 200);
    if (
      request.limit < 1 ||
      !Array.isArray(request.columns) ||
      !request.columns.length ||
      request.columns.length > 64 ||
      new Set(request.columns).size !== request.columns.length
    )
      fail();
    request.columns.forEach((column) => {
      identity(column);
      if (!/^r(?:0|[1-9][0-9]*)$/.test(column) || Number(column.slice(1)) > 4095) fail();
    });
    return request;
  } catch {
    throw new DataViewerError(
      "InvalidRequest",
      "SQL pages allow 1–200 rows and 1–64 unique columns.",
    );
  }
}
function viewIdentity(runId: string, resultId: string, viewId: string) {
  identity(runId);
  identity(resultId);
  identity(viewId);
  return { runId, resultId, viewId };
}
function verifyViewIdentity(
  value: { documentId: string; sessionId: string; queryId: string },
  resultId: string,
  viewId: string,
) {
  if (
    value.documentId !== "sql-workspace" ||
    value.sessionId !== resultId ||
    value.queryId !== viewId
  )
    fail("SQL result view identity does not match.");
}
export function validateSqlBoundary(
  runId: string,
  resultId: string,
  request: FindBoundaryRequest,
  viewId?: string,
): FindBoundaryRequest {
  identity(runId);
  identity(resultId);
  if (viewId !== undefined) identity(viewId);
  const validated = validatedFindBoundaryRequest(request);
  if (
    validated.documentId !== "sql-workspace" ||
    validated.sessionId !== resultId ||
    validated.queryId !== (viewId ?? runId)
  )
    throw new DataViewerError("InvalidRequest", "The navigation belongs to another SQL result.");
  return validated;
}
function viewStatus(value: unknown, resultId: string, viewId: string) {
  const status = parseQueryStatus(value);
  verifyViewIdentity(status, resultId, viewId);
  if (status.taskId !== viewId) fail("SQL result view task identity does not match.");
  return status;
}
async function call<T>(
  command: string,
  args: Record<string, unknown>,
  parse: (v: unknown) => T,
): Promise<T> {
  try {
    return parse(await invoke(command, args));
  } catch (error) {
    if (error instanceof DataViewerError) throw error;
    const raw = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    throw new DataViewerError(
      typeof raw?.code === "string" ? raw.code : "QueryFailed",
      typeof raw?.message === "string" ? raw.message : String(error),
    );
  }
}
export function createSqlWorkspaceTransport(): SqlWorkspaceBackend {
  return {
    resultView: {
      start(runId, resultId, viewId, plan) {
        const args = viewIdentity(runId, resultId, viewId);
        return call("start_sql_result_view", { ...args, plan: parseQueryPlan(plan) }, (v) =>
          viewStatus(v, resultId, viewId),
        );
      },
      status(runId, resultId, viewId) {
        return call("get_sql_result_view_status", viewIdentity(runId, resultId, viewId), (v) =>
          viewStatus(v, resultId, viewId),
        );
      },
      cancel(runId, resultId, viewId) {
        return call("cancel_sql_result_view", viewIdentity(runId, resultId, viewId), (v) =>
          viewStatus(v, resultId, viewId),
        );
      },
      release(runId, resultId, viewId) {
        return call(
          "release_sql_result_view",
          viewIdentity(runId, resultId, viewId),
          () => undefined,
        );
      },
      find(runId, resultId, viewId, request) {
        const args = viewIdentity(runId, resultId, viewId);
        verifyViewIdentity(request, resultId, viewId);
        return call(
          "find_sql_result_view_match",
          { ...args, request: validatedFindQueryMatchRequest(request) },
          (v) => {
            const result = parseFindQueryMatchResponse(v);
            verifyViewIdentity(result, resultId, viewId);
            return result;
          },
        );
      },
    },
    describeTables(sources) {
      if (sources.length > 32)
        return Promise.reject(
          new DataViewerError("InvalidRequest", "At most 32 SQL sources are supported."),
        );
      sources.forEach((s) => {
        identity(s.documentId);
        identity(s.sessionId);
      });
      return call("describe_sql_tables", { sources }, (v) => {
        if (!Array.isArray(v) || v.length !== sources.length) fail();
        const tables = v.map(parseSqlTable);
        if (
          tables.some(
            (t, i) =>
              t.documentId !== sources[i].documentId || t.sessionId !== sources[i].sessionId,
          )
        )
          fail("SQL tables belong to another source snapshot.");
        return tables;
      });
    },
    startQuery(request) {
      validateSqlRequest(request);
      return call("start_sql_query", { request }, (v) => parseSqlStatus(v, request.runId));
    },
    getStatus(runId) {
      identity(runId);
      return call("get_sql_query_status", { runId }, (v) => parseSqlStatus(v, runId));
    },
    cancelQuery(runId) {
      identity(runId);
      return call("cancel_sql_query", { runId }, (v) => parseSqlStatus(v, runId));
    },
    readPage(request) {
      validateSqlPage(request);
      const { viewId, ...pageRequest } = request;
      return call(
        "read_sql_query_page",
        { request: pageRequest, ...(viewId && { viewId }) },
        (v) => {
          const wire = obj(v);
          if (
            Object.prototype.hasOwnProperty.call(wire, "sessionId") &&
            wire.sessionId !== request.resultId
          )
            fail("SQL page belongs to another result/projection.");
          // Native DataPage carries page data only. The validated SQL request binds
          // it to the result; frontend grid adapters use that result as sessionId.
          const page = parseDataPage({ ...wire, sessionId: request.resultId });
          if (
            page.sessionId !== request.resultId ||
            page.offset !== request.offset ||
            page.limit !== request.limit ||
            JSON.stringify(page.columns) !== JSON.stringify(request.columns)
          )
            fail("SQL page belongs to another result/projection.");
          return page;
        },
      );
    },
    readCell(runId, resultId, row, columnId, viewId) {
      identity(runId);
      identity(resultId);
      integer(row, 999_999);
      identity(columnId);
      if (viewId !== undefined) identity(viewId);
      if (!/^r(?:0|[1-9][0-9]*)$/.test(columnId) || Number(columnId.slice(1)) > 4095)
        throw new DataViewerError("InvalidRequest", "Unknown SQL column identity.");
      return call(
        "read_sql_query_cell",
        { runId, resultId, row, columnId, ...(viewId && { viewId }) },
        (v) => parseDataValue(v) ?? fail(),
      );
    },
    async findBoundary(runId, resultId, request, viewId) {
      const validated = validateSqlBoundary(runId, resultId, request, viewId);
      return call(
        "find_sql_result_boundary",
        { runId, resultId, ...(viewId !== undefined && { viewId }), request: validated },
        (value) => parseRequestedBoundaryResponse(value, validated),
      );
    },
    releaseResult(runId, resultId) {
      identity(runId);
      identity(resultId);
      return call("release_sql_result", { runId, resultId }, () => undefined);
    },
    exportResult(request) {
      identity(request.runId);
      identity(request.resultId);
      if (request.viewId !== undefined) identity(request.viewId);
      return call("export_sql_result", { request }, bool);
    },
    startCopy(runId, resultId, request, viewId) {
      identity(runId);
      identity(resultId);
      if (viewId !== undefined) identity(viewId);
      const queryId = viewId ?? runId;
      if (
        request.documentId !== "sql-workspace" ||
        request.sessionId !== resultId ||
        request.queryId !== queryId
      )
        throw new DataViewerError("InvalidRequest", "Copy belongs to another SQL result.");
      return call(
        "start_sql_copy",
        { runId, resultId, request, ...(viewId && { viewId }) },
        (v) => {
          const status = parseCopyOperationStatus(v);
          if (
            status.operationId !== request.operationId ||
            status.documentId !== request.documentId ||
            status.sessionId !== resultId ||
            status.queryId !== queryId
          )
            fail("SQL copy belongs to another result.");
          return status;
        },
      );
    },
  };
}
