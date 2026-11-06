import { useEffect, useRef, useState } from "react";
import { Copy, LoaderCircle, X } from "lucide-react";
import type { CopyOperationStatus } from "../backend";
import type {
  ColumnValuesBackend,
  ColumnValuesIdentity,
  ColumnValuesOrder,
  ColumnValuesPageResponse,
  ColumnValuesStatus,
} from "./backend";
import "./column-values.css";

export interface ColumnValuesPanelProps {
  backend: ColumnValuesBackend;
  documentId: string;
  sessionId: string;
  queryId: string | null;
  columnId: string;
  onClose(): void;
}
const terminalCopy = (status: CopyOperationStatus) =>
  ["complete", "failed", "cancelled"].includes(status.state);
export function ColumnValuesPanel({
  backend,
  documentId,
  sessionId,
  queryId,
  columnId,
  onClose,
}: ColumnValuesPanelProps) {
  const [scope, setScope] = useState<"source" | "filtered">(queryId ? "filtered" : "source");
  const [status, setStatus] = useState<ColumnValuesStatus | null>(null);
  const [page, setPage] = useState<ColumnValuesPageResponse | null>(null);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [order, setOrder] = useState<ColumnValuesOrder>("countDescending");
  const [navigation, setNavigation] = useState<{ offset: number; cursor: string | null }>({
    offset: 0,
    cursor: null,
  });
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startingCopy, setStartingCopy] = useState(false);
  const [copy, setCopy] = useState<CopyOperationStatus | null>(null);
  const operation = useRef<ColumnValuesIdentity | null>(null);
  const copyRef = useRef<CopyOperationStatus | null>(null);
  const generation = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  copyRef.current = copy;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    const token = ++generation.current;
    const identity = { operationId: crypto.randomUUID(), documentId, sessionId };
    operation.current = identity;
    setStatus(null);
    setPage(null);
    setError(null);
    setNavigation({ offset: 0, cursor: null });
    setPageOffset(0);
    setCopy(null);
    setStartingCopy(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (next?: ColumnValuesStatus) => {
      try {
        const response = next ?? (await backend.getColumnValuesStatus(identity));
        if (generation.current !== token) return;
        setStatus(response);
        if (response.state === "queued" || response.state === "running")
          timer = setTimeout(() => void poll(), 200);
      } catch (e) {
        if (generation.current === token) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void backend
      .startColumnValues({ ...identity, queryId: scope === "filtered" ? queryId : null, columnId })
      .then(
        (result) => {
          if (generation.current !== token) {
            void backend.releaseColumnValues(identity).catch(() => {});
            return;
          }
          return poll(result);
        },
        (e) => {
          if (generation.current === token) setError(e instanceof Error ? e.message : String(e));
        },
      );
    return () => {
      generation.current = token + 1;
      clearTimeout(timer);
      operation.current = null;
      void backend.releaseColumnValues(identity).catch(() => {});
      const active = copyRef.current;
      if (active && !terminalCopy(active))
        void backend
          .cancelCopy({ operationId: active.operationId, documentId, sessionId })
          .catch(() => {});
    };
  }, [backend, documentId, sessionId, queryId, columnId, scope, attempt]);
  useEffect(() => {
    const identity = operation.current;
    if (status?.state !== "ready" || !identity || status.operationId !== identity.operationId)
      return;
    let alive = true;
    setLoading(true);
    setError(null);
    void backend
      .readColumnValuesPage({
        ...identity,
        search: submittedSearch || null,
        order,
        offset: navigation.offset,
        cursor: navigation.cursor,
        limit: 100,
      })
      .then(
        (response) => {
          if (alive) {
            setPage(response);
            setPageOffset(navigation.offset);
          }
        },
        (e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [backend, status?.state, status?.operationId, submittedSearch, order, navigation]);
  useEffect(() => {
    if (!copy || terminalCopy(copy)) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        void backend.getCopyStatus({ operationId: copy.operationId, documentId, sessionId }).then(
          (response) => {
            if (alive) setCopy(response);
          },
          (e) => {
            if (alive) setError(e instanceof Error ? e.message : String(e));
          },
        ),
      200,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [backend, copy, documentId, sessionId]);
  useEffect(() => {
    if (!queryId && scope === "filtered") setScope("source");
  }, [queryId, scope]);
  useEffect(() => {
    // A completed operation can remove its focused Cancel button. Keep keyboard
    // ownership in the modal so Escape and Tab continue to work.
    if (panel.current && !panel.current.contains(document.activeElement)) {
      panel.current.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [status?.state, copy?.state, startingCopy]);
  const copying = startingCopy || (copy !== null && !terminalCopy(copy));
  const resetPage = () => {
    setPage(null);
    setNavigation({ offset: 0, cursor: null });
    setPageOffset(0);
  };
  async function startCopy(includeCounts: boolean) {
    const identity = operation.current;
    if (!identity) return;
    const token = generation.current;
    setError(null);
    setStartingCopy(true);
    try {
      const response = await backend.startColumnValuesCopy({
        ...identity,
        search: submittedSearch || null,
        order,
        includeCounts,
      });
      if (token === generation.current) setCopy(response);
      else if (!terminalCopy(response))
        void backend
          .cancelCopy({ operationId: response.operationId, documentId, sessionId })
          .catch(() => {});
    } catch (e) {
      if (token === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === generation.current) setStartingCopy(false);
    }
  }
  return (
    <div
      className="column-values-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        aria-label={`Column values: ${columnId}`}
        aria-modal="true"
        className="column-values-panel"
        role="dialog"
        ref={panel}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                "button:not([disabled]),input:not([disabled]),select:not([disabled])",
              ) ?? [],
            );
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2>Column values</h2>
            <p title={columnId}>{columnId}</p>
          </div>
          <button aria-label="Close column values" className="icon-button" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="column-values-controls">
          <label>
            Scope
            <select
              aria-label="Distinct value scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as typeof scope);
                resetPage();
              }}
              disabled={copying}
            >
              <option value="source">Whole file</option>
              <option value="filtered" disabled={!queryId}>
                Current filtered result
              </option>
            </select>
          </label>
          <label>
            Order
            <select
              aria-label="Distinct value order"
              value={order}
              onChange={(e) => {
                setOrder(e.target.value as ColumnValuesOrder);
                resetPage();
              }}
              disabled={copying}
            >
              <option value="countDescending">Most frequent first</option>
              <option value="countAscending">Least frequent first</option>
              <option value="valueAscending">Value ascending</option>
              <option value="valueDescending">Value descending</option>
            </select>
          </label>
        </div>
        <form
          className="column-values-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedSearch(search);
            resetPage();
          }}
        >
          <input
            aria-label="Search column values"
            placeholder="Search values"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={copying}
          />
          <button type="submit" disabled={status?.state !== "ready" || copying}>
            Search
          </button>
        </form>
        <div className="column-values-summary" role="status">
          {status?.state === "ready" ? (
            <>
              <strong>
                {(page?.totalCount ?? status.totalCount ?? 0).toLocaleString()} distinct values
              </strong>
              <span>
                {scope === "source" ? "Whole file" : "Current filtered result"}
                {submittedSearch ? ` · ${(page?.matchedCount ?? 0).toLocaleString()} matching` : ""}
              </span>
            </>
          ) : status?.state === "failed" || status?.state === "cancelled" ? (
            <>
              <span>{status.error?.message ?? "Calculation cancelled."}</span>
              <button
                onClick={() => {
                  resetPage();
                  setAttempt((value) => value + 1);
                }}
              >
                Retry calculation
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="button-spinner" aria-hidden="true" />
              Calculating distinct values…{" "}
              <button
                onClick={() => {
                  const id = operation.current;
                  if (id) void backend.cancelColumnValues(id).then(setStatus);
                }}
              >
                Cancel calculation
              </button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="column-values-error">
            {error}
          </p>
        )}
        <div className="column-values-table" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>Value</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {page?.values.map((item, index) => (
                <tr key={`${pageOffset + index}`}>
                  <td>
                    {item.isNull ? (
                      <span className="value-state">NULL</span>
                    ) : item.isEmpty ? (
                      <span className="value-state">Empty string</span>
                    ) : (
                      <>
                        <span className={item.isInvalid ? "value-invalid" : undefined}>
                          {item.value}
                        </span>
                        {item.isInvalid && <small className="value-state">Invalid</small>}
                        {item.truncated && (
                          <small className="value-state">
                            Preview truncated · copy includes full value
                          </small>
                        )}
                      </>
                    )}
                  </td>
                  <td>{item.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p role="status">Loading values…</p>}
          {page?.values.length === 0 && !loading && <p>No matching values.</p>}
        </div>
        <nav aria-label="Distinct values pages">
          <button
            disabled={!page?.previousCursor || loading || copying}
            onClick={() => {
              if (page?.previousCursor)
                setNavigation({
                  offset: Math.max(0, pageOffset - 100),
                  cursor: page.previousCursor,
                });
            }}
          >
            Previous
          </button>
          <span>
            {page && page.values.length
              ? `${pageOffset + 1}–${pageOffset + page.values.length} of ${page.matchedCount.toLocaleString()}`
              : "0 values"}
          </span>
          <button
            disabled={!page?.nextCursor || loading || copying}
            onClick={() => {
              if (page?.nextCursor)
                setNavigation({ offset: pageOffset + 100, cursor: page.nextCursor });
            }}
          >
            Next
          </button>
        </nav>
        <footer>
          <p>
            Copy all matching values, including values on other pages. TSV headers are included.
          </p>
          <div>
            <button
              disabled={status?.state !== "ready" || !page?.matchedCount || copying || loading}
              onClick={() => void startCopy(false)}
            >
              <Copy aria-hidden="true" />
              Copy values
            </button>
            <button
              disabled={status?.state !== "ready" || !page?.matchedCount || copying || loading}
              onClick={() => void startCopy(true)}
            >
              Copy values and counts
            </button>
            {copying && (
              <button
                onClick={() => {
                  if (copy)
                    void backend
                      .cancelCopy({ operationId: copy.operationId, documentId, sessionId })
                      .then(setCopy);
                }}
              >
                Cancel copy
              </button>
            )}
          </div>
          {copy && (
            <span role="status">
              {copy.state === "complete"
                ? `Copied ${copy.progress.totalRows.toLocaleString()} values.`
                : (copy.failure?.message ??
                  `${copy.state}: ${copy.progress.rowsProcessed.toLocaleString()} / ${copy.progress.totalRows.toLocaleString()}`)}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
