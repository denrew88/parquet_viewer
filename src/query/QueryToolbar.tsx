import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  LoaderCircle,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { type QueryFilter, type QueryPlan, type QuerySearch, type QuerySort } from "./model";
import { usePointerReorder } from "../components/usePointerReorder";
import "./query.css";

interface SortDraftRow extends Omit<QuerySort, "nullsLast"> {
  readonly draftId: string;
  readonly nullsLast: boolean;
}

let nextSortDraftId = 0;

function createSortDraft(
  columnId = "",
  direction: QuerySort["direction"] = "ascending",
  nullsLast = true,
) {
  nextSortDraftId += 1;
  return {
    draftId: `sort-draft-${nextSortDraftId}`,
    columnId,
    direction,
    nullsLast,
  } as const;
}

function draftFromPlan(sort: readonly QuerySort[]): SortDraftRow[] {
  return sort.map((entry) => createSortDraft(entry.columnId, entry.direction, entry.nullsLast));
}

function moveSortDraft(
  rows: readonly SortDraftRow[],
  draftId: string,
  direction: -1 | 1,
): SortDraftRow[] {
  const index = rows.findIndex((entry) => entry.draftId === draftId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

interface SortColumnComboboxProps {
  autoFocus: boolean;
  columns: readonly QuerySearchColumn[];
  currentId: string;
  index: number;
  selectedIds: ReadonlySet<string>;
  invalidReason?: string;
  invalidReasonId?: string;
  onSelect(columnId: string): void;
}

function SortColumnCombobox({
  autoFocus,
  columns,
  currentId,
  index,
  selectedIds,
  invalidReason,
  invalidReasonId,
  onSelect,
}: SortColumnComboboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const selected = columns.find((column) => column.id === currentId);
  const filtered = useMemo(
    () =>
      columns.filter((column) =>
        column.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
    [columns, search],
  );
  const selectable = useMemo(
    () => filtered.filter((column) => column.id === currentId || !selectedIds.has(column.id)),
    [currentId, filtered, selectedIds],
  );
  const activeOptionIndex = filtered.findIndex((column) => column.id === activeId);

  useEffect(() => {
    if (!open) return;
    setActiveId((current) => {
      if (current && selectable.some((column) => column.id === current)) return current;
      if (currentId && selectable.some((column) => column.id === currentId)) return currentId;
      return selectable[0]?.id ?? null;
    });
  }, [currentId, open, selectable]);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    setOpen(true);
  }, [autoFocus]);

  return (
    <div
      className="query-sort-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setSearch("");
        }
      }}
    >
      <input
        aria-activedescendant={
          open && activeOptionIndex >= 0
            ? `sort-column-option-${index}-${activeOptionIndex}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={`sort-column-options-${index}`}
        aria-describedby={invalidReason ? invalidReasonId : undefined}
        aria-expanded={open}
        aria-invalid={invalidReason ? "true" : undefined}
        aria-label={`Column for sort priority ${index + 1}`}
        onChange={(event) => {
          setSearch(event.target.value);
          setOpen(true);
        }}
        onFocus={(event) => {
          setOpen(true);
          setSearch("");
          setActiveId(currentId || null);
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setSearch("");
            setActiveId(null);
            return;
          }
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
            setOpen(true);
            if (selectable.length === 0) return;
            const currentIndex = selectable.findIndex((column) => column.id === activeId);
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? selectable.length - 1
                  : event.key === "ArrowDown"
                    ? currentIndex < 0
                      ? 0
                      : (currentIndex + 1) % selectable.length
                    : currentIndex < 0
                      ? selectable.length - 1
                      : (currentIndex - 1 + selectable.length) % selectable.length;
            setActiveId(selectable[nextIndex]?.id ?? null);
            return;
          }
          if (event.key !== "Enter" || !open || !activeId) return;
          const active = selectable.find((column) => column.id === activeId);
          if (!active) return;
          event.preventDefault();
          onSelect(active.id);
          setOpen(false);
          setSearch("");
          setActiveId(null);
        }}
        placeholder="Choose a column..."
        ref={inputRef}
        role="combobox"
        type="search"
        value={open ? search : (selected?.label ?? "")}
      />
      {open && (
        <div
          aria-label={`Columns for sort priority ${index + 1}`}
          className="query-sort-combobox__options"
          id={`sort-column-options-${index}`}
          role="listbox"
        >
          {filtered.map((column, optionIndex) => {
            const alreadyUsed = column.id !== currentId && selectedIds.has(column.id);
            return (
              <button
                aria-disabled={alreadyUsed}
                aria-selected={column.id === currentId}
                className={column.id === activeId ? "is-active" : undefined}
                disabled={alreadyUsed}
                id={`sort-column-option-${index}-${optionIndex}`}
                key={column.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSelect(column.id);
                  setOpen(false);
                  setSearch("");
                  setActiveId(null);
                  inputRef.current?.focus();
                }}
                onMouseEnter={() => {
                  if (!alreadyUsed) setActiveId(column.id);
                }}
                role="option"
                type="button"
              >
                <span>
                  {column.label}
                  {column.hidden ? " (Hidden)" : ""}
                </span>
                {alreadyUsed && <small>Already used</small>}
              </button>
            );
          })}
          {filtered.length === 0 && <span className="query-sort-combobox__empty">No columns</span>}
        </div>
      )}
    </div>
  );
}

export interface QuerySearchColumn {
  id: string;
  label: string;
  searchable: boolean;
  hidden?: boolean;
  disabledReason?: string;
}

export interface QueryToolbarStatus {
  state: "idle" | "queued" | "running" | "cancelling" | "error";
  message: string;
  matchCount: number | null;
}

export interface QueryToolbarProps {
  active?: boolean;
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
  onSortChange?(sort: readonly QuerySort[]): void;
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
  mode: "find",
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

type ComparableSort = Pick<QuerySort, "columnId" | "direction"> & { nullsLast: boolean };

function sameSort(left: readonly ComparableSort[], right: readonly ComparableSort[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.columnId === right[index]?.columnId &&
        entry.direction === right[index]?.direction &&
        entry.nullsLast === right[index]?.nullsLast,
    )
  );
}

function sortDraftInvalidReason(
  entry: SortDraftRow,
  rows: readonly SortDraftRow[],
  columns: readonly QuerySearchColumn[],
): string | null {
  if (!entry.columnId) return "Choose a column for this sort level.";
  if (!columns.some((column) => column.id === entry.columnId)) {
    return "This column is no longer available.";
  }
  if (rows.filter((candidate) => candidate.columnId === entry.columnId).length > 1) {
    return "This column is already used by another sort level.";
  }
  return null;
}

export function QueryToolbar({
  active = true,
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
  onSortChange,
}: QueryToolbarProps) {
  const [draft, setDraft] = useState<QuerySearch>(() => plan.search ?? emptySearch);
  const [findOpen, setFindOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const findTriggerRef = useRef<HTMLButtonElement>(null);
  const [sortPanelOpen, setSortPanelOpen] = useState(false);
  const [sortDraft, setSortDraft] = useState<SortDraftRow[]>(() => draftFromPlan(plan.sort));
  const [focusSortDraftId, setFocusSortDraftId] = useState<string | null>(null);
  const sortPanelRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [targetMenuPosition, setTargetMenuPosition] = useState({ left: 8, top: 8 });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPosition, setFilterMenuPosition] = useState({ left: 8, top: 8 });
  const targetTriggerRef = useRef<HTMLButtonElement>(null);
  const targetMenuRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(plan.search ?? emptySearch), [plan.search]);
  useEffect(() => {
    if (!sortPanelOpen) setSortDraft(draftFromPlan(plan.sort));
  }, [plan.sort, sortPanelOpen]);
  const sortReorder = usePointerReorder({
    ids: sortDraft.map((entry) => entry.draftId),
    containerRef: sortPanelRef,
    orientation: "vertical",
    onCommit: (ids) =>
      setSortDraft((current) =>
        ids.flatMap((id) => {
          const entry = current.find((candidate) => candidate.draftId === id);
          return entry ? [entry] : [];
        }),
      ),
  });
  useEffect(() => {
    if (!active) {
      setFindOpen(false);
      setSortPanelOpen(false);
      setTargetMenuOpen(false);
      setFilterMenuOpen(false);
      return;
    }
    const openFind = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLocaleLowerCase() !== "f" ||
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog'], [aria-modal='true']",
        )
      )
        return;
      event.preventDefault();
      setFindOpen(true);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", openFind);
    return () => window.removeEventListener("keydown", openFind);
  }, [active]);
  useEffect(() => {
    if (!sortPanelOpen) return;
    const close = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (sortPanelRef.current?.contains(target) || sortTriggerRef.current?.contains(target))
      )
        return;
      setSortDraft(draftFromPlan(plan.sort));
      setSortPanelOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSortDraft(draftFromPlan(plan.sort));
      setSortPanelOpen(false);
      sortTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keydown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [plan.sort, sortPanelOpen]);
  useLayoutEffect(() => {
    if (findOpen) searchInputRef.current?.focus();
  }, [findOpen]);
  const searchableColumnKey = columns
    .filter((column) => column.searchable)
    .map((column) => column.id)
    .join("\u0000");
  const defaultTargetKey = columns
    .filter((column) => column.searchable && !column.hidden)
    .map((column) => column.id)
    .join("\u0000");
  useEffect(() => {
    const searchableIds = new Set(searchableColumnKey.split("\u0000").filter(Boolean));
    setDraft((current) => {
      const targetColumnIds = current.targetColumnIds.filter((id) => searchableIds.has(id));
      return targetColumnIds.length === current.targetColumnIds.length
        ? current
        : { ...current, targetColumnIds };
    });
  }, [searchableColumnKey]);

  function closeFind(): void {
    setTargetMenuOpen(false);
    setFindOpen(false);
    window.requestAnimationFrame(() => findTriggerRef.current?.focus());
  }
  function submitFind(): void {
    const search = draft.text.trim()
      ? {
          ...draft,
          mode: "find" as const,
          text: draft.text.trim(),
          targetColumnIds:
            draft.targetColumnIds.length > 0
              ? draft.targetColumnIds
              : defaultTargetKey.split("\u0000").filter(Boolean),
        }
      : null;
    if (!sameSearch(plan.search, search)) onSearchChange(search);
    else if (search) onFindNext?.();
  }

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
    const close = (event: Event) => {
      if (
        event.target instanceof Node &&
        (targetMenuRef.current?.contains(event.target) ||
          targetTriggerRef.current?.contains(event.target))
      )
        return;
      setTargetMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [targetMenuOpen]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const close = (event: Event) => {
      if (
        event.target instanceof Node &&
        (filterMenuRef.current?.contains(event.target) ||
          filterTriggerRef.current?.contains(event.target))
      )
        return;
      setFilterMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
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
  const selectedSortIds = new Set(sortDraft.map((entry) => entry.columnId).filter(Boolean));
  const sortDraftValid =
    sortDraft.length <= 64 &&
    sortDraft.every(
      (entry, index) =>
        Boolean(entry.columnId) &&
        columns.some((column) => column.id === entry.columnId) &&
        sortDraft.findIndex((candidate) => candidate.columnId === entry.columnId) === index,
    );

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
      {!findOpen && (
        <button
          className="query-open-find"
          onClick={() => {
            setFindOpen(true);
            window.requestAnimationFrame(() => searchInputRef.current?.focus());
          }}
          ref={findTriggerRef}
          type="button"
        >
          <Search aria-hidden="true" /> Find
        </button>
      )}
      {findOpen && (
        <form
          className="query-find-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitFind();
          }}
        >
          <div className="query-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Find data"
              onChange={(event) =>
                setDraft((current) => ({ ...current, text: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                closeFind();
              }}
              ref={searchInputRef}
              type="search"
              value={draft.text}
            />
          </div>
          <button className="query-submit-find" type="submit">
            Search
          </button>
        </form>
      )}
      {findOpen && (
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
      )}
      {findOpen && (
        <div className="query-find-navigation">
          <button aria-label="Previous match" onClick={onFindPrevious} type="button">
            <ChevronLeft aria-hidden="true" />
          </button>
          <button aria-label="Next match" onClick={onFindNext} type="button">
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      )}
      {findOpen && (
        <button
          aria-label="Close Find"
          className="query-close-find"
          onClick={closeFind}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      )}
      {onSortChange && (
        <div className="query-sort-editor">
          <button
            aria-expanded={sortPanelOpen}
            onClick={() => {
              setTargetMenuOpen(false);
              setSortDraft(draftFromPlan(plan.sort));
              setFocusSortDraftId(null);
              setSortPanelOpen((open) => !open);
            }}
            ref={sortTriggerRef}
            type="button"
          >
            Sorts ({plan.sort.length})
          </button>
          {sortPanelOpen && (
            <div
              aria-label="Multi-column sort"
              className="query-sort-editor__panel"
              ref={sortPanelRef}
              role="dialog"
            >
              <header>
                <strong>Multi-column sort</strong>
                <span>Drag rows to change sort priority.</span>
              </header>
              <button
                className="query-sort-editor__add-level"
                disabled={sortDraft.length >= 64}
                onClick={() => {
                  const row = createSortDraft();
                  setSortDraft((current) => [...current, row]);
                  setFocusSortDraftId(row.draftId);
                }}
                type="button"
              >
                <Plus aria-hidden="true" /> Add level
              </button>
              {sortDraft.length === 0 ? (
                <span>No sorted columns</span>
              ) : (
                sortDraft.map((entry, index) => {
                  const invalidReason = sortDraftInvalidReason(entry, sortDraft, columns);
                  const invalidReasonId = `sort-row-error-${entry.draftId}`;
                  return (
                    <div
                      aria-describedby={invalidReason ? invalidReasonId : undefined}
                      className={`query-sort-editor__row${invalidReason ? " is-invalid" : ""}${sortReorder.state.movingId === entry.draftId ? " is-reordering" : ""}${sortReorder.state.targetId === entry.draftId ? ` is-insert-${sortReorder.state.side}` : ""}`}
                      key={entry.draftId}
                      role="group"
                    >
                      <button
                        {...sortReorder.getItemProps(entry.draftId)}
                        aria-label={`Reorder sort ${entry.columnId || "empty level"}, priority ${index + 1}`}
                        className="query-sort-editor__drag"
                        onKeyDown={(event) => {
                          if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey)
                            return;
                          const direction =
                            event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
                          if (direction === null) return;
                          event.preventDefault();
                          setSortDraft((current) =>
                            moveSortDraft(current, entry.draftId, direction),
                          );
                        }}
                        type="button"
                      >
                        <GripVertical aria-hidden="true" />
                        <span>{index + 1}</span>
                      </button>
                      <SortColumnCombobox
                        autoFocus={focusSortDraftId === entry.draftId}
                        columns={columns}
                        currentId={entry.columnId}
                        index={index}
                        invalidReason={invalidReason ?? undefined}
                        invalidReasonId={invalidReasonId}
                        onSelect={(nextColumnId) => {
                          setSortDraft((current) =>
                            current.map((candidate) =>
                              candidate.draftId === entry.draftId
                                ? { ...candidate, columnId: nextColumnId }
                                : candidate,
                            ),
                          );
                          setFocusSortDraftId(null);
                        }}
                        selectedIds={selectedSortIds}
                      />
                      <select
                        aria-label={`Direction for sort priority ${index + 1}`}
                        onChange={(event) =>
                          setSortDraft((current) =>
                            current.map((candidate) =>
                              candidate.draftId === entry.draftId
                                ? {
                                    ...candidate,
                                    direction: event.target.value as QuerySort["direction"],
                                  }
                                : candidate,
                            ),
                          )
                        }
                        value={entry.direction}
                      >
                        <option value="ascending">Ascending</option>
                        <option value="descending">Descending</option>
                      </select>
                      <button
                        aria-label={`Remove sort ${entry.columnId || `priority ${index + 1}`}`}
                        onClick={() =>
                          setSortDraft((current) =>
                            current.filter((candidate) => candidate.draftId !== entry.draftId),
                          )
                        }
                        type="button"
                      >
                        <X aria-hidden="true" />
                      </button>
                      {invalidReason && (
                        <span
                          className="query-sort-editor__row-error"
                          id={invalidReasonId}
                          role="alert"
                        >
                          {invalidReason}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
              <footer>
                <button
                  disabled={sortDraft.length === 0}
                  onClick={() => setSortDraft([])}
                  type="button"
                >
                  Clear all
                </button>
                <span />
                <button
                  onClick={() => {
                    setSortDraft(draftFromPlan(plan.sort));
                    setSortPanelOpen(false);
                  }}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  disabled={!sortDraftValid || sameSort(plan.sort, sortDraft)}
                  onClick={() => {
                    onSortChange(
                      sortDraft.map(
                        ({ columnId, direction, nullsLast }) =>
                          ({
                            columnId,
                            direction,
                            nullsLast,
                          }) as QuerySort,
                      ),
                    );
                    setSortPanelOpen(false);
                  }}
                  type="button"
                >
                  Apply
                </button>
              </footer>
            </div>
          )}
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
