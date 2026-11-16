import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BackendAdapter, DataPage, FileSummary, ReadPageRequest } from "../backend";
import { VirtualDataGrid } from "../VirtualDataGrid";
import { activeCopyOptions, type AppSettings } from "../settings/model";
import type { SqlSourceIdentity } from "./backend";

export interface SqlSourceDataProps {
  source: SqlSourceIdentity;
  summary: FileSummary;
  backend: BackendAdapter;
  settings: AppSettings;
  active: boolean;
  blocked?: boolean;
  onOpenCopySettings?(): void;
  onOpenData?(): void;
  linkedCharts?: ReactNode;
}
type SourceView = "data" | "schema" | "charts";
interface SourcePage {
  identity: string;
  page: DataPage | null;
  view: SourceView;
}
const MAX_REMEMBERED_SOURCES = 8;
const sourceError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function SqlSourceData({
  source,
  summary,
  backend,
  settings,
  active,
  blocked = false,
  onOpenCopySettings,
  onOpenData,
  linkedCharts,
}: SqlSourceDataProps) {
  const identity = JSON.stringify([source.documentId, source.sessionId]);
  const pages = useRef(new Map<string, SourcePage>());
  const generation = useRef(0);
  const consumedRetry = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [display, setDisplay] = useState<SourcePage>({ identity, page: null, view: "data" });
  const [error, setError] = useState<{ identity: string; message: string; offset: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const logicalColumns = useMemo(() => summary.columns.map(({ name }) => name), [summary.columns]);
  const projectionKey = JSON.stringify(logicalColumns.slice(0, 64));
  const selected = display.identity === identity ? display : pages.current.get(identity);
  const view = selected?.view ?? "data";
  const page = selected?.page ?? null;
  const visibleError = error?.identity === identity ? error : null;

  const remember = useCallback((next: SourcePage) => {
    pages.current.delete(next.identity);
    pages.current.set(next.identity, next);
    while (pages.current.size > MAX_REMEMBERED_SOURCES) {
      const oldest = pages.current.keys().next().value;
      if (oldest !== undefined) pages.current.delete(oldest);
    }
    setDisplay(next);
  }, []);

  const readPage = useCallback(
    async (request: ReadPageRequest) => {
      const next = await backend.readPage({
        ...request,
        documentId: source.documentId,
        sessionId: source.sessionId,
      });
      if (next.sessionId !== source.sessionId || next.offset !== request.offset)
        throw new Error("The source page no longer matches this file session.");
      return next;
    },
    [backend, source.documentId, source.sessionId],
  );

  useEffect(() => {
    const token = ++generation.current;
    if (!active || blocked) {
      setLoading(false);
      return;
    }
    const cached = pages.current.get(identity);
    const forceRetry = consumedRetry.current !== retry;
    consumedRetry.current = retry;
    if (cached?.page && !forceRetry) {
      setDisplay(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const columns = JSON.parse(projectionKey) as string[];
    if (!columns.length) {
      remember({
        identity,
        page: {
          sessionId: source.sessionId,
          offset: 0,
          limit: 200,
          columns: [],
          rows: [],
          totalRows: summary.rowCount,
          hasMore: false,
        },
        view: cached?.view ?? "data",
      });
      setLoading(false);
      return;
    }
    void readPage({
      sessionId: source.sessionId,
      offset: cached?.page?.offset ?? 0,
      limit: 200,
      columns,
    }).then(
      (next) => {
        if (token !== generation.current || currentIdentity.current !== identity) return;
        remember({
          identity,
          page: next,
          view: pages.current.get(identity)?.view ?? cached?.view ?? "data",
        });
        setLoading(false);
      },
      (cause) => {
        if (token !== generation.current || currentIdentity.current !== identity) return;
        setError({ identity, message: sourceError(cause), offset: cached?.page?.offset ?? 0 });
        setLoading(false);
      },
    );
    return invalidate;
  }, [
    active,
    backend,
    blocked,
    identity,
    invalidate,
    projectionKey,
    readPage,
    remember,
    retry,
    source.sessionId,
    summary.rowCount,
  ]);

  function changeView(next: SourceView) {
    remember({ identity, page, view: next });
  }
  async function goToPage(offset: number) {
    if (!active || blocked || !page) return;
    const token = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readPage({
        sessionId: source.sessionId,
        offset,
        limit: 200,
        columns: page.columns.length ? page.columns : logicalColumns.slice(0, 64),
      });
      if (token !== generation.current || currentIdentity.current !== identity) return;
      remember({ identity, page: next, view: pages.current.get(identity)?.view ?? view });
    } catch (cause) {
      if (token === generation.current && currentIdentity.current === identity)
        setError({ identity, message: sourceError(cause), offset });
    } finally {
      if (token === generation.current && currentIdentity.current === identity) setLoading(false);
    }
  }
  const rows = page?.totalRows ?? summary.rowCount;
  return (
    <section className="sql-source-data" aria-label="Source file data">
      <div className="sql-source-data__heading">
        <div>
          <strong>{summary.fileName}</strong>
          <span>
            {rows === null ? "Counting rows…" : `${rows.toLocaleString()} rows`} ·{" "}
            {summary.columnCount.toLocaleString()} columns
          </span>
        </div>
        {onOpenData && (
          <button type="button" onClick={onOpenData}>
            Open in Data
          </button>
        )}
      </div>
      <div className="sql-source-data__tabs" role="tablist" aria-label="Source views">
        <button
          type="button"
          role="tab"
          aria-selected={view === "data"}
          onClick={() => changeView("data")}
        >
          Data
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "schema"}
          onClick={() => changeView("schema")}
        >
          Schema
        </button>
        {linkedCharts && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "charts"}
            onClick={() => changeView("charts")}
          >
            Linked Charts
          </button>
        )}
        <span>Original data</span>
      </div>
      {visibleError && (
        <div className="sql-source-data__error" role="alert">
          {visibleError.message}
          <button
            type="button"
            onClick={() => {
              if (page) void goToPage(visibleError.offset);
              else setRetry((value) => value + 1);
            }}
          >
            Retry source page
          </button>
        </div>
      )}
      <div className="sql-source-data__content" hidden={view !== "data"}>
        {blocked ? (
          <p role="status">Preparing CSV data…</p>
        ) : page ? (
          <VirtualDataGrid
            key={identity}
            active={active && view === "data"}
            documentId={source.documentId}
            summary={summary}
            page={page}
            resultKey={`sql-source:${identity}`}
            logicalColumnNames={logicalColumns}
            isLoading={loading}
            copyOptions={activeCopyOptions(settings)}
            copyLimits={settings.copyLimits}
            displayFormats={settings.displayFormats}
            onOpenCopySettings={onOpenCopySettings}
            onPageChange={(offset) => void goToPage(offset)}
            onReadError={(cause, offset) =>
              setError({ identity, offset, message: sourceError(cause) })
            }
            readPage={readPage}
            readCellValue={(row, columnId) => backend.readCellValue({ ...source, row, columnId })}
            findDataBoundary={(request) =>
              backend.findDataBoundary({ ...request, ...source, queryId: undefined })
            }
            cancelDataBoundaryNavigation={backend.cancelDataBoundaryNavigation}
            startCopy={(request) => backend.startCopy({ ...request, ...source, queryId: null })}
            getCopyStatus={backend.getCopyStatus}
            cancelCopyOperation={backend.cancelCopy}
            getCopyHistory={backend.getCopyHistory}
          />
        ) : (
          <p role="status">{loading ? "Loading source data…" : "No source page available."}</p>
        )}
      </div>
      {view === "schema" && (
        <div className="sql-source-data__schema" role="tabpanel" aria-label="Source schema">
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
              </tr>
            </thead>
            <tbody>
              {summary.columns.map((column) => (
                <tr key={column.name}>
                  <td>{column.name}</td>
                  <td>{column.valueLogicalType || column.logicalType}</td>
                  <td>{column.nullable ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === "charts" && (
        <div className="sql-source-data__schema" role="tabpanel" aria-label="Source linked charts">
          {linkedCharts}
        </div>
      )}
    </section>
  );
}
