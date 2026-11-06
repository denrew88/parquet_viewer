import { invoke } from "@tauri-apps/api/core";
import type { CopyOperationStatus, CopyOperationIdentity, QueryTempUsage } from "../backend";

export type ColumnValuesOrder =
  "valueAscending" | "valueDescending" | "countDescending" | "countAscending";
export interface ColumnValuesIdentity {
  operationId: string;
  documentId: string;
  sessionId: string;
}
export interface StartColumnValuesRequest extends ColumnValuesIdentity {
  queryId: string | null;
  columnId: string;
}
export interface ColumnValue {
  value: string | null;
  isNull: boolean;
  isEmpty: boolean;
  isInvalid: boolean;
  count: number;
  truncated: boolean;
}
export interface ColumnValuesStatus extends StartColumnValuesRequest {
  state: "queued" | "running" | "ready" | "cancelled" | "failed";
  stage: string;
  totalCount: number | null;
  matchedCount: number | null;
  error: { code: string; message: string } | null;
}
export interface ColumnValuesPageRequest extends ColumnValuesIdentity {
  search: string | null;
  order: ColumnValuesOrder;
  offset: number;
  limit: number;
  cursor?: string | null;
}
export interface ColumnValuesPageResponse extends StartColumnValuesRequest {
  totalCount: number;
  matchedCount: number;
  values: ColumnValue[];
  hasMore: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
}
export interface ColumnValuesCopyRequest extends ColumnValuesIdentity {
  search: string | null;
  order: ColumnValuesOrder;
  includeCounts: boolean;
}
export interface ColumnValuesBackend {
  startColumnValues(request: StartColumnValuesRequest): Promise<ColumnValuesStatus>;
  getColumnValuesStatus(identity: ColumnValuesIdentity): Promise<ColumnValuesStatus>;
  cancelColumnValues(identity: ColumnValuesIdentity): Promise<ColumnValuesStatus>;
  releaseColumnValues(identity: ColumnValuesIdentity): Promise<void>;
  readColumnValuesPage(request: ColumnValuesPageRequest): Promise<ColumnValuesPageResponse>;
  startColumnValuesCopy(request: ColumnValuesCopyRequest): Promise<CopyOperationStatus>;
  getCopyStatus(identity: CopyOperationIdentity): Promise<CopyOperationStatus>;
  cancelCopy(identity: CopyOperationIdentity): Promise<CopyOperationStatus>;
}
export interface CacheMigrationPreview {
  sourceUnavailable?: boolean;
  sourcePath: string;
  targetPath: string;
  bytes: number;
  entries: number;
  activeEntries: number;
  availableBytes: number;
  requiredFreeBytes: number;
}
export interface CacheLocationSelection {
  selectionId: string;
  preview: CacheMigrationPreview;
}
export interface CacheMigrationStatus {
  operationId: string;
  state: "queued" | "running" | "complete" | "cancelled" | "failed";
  progress: {
    copiedBytes: number;
    totalBytes: number;
    copiedEntries: number;
    totalEntries: number;
    phase: string;
  };
  sourcePath: string;
  targetPath: string;
  error: { code: string; message: string } | null;
  result: {
    sourcePath: string;
    targetPath: string;
    movedBytes: number;
    movedEntries: number;
    cleanupFailures: string[];
  } | null;
}
export interface CacheManagementBackend {
  chooseCsvCacheLocation(): Promise<CacheLocationSelection | null>;
  startCsvCacheMigration(selectionId: string): Promise<CacheMigrationStatus>;
  getCsvCacheMigrationStatus(operationId: string): Promise<CacheMigrationStatus>;
  cancelCsvCacheMigration(operationId: string): Promise<CacheMigrationStatus>;
  getQueryTempUsage(): Promise<QueryTempUsage>;
}

type Obj = Record<string, unknown>;
function keys(x: Obj, expected: readonly string[]) {
  if (Object.keys(x).length !== expected.length || expected.some((key) => !(key in x)))
    throw new Error("Invalid response fields");
}
const identityKeys = ["operationId", "documentId", "sessionId"];
const sourceKeys = [...identityKeys, "queryId", "columnId"];
async function call(command: string, args?: Obj): Promise<unknown> {
  try {
    return await invoke(command, args);
  } catch (reason) {
    if (
      reason &&
      typeof reason === "object" &&
      "message" in reason &&
      typeof reason.message === "string"
    )
      throw Object.assign(new Error(reason.message), "code" in reason ? { code: reason.code } : {});
    throw reason;
  }
}
const object = (x: unknown): Obj => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Invalid response object");
  return x as Obj;
};
const text = (x: unknown): string => {
  if (typeof x !== "string") throw new Error("Invalid response string");
  return x;
};
const integer = (x: unknown): number => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0)
    throw new Error("Invalid response integer");
  return x;
};
const boolean = (x: unknown): boolean => {
  if (typeof x !== "boolean") throw new Error("Invalid response boolean");
  return x;
};
const error = (x: unknown) =>
  x === null ? null : { code: text(object(x).code), message: text(object(x).message) };
function identity(x: Obj): ColumnValuesIdentity {
  const result = {
    operationId: text(x.operationId),
    documentId: text(x.documentId),
    sessionId: text(x.sessionId),
  };
  if (Object.values(result).some((v) => !v.trim() || new TextEncoder().encode(v).length > 128))
    throw new Error("Invalid operation identity");
  return result;
}
const sourceIdentity = (x: Obj): StartColumnValuesRequest => ({
  ...identity(x),
  queryId: x.queryId === null ? null : text(x.queryId),
  columnId: text(x.columnId),
});
function matchIdentity(actual: ColumnValuesIdentity, expected: ColumnValuesIdentity) {
  if (
    actual.operationId !== expected.operationId ||
    actual.documentId !== expected.documentId ||
    actual.sessionId !== expected.sessionId
  )
    throw new Error("The response belongs to another column operation");
}
export function validateColumnValuesPageRequest(
  request: ColumnValuesPageRequest,
): ColumnValuesPageRequest {
  identity(request as unknown as Obj);
  keys(request as unknown as Obj, [
    ...identityKeys,
    "search",
    "order",
    "offset",
    "limit",
    ...(Object.prototype.hasOwnProperty.call(request, "cursor") ? ["cursor"] : []),
  ]);
  if (
    !["valueAscending", "valueDescending", "countDescending", "countAscending"].includes(
      request.order,
    ) ||
    integer(request.limit) < 1 ||
    request.limit > 200 ||
    integer(request.offset) > Number.MAX_SAFE_INTEGER ||
    (request.search !== null &&
      (typeof request.search !== "string" ||
        request.search.includes("\0") ||
        new TextEncoder().encode(request.search).length > 4096))
  )
    throw new Error("Invalid column-values page request");
  return { ...request, cursor: parseCursor(request.cursor ?? null) };
}
function parseCursor(value: unknown): string | null {
  if (value === null) return null;
  const cursor = text(value);
  if (
    /^\p{White_Space}*$/u.test(cursor) ||
    cursor.includes("\0") ||
    new TextEncoder().encode(cursor).length > 128
  )
    throw new Error("Invalid column-values cursor");
  return cursor;
}
export function parseColumnValuesStatus(value: unknown): ColumnValuesStatus {
  const x = object(value),
    state = text(x.state) as ColumnValuesStatus["state"];
  keys(x, [...sourceKeys, "state", "stage", "totalCount", "matchedCount", "error"]);
  if (!["queued", "running", "ready", "cancelled", "failed"].includes(state))
    throw new Error("Invalid column-values state");
  return {
    ...sourceIdentity(x),
    state,
    stage: text(x.stage),
    totalCount: x.totalCount === null ? null : integer(x.totalCount),
    matchedCount: x.matchedCount === null ? null : integer(x.matchedCount),
    error: error(x.error),
  };
}
export function parseColumnValuesPage(value: unknown): ColumnValuesPageResponse {
  const x = object(value);
  keys(x, [
    ...sourceKeys,
    "totalCount",
    "matchedCount",
    "values",
    "hasMore",
    "nextCursor",
    "previousCursor",
  ]);
  if (!Array.isArray(x.values) || x.values.length > 200)
    throw new Error("Invalid column-values page");
  const values = x.values.map((item) => {
    const v = object(item);
    keys(v, ["value", "isNull", "isEmpty", "isInvalid", "count", "truncated"]);
    const result = {
      value: v.value === null ? null : text(v.value),
      isNull: boolean(v.isNull),
      isEmpty: boolean(v.isEmpty),
      isInvalid: boolean(v.isInvalid),
      count: integer(v.count),
      truncated: boolean(v.truncated),
    };
    if (
      result.count < 1 ||
      (result.isNull && (result.value !== null || result.isEmpty || result.isInvalid)) ||
      (result.isEmpty && (result.value !== "" || result.isInvalid)) ||
      (!result.isNull && result.value === null) ||
      (result.value !== null && [...result.value].length > 1024)
    )
      throw new Error("Invalid distinct value state");
    return result;
  });
  const totalCount = integer(x.totalCount),
    matchedCount = integer(x.matchedCount);
  if (matchedCount > totalCount || values.length > matchedCount)
    throw new Error("Inconsistent distinct totals");
  const hasMore = boolean(x.hasMore),
    nextCursor = parseCursor(x.nextCursor),
    previousCursor = parseCursor(x.previousCursor);
  if (hasMore !== (nextCursor !== null)) throw new Error("Inconsistent column page cursor");
  return {
    ...sourceIdentity(x),
    totalCount,
    matchedCount,
    values,
    hasMore,
    nextCursor,
    previousCursor,
  };
}
export function parseCacheSelection(value: unknown): CacheLocationSelection | null {
  if (value === null) return null;
  const x = object(value),
    p = object(x.preview);
  keys(x, ["selectionId", "preview"]);
  keys(p, [
    ...("sourceUnavailable" in p ? ["sourceUnavailable"] : []),
    "sourcePath",
    "targetPath",
    "bytes",
    "entries",
    "activeEntries",
    "availableBytes",
    "requiredFreeBytes",
  ]);
  return {
    selectionId: text(x.selectionId),
    preview: {
      sourceUnavailable: p.sourceUnavailable === undefined ? false : boolean(p.sourceUnavailable),
      sourcePath: text(p.sourcePath),
      targetPath: text(p.targetPath),
      bytes: integer(p.bytes),
      entries: integer(p.entries),
      activeEntries: integer(p.activeEntries),
      availableBytes: integer(p.availableBytes),
      requiredFreeBytes: integer(p.requiredFreeBytes),
    },
  };
}
export function parseCacheMigrationStatus(value: unknown): CacheMigrationStatus {
  const x = object(value),
    p = object(x.progress),
    state = text(x.state) as CacheMigrationStatus["state"];
  keys(x, ["operationId", "state", "progress", "sourcePath", "targetPath", "error", "result"]);
  keys(p, ["copiedBytes", "totalBytes", "copiedEntries", "totalEntries", "phase"]);
  if (!["queued", "running", "complete", "cancelled", "failed"].includes(state))
    throw new Error("Invalid cache migration state");
  const result = x.result === null ? null : object(x.result);
  if (result)
    keys(result, ["sourcePath", "targetPath", "movedBytes", "movedEntries", "cleanupFailures"]);
  if (
    result &&
    (!Array.isArray(result.cleanupFailures) ||
      result.cleanupFailures.some((v) => typeof v !== "string"))
  )
    throw new Error("Invalid migration cleanup result");
  return {
    operationId: text(x.operationId),
    state,
    progress: {
      copiedBytes: integer(p.copiedBytes),
      totalBytes: integer(p.totalBytes),
      copiedEntries: integer(p.copiedEntries),
      totalEntries: integer(p.totalEntries),
      phase: text(p.phase),
    },
    sourcePath: text(x.sourcePath),
    targetPath: text(x.targetPath),
    error: error(x.error),
    result: result
      ? {
          sourcePath: text(result.sourcePath),
          targetPath: text(result.targetPath),
          movedBytes: integer(result.movedBytes),
          movedEntries: integer(result.movedEntries),
          cleanupFailures: result.cleanupFailures as string[],
        }
      : null,
  };
}
export function createColumnValuesTransport(parseCopy: (value: unknown) => CopyOperationStatus) {
  return {
    async startColumnValues(request: StartColumnValuesRequest) {
      identity(request as unknown as Obj);
      keys(request as unknown as Obj, sourceKeys);
      if (
        !request.columnId ||
        new TextEncoder().encode(request.columnId).length > 4096 ||
        (request.queryId !== null && typeof request.queryId !== "string")
      )
        throw new Error("Invalid column-values source");
      const result = parseColumnValuesStatus(await call("start_column_values", { request }));
      matchIdentity(result, request);
      if (result.columnId !== request.columnId || result.queryId !== request.queryId)
        throw new Error("The response belongs to another column scope");
      return result;
    },
    async getColumnValuesStatus(request: ColumnValuesIdentity) {
      const result = parseColumnValuesStatus(
        await call("get_column_values_status", request as unknown as Obj),
      );
      matchIdentity(result, request);
      return result;
    },
    async cancelColumnValues(request: ColumnValuesIdentity) {
      const result = parseColumnValuesStatus(
        await call("cancel_column_values", request as unknown as Obj),
      );
      matchIdentity(result, request);
      return result;
    },
    async releaseColumnValues(request: ColumnValuesIdentity) {
      await call("release_column_values", request as unknown as Obj);
    },
    async readColumnValuesPage(request: ColumnValuesPageRequest) {
      const validated = validateColumnValuesPageRequest(request);
      const result = parseColumnValuesPage(
        await call("read_column_values_page", { request: validated }),
      );
      matchIdentity(result, request);
      if (
        result.values.length > request.limit ||
        result.hasMore !== request.offset + result.values.length < result.matchedCount
      )
        throw new Error("Inconsistent column page range");
      return result;
    },
    async startColumnValuesCopy(request: ColumnValuesCopyRequest) {
      keys(request as unknown as Obj, [...identityKeys, "search", "order", "includeCounts"]);
      validateColumnValuesPageRequest({
        operationId: request.operationId,
        documentId: request.documentId,
        sessionId: request.sessionId,
        search: request.search,
        order: request.order,
        offset: 0,
        limit: 1,
      });
      if (typeof request.includeCounts !== "boolean")
        throw new Error("Invalid distinct copy options");
      const result = parseCopy(await call("start_column_values_copy", { request }));
      if (result.documentId !== request.documentId || result.sessionId !== request.sessionId)
        throw new Error("The copy belongs to another document");
      return result;
    },
    async chooseCsvCacheLocation() {
      return parseCacheSelection(await call("choose_csv_cache_location"));
    },
    async startCsvCacheMigration(selectionId: string) {
      return parseCacheMigrationStatus(await call("start_csv_cache_migration", { selectionId }));
    },
    async getCsvCacheMigrationStatus(operationId: string) {
      const status = parseCacheMigrationStatus(
        await call("get_csv_cache_migration_status", { operationId }),
      );
      if (status.operationId !== operationId) throw new Error("Migration identity changed");
      return status;
    },
    async cancelCsvCacheMigration(operationId: string) {
      return parseCacheMigrationStatus(await call("cancel_csv_cache_migration", { operationId }));
    },
  };
}
