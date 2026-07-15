import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { QueryFilter, QueryPlan, QuerySearch } from "./model";
import "./query.css";

export interface QuerySearchColumn {
  id: string;
  label: string;
  searchable: boolean;
  disabledReason?: string;
}

export interface QueryToolbarStatus {
  state: "idle" | "queued" | "running" | "cancelling" | "error";
  message: string;
  matchCount: number | null;
}

export interface QueryToolbarProps {
  plan: QueryPlan;
  columns: QuerySearchColumn[];
  status?: QueryToolbarStatus;
  onSearchChange(search: QuerySearch | null): void;
  onRemoveFilter(filterId: string): void;
  onClearFilters(): void;
  onCancelQuery?(): void;
  onFindPrevious?(): void;
  onFindNext?(): void;
  onRetryQuery?(): void;
}

const operatorLabels: Record<QueryFilter["operator"], string> = {
  equals: "=",
  notEquals: "!=",
  oneOf: "in",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  between: "between",
  isTrue: "is true",
  isFalse: "is false",
  isNull: "is null",
  isNotNull: "is not null",
  isInvalid: "is invalid",
  isNotInvalid: "is not invalid",
};

function summarizeFilter(filter: QueryFilter): string {
  const values =
    filter.values.length > 2
      ? `${filter.values.slice(0, 2).join(", ")}...`
      : filter.values.join(" - ");
  return [filter.columnId, operatorLabels[filter.operator], values].filter(Boolean).join(" ");
}

const emptySearch: QuerySearch = {
  text: "",
  mode: "filter",
  caseSensitive: false,
  exact: false,
  targetColumnIds: [],
};

function sameSearch(left: QuerySearch | null, right: QuerySearch | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.text === right.text &&
    left.mode === right.mode &&
    left.caseSensitive === right.caseSensitive &&
    left.exact === right.exact &&
    left.targetColumnIds.length === right.targetColumnIds.length &&
    left.targetColumnIds.every((id, index) => id === right.targetColumnIds[index])
  );
}

export function QueryToolbar({
  plan,
  columns,
  status = { state: "idle", message: "", matchCount: null },
  onSearchChange,
  onRemoveFilter,
  onClearFilters,
  onCancelQuery,
  onFindPrevious,
  onFindNext,
  onRetryQuery,
}: QueryToolbarProps) {
  const [draft, setDraft] = useState<QuerySearch>(() => plan.search ?? emptySearch);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [targetMenuPosition, setTargetMenuPosition] = useState({ left: 8, top: 8 });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPosition, setFilterMenuPosition] = useState({ left: 8, top: 8 });
  const targetTriggerRef = useRef<HTMLButtonElement>(null);
  const targetMenuRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  useEffect(() => setDraft(plan.search ?? emptySearch), [plan.search]);
  const defaultTargetKey = columns
    .filter((column) => column.searchable)
    .map((column) => column.id)
    .join("\u0000");
  useEffect(() => {
    const visibleSearchableIds = new Set(defaultTargetKey.split("\u0000").filter(Boolean));
    setDraft((current) => {
      const targetColumnIds = current.targetColumnIds.filter((id) => visibleSearchableIds.has(id));
      return targetColumnIds.length === current.targetColumnIds.length
        ? current
        : { ...current, targetColumnIds };
    });
  }, [defaultTargetKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = draft.text.trim()
        ? {
            ...draft,
            text: draft.text.trim(),
            targetColumnIds:
              draft.targetColumnIds.length > 0
                ? draft.targetColumnIds
                : defaultTargetKey.split("\u0000").filter(Boolean),
          }
        : null;
      if (!sameSearch(plan.search, search)) onSearchChangeRef.current(search);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [defaultTargetKey, draft, plan.search]);

  useLayoutEffect(() => {
    if (!targetMenuOpen || !targetTriggerRef.current || !targetMenuRef.current) return;
    const trigger = targetTriggerRef.current.getBoundingClientRect();
    const menu = targetMenuRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const below = trigger.bottom + gap;
    const top =
      below + menu.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, trigger.top - menu.height - gap);
    setTargetMenuPosition({
      left: Math.max(margin, Math.min(trigger.left, window.innerWidth - menu.width - margin)),
      top,
    });
    targetMenuRef.current
      ?.querySelector<HTMLElement>("[role='menuitemcheckbox']:not([disabled])")
      ?.focus();
  }, [targetMenuOpen]);

  useLayoutEffect(() => {
    if (!filterMenuOpen || !filterTriggerRef.current || !filterMenuRef.current) return;
    const trigger = filterTriggerRef.current.getBoundingClientRect();
    const menu = filterMenuRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const below = trigger.bottom + gap;
    const top =
      below + menu.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, trigger.top - menu.height - gap);
    setFilterMenuPosition({
      left: Math.max(margin, Math.min(trigger.left, window.innerWidth - menu.width - margin)),
      top,
    });
    filterMenuRef.current.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [filterMenuOpen]);

  useEffect(() => {
    if (!targetMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (
        targetMenuRef.current?.contains(event.target as Node) ||
        targetTriggerRef.current?.contains(event.target as Node)
      )
        return;
      setTargetMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [targetMenuOpen]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (
        filterMenuRef.current?.contains(event.target as Node) ||
        filterTriggerRef.current?.contains(event.target as Node)
      )
        return;
      setFilterMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [filterMenuOpen]);

  useEffect(() => {
    if (plan.filters.length > 3 || !filterMenuOpen) return;
    setFilterMenuOpen(false);
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
  }, [filterMenuOpen, plan.filters.length]);

  const activeTargetCount = draft.targetColumnIds.filter((id) =>
    columns.some((column) => column.id === id && column.searchable),
  ).length;
  const targetSummary =
    activeTargetCount === 0
      ? "All visible columns"
      : `${activeTargetCount} visible ${activeTargetCount === 1 ? "column" : "columns"}`;

  function toggleTarget(columnId: string): void {
    setDraft((current) => ({
      ...current,
      targetColumnIds: current.targetColumnIds.includes(columnId)
        ? current.targetColumnIds.filter((id) => id !== columnId)
        : [...current.targetColumnIds, columnId],
    }));
  }

  function handleTargetMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setTargetMenuOpen(false);
      targetTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      targetMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitemcheckbox']:not([disabled])",
      ) ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function handleFilterMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setFilterMenuOpen(false);
      filterTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      filterMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div aria-label="Query tools" className="query-toolbar">
      <div className="query-search">
        <Search aria-hidden="true" />
        <input
          aria-label="Search data"
          onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
          type="search"
          value={draft.text}
        />
      </div>
      <div aria-label="Search mode" className="query-mode" role="group">
        {(["find", "filter"] as const).map((mode) => (
          <button
            aria-pressed={draft.mode === mode}
            key={mode}
            onClick={() => setDraft((current) => ({ ...current, mode }))}
            type="button"
          >
            {mode === "find" ? "Find" : "Filter"}
          </button>
        ))}
      </div>
      <div className="query-targets">
        <button
          aria-label="Search options"
          aria-expanded={targetMenuOpen}
          aria-haspopup="menu"
          className={
            draft.caseSensitive || draft.exact || activeTargetCount > 0 ? "is-active" : undefined
          }
          onClick={() => {
            setFilterMenuOpen(false);
            setTargetMenuOpen((open) => !open);
          }}
          ref={targetTriggerRef}
          title={`Search options (${targetSummary})`}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" />
          <span>Options</span>
          <ChevronDown aria-hidden="true" />
        </button>
        {targetMenuOpen && (
          <div
            aria-label="Search options"
            className="query-targets__menu"
            onKeyDown={handleTargetMenuKeyDown}
            ref={targetMenuRef}
            role="menu"
            style={targetMenuPosition}
          >
            <button
              aria-checked={draft.caseSensitive}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  caseSensitive: !current.caseSensitive,
                }))
              }
              role="menuitemcheckbox"
              type="button"
            >
              <span>Case sensitive</span>
            </button>
            <button
              aria-checked={draft.exact}
              onClick={() => setDraft((current) => ({ ...current, exact: !current.exact }))}
              role="menuitemcheckbox"
              type="button"
            >
              <span>Exact match</span>
            </button>
            <div className="query-targets__separator" role="separator" />
            <div className="query-targets__heading">
              <strong>Columns</strong>
              <span>{targetSummary}</span>
            </div>
            {columns.map((column) => (
              <button
                aria-checked={draft.targetColumnIds.includes(column.id)}
                aria-disabled={!column.searchable}
                key={column.id}
                onClick={() => {
                  if (column.searchable) toggleTarget(column.id);
                }}
                role="menuitemcheckbox"
                title={column.disabledReason}
                type="button"
              >
                <span>{column.label}</span>
                {!column.searchable && column.disabledReason ? (
                  <span className="query-targets__disabled-reason">
                    Excluded: {column.disabledReason}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
      {draft.mode === "find" && (
        <div className="query-find-navigation">
          <button aria-label="Previous match" onClick={onFindPrevious} type="button">
            <ChevronLeft aria-hidden="true" />
          </button>
          <button aria-label="Next match" onClick={onFindNext} type="button">
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      )}
      <div aria-label="Active filters" className="query-filter-chips">
        {plan.filters.slice(0, 3).map((filter) => (
          <span className="query-filter-chip" key={filter.id} title={summarizeFilter(filter)}>
            <span>{summarizeFilter(filter)}</span>
            <button
              aria-label={`Remove filter ${filter.columnId}`}
              onClick={() => onRemoveFilter(filter.id)}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        {plan.filters.length > 3 && (
          <span className="query-filter-overflow">
            <button
              aria-expanded={filterMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                setTargetMenuOpen(false);
                setFilterMenuOpen((open) => !open);
              }}
              ref={filterTriggerRef}
              type="button"
            >
              +{plan.filters.length - 3} filters
            </button>
            {filterMenuOpen && (
              <div
                aria-label="Hidden active filters"
                className="query-filter-overflow__menu"
                onKeyDown={handleFilterMenuKeyDown}
                ref={filterMenuRef}
                role="menu"
                style={filterMenuPosition}
              >
                {plan.filters.slice(3).map((filter) => (
                  <button
                    aria-label={`Remove filter ${filter.columnId}`}
                    key={filter.id}
                    onClick={() => onRemoveFilter(filter.id)}
                    role="menuitem"
                    title={summarizeFilter(filter)}
                    type="button"
                  >
                    <span>{summarizeFilter(filter)}</span>
                    <X aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {plan.filters.length > 0 && (
          <button onClick={onClearFilters} type="button">
            Clear
          </button>
        )}
      </div>
      {(status.state !== "idle" || status.matchCount !== null) && (
        <span
          className={`query-status query-status--${status.state}`}
          role={status.state === "error" ? "alert" : "status"}
        >
          {["queued", "running", "cancelling"].includes(status.state) && (
            <LoaderCircle aria-hidden="true" />
          )}
          {status.message}
          {status.matchCount !== null && ` ${status.matchCount.toLocaleString()} matches`}
          {status.state === "error" && onRetryQuery && (
            <button onClick={onRetryQuery} type="button">
              Retry
            </button>
          )}
          {["queued", "running"].includes(status.state) && onCancelQuery && (
            <button onClick={onCancelQuery} type="button">
              Cancel
            </button>
          )}
        </span>
      )}
    </div>
  );
}
