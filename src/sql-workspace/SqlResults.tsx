import { useEffect, useMemo, useRef, useState } from "react";
import type { BackendAdapter, DataPage, FileSummary } from "../backend";
import { VirtualDataGrid, type ResultClipboardHandle } from "../VirtualDataGrid";
import { activeCopyOptions, type AppSettings } from "../settings/model";
import type { SqlExportRequest, SqlResultColumn, SqlWorkspaceBackend } from "./backend";
import { useSqlResultView } from "./useSqlResultView";

interface Props {
  active: boolean;
  api: SqlWorkspaceBackend;
  backend: BackendAdapter;
  busy: boolean;
  runId: string;
  resultId: string;
  columns: SqlResultColumn[];
  summary: FileSummary;
  page: DataPage;
  settings: AppSettings;
  context: { current: boolean; labels: string[] } | null;
  onClear(): void;
  onExportBusyChange(busy: boolean): void;
  onOpenCopySettings(): void;
  onReadError(cause: unknown): void;
}

const FORMATS = [
  ["csv", "CSV"],
  ["tsv", "TSV"],
  ["parquet", "Parquet"],
  ["clipboard", "Clipboard"],
] as const;

export function SqlResults({
  active,
  api,
  backend,
  busy,
  runId,
  resultId,
  columns,
  summary,
  page,
  settings,
  context,
  onClear,
  onExportBusyChange,
  onOpenCopySettings,
  onReadError,
}: Props) {
  const view = useSqlResultView(api, runId, resultId, page);
  const clipboard = useRef<ResultClipboardHandle>(null);
  const exportingRef = useRef(false);
  const mounted = useRef(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ text: string; error: boolean } | null>(null);
  const labels = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.id, column.name])),
    [columns],
  );
  const logicalColumns = useMemo(() => columns.map((column) => column.id), [columns]);
  const baseProjection = useMemo(() => logicalColumns.slice(0, 64), [logicalColumns]);
  const activeRows = view.page.totalRows ?? summary.rowCount ?? 0;
  const baseRows = summary.rowCount ?? page.totalRows ?? 0;
  const exportDisabled = busy || exporting || view.applying;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function exportResult(format: SqlExportRequest["format"] | "clipboard", viewId?: string) {
    if (exportDisabled || exportingRef.current) return;
    setExportOpen(false);
    setExportNotice(null);
    if (format === "clipboard") {
      await clipboard.current?.copyAll(viewId ? undefined : { rowCount: baseRows, queryId: runId });
      return;
    }
    exportingRef.current = true;
    onExportBusyChange(true);
    setExporting(true);
    try {
      const saved = await api.exportResult({
        runId,
        resultId,
        format,
        ...(viewId ? { viewId } : {}),
      });
      if (mounted.current)
        setExportNotice({ text: saved ? "Result exported." : "Export cancelled.", error: false });
    } catch (cause) {
      if (mounted.current)
        setExportNotice({
          text: cause instanceof Error ? cause.message : String(cause),
          error: true,
        });
    } finally {
      exportingRef.current = false;
      onExportBusyChange(false);
      if (mounted.current) setExporting(false);
    }
  }

  const exportButtons = (viewId?: string) =>
    FORMATS.map(([format, label]) => (
      <button key={format} type="button" onClick={() => void exportResult(format, viewId)}>
        {label}
      </button>
    ));

  return (
    <div className="sql-result-content">
      <div className="sql-result-heading">
        <div className="sql-result-summary">
          <span>
            {activeRows.toLocaleString()}
            {activeRows !== baseRows && ` of ${baseRows.toLocaleString()}`} rows · {columns.length}{" "}
            columns
          </span>
          <div
            className="sql-output-context"
            role="status"
            aria-label="Result context"
            data-current={context?.current}
          >
            {context?.labels.map((label) => (
              <span key={label}>{label}</span>
            ))}
            {view.draftDiffers && (
              <span>
                {view.viewId ? "Showing last applied view" : "Showing whole result"}
                {" · "}
                {view.applying ? "Applying view changes" : "View draft differs"}
              </span>
            )}
          </div>
          {exportNotice && (
            <div role={exportNotice.error ? "alert" : "status"}>{exportNotice.text}</div>
          )}
        </div>
        <div className="sql-result-actions">
          <div className="sql-export">
            <button
              type="button"
              disabled={exportDisabled}
              aria-expanded={exportOpen && !exportDisabled}
              onClick={() => setExportOpen((open) => !open)}
            >
              {exporting ? "Exporting…" : "Export results"}
            </button>
            {exportOpen && !exportDisabled && (
              <div
                className={`sql-export-options${view.viewId ? " sql-export-options--scoped" : ""}`}
                role="group"
                aria-label="Export format"
              >
                {view.viewId ? (
                  <>
                    <div className="sql-export-scope" role="group" aria-label="Current view">
                      <strong>Current view</strong>
                      {exportButtons(view.viewId)}
                    </div>
                    <div className="sql-export-scope" role="group" aria-label="Whole result">
                      <strong>Whole result</strong>
                      {exportButtons()}
                    </div>
                  </>
                ) : (
                  exportButtons()
                )}
              </div>
            )}
          </div>
          <button type="button" disabled={busy || exporting} onClick={onClear}>
            Clear result
          </button>
        </div>
      </div>
      <VirtualDataGrid
        active={active}
        resultClipboardRef={clipboard}
        documentId="sql-workspace"
        summary={summary}
        page={view.page}
        isLoading={false}
        resultKey={`${runId}:${resultId}:${view.viewId ?? "base"}`}
        queryId={view.viewId ?? runId}
        queryActive={Boolean(view.viewId)}
        queryPlan={api.resultView ? view.plan : undefined}
        queryStatus={view.toolbar}
        findTarget={view.findTarget ?? undefined}
        onFindNext={() => void view.find("next")}
        onFindPrevious={() => void view.find("previous")}
        onCancelQuery={view.cancel}
        onRetryQuery={() => void view.apply(view.plan)}
        onQueryPlanChange={
          api.resultView
            ? (plan) => {
                if (exportingRef.current) return;
                setExportOpen(false);
                void view.apply(plan);
              }
            : undefined
        }
        columnLabels={labels}
        logicalColumnNames={logicalColumns}
        copyOptions={activeCopyOptions(settings)}
        displayFormats={settings.displayFormats}
        copyLimits={settings.copyLimits}
        onOpenCopySettings={onOpenCopySettings}
        onPageChange={(offset) => void view.goToPage(offset, onReadError)}
        onReadError={onReadError}
        readPage={(request) =>
          api.readPage({
            runId,
            resultId,
            ...(view.viewId ? { viewId: view.viewId } : {}),
            offset: request.offset,
            limit: request.limit,
            columns: request.columns ?? baseProjection,
          })
        }
        readCellValue={(row, columnId) =>
          view.viewId
            ? api.readCell(runId, resultId, row, columnId, view.viewId)
            : api.readCell(runId, resultId, row, columnId)
        }
        startCopy={(request) =>
          request.queryId && request.queryId !== runId
            ? api.startCopy(runId, resultId, request, request.queryId)
            : api.startCopy(runId, resultId, request)
        }
        getCopyStatus={backend.getCopyStatus}
        cancelCopyOperation={backend.cancelCopy}
        getCopyHistory={backend.getCopyHistory}
      />
    </div>
  );
}
