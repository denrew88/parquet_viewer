import type { CopyOperationStatus } from "../backend";
import { validateColumnValuesPageRequest } from "./backend";
import type {
  CacheLocationSelection,
  CacheMigrationStatus,
  ColumnValue,
  ColumnValuesCopyRequest,
  ColumnValuesIdentity,
  ColumnValuesPageRequest,
  ColumnValuesStatus,
  StartColumnValuesRequest,
} from "./backend";

export function createColumnValuesMock(
  load: (request: StartColumnValuesRequest) => Promise<ColumnValue[]>,
  copy: (request: ColumnValuesCopyRequest, values: ColumnValue[]) => Promise<CopyOperationStatus>,
  migrated: (path: string) => void,
) {
  type Cursor = {
    offset: number;
    limit: number;
    search: string;
    order: ColumnValuesPageRequest["order"];
    expiresAt: number;
  };
  const tasks = new Map<
    string,
    { status: ColumnValuesStatus; values: ColumnValue[]; cursors: Map<string, Cursor> }
  >();
  const migrations = new Map<string, CacheMigrationStatus>();
  let selection: CacheLocationSelection | null = null;
  const task = (id: ColumnValuesIdentity) => {
    const found = tasks.get(id.operationId);
    if (
      !found ||
      found.status.documentId !== id.documentId ||
      found.status.sessionId !== id.sessionId
    )
      throw new Error("Column values operation is unavailable");
    return found;
  };
  const matching = (request: ColumnValuesPageRequest | ColumnValuesCopyRequest) => {
    const item = task(request);
    let values = item.values.filter(
      (v) =>
        !request.search ||
        (v.value ?? "").toLocaleLowerCase().includes(request.search.toLocaleLowerCase()),
    );
    const compare = (a: ColumnValue, b: ColumnValue, descending = false) => {
      const category = (v: ColumnValue) => (v.isNull ? 3 : v.isEmpty ? 2 : v.isInvalid ? 1 : 0);
      const categoryDifference = category(a) - category(b);
      if (categoryDifference) return categoryDifference;
      const av = a.value ?? "";
      const bv = b.value ?? "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * (descending ? -1 : 1);
    };
    values = [...values].sort((a, b) =>
      request.order === "valueAscending"
        ? compare(a, b)
        : request.order === "valueDescending"
          ? compare(a, b, true)
          : request.order === "countDescending"
            ? b.count - a.count || compare(a, b)
            : a.count - b.count || compare(a, b),
    );
    return values;
  };
  return {
    async startColumnValues(request: StartColumnValuesRequest) {
      if (tasks.has(request.operationId)) throw new Error("Operation ID already used");
      const values = await load(request);
      const status: ColumnValuesStatus = {
        ...request,
        state: "ready",
        stage: "complete",
        totalCount: values.length,
        matchedCount: values.length,
        error: null,
      };
      tasks.set(request.operationId, { status, values, cursors: new Map() });
      return status;
    },
    async getColumnValuesStatus(request: ColumnValuesIdentity) {
      return task(request).status;
    },
    async cancelColumnValues(request: ColumnValuesIdentity) {
      const found = task(request);
      found.status = { ...found.status, state: "cancelled" };
      found.cursors.clear();
      return found.status;
    },
    async releaseColumnValues(request: ColumnValuesIdentity) {
      const found = tasks.get(request.operationId);
      if (
        found &&
        found.status.documentId === request.documentId &&
        found.status.sessionId === request.sessionId
      )
        tasks.delete(request.operationId);
    },
    async readColumnValuesPage(request: ColumnValuesPageRequest) {
      const validated = validateColumnValuesPageRequest(request);
      const found = task(validated);
      if (found.status.state !== "ready") throw new Error("Column values operation is unavailable");
      if (validated.cursor) {
        const marker = found.cursors.get(validated.cursor);
        if (
          !marker ||
          marker.expiresAt < Date.now() ||
          marker.offset !== validated.offset ||
          marker.limit !== validated.limit ||
          marker.search !== (validated.search || "") ||
          marker.order !== validated.order
        )
          throw new Error("Column values cursor is unavailable for this page");
      }
      const values = matching(validated);
      const page = values.slice(validated.offset, validated.offset + validated.limit);
      const hasMore = validated.offset + page.length < values.length;
      const cursor = (offset: number) => {
        const token = crypto.randomUUID();
        found.cursors.set(token, {
          offset,
          limit: validated.limit,
          search: validated.search || "",
          order: validated.order,
          expiresAt: Date.now() + 30 * 60 * 1000,
        });
        while (found.cursors.size > 256) found.cursors.delete(found.cursors.keys().next().value!);
        return token;
      };
      return {
        ...found.status,
        totalCount: found.values.length,
        matchedCount: values.length,
        values: page,
        hasMore,
        nextCursor: hasMore ? cursor(validated.offset + page.length) : null,
        previousCursor:
          page.length && validated.offset > 0
            ? cursor(Math.max(0, validated.offset - validated.limit))
            : null,
      };
    },
    async startColumnValuesCopy(request: ColumnValuesCopyRequest) {
      return copy(request, matching(request));
    },
    async chooseCsvCacheLocation() {
      selection = {
        selectionId: crypto.randomUUID(),
        preview: {
          sourcePath: "Browser mock (no persistent cache)",
          targetPath: "D:\\Data Viewer Cache\\data-viewer-csv-cache",
          bytes: 0,
          entries: 0,
          activeEntries: 0,
          availableBytes: 100 * 1024 ** 3,
          requiredFreeBytes: 5 * 1024 ** 3,
        },
      };
      return selection;
    },
    async startCsvCacheMigration(selectionId: string) {
      if (!selection || selection.selectionId !== selectionId)
        throw new Error("Choose a cache location again");
      const status: CacheMigrationStatus = {
        operationId: crypto.randomUUID(),
        state: "complete",
        progress: {
          copiedBytes: selection.preview.bytes,
          totalBytes: selection.preview.bytes,
          copiedEntries: selection.preview.entries,
          totalEntries: selection.preview.entries,
          phase: "complete",
        },
        sourcePath: selection.preview.sourcePath,
        targetPath: selection.preview.targetPath,
        error: null,
        result: {
          sourcePath: selection.preview.sourcePath,
          targetPath: selection.preview.targetPath,
          movedBytes: selection.preview.bytes,
          movedEntries: selection.preview.entries,
          cleanupFailures: [],
        },
      };
      migrations.set(status.operationId, status);
      migrated(status.targetPath);
      return status;
    },
    async getCsvCacheMigrationStatus(operationId: string) {
      const found = migrations.get(operationId);
      if (!found) throw new Error("Migration not found");
      return found;
    },
    async cancelCsvCacheMigration(operationId: string) {
      const found = migrations.get(operationId);
      if (!found) throw new Error("Migration not found");
      return found;
    },
  };
}
