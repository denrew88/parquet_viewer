export const SQL_PANE_LAYOUT_KEY = "data-viewer.sql-pane-layout.v1";
export const SQL_PANE_SEPARATOR = 7;
export type SourceDock = "auto" | "right" | "bottom";
export interface SqlPanePreference {
  tables: number;
  source: number;
  sourceHeight: number;
  dock: SourceDock;
}
export const defaultSqlPanePreference: SqlPanePreference = {
  tables: 0.2,
  source: 0.4,
  sourceHeight: 0.46,
  dock: "auto",
};
const ratio = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0.05 && value <= 0.85
    ? value
    : fallback;

export function readSqlPanePreference(): SqlPanePreference {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SQL_PANE_LAYOUT_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return { ...defaultSqlPanePreference };
    const value = stored as Partial<SqlPanePreference>;
    return {
      tables: ratio(value.tables, defaultSqlPanePreference.tables),
      source: ratio(value.source, defaultSqlPanePreference.source),
      sourceHeight: ratio(value.sourceHeight, defaultSqlPanePreference.sourceHeight),
      dock: value.dock === "right" || value.dock === "bottom" ? value.dock : "auto",
    };
  } catch {
    return { ...defaultSqlPanePreference };
  }
}
export function saveSqlPanePreference(value: SqlPanePreference) {
  try {
    localStorage.setItem(SQL_PANE_LAYOUT_KEY, JSON.stringify(value));
  } catch {
    // A full or unavailable preference store must not disable pane resizing.
  }
}
export function sqlPaneGeometry(
  width: number,
  height: number,
  preference: SqlPanePreference,
  sourceOpen: boolean,
) {
  const safeWidth = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 0);
  const safeHeight = Math.max(0, Number.isFinite(height) ? Math.floor(height) : 0);
  const dock =
    preference.dock === "auto"
      ? safeWidth < 1000 && safeHeight >= 700
        ? "bottom"
        : "right"
      : preference.dock;
  const side = sourceOpen && dock === "right";
  const separators = SQL_PANE_SEPARATOR * (side ? 2 : 1);
  const available = Math.max(0, safeWidth - separators);
  const minTables = Math.min(150, Math.floor(available * 0.24));
  const minSource = side ? Math.min(280, Math.floor(available * 0.35)) : 0;
  const minQuery = Math.min(280, Math.floor(available * (side ? 0.35 : 0.52)));
  const tablesMax = Math.max(minTables, available - minQuery - minSource);
  const tables = Math.round(
    Math.max(minTables, Math.min(tablesMax, safeWidth * preference.tables)),
  );
  const sourceMax = Math.max(minSource, available - tables - minQuery);
  const source = side
    ? Math.round(Math.max(minSource, Math.min(sourceMax, safeWidth * preference.source)))
    : 0;
  const query = Math.max(0, available - tables - source);
  const verticalAvailable = Math.max(0, safeHeight - SQL_PANE_SEPARATOR);
  const minSourceHeight = Math.min(180, Math.floor(verticalAvailable * 0.42));
  const minQueryHeight = Math.min(250, Math.floor(verticalAvailable * 0.5));
  const sourceHeightMax = Math.max(minSourceHeight, verticalAvailable - minQueryHeight);
  const sourceHeight = Math.round(
    Math.max(
      minSourceHeight,
      Math.min(sourceHeightMax, verticalAvailable * preference.sourceHeight),
    ),
  );
  return {
    dock,
    tables,
    source,
    query,
    minTables,
    tablesMax,
    minSource,
    sourceMax,
    sourceHeight,
    minSourceHeight,
    sourceHeightMax,
  };
}
