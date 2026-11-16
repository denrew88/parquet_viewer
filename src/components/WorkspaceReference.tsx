import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { DataPage, DataValue } from "../backend";
import type { ChartColumn } from "../chart-workspace/contract";

const PREVIEW_ROWS = 6;
const PREVIEW_COLUMNS = 8;

type Preview = { page: DataPage } | { error: string };

export interface WorkspaceReferenceProps {
  active: boolean;
  name: string;
  kind: "file" | "sql" | "selection";
  columns: readonly ChartColumn[];
  chartColumnIds?: readonly string[];
  rowCount?: number | null;
  label?: string;
  statement?: string;
  readPreview?(limit: number, columns: string[]): Promise<DataPage>;
  open?: { label: string; run(): void };
  linkedCharts?: ReactNode;
}

function cellText(value: DataValue | undefined) {
  if (!value || value.kind === "null" || value.state === "null") return "NULL";
  if (value.state === "empty" || value.display === "") return '""';
  const display = value.display ?? "";
  return display.length > 200 ? `${display.slice(0, 200)}…` : display;
}

export function WorkspaceReference({
  active,
  name,
  kind,
  columns,
  chartColumnIds,
  rowCount,
  label,
  statement,
  readPreview,
  open,
  linkedCharts,
}: WorkspaceReferenceProps) {
  const [view, setView] = useState<"preview" | "detail" | "charts">(
    readPreview ? "preview" : "detail",
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [attempt, setAttempt] = useState(0);
  const chartSource = chartColumnIds !== undefined;
  const highlighted = new Set(chartColumnIds);
  const chartColumns = columns.filter(({ id }) => highlighted.has(id));
  const otherColumns = columns.filter(({ id }) => !highlighted.has(id));
  const previewIds = new Set(
    [...chartColumns, ...otherColumns].slice(0, PREVIEW_COLUMNS).map(({ id }) => id),
  );
  const previewColumns = columns.filter(({ id }) => previewIds.has(id));
  const loader = useRef({ readPreview, previewColumns });
  loader.current = { readPreview, previewColumns };
  const pending = useRef<{ attempt: number; promise: Promise<DataPage> } | null>(null);
  const hasPreview = Boolean(readPreview && previewColumns.length);
  const showPreview = view === "preview" && hasPreview;
  const showCharts = view === "charts" && Boolean(linkedCharts);

  useEffect(() => {
    if (!active || !showPreview) return;
    const { readPreview, previewColumns } = loader.current;
    if (!readPreview) return;
    let current = true;
    if (pending.current?.attempt !== attempt) {
      const ids = previewColumns.map(({ id }) => id);
      pending.current = {
        attempt,
        promise: Promise.resolve().then(() => readPreview(PREVIEW_ROWS, ids)),
      };
    }
    void pending.current.promise.then(
      (page) => {
        if (current) setPreview({ page });
      },
      (error: unknown) => {
        if (current) setPreview({ error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [active, attempt, showPreview]);

  const page = preview && "page" in preview ? preview.page : null;
  const totalRows = page?.totalRows ?? rowCount;
  const previewCount = Math.min(PREVIEW_ROWS, page?.rows.length ?? 0);
  const detailName = kind === "sql" ? "Query" : "Schema";
  const previewName =
    kind === "sql"
      ? "Result Preview"
      : kind === "selection"
        ? "Selection Preview"
        : chartSource
          ? "File Preview"
          : "Data Preview";
  const tableName =
    kind === "sql"
      ? "SQL result preview"
      : kind === "selection"
        ? "Selection preview"
        : "File data preview";
  const sourceKind =
    kind === "file" ? "File" : kind === "sql" ? "SQL result" : "Captured selection";
  const sourceName = kind === "file" ? `Data · ${name}` : kind === "sql" ? `SQL · ${name}` : name;
  return (
    <div className="workspace-reference" data-chart-source={chartSource}>
      <div className="workspace-reference__title">
        <div>
          <span>{chartSource ? "Data source" : sourceKind}</span>
          <strong title={chartSource ? sourceName : name}>{chartSource ? sourceName : name}</strong>
        </div>
        {(label || chartSource) && (
          <span className="workspace-reference__status">{label ?? sourceKind}</span>
        )}
      </div>
      {(hasPreview || linkedCharts) && (
        <div className="workspace-reference__tabs" role="group" aria-label="Reference views">
          {hasPreview && (
            <button type="button" aria-pressed={showPreview} onClick={() => setView("preview")}>
              {previewName}
            </button>
          )}
          <button
            type="button"
            aria-pressed={!showPreview && !showCharts}
            onClick={() => setView("detail")}
          >
            {detailName}
          </button>
          {linkedCharts && (
            <button type="button" aria-pressed={showCharts} onClick={() => setView("charts")}>
              Linked Charts
            </button>
          )}
        </div>
      )}
      <div className="workspace-reference__body">
        {showCharts ? (
          linkedCharts
        ) : showPreview ? (
          page ? (
            page.rows.length ? (
              <table aria-label={tableName}>
                <thead>
                  <tr>
                    {previewColumns.map(({ id, name }) => (
                      <th
                        key={id}
                        scope="col"
                        title={name}
                        data-chart-column={highlighted.has(id) || undefined}
                      >
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                    <tr key={page.offset + index}>
                      {previewColumns.map(({ id }) => {
                        const text = cellText(row[page.columns.indexOf(id)]);
                        return (
                          <td
                            key={id}
                            title={text}
                            data-chart-column={highlighted.has(id) || undefined}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p role="status">No rows to preview.</p>
            )
          ) : preview && "error" in preview ? (
            <div role="alert">
              <p>{preview.error}</p>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setAttempt((current) => current + 1);
                }}
              >
                Retry Preview
              </button>
            </div>
          ) : (
            <p role="status">Loading preview…</p>
          )
        ) : kind === "sql" ? (
          statement ? (
            <pre aria-label="Executed SQL query">{statement}</pre>
          ) : (
            <p>The executed query text is unavailable for this result.</p>
          )
        ) : (
          <table aria-label="Source schema">
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Type</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.id}>
                  <td title={column.name}>{column.name}</td>
                  <td title={column.logicalType}>{column.logicalType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!showCharts && (
        <div className="workspace-reference__footer">
          <span>
            {showPreview && previewCount
              ? chartSource && totalRows != null
                ? `${((page?.offset ?? 0) + 1).toLocaleString()}–${((page?.offset ?? 0) + previewCount).toLocaleString()} / ${totalRows.toLocaleString()} rows`
                : `First ${previewCount} rows`
              : rowCount != null
                ? `${rowCount.toLocaleString()} rows`
                : ""}
            {showPreview && columns.length > PREVIEW_COLUMNS
              ? ` · ${chartSource ? `${PREVIEW_COLUMNS} of ${columns.length}` : `First ${PREVIEW_COLUMNS}`} columns`
              : ""}
          </span>
          {open && (
            <button type="button" onClick={open.run}>
              <ArrowUpRight aria-hidden="true" /> {open.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
