import type {
  SqlColumnMode,
  SqlSourceColumn,
  SqlTableBinding,
  SqlTableDescriptor,
} from "./backend";
import { foldSqlIdentifier, validateSqlAlias } from "./backend";
import identifierKeywords from "./identifierKeywords.json";

export interface SqlTable extends SqlTableDescriptor {
  alias: string;
  columnMode: SqlColumnMode;
}
export const sourceKey = (source: { documentId: string; sessionId: string }) =>
  JSON.stringify([source.documentId, source.sessionId]);
export const quoteSqlIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sqlKeywords = new Set(identifierKeywords.keywords);
// Match DuckDB's conservative ASCII/keyword quoting policy, preserving spelling.
export const sqlIdentifier = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !sqlKeywords.has(foldSqlIdentifier(name))
    ? name
    : quoteSqlIdentifier(name);
export const sqlTableName = (alias: string) => sqlIdentifier(alias);
export function sqlColumnName(column: SqlSourceColumn, mode: SqlColumnMode): string {
  return mode === "ordinal" ? `c${column.sourceIndex + 1}` : sqlIdentifier(column.originalName);
}
export function reconcileSqlTables(
  descriptors: SqlTableDescriptor[],
  previous: SqlTable[],
): SqlTable[] {
  const old = new Map(previous.map((t) => [sourceKey(t), t]));
  const used: string[] = [];
  return descriptors.map((descriptor) => {
    const existing = old.get(sourceKey(descriptor));
    let base =
      descriptor.fileName.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_]/gu, "_") || "table";
    if (/^[0-9]/.test(base)) base = `t_${base}`;
    base = [...base].slice(0, 100).join("");
    let alias = existing?.alias ?? base;
    let n = 2;
    while (validateSqlAlias(alias, used)) alias = `${base}_${n++}`;
    used.push(alias);
    return {
      ...descriptor,
      alias,
      columnMode:
        existing?.columnMode === "name" && !descriptor.nameModeAllowed
          ? "ordinal"
          : (existing?.columnMode ?? descriptor.defaultColumnMode),
    };
  });
}
export function tableBindings(tables: readonly SqlTable[]): SqlTableBinding[] {
  return tables.map(({ documentId, sessionId, alias, columnMode }) => ({
    documentId,
    sessionId,
    alias,
    columnMode,
  }));
}
export type SqlExample = "basic" | "filter" | "group" | "join";
export function sqlExample(
  kind: SqlExample,
  tables: readonly SqlTable[],
  selected: SqlTable | undefined,
): string {
  const a = selected ?? tables[0];
  if (!a || !a.columns.length) return "-- Open a CSV or Parquet file to start.";
  const name = sqlTableName(a.alias),
    first = sqlColumnName(a.columns[0], a.columnMode);
  if (kind === "join") {
    const b = tables.find((t) => sourceKey(t) !== sourceKey(a));
    if (!b?.columns.length) return "-- Open a second file to create a JOIN example.";
    return `SELECT a.${first},\n       b.${sqlColumnName(b.columns[0], b.columnMode)}\nFROM ${name} AS a\nJOIN ${sqlTableName(b.alias)} AS b\n  ON a.${first} = b.${sqlColumnName(b.columns[0], b.columnMode)}\nLIMIT 100;`;
  }
  if (kind === "group")
    return `SELECT ${first}, COUNT(*) AS row_count\nFROM ${name}\nGROUP BY ${first}\nORDER BY row_count DESC\nLIMIT 100;`;
  if (kind === "filter")
    return `SELECT *\nFROM ${name}\nWHERE ${first} IS NOT NULL\nORDER BY ${first}\nLIMIT 100;`;
  return `SELECT *\nFROM ${name}\nLIMIT 100;`;
}
export function sqlAliasConflict(alias: string, table: SqlTable, all: readonly SqlTable[]) {
  return validateSqlAlias(
    alias,
    all.filter((t) => sourceKey(t) !== sourceKey(table)).map((t) => t.alias),
  );
}
export const sameSqlIdentifier = (a: string, b: string) =>
  foldSqlIdentifier(a) === foldSqlIdentifier(b);
