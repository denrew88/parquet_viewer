import type { SqlSourceIdentity, SqlStatus, SqlTableBinding, StartSqlRequest } from "./backend";

export interface SqlExecutionSnapshot {
  readonly runId: string;
  readonly sql: string;
  readonly editorSql: string;
  readonly tables: readonly SqlTableBinding[];
}
export function captureSqlExecution(
  request: StartSqlRequest,
  editorSql = request.sql,
): SqlExecutionSnapshot {
  return Object.freeze({
    runId: request.runId,
    sql: request.sql,
    editorSql,
    tables: Object.freeze(request.tables.map((table) => Object.freeze({ ...table }))),
  });
}
const identities = (sources: readonly SqlSourceIdentity[]) =>
  JSON.stringify(
    sources.map((source) => JSON.stringify([source.documentId, source.sessionId])).sort(),
  );
const configuration = (tables: readonly SqlTableBinding[]) =>
  JSON.stringify(
    tables
      .map((table) =>
        JSON.stringify([table.documentId, table.sessionId, table.alias, table.columnMode]),
      )
      .sort(),
  );
export function sqlOutputContext(
  snapshot: SqlExecutionSnapshot,
  kind: "result" | "plan",
  sql: string,
  tables: readonly SqlTableBinding[],
  sources: readonly SqlSourceIdentity[],
  status: SqlStatus | null,
  pendingResult: boolean,
) {
  const labels: string[] = [];
  if (snapshot.editorSql !== sql) labels.push(`SQL changed · previous ${kind}`);
  if (
    configuration(snapshot.tables) !== configuration(tables) ||
    identities(snapshot.tables) !== identities(sources)
  )
    labels.push(`Table setup changed · previous ${kind}`);
  const current = labels.length === 0;
  if (current) labels.push(`Current ${kind}`);
  if (status && status.runId !== snapshot.runId) {
    if (status.state === "failed")
      labels.push(`Latest execution failed · previous successful ${kind}`);
    else if (status.state === "cancelled")
      labels.push(`Latest execution cancelled · previous successful ${kind}`);
    else if (status.state === "queued" || status.state === "running")
      labels.push(`Query running · previous successful ${kind}`);
    else if (kind === "result" && pendingResult)
      labels.push("New result loading · previous successful result");
  }
  return { current, labels };
}

export const SQL_HELP_PREFERENCE_KEY = "data-viewer.sql.examples-help-open.v1";
export function readSqlHelpOpen(): boolean {
  try {
    return window.localStorage.getItem(SQL_HELP_PREFERENCE_KEY) !== "false";
  } catch {
    return true;
  }
}
export function saveSqlHelpOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SQL_HELP_PREFERENCE_KEY, String(open));
  } catch {
    /* UI remains usable without persistence. */
  }
}
