import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, Pencil, Play, Square, X } from "lucide-react";
import type { BackendAdapter, DataPage, FileSummary } from "../backend";
import type { AppSettings } from "../settings/model";
import {
  SQL_MAX_BYTES,
  trimSqlWhitespace,
  validateSqlRequest,
  type SqlAction,
  type SqlSourceIdentity,
  type SqlStatus,
} from "./backend";
import {
  sqlIdentifier,
  reconcileSqlTables,
  sourceKey,
  sqlAliasConflict,
  sqlColumnName,
  sqlExample,
  sqlTableName,
  tableBindings,
  type SqlExample,
  type SqlTable,
} from "./model";
import "./SqlWorkspace.css";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { SqlPlan } from "./SqlPlan";
import { SqlResults } from "./SqlResults";
import { clampSourcePane, SOURCE_SEPARATOR_PX } from "./sourcePaneState";
import { clampQueryPane, QUERY_SEPARATOR_PX, useVerticalSplitter } from "./useVerticalSplitter";
import {
  captureSqlExecution,
  readSqlHelpOpen,
  saveSqlHelpOpen,
  sqlOutputContext,
  type SqlExecutionSnapshot,
} from "./workspaceState";

interface Props {
  active: boolean;
  backend: BackendAdapter;
  sources: SqlSourceIdentity[];
  settings: AppSettings;
  onOpenCopySettings(): void;
  onOpenSource(source: SqlSourceIdentity): void;
}
interface Result {
  execution: SqlExecutionSnapshot;
  status: SqlStatus;
  summary: FileSummary;
  page: DataPage;
}
interface PendingResult {
  status: SqlStatus;
  execution: SqlExecutionSnapshot;
}
const busyStatus = (status: SqlStatus | null) =>
  status?.state === "queued" || status?.state === "running";
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
function resultSummary(status: SqlStatus): FileSummary {
  return {
    sessionId: status.resultId!,
    fileName: "SQL result",
    path: "SQL result",
    format: "sql-result",
    fileSize: 0,
    rowCount: status.rowCount,
    columnCount: status.columns.length,
    rowGroupCount: 0,
    rowGroups: [],
    csvMetadata: null,
    rowCountStatus: {
      state: "complete",
      rowsScanned: status.rowCount ?? 0,
      bytesScanned: 0,
      totalBytes: 0,
      generation: 0,
      message: null,
    },
    columns: status.columns.map((column) => ({
      name: column.id,
      logicalType: column.logicalType,
      valueLogicalType: column.logicalType,
      physicalType: column.logicalType,
      nullable: column.nullable,
    })),
  };
}
export function SqlWorkspace({
  active,
  backend,
  sources,
  settings,
  onOpenCopySettings,
  onOpenSource,
}: Props) {
  const api = backend.sqlWorkspace;
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);
  const [aliasEdit, setAliasEdit] = useState<{ key: string; value: string } | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SqlStatus | null>(null);
  const [planSnapshot, setPlanSnapshot] = useState<PendingResult | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportInProgress = useRef(false);
  const onExportBusyChange = useCallback((busy: boolean) => {
    exportInProgress.current = busy;
    setExporting(busy);
  }, []);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<PendingResult | null>(null);
  const [output, setOutput] = useState<"result" | "plan" | "messages">("result");
  const [helpOpen, setHelpOpen] = useState(readSqlHelpOpen);
  const [helpTab, setHelpTab] = useState<"examples" | "guide">("examples");
  const [example, setExample] = useState<SqlExample>("basic");
  const editor = useRef<SqlEditorHandle>(null);
  const columnScroll = useRef<HTMLDivElement>(null);
  const sourceSplit = useVerticalSplitter<HTMLElement>(active, clampSourcePane);
  const querySplit = useVerticalSplitter<HTMLDivElement>(active, clampQueryPane);
  const mounted = useRef(true),
    opened = useRef(false),
    sourceGeneration = useRef(0),
    sequence = useRef(0);
  const resultRef = useRef<Result | null>(null),
    pendingResultRef = useRef<PendingResult | null>(null);
  const currentRun = useRef<{ runId: string; started: boolean; cancelRequested: boolean } | null>(
    null,
  );
  const latestTables = useRef(tables);
  latestTables.current = tables;
  const activeRef = useRef(active);
  activeRef.current = active;
  const sourcesKey = JSON.stringify(sources);
  const busy = busyStatus(status);
  const selected = tables.find((table) => sourceKey(table) === selectedKey) ?? tables[0];
  const selectedCol =
    selected?.columns.find((column) => column.id === selectedColumn) ?? selected?.columns[0];
  const columns = useMemo(
    () =>
      selected?.columns.filter((column) =>
        `${column.originalName} ${sqlColumnName(column, selected.columnMode)}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase().trim()),
      ) ?? [],
    [selected, search],
  );
  const columnVirtualizer = useVirtualizer({
    count: columns.length,
    getScrollElement: () => columnScroll.current,
    estimateSize: () => 42,
    overscan: 5,
    initialRect: { width: 240, height: 230 },
  });
  const exampleSql = sqlExample(example, tables, selected);
  const sqlBytes = new TextEncoder().encode(sql).length;

  useEffect(() => {
    if (active) opened.current = true;
    if (!api || (!active && !opened.current)) return;
    const generation = ++sourceGeneration.current;
    if (sources.length > 32) {
      setSourceLoading(false);
      setSourceError(
        "SQL supports at most 32 open CSV/Parquet files. Close unused files before registering SQL inputs.",
      );
      return;
    }
    setSourceLoading(true);
    setSourceError(null);
    void api
      .describeTables(JSON.parse(sourcesKey) as SqlSourceIdentity[])
      .then((descriptors) => {
        if (!mounted.current || generation !== sourceGeneration.current) return;
        setTables((old) => reconcileSqlTables(descriptors, old));
      })
      .catch((cause) => {
        if (mounted.current && generation === sourceGeneration.current)
          setSourceError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted.current && generation === sourceGeneration.current) setSourceLoading(false);
      });
  }, [active, api, sourcesKey, sources.length, sourceRetry]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const run = currentRun.current;
      if (run) void api?.cancelQuery(run.runId).catch(() => {});
      const snapshots = [resultRef.current?.status, pendingResultRef.current?.status].filter(
        (s): s is SqlStatus => Boolean(s?.resultId),
      );
      snapshots.forEach((s) => void api?.releaseResult(s.runId, s.resultId!).catch(() => {}));
    };
  }, [api]);

  function selectTable(table: SqlTable) {
    setSelectedKey(sourceKey(table));
    setSearch("");
    setSelectedColumn(null);
    setAliasEdit(null);
    setAliasError(null);
    columnScroll.current?.scrollTo?.({ top: 0 });
  }
  function insert(text: string) {
    editor.current?.insertText(text);
  }
  function beginAlias(table: SqlTable) {
    if (busy) return;
    setAliasEdit({ key: sourceKey(table), value: table.alias });
    setAliasError(null);
  }
  function commitAlias(table: SqlTable) {
    if (!aliasEdit || busy) return;
    const value = trimSqlWhitespace(aliasEdit.value),
      validation = sqlAliasConflict(value, table, tables);
    if (validation) {
      setAliasError(validation);
      return;
    }
    setTables((old) =>
      old.map((t) => (sourceKey(t) === sourceKey(table) ? { ...t, alias: value } : t)),
    );
    setAliasEdit(null);
    setAliasError(null);
    setNotice(
      "Table alias changed. Existing SQL was not rewritten; check the query or insert an updated example.",
    );
  }
  function changeMode(table: SqlTable, columnMode: SqlTable["columnMode"]) {
    if (
      busy ||
      columnMode === table.columnMode ||
      (columnMode === "name" && !table.nameModeAllowed)
    )
      return;
    setTables((old) =>
      old.map((t) => (sourceKey(t) === sourceKey(table) ? { ...t, columnMode } : t)),
    );
    setNotice("SQL column mode changed for this table only. Existing SQL was not rewritten.");
  }
  async function publishResult(next: SqlStatus, execution: SqlExecutionSnapshot) {
    if (!api || !next.resultId) return;
    setPageError(null);
    const page = await api.readPage({
      runId: next.runId,
      resultId: next.resultId,
      offset: 0,
      limit: 100,
      columns: next.columns.slice(0, 64).map((c) => c.id),
    });
    if (!mounted.current || currentRun.current?.runId !== next.runId) {
      await api.releaseResult(next.runId, next.resultId);
      return;
    }
    const previous = resultRef.current;
    const value = { status: next, page, summary: resultSummary(next), execution };
    resultRef.current = value;
    setResult(value);
    setPendingResult(null);
    pendingResultRef.current = null;
    setOutput("result");
    if (previous?.status.resultId && previous.status.resultId !== next.resultId)
      void api.releaseResult(previous.status.runId, previous.status.resultId).catch((cause) => {
        if (mounted.current) setError(errorMessage(cause));
      });
  }
  async function execute(action: SqlAction, statement = sql, draft = sql) {
    if (!api || busyStatus(status) || sourceLoading || exportInProgress.current) return;
    if (sourceError) {
      setError(sourceError);
      setOutput("messages");
      return;
    }
    const runId = `sql-${Date.now()}-${++sequence.current}`;
    const request = { runId, sql: statement, action, tables: tableBindings(latestTables.current) };
    const execution = captureSqlExecution(request, draft);
    try {
      validateSqlRequest(request);
    } catch (cause) {
      setError(errorMessage(cause));
      setOutput("messages");
      return;
    }
    // Abandon a previous unpublished result only when a new explicit execution begins.
    const previousPending = pendingResultRef.current;
    if (previousPending?.status.resultId) {
      await api
        .releaseResult(previousPending.status.runId, previousPending.status.resultId)
        .catch(() => {});
      pendingResultRef.current = null;
      setPendingResult(null);
    }
    const run = { runId, started: false, cancelRequested: false };
    currentRun.current = run;
    setError(null);
    setPageError(null);
    setNotice(null);
    setStatus({
      runId,
      state: "queued",
      phase: "starting",
      elapsedMs: 0,
      rowsProduced: 0,
      resultId: null,
      columns: [],
      rowCount: null,
      planText: null,
      planJson: null,
      warnings: [],
      error: null,
    });
    try {
      let next = await api.startQuery(request);
      run.started = true;
      if (run.cancelRequested && busyStatus(next)) next = await api.cancelQuery(runId);
      while (mounted.current && currentRun.current === run) {
        setStatus(next);
        if (!busyStatus(next)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (!mounted.current || currentRun.current !== run) return;
        next = await api.getStatus(runId);
      }
      if (!mounted.current || currentRun.current !== run) return;
      if (next.state === "complete") {
        if (action !== "execute") {
          setPlanSnapshot({ status: next, execution });
          setOutput("plan");
        } else if (next.resultId) {
          pendingResultRef.current = { status: next, execution };
          setPendingResult({ status: next, execution });
          await publishResult(next, execution).catch((cause) => {
            if (mounted.current && currentRun.current === run) {
              setPageError(errorMessage(cause));
              setOutput("result");
            }
          });
        }
      } else if (next.state === "failed") {
        setError(next.error?.message ?? "SQL execution failed.");
        setOutput("messages");
      } else if (next.state === "cancelled")
        setNotice(
          next.error?.message ??
            "SQL execution cancelled. The previous successful result is unchanged.",
        );
    } catch (cause) {
      if (mounted.current && currentRun.current === run) {
        setError(errorMessage(cause));
        setOutput("messages");
        setStatus((old) =>
          old?.runId === runId
            ? {
                ...old,
                state: "failed",
                phase: "failed",
                error: { code: "QueryFailed", message: errorMessage(cause) },
              }
            : old,
        );
      }
    }
  }
  async function cancel() {
    const run = currentRun.current;
    if (!api || !run) return;
    run.cancelRequested = true;
    setNotice("Cancelling SQL execution…");
    if (run.started)
      await api
        .cancelQuery(run.runId)
        .then((next) => {
          if (mounted.current && currentRun.current === run) setStatus(next);
        })
        .catch((cause) => {
          if (mounted.current) setError(errorMessage(cause));
        });
  }
  async function clearResult() {
    const old = resultRef.current;
    if (!api || !old?.status.resultId || busy || exportInProgress.current) return;
    try {
      await api.releaseResult(old.status.runId, old.status.resultId);
      resultRef.current = null;
      setResult(null);
      setPageError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const resultSnapshot = result?.status;
  const resultContext = result
    ? sqlOutputContext(
        result.execution,
        "result",
        sql,
        tableBindings(tables),
        sources,
        status,
        Boolean(pendingResult),
      )
    : null;
  const planContext = planSnapshot
    ? sqlOutputContext(
        planSnapshot.execution,
        "plan",
        sql,
        tableBindings(tables),
        sources,
        status,
        false,
      )
    : null;
  return (
    <section className="sql-workspace" aria-label="SQL workspace" hidden={!active}>
      <aside
        className="sql-sources"
        aria-label="SQL tables and columns"
        ref={sourceSplit.pane}
        style={
          sourceSplit.height > 0
            ? { gridTemplateRows: `${sourceSplit.top}px ${SOURCE_SEPARATOR_PX}px minmax(0, 1fr)` }
            : undefined
        }
      >
        <div className="sql-table-area">
          <h2>
            Tables <span>{tables.length} files</span>
          </h2>
          {sourceLoading && <p role="status">Loading SQL schemas…</p>}
          {sourceError && (
            <div className="sql-error" role="alert">
              {sourceError}
              <button type="button" onClick={() => setSourceRetry((n) => n + 1)}>
                Retry SQL schemas
              </button>
            </div>
          )}
          {!tables.length && !sourceLoading && (
            <p className="sql-help-note">Open a CSV or Parquet file to register a SQL table.</p>
          )}
          <div className="sql-table-list">
            {tables.map((table) => {
              const key = sourceKey(table);
              return (
                <div key={key} className={`sql-table${selected === table ? " is-selected" : ""}`}>
                  {aliasEdit?.key === key ? (
                    <form
                      className="sql-alias-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitAlias(table);
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Table alias"
                        maxLength={256}
                        value={aliasEdit.value}
                        onChange={(e) => setAliasEdit({ key, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setAliasEdit(null);
                            setAliasError(null);
                          }
                        }}
                      />
                      <button type="submit" aria-label="Save table alias">
                        ✓
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel alias edit"
                        onClick={() => {
                          setAliasEdit(null);
                          setAliasError(null);
                        }}
                      >
                        ×
                      </button>
                    </form>
                  ) : null}
                  <button
                    type="button"
                    className="sql-table__select"
                    aria-label={table.alias}
                    aria-description={`${table.path}. ${table.columnMode === "name" ? "Names only" : "c-numbers only"}`}
                    aria-pressed={selected === table}
                    onClick={(event) => {
                      selectTable(table);
                      event.currentTarget.scrollIntoView?.({ block: "nearest" });
                    }}
                    onDoubleClick={() => beginAlias(table)}
                  >
                    {aliasEdit?.key !== key && (
                      <span className="sql-table__alias">{table.alias}</span>
                    )}
                    <span className="sql-table__path" title={table.path}>
                      {table.path}
                    </span>
                    <span className="sql-table__mode">
                      {table.columnMode === "name" ? "Names only" : "c-numbers only"}
                    </span>
                  </button>
                  {aliasEdit?.key !== key && (
                    <button
                      type="button"
                      disabled={busy}
                      className="sql-icon-button"
                      aria-label={`Rename table ${table.alias}`}
                      onClick={() => beginAlias(table)}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                  )}
                  {aliasEdit?.key === key && aliasError && (
                    <p className="sql-error" role="alert">
                      {aliasError}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="sql-help-note">
            Double-click an alias or use its pencil to rename. File names stay unchanged.
          </p>
        </div>
        <div
          {...sourceSplit.separator}
          aria-label="Resize tables and columns"
          className="sql-source-separator"
        />
        <div className="sql-column-area">
          <h2>
            {selected ? `${selected.alias} columns` : "Columns"}
            <span>
              {columns.length}/{selected?.columns.length ?? 0}
            </span>
          </h2>
          {selected && (
            <>
              <fieldset className="sql-column-mode" disabled={busy}>
                <legend>SQL column reference</legend>
                <p>
                  Choose <strong>one</strong> mode for this table.
                </p>
                <label>
                  <input
                    type="radio"
                    name="sql-column-mode"
                    checked={selected.columnMode === "name"}
                    disabled={!selected.nameModeAllowed}
                    onChange={() => changeMode(selected, "name")}
                  />
                  <span>
                    Original names only
                    <small>e.g. {sqlIdentifier(selected.columns[0]?.originalName ?? "name")}</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="sql-column-mode"
                    checked={selected.columnMode === "ordinal"}
                    onChange={() => changeMode(selected, "ordinal")}
                  />
                  <span>
                    c-numbers only<small>c1, c2, c3…</small>
                  </span>
                </label>
                <p className={!selected.nameModeAllowed ? "sql-error" : ""}>
                  {selected.nameModeReason ??
                    `Only ${selected.columnMode === "name" ? "original names" : "c-numbers"} are exposed to SQL. The two modes cannot be mixed within this table.`}
                </p>
              </fieldset>
              <input
                className="sql-column-search"
                aria-label="Search SQL columns"
                placeholder="Original name or SQL reference"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="sql-column-list" ref={columnScroll} aria-label="SQL column list">
                <div style={{ height: columnVirtualizer.getTotalSize(), position: "relative" }}>
                  {columnVirtualizer.getVirtualItems().map((item) => {
                    const column = columns[item.index];
                    return (
                      <button
                        type="button"
                        key={column.id}
                        className="sql-column"
                        aria-pressed={selectedCol?.id === column.id}
                        style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                        onClick={() => setSelectedColumn(column.id)}
                        onDoubleClick={() => insert(sqlColumnName(column, selected.columnMode))}
                      >
                        <code>{sqlColumnName(column, selected.columnMode)}</code>
                        <span title={column.originalName}>
                          {column.originalName || "(empty name)"}
                        </span>
                        <small>{column.sqlType}</small>
                      </button>
                    );
                  })}
                </div>
                {!columns.length && <p className="sql-help-note">No matching columns.</p>}
              </div>
              <p className="sql-help-note">
                Numbers follow original file positions. Double-click to insert the current SQL
                reference.
              </p>
              <div className="sql-column-actions">
                <button
                  type="button"
                  disabled={!selectedCol}
                  onClick={() =>
                    selectedCol && insert(sqlColumnName(selectedCol, selected.columnMode))
                  }
                >
                  Insert column
                </button>
                <button type="button" onClick={() => insert(sqlTableName(selected.alias))}>
                  Insert table
                </button>
                <button type="button" onClick={() => onOpenSource(selected)}>
                  View source
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
      <div className="sql-main">
        <header className="sql-query-heading">
          <h2>Query</h2>
          <button
            type="button"
            aria-expanded={helpOpen}
            onClick={() => {
              const next = !helpOpen;
              setHelpOpen(next);
              saveSqlHelpOpen(next);
            }}
          >
            <BookOpen aria-hidden="true" />
            Examples & help
          </button>
        </header>
        <div
          className="sql-split"
          ref={querySplit.pane}
          style={
            querySplit.height > 0
              ? { gridTemplateRows: `${querySplit.top}px ${QUERY_SEPARATOR_PX}px minmax(0, 1fr)` }
              : undefined
          }
        >
          <div
            id="sql-query-editor-pane"
            className={`sql-editing${helpOpen ? "" : " sql-editing--help-closed"}`}
          >
            <div className="sql-editor-area">
              <SqlEditor
                completionMode={settings.sqlCompletionMode}
                tables={sourceLoading ? [] : tables}
                value={sql}
                onChange={setSql}
                onRun={(statement, draft) => void execute("execute", statement, draft)}
                editorRef={editor}
              />
              <div className="sql-run-actions">
                <button
                  type="button"
                  className="sql-run-button"
                  disabled={
                    !api ||
                    busy ||
                    exporting ||
                    sourceLoading ||
                    !tables.length ||
                    !sql.trim() ||
                    sqlBytes > SQL_MAX_BYTES
                  }
                  onClick={() => void execute("execute")}
                >
                  <Play aria-hidden="true" />
                  Run
                </button>
                <button type="button" disabled={!busy} onClick={() => void cancel()}>
                  <Square aria-hidden="true" />
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!api || busy || exporting || !sql.trim() || !tables.length}
                  onClick={() => void execute("explain")}
                >
                  Explain
                </button>
                <button
                  type="button"
                  disabled={!api || busy || exporting || !sql.trim() || !tables.length}
                  onClick={() => void execute("analyze")}
                >
                  Analyze
                </button>
              </div>
              <p className={`sql-help-note${sqlBytes > SQL_MAX_BYTES ? " sql-error" : ""}`}>
                Ctrl+Enter runs statement at cursor · {sqlBytes.toLocaleString()}/
                {SQL_MAX_BYTES.toLocaleString()} UTF-8 bytes · Analyze executes the query.
              </p>
              <p className="sql-help-note" aria-label="Column completion help">
                Before FROM, use{" "}
                <code>{selected ? sqlTableName(selected.alias) : '"table_alias"'}.</code>;{" "}
                <code>c.</code> needs a declared alias.
              </p>
            </div>
            {helpOpen && (
              <aside className="sql-help" aria-label="SQL examples and help">
                <div role="tablist" aria-label="SQL help">
                  <button
                    role="tab"
                    id="sql-help-examples"
                    aria-controls="sql-examples-panel"
                    aria-selected={helpTab === "examples"}
                    type="button"
                    onClick={() => setHelpTab("examples")}
                  >
                    Examples
                  </button>
                  <button
                    role="tab"
                    id="sql-help-guide"
                    aria-controls="sql-guide-panel"
                    aria-selected={helpTab === "guide"}
                    type="button"
                    onClick={() => setHelpTab("guide")}
                  >
                    Writing guide
                  </button>
                </div>
                <div
                  role="tabpanel"
                  id="sql-examples-panel"
                  aria-labelledby="sql-help-examples"
                  hidden={helpTab !== "examples"}
                >
                  <div className="sql-example-options">
                    {(["basic", "filter", "group", "join"] as const).map((item) => (
                      <button
                        type="button"
                        key={item}
                        aria-pressed={example === item}
                        onClick={() => setExample(item)}
                      >
                        {
                          {
                            basic: "First rows",
                            filter: "Filter / sort",
                            group: "Aggregate",
                            join: "JOIN",
                          }[item]
                        }
                      </button>
                    ))}
                  </div>
                  <pre aria-label="SQL example">{exampleSql}</pre>
                  <button
                    type="button"
                    disabled={!tables.length}
                    onClick={() => {
                      setSql(exampleSql);
                      setNotice("Example inserted. It has not been executed.");
                      editor.current?.focus();
                    }}
                  >
                    Insert example
                  </button>
                  <p className="sql-help-note">
                    Replaces editor text. Uses the current aliases and each table’s selected mode;
                    does not run automatically.
                  </p>
                </div>
                <div
                  role="tabpanel"
                  id="sql-guide-panel"
                  aria-labelledby="sql-help-guide"
                  hidden={helpTab !== "guide"}
                >
                  <h3>Editor shortcuts</h3>
                  <p>
                    Declare aliases in FROM/JOIN first. Before declaring an alias, use a registered
                    table name before the dot, or select a table to search and insert its columns.
                  </p>
                  <code>{`SELECT ${selected ? sqlTableName(selected.alias) : '"table_alias"'}.\n-- Choose a column, then add FROM ${selected ? sqlTableName(selected.alias) : '"table_alias"'}\nSELECT c.* FROM ${selected ? sqlTableName(selected.alias) : '"table_alias"'} AS c;`}</code>
                  <p>
                    Ctrl+Space opens suggestions in every mode. Enter or Tab accepts the selected
                    suggestion. Shift+Enter starts a new line. Escape closes suggestions for the
                    current token. Ctrl+Enter runs the statement at the cursor. Ctrl+F searches the
                    editor text.
                  </p>
                  <p>
                    Contextual (default) suggests tables after FROM, JOIN or a table-list comma,
                    columns after a dot or in HAVING, and possible JOIN conditions after ON.
                    Automatic adds expression suggestions after two characters. Manual opens only
                    with Ctrl+Space.
                  </p>
                  <p>
                    Suggestions use current file aliases and column modes. Function hints describe
                    common signatures; they do not validate SQL. CTE and subquery output columns are
                    not inferred.
                  </p>
                  <h3>One mode per table</h3>
                  <p>
                    Names mode exposes original names only. Number mode exposes c1, c2… only.
                    Different tables may use different modes.
                  </p>
                  <h3>Names and text</h3>
                  <code>
                    {'"Payment amount"\n"Product ""name"""\nWHERE c2 = \'Seoul\'\nWHERE c2 IS NULL'}
                  </code>
                  <p>
                    Double quotes identify names; single quotes identify text. Simple names are
                    inserted without quotes. Spaces, special characters and DuckDB keywords are
                    quoted automatically.
                  </p>
                  <h3>JOIN keys</h3>
                  <p>
                    Use a.c1 and b.c1, or quoted names in names mode. Check matching key types; a
                    JOIN can greatly increase output rows.
                  </p>
                  <h3>Read-only queries</h3>
                  <p>
                    One SELECT or CTE. Registered files only. Add LIMIT explicitly for a smaller
                    output; LIMIT does not bound every intermediate operation.
                  </p>
                </div>
              </aside>
            )}
          </div>
          <div
            {...querySplit.separator}
            aria-label="Resize query and output"
            aria-controls="sql-query-editor-pane sql-output-pane"
            className="sql-source-separator sql-query-separator"
          />
          <div className="sql-output" id="sql-output-pane">
            {!api && (
              <div className="sql-error-banner" role="alert">
                SQL execution is unavailable in this backend.
              </div>
            )}
            {notice && (
              <div className="sql-notice" role="status">
                <span>{notice}</span>
                <button
                  type="button"
                  aria-label="Dismiss SQL notice"
                  onClick={() => setNotice(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            )}
            <div className="sql-output-tabs" role="tablist" aria-label="SQL output">
              {(["result", "plan", "messages"] as const).map((name) => (
                <button
                  type="button"
                  role="tab"
                  key={name}
                  id={`sql-output-${name}`}
                  aria-controls={`sql-${name}-panel`}
                  aria-selected={output === name}
                  onClick={() => setOutput(name)}
                >
                  {{ result: "Results", plan: "Execution plan", messages: "Messages" }[name]}
                </button>
              ))}
              <span role="status" aria-live="polite">
                {status
                  ? `${status.state} · ${status.phase} · ${(status.elapsedMs / 1000).toFixed(2)} s`
                  : "Ready"}
              </span>
            </div>
            <section
              className="sql-result-panel"
              role="tabpanel"
              id="sql-result-panel"
              aria-labelledby="sql-output-result"
              hidden={output !== "result"}
            >
              {pendingResult && pageError && (
                <div role="alert" className="sql-error-banner">
                  {pageError}
                  <button
                    type="button"
                    onClick={() =>
                      void publishResult(pendingResult.status, pendingResult.execution).catch(
                        (cause) => {
                          if (
                            mounted.current &&
                            currentRun.current?.runId === pendingResult.status.runId
                          )
                            setPageError(errorMessage(cause));
                        },
                      )
                    }
                  >
                    Retry result page
                  </button>
                </div>
              )}
              {result && resultSnapshot?.resultId && api ? (
                <SqlResults
                  key={resultSnapshot.resultId}
                  active={active && output === "result"}
                  api={api}
                  backend={backend}
                  busy={busy}
                  runId={resultSnapshot.runId}
                  resultId={resultSnapshot.resultId}
                  columns={resultSnapshot.columns}
                  summary={result.summary}
                  page={result.page}
                  settings={settings}
                  context={resultContext}
                  onClear={() => void clearResult()}
                  onExportBusyChange={onExportBusyChange}
                  onOpenCopySettings={onOpenCopySettings}
                  onReadError={(cause) => setPageError(errorMessage(cause))}
                />
              ) : (
                <div className="sql-empty">
                  Run a query to view its result. Input files are read-only.
                </div>
              )}
              {pageError && !pendingResult && (
                <p className="sql-error" role="alert">
                  {pageError}
                </p>
              )}
            </section>
            <section
              className="sql-plan-panel"
              role="tabpanel"
              id="sql-plan-panel"
              aria-labelledby="sql-output-plan"
              hidden={output !== "plan"}
            >
              {planContext && (
                <div
                  className="sql-output-context"
                  role="status"
                  aria-label="Plan context"
                  data-current={planContext.current}
                >
                  {planContext.labels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              )}
              <SqlPlan key={planSnapshot?.status.runId} status={planSnapshot?.status ?? null} />
            </section>
            <section
              className="sql-messages-panel"
              role="tabpanel"
              id="sql-messages-panel"
              aria-labelledby="sql-output-messages"
              hidden={output !== "messages"}
            >
              {error && (
                <div className="sql-error-banner" role="alert">
                  {error}
                </div>
              )}
              {status?.warnings.map((warning, index) => (
                <p className="sql-warning" key={index}>
                  {warning}
                </p>
              ))}
              {status?.state === "cancelled" && (
                <p>
                  {status.error?.message ??
                    "Execution cancelled. Previous successful results remain available."}
                </p>
              )}
              <p>
                One read-only statement. SQL results and working files share the managed storage
                limit.
              </p>
              {tables.length > 0 && (
                <div className="sql-warning-sources">
                  Inspect source parsing profiles:{" "}
                  {tables.map((table) => (
                    <button
                      type="button"
                      key={sourceKey(table)}
                      onClick={() => onOpenSource(table)}
                    >
                      {table.alias}
                    </button>
                  ))}
                </div>
              )}
            </section>
            {status?.warnings.length ? (
              <div className="sql-warning" role="status">
                {status.warnings.length} SQL warning(s).{" "}
                <button type="button" onClick={() => setOutput("messages")}>
                  View messages
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
