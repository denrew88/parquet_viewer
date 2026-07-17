import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  ClipboardCopy,
  Columns3,
  Eye,
  EyeOff,
  Filter,
  LoaderCircle,
  Search,
  Settings2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DataPage, DataValue, FileSummary, ReadPageRequest } from "./backend";
import {
  applyGridKey,
  createSelection,
  isSelected,
  selectionReducer,
  type GridBounds,
  type GridCoordinate,
} from "./gridSelection";
import { CopyAccumulator, CopyByteLimitExceededError, serializeCopyField } from "./copy/serializer";
import { COPY_PRESETS } from "./copy/presets";
import type { CopyOptions, CopyPreset } from "./copy/model";
import { orderedProjectionForWindow, sameProjectedColumns } from "./gridProjection";
import { ColumnFilterPopover, type DistinctValuesState } from "./query/ColumnFilterPopover";
import {
  clearFilters,
  removeFilter,
  setSearch,
  toggleSort,
  upsertFilter,
  type QueryPlan,
  type QueryScalarType,
} from "./query/model";
import { inferQueryScalarType } from "./query/scalarType";
import {
  QueryToolbar,
  type QuerySearchColumn,
  type QueryToolbarStatus,
} from "./query/QueryToolbar";
import {
  COPY_CHUNK_ROWS,
  COPY_HARD_CELL_LIMIT,
  COPY_SOFT_BYTE_LIMIT,
  COPY_SOFT_CELL_LIMIT,
} from "./tsv";

export const GRID_ROW_HEIGHT = 34;
export const GRID_HEADER_HEIGHT = 36;
export const GRID_ROW_NUMBER_WIDTH = 56;
export const GRID_DEFAULT_COLUMN_WIDTH = 180;
export const GRID_MIN_COLUMN_WIDTH = 80;
export const GRID_MAX_COLUMN_WIDTH = 800;
export const GRID_ROW_OVERSCAN = 8;
export const GRID_COLUMN_OVERSCAN = 3;
export const GRID_PREFETCH_DISTANCE = 40;
const MAX_PAGE_WINDOW = 3;
const MAX_CONCURRENT_REQUESTS = 2;

export interface VirtualDataGridProps {
  active?: boolean;
  copyOptions?: CopyOptions;
  copyPresetError?: string | null;
  copyPresetSaving?: boolean;
  distinctValuesForColumn?(columnId: string): DistinctValuesState | undefined;
  findTarget?: { row: number; columnId: string; key: string };
  isLoading: boolean;
  logicalColumnNames?: readonly string[];
  onCancelQuery?(): void;
  onFindNext?(): void;
  onFindPrevious?(): void;
  onOpenDistinctValues?(columnId: string): void;
  onRetryQuery?(): void;
  onOpenCopySettings?(): void;
  onCopyPresetChange?(preset: CopyPreset): void;
  onPageChange(offset: number): void;
  onQueryPlanChange?(plan: QueryPlan): void;
  onReadError(error: unknown, offset: number): void;
  page: DataPage;
  queryPlan?: QueryPlan;
  queryScalarTypes?: Readonly<Record<string, QueryScalarType>>;
  queryStatus?: QueryToolbarStatus;
  readPage(request: ReadPageRequest): Promise<DataPage>;
  resultKey?: string;
  summary: FileSummary;
  writeClipboardText?: (text: string) => Promise<void>;
}

function projectedPageKey(offset: number, columns: readonly string[]): string {
  return `${offset}:${JSON.stringify(columns)}`;
}

interface CopyProgress {
  copiedRows: number;
  totalRows: number;
  state: "copying" | "cancelling";
}

async function defaultWriteClipboardText(text: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await writeText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard access is unavailable in this environment.");
}

function pageOffsetFor(row: number, limit: number): number {
  return Math.floor(row / limit) * limit;
}

function dataCellText(value: DataValue): string {
  if (value.kind === "null") return "null";
  if (value.kind === "string" && value.display === "") return '""';
  return value.display ?? "";
}

function cellClass(value: DataValue): string {
  return `virtual-grid__cell data-value--${value.kind}${
    value.kind === "null"
      ? " null-value"
      : value.kind === "string" && value.display === ""
        ? " empty-string"
        : ""
  }${value.state === "invalid" ? " data-value--invalid" : ""}`;
}

function pageStatus(page: DataPage): string {
  if (page.totalRows === 0) return "No rows";
  if (page.rows.length === 0) return `No rows at offset ${page.offset.toLocaleString()}`;
  const range = `${page.offset + 1}-${page.offset + page.rows.length}`;
  return page.totalRows === null
    ? `Showing rows ${range}; total calculating`
    : `Showing rows ${range} of ${page.totalRows.toLocaleString()}`;
}

export function VirtualDataGrid({
  active = true,
  copyOptions = COPY_PRESETS.excel,
  copyPresetError = null,
  copyPresetSaving = false,
  distinctValuesForColumn,
  findTarget,
  isLoading,
  logicalColumnNames: logicalColumnNamesProp,
  onCancelQuery,
  onFindNext,
  onFindPrevious,
  onOpenDistinctValues,
  onRetryQuery,
  onOpenCopySettings,
  onCopyPresetChange,
  onPageChange,
  onQueryPlanChange,
  onReadError,
  page,
  queryPlan,
  queryScalarTypes,
  queryStatus,
  readPage,
  resultKey,
  summary,
  writeClipboardText = defaultWriteClipboardText,
}: VirtualDataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const latestPage = useRef(page);
  latestPage.current = page;
  const activeResultKey = resultKey ?? summary.sessionId;
  const latestResultKey = useRef(activeResultKey);
  latestResultKey.current = activeResultKey;
  const generation = useRef(0);
  const copyGeneration = useRef(0);
  const mounted = useRef(true);
  const dragging = useRef(false);
  const horizontalGeneration = useRef(0);
  const inFlight = useRef(new Map<string, Promise<DataPage>>());
  const [pages, setPages] = useState<Map<string, DataPage>>(
    () => new Map([[projectedPageKey(page.offset, page.columns), page]]),
  );
  const [activeOffset, setActiveOffset] = useState(page.offset);
  const [activeProjection, setActiveProjection] = useState<string[]>(() => [...page.columns]);
  const [loadingPageKeys, setLoadingPageKeys] = useState<Set<string>>(new Set());
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [chooserOpen, setChooserOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const copyMenuPanelRef = useRef<HTMLDivElement>(null);
  const copyMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [searchInput, setSearchInput] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const logicalColumnNames = useMemo(
    () => logicalColumnNamesProp ?? summary.columns.map((column) => column.name),
    [logicalColumnNamesProp, summary.columns],
  );
  const logicalColumnsKey = JSON.stringify(logicalColumnNames);
  const initialBounds = {
    rowCount: Math.max(1, summary.rowCount ?? page.offset + page.rows.length),
    columnCount: Math.max(1, logicalColumnNames.length),
    pageStep: 10,
  };
  const [selection, dispatchSelection] = useReducer(
    selectionReducer,
    createSelection(activeResultKey, initialBounds),
  );
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{
    coordinate: GridCoordinate;
    value: DataValue;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    coordinate: GridCoordinate;
    x: number;
    y: number;
  } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ left: 0, top: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [filterPopover, setFilterPopover] = useState<{
    columnId: string;
    left: number;
    top: number;
  } | null>(null);
  const [filterPopoverPosition, setFilterPopoverPosition] = useState({ left: 8, top: 8 });
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queryEnabled = Boolean(queryPlan && onQueryPlanChange);

  const closeFilterPopover = useCallback((restoreFocus = true) => {
    setFilterPopover(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
    }
  }, []);

  const handleSearchChange = useCallback(
    (search: Parameters<typeof setSearch>[1]) => {
      if (queryPlan && onQueryPlanChange) onQueryPlanChange(setSearch(queryPlan, search));
    },
    [onQueryPlanChange, queryPlan],
  );

  const handleRemoveFilter = useCallback(
    (filterId: string) => {
      if (queryPlan && onQueryPlanChange) {
        onQueryPlanChange(removeFilter(queryPlan, filterId));
      }
    },
    [onQueryPlanChange, queryPlan],
  );

  const handleClearFilters = useCallback(() => {
    if (queryPlan && onQueryPlanChange) onQueryPlanChange(clearFilters(queryPlan));
  }, [onQueryPlanChange, queryPlan]);

  useEffect(() => {
    mounted.current = true;
    const pendingRequests = inFlight.current;
    return () => {
      mounted.current = false;
      generation.current += 1;
      copyGeneration.current += 1;
      pendingRequests.clear();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setColumnSearch(searchInput), 100);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const firstPage = latestPage.current;
    generation.current += 1;
    horizontalGeneration.current += 1;
    inFlight.current.clear();
    setPages(new Map([[projectedPageKey(firstPage.offset, firstPage.columns), firstPage]]));
    setActiveOffset(firstPage.offset);
    setActiveProjection([...firstPage.columns]);
    setLoadingPageKeys(new Set());
    setColumnSizing({});
    setColumnVisibility({});
    copyGeneration.current += 1;
    setCopyProgress(null);
    setCopyMessage(null);
    dispatchSelection({
      type: "reset",
      sessionId: activeResultKey,
      bounds: {
        rowCount: Math.max(1, firstPage.totalRows ?? firstPage.rows.length),
        columnCount: Math.max(1, logicalColumnNames.length),
        pageStep: 10,
      },
    });
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
    if (activeRef.current) window.requestAnimationFrame(() => gridRef.current?.focus());
  }, [activeResultKey, logicalColumnsKey, logicalColumnNames.length]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    setContextMenuPosition({
      left: Math.max(margin, Math.min(contextMenu.x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(contextMenu.y, window.innerHeight - rect.height - margin)),
    });
    const first = contextMenuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
  }, [contextMenu]);

  useEffect(() => {
    if (!copyMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (copyMenuRef.current?.contains(event.target as Node)) return;
      setCopyMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [copyMenuOpen]);

  useLayoutEffect(() => {
    if (!copyMenuOpen) return;
    copyMenuPanelRef.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem'], [role='menuitemradio']")
      ?.focus();
  }, [copyMenuOpen]);

  function handleCopyMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setCopyMenuOpen(false);
      copyMenuTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      copyMenuPanelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem'], [role='menuitemradio']",
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

  useEffect(() => {
    if (active || !contextMenu) return;
    setContextMenu(null);
  }, [active, contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event?: Event) => {
      if (event && contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!filterPopover || !filterPopoverRef.current) return;
    const host = filterPopoverRef.current;
    const reposition = () => {
      const rect = host.getBoundingClientRect();
      const margin = 8;
      const next = {
        left: Math.max(
          margin,
          Math.min(filterPopover.left, window.innerWidth - rect.width - margin),
        ),
        top: Math.max(
          margin,
          Math.min(filterPopover.top, window.innerHeight - rect.height - margin),
        ),
      };
      setFilterPopoverPosition((current) =>
        current.left === next.left && current.top === next.top ? current : next,
      );
    };
    reposition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    observer?.observe(host);
    const first = host.querySelector<HTMLElement>("select, input, button:not(:disabled)");
    first?.focus();
    return () => observer?.disconnect();
  }, [filterPopover]);

  useEffect(() => {
    if ((active && queryEnabled) || !filterPopover) return;
    closeFilterPopover(false);
  }, [active, closeFilterPopover, filterPopover, queryEnabled]);

  useEffect(() => {
    if (!filterPopover) return;
    const close = (event?: Event) => {
      if (event && filterPopoverRef.current?.contains(event.target as Node)) return;
      closeFilterPopover(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [closeFilterPopover, filterPopover]);

  useEffect(() => {
    setPages((current) => {
      const next = new Map(current);
      next.set(projectedPageKey(page.offset, page.columns), page);
      return next;
    });
    setActiveOffset(page.offset);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = page.offset * GRID_ROW_HEIGHT;
      scrollRef.current.dispatchEvent(new Event("scroll"));
    }
  }, [page]);

  const columnHelper = createColumnHelper<DataValue[]>();
  const columnDefs = useMemo(
    () =>
      logicalColumnNames.map((name) =>
        columnHelper.display({
          id: name,
          header: name,
          size: GRID_DEFAULT_COLUMN_WIDTH,
          minSize: GRID_MIN_COLUMN_WIDTH,
          maxSize: GRID_MAX_COLUMN_WIDTH,
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logicalColumnsKey],
  );
  const table = useReactTable({
    data: page.rows,
    columns: columnDefs,
    state: { columnSizing, columnVisibility },
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  });
  const visibleColumns = table.getVisibleLeafColumns();
  const allColumns = table.getAllLeafColumns();
  const visibleColumnIndexes = useMemo(
    () => visibleColumns.map((column) => logicalColumnNames.indexOf(column.id)),
    [logicalColumnNames, visibleColumns],
  );
  const totalColumnWidth = visibleColumns.reduce((total, column) => total + column.getSize(), 0);

  const knownCount = queryEnabled ? page.totalRows : summary.rowCount;
  const loadedEnd = Math.max(
    ...[...pages.values()].map((loaded) => loaded.offset + loaded.rows.length),
  );
  const finalLoadedPage = [...pages.values()].find((loaded) => !loaded.hasMore);
  const rowCount = knownCount ?? (finalLoadedPage ? loadedEnd : loadedEnd + 1);
  const selectionBounds: GridBounds = {
    rowCount,
    columnCount: logicalColumnNames.length,
    pageStep: Math.max(
      1,
      Math.floor(((scrollRef.current?.clientHeight ?? 420) - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT),
    ),
  };

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: GRID_ROW_OVERSCAN,
    useFlushSync: false,
    useScrollendEvent: true,
    initialRect: { width: 1024, height: 420 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback({ width: rect.width || 1024, height: rect.height || 420 }),
      ),
  });
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: visibleColumns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => visibleColumns[index]?.getSize() ?? GRID_DEFAULT_COLUMN_WIDTH,
    overscan: GRID_COLUMN_OVERSCAN,
    useFlushSync: false,
    useScrollendEvent: true,
    initialRect: { width: 1024 - GRID_ROW_NUMBER_WIDTH, height: 420 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback({ width: rect.width || 1024, height: rect.height || 420 }),
      ),
  });

  useEffect(() => columnVirtualizer.measure(), [columnSizing, columnVirtualizer]);

  useEffect(() => {
    if (!findTarget) return;
    const column = logicalColumnNames.indexOf(findTarget.columnId);
    if (column < 0 || findTarget.row < 0 || findTarget.row >= selectionBounds.rowCount) return;
    const coordinate = { row: findTarget.row, column };
    dispatchSelection({ type: "click", coordinate, bounds: selectionBounds });
    scrollToCoordinate(coordinate);
    window.requestAnimationFrame(() => gridRef.current?.focus());
    // The key represents a backend match cursor move, including repeated moves to the same cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findTarget?.key]);

  const trimPageWindow = useCallback((source: Map<string, DataPage>, focusKey: string) => {
    if (source.size <= MAX_PAGE_WINDOW) return source;
    const focusOffset = source.get(focusKey)?.offset ?? 0;
    const ordered = [...source.keys()].sort((left, right) => {
      if (left === focusKey) return -1;
      if (right === focusKey) return 1;
      return (
        Math.abs((source.get(left)?.offset ?? 0) - focusOffset) -
        Math.abs((source.get(right)?.offset ?? 0) - focusOffset)
      );
    });
    const keep = new Set(ordered.slice(0, MAX_PAGE_WINDOW));
    return new Map([...source].filter(([key]) => keep.has(key)));
  }, []);

  const requestPage = useCallback(
    (offset: number, foreground: boolean) => {
      if (offset < 0 || activeProjection.length === 0) return Promise.resolve(null);
      const key = projectedPageKey(offset, activeProjection);
      if (pages.has(key)) return Promise.resolve(pages.get(key) ?? null);
      const compatible = [...pages.values()].find(
        (candidate) =>
          candidate.offset === offset &&
          activeProjection.every((column) => candidate.columns.includes(column)),
      );
      if (compatible) return Promise.resolve(compatible);
      const existing = inFlight.current.get(key);
      if (existing) return existing;
      if (inFlight.current.size >= MAX_CONCURRENT_REQUESTS) return Promise.resolve(null);
      const requestGeneration = generation.current;
      const requestHorizontalGeneration = horizontalGeneration.current;
      const requestedColumns = [...activeProjection];
      const promise = readPage({
        sessionId: summary.sessionId,
        offset,
        limit: page.limit,
        columns: requestedColumns,
      });
      inFlight.current.set(key, promise);
      setLoadingPageKeys((current) => new Set(current).add(key));
      void promise
        .then(
          (nextPage) => {
            if (
              requestGeneration !== generation.current ||
              requestHorizontalGeneration !== horizontalGeneration.current ||
              nextPage.sessionId !== summary.sessionId ||
              nextPage.offset !== offset ||
              !sameProjectedColumns(nextPage.columns, requestedColumns)
            ) {
              return;
            }
            setPages((current) => {
              const next = new Map(current);
              next.set(key, nextPage);
              return trimPageWindow(next, key);
            });
            if (foreground) setActiveOffset(offset);
          },
          (error: unknown) => {
            if (
              foreground &&
              requestGeneration === generation.current &&
              requestHorizontalGeneration === horizontalGeneration.current
            )
              onReadError(error, offset);
          },
        )
        .finally(() => {
          if (inFlight.current.get(key) === promise) inFlight.current.delete(key);
          if (
            requestGeneration === generation.current &&
            requestHorizontalGeneration === horizontalGeneration.current
          ) {
            setLoadingPageKeys((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }
        });
      return promise;
    },
    [activeProjection, onReadError, page.limit, pages, readPage, summary.sessionId, trimPageWindow],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const columnVirtualItems = columnVirtualizer.getVirtualItems();
  const firstVisibleRow = virtualRows[0]?.index ?? 0;
  const lastVisibleRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  const mountedLogicalOrdinals = columnVirtualItems.map(
    (virtualColumn) => visibleColumnIndexes[virtualColumn.index],
  );
  const mountedLogicalOrdinalsKey = mountedLogicalOrdinals.join(",");

  useEffect(() => {
    setActiveProjection((current) => {
      const next = orderedProjectionForWindow(logicalColumnNames, mountedLogicalOrdinals, current);
      return sameProjectedColumns(current, next) ? current : next;
    });
    // The key captures the virtual range without making this effect depend on a fresh array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logicalColumnsKey, mountedLogicalOrdinalsKey]);

  const activeProjectionKey = JSON.stringify(activeProjection);
  useEffect(() => {
    horizontalGeneration.current += 1;
    inFlight.current.clear();
    setLoadingPageKeys(new Set());
  }, [activeProjectionKey]);

  useEffect(() => {
    if (rowCount === 0) return;
    const scrollRow = Math.floor(
      (scrollRef.current?.scrollTop ?? firstVisibleRow * GRID_ROW_HEIGHT) / GRID_ROW_HEIGHT,
    );
    const visibleOffset = pageOffsetFor(scrollRow, page.limit);
    const visibleKey = projectedPageKey(visibleOffset, activeProjection);
    const compatible = [...pages.values()].find(
      (candidate) =>
        candidate.offset === visibleOffset &&
        activeProjection.every((column) => candidate.columns.includes(column)),
    );
    const propPageCompatible =
      page.offset === visibleOffset &&
      activeProjection.every((column) => page.columns.includes(column));
    if (!pages.has(visibleKey) && !compatible && !propPageCompatible) {
      void requestPage(visibleOffset, true);
    } else setActiveOffset(visibleOffset);

    const current = pages.get(visibleKey) ?? compatible ?? (propPageCompatible ? page : undefined);
    if (!current) return;
    const distanceToEnd = current.offset + current.rows.length - 1 - lastVisibleRow;
    if (current.hasMore && distanceToEnd <= GRID_PREFETCH_DISTANCE) {
      void requestPage(current.offset + page.limit, false);
    }
    const distanceToStart = firstVisibleRow - current.offset;
    if (current.offset > 0 && distanceToStart <= GRID_PREFETCH_DISTANCE) {
      void requestPage(Math.max(0, current.offset - page.limit), false);
    }
  }, [activeProjection, firstVisibleRow, lastVisibleRow, page, pages, requestPage, rowCount]);

  const activePage = pages.get(projectedPageKey(activeOffset, activeProjection)) ?? page;

  useEffect(() => {
    const stopDragging = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("blur", stopDragging);
    };
  }, []);

  function valueAt(rowIndex: number, columnIndex: number): DataValue | null {
    const offset = pageOffsetFor(rowIndex, page.limit);
    const columnName = logicalColumnNames[columnIndex];
    if (!columnName) return null;
    const preferred = pages.get(projectedPageKey(offset, activeProjection));
    const candidates = preferred
      ? [preferred, ...[...pages.values()].filter((candidate) => candidate !== preferred)]
      : [...pages.values()];
    for (const loaded of candidates) {
      if (loaded.offset !== offset) continue;
      const projectedIndex = loaded.columns.indexOf(columnName);
      if (projectedIndex < 0) continue;
      const value = loaded.rows[rowIndex - offset]?.[projectedIndex];
      if (value) return value;
    }
    return null;
  }

  function inspect(coordinate: GridCoordinate) {
    const value = valueAt(coordinate.row, coordinate.column);
    if (value) setInspected({ coordinate, value });
  }

  function scrollToCoordinate(coordinate: GridCoordinate) {
    rowVirtualizer.scrollToIndex(coordinate.row, { align: "auto" });
    const visibleIndex = visibleColumnIndexes.indexOf(coordinate.column);
    if (visibleIndex >= 0) columnVirtualizer.scrollToIndex(visibleIndex, { align: "auto" });
  }

  async function copySelection(includeColumnHeaders?: boolean, options = copyOptions) {
    if (copyProgress || rowCount === 0 || logicalColumnNames.length === 0) return;
    const copyId = ++copyGeneration.current;
    const sessionId = summary.sessionId;
    const copyResultKey = activeResultKey;
    const { top, left, bottom, right } = selection.rect;
    const totalRows = bottom - top + 1;
    const selectedColumns = logicalColumnNames.slice(left, right + 1);
    const cellCount = totalRows * selectedColumns.length;
    setCopyMessage(null);

    if (cellCount > COPY_HARD_CELL_LIMIT) {
      setCopyMessage("Selection exceeds the 1,000,000-cell clipboard limit.");
      return;
    }
    if (selectedColumns.length > 64) {
      setCopyMessage("Copy at most 64 columns at a time.");
      return;
    }
    if (
      cellCount > COPY_SOFT_CELL_LIMIT &&
      !window.confirm(
        `Copy ${cellCount.toLocaleString()} cells? Large selections may take a moment.`,
      )
    ) {
      return;
    }

    const activeCopyOptions = {
      ...options,
      includeHeaders: includeColumnHeaders ?? options.includeHeaders,
    };
    const writer = new CopyAccumulator(activeCopyOptions);
    let copiedRows = 0;
    let softBytesConfirmed = cellCount > COPY_SOFT_CELL_LIMIT;
    setCopyProgress({ copiedRows, totalRows, state: "copying" });
    try {
      for (let offset = top; offset <= bottom; offset += COPY_CHUNK_ROWS) {
        if (
          !mounted.current ||
          copyId !== copyGeneration.current ||
          copyResultKey !== latestResultKey.current
        )
          return;
        const limit = Math.min(COPY_CHUNK_ROWS, bottom - offset + 1);
        const cachedRows: DataValue[][] = [];
        let cached = true;
        for (let row = offset; row < offset + limit; row += 1) {
          const values = [];
          for (let column = left; column <= right; column += 1) {
            const value = valueAt(row, column);
            if (value === null) {
              cached = false;
              break;
            }
            values.push(value);
          }
          if (!cached) break;
          cachedRows.push(values);
        }
        const rows = cached
          ? cachedRows
          : (
              await readPage({
                sessionId,
                offset,
                limit,
                columns: selectedColumns,
              })
            ).rows;
        if (
          !mounted.current ||
          copyId !== copyGeneration.current ||
          copyResultKey !== latestResultKey.current
        )
          return;
        writer.appendRows(
          rows,
          copiedRows === 0 && activeCopyOptions.includeHeaders ? selectedColumns : undefined,
        );
        copiedRows += rows.length;
        setCopyProgress({ copiedRows, totalRows, state: "copying" });
        if (rows.length < limit) break;
      }

      if (
        writer.byteLength > COPY_SOFT_BYTE_LIMIT &&
        !softBytesConfirmed &&
        !window.confirm(
          `Copy ${(writer.byteLength / (1024 * 1024)).toFixed(1)} MiB to the clipboard?`,
        )
      ) {
        return;
      }
      softBytesConfirmed = true;
      if (
        !mounted.current ||
        copyId !== copyGeneration.current ||
        copyResultKey !== latestResultKey.current
      )
        return;
      await writeClipboardText(writer.finish());
      if (
        mounted.current &&
        copyId === copyGeneration.current &&
        copyResultKey === latestResultKey.current
      ) {
        setCopyMessage(`Copied ${copiedRows.toLocaleString()} rows.`);
      }
    } catch (error) {
      if (copyId !== copyGeneration.current) return;
      setCopyMessage(
        error instanceof CopyByteLimitExceededError || error instanceof Error
          ? error.message
          : "The selection could not be copied.",
      );
    } finally {
      if (copyId === copyGeneration.current) setCopyProgress(null);
    }
  }

  function cancelCopy() {
    copyGeneration.current += 1;
    setCopyProgress((current) => (current ? { ...current, state: "cancelling" } : current));
    window.setTimeout(() => setCopyProgress(null), 0);
    setCopyMessage("Copy cancelled.");
  }

  function closeContextMenu(restoreFocus = true) {
    setContextMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => gridRef.current?.focus());
  }

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>, coordinate: GridCoordinate) {
    event.preventDefault();
    if (!isSelected(selection, coordinate)) {
      dispatchSelection({ type: "click", coordinate, bounds: selectionBounds });
    }
    setContextMenu({ coordinate, x: event.clientX, y: event.clientY });
  }

  function openKeyboardContextMenu() {
    const coordinate = selection.active;
    scrollToCoordinate(coordinate);
    window.requestAnimationFrame(() => {
      const cell = gridRef.current?.querySelector<HTMLElement>(
        `[data-grid-row="${coordinate.row}"][data-grid-column="${coordinate.column}"]`,
      );
      const rect = cell?.getBoundingClientRect() ?? gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      setContextMenu({
        coordinate,
        x: Math.min(rect.right, window.innerWidth - 8),
        y: Math.min(rect.bottom, window.innerHeight - 8),
      });
    });
  }

  async function copyContextCell(coordinate: GridCoordinate) {
    const value = valueAt(coordinate.row, coordinate.column);
    if (!value) return;
    try {
      await writeClipboardText(serializeCopyField(value, copyOptions));
      setCopyMessage("Copied cell value.");
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : "The cell could not be copied.");
    }
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openKeyboardContextMenu();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      inspect(selection.active);
      return;
    }
    const primary = event.ctrlKey || event.metaKey;
    if (primary && event.key.toLocaleLowerCase() === "c") {
      event.preventDefault();
      void copySelection();
      return;
    }
    const handled =
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Escape",
      ].includes(event.key) ||
      (primary && event.key.toLocaleLowerCase() === "a");
    if (!handled || event.altKey) return;
    event.preventDefault();
    const next = applyGridKey(
      selection,
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      },
      selectionBounds,
      (coordinate) => {
        const value = valueAt(coordinate.row, coordinate.column);
        return value === null || value.kind === "null" || value.display === "";
      },
    );
    dispatchSelection({
      type: "key",
      command: {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      },
      bounds: selectionBounds,
      isEmpty: (coordinate) => {
        const value = valueAt(coordinate.row, coordinate.column);
        return value === null || value.kind === "null" || value.display === "";
      },
    });
    scrollToCoordinate(next.active);
  }

  function resizeColumn(
    event: ReactPointerEvent<HTMLDivElement>,
    columnId: string,
    originalSize: number,
  ) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const size = Math.min(
        GRID_MAX_COLUMN_WIDTH,
        Math.max(GRID_MIN_COLUMN_WIDTH, originalSize + moveEvent.clientX - startX),
      );
      setColumnSizing((current) => ({ ...current, [columnId]: size }));
    };
    const stop = () => {
      target.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function resizeColumnWithKeyboard(event: KeyboardEvent<HTMLDivElement>, columnId: string) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const current = table.getColumn(columnId)?.getSize() ?? GRID_DEFAULT_COLUMN_WIDTH;
    if (event.key === "Home" || event.key === "End") {
      setColumnSizing((sizes) => ({
        ...sizes,
        [columnId]: event.key === "Home" ? GRID_MIN_COLUMN_WIDTH : GRID_MAX_COLUMN_WIDTH,
      }));
      return;
    }
    const delta = event.key === "ArrowRight" ? 10 : -10;
    setColumnSizing((sizes) => ({
      ...sizes,
      [columnId]: Math.min(GRID_MAX_COLUMN_WIDTH, Math.max(GRID_MIN_COLUMN_WIDTH, current + delta)),
    }));
  }

  const filteredColumns = allColumns.filter((column) =>
    column.id.toLocaleLowerCase().includes(columnSearch.trim().toLocaleLowerCase()),
  );
  const mountedCellCount = virtualRows.length * columnVirtualItems.length;
  const querySearchColumns: QuerySearchColumn[] = visibleColumns.map((column) => {
    const columnId = column.id;
    const scalarType = queryScalarTypes?.[columnId] ?? inferQueryScalarType(summary, columnId);
    return {
      id: columnId,
      label: columnId,
      searchable: scalarType !== "other",
      disabledReason:
        scalarType === "other" ? "Search is unavailable for this column type." : undefined,
    };
  });
  const queryHasConditions = Boolean(
    queryPlan && (queryPlan.filters.length > 0 || queryPlan.search?.text.trim()),
  );

  return (
    <div
      className="virtual-grid-shell"
      style={queryEnabled ? { gridTemplateRows: "38px 38px minmax(0, 1fr) 40px" } : undefined}
    >
      {queryEnabled && queryPlan && (
        <QueryToolbar
          columns={querySearchColumns}
          onCancelQuery={onCancelQuery}
          onClearFilters={handleClearFilters}
          onFindNext={onFindNext}
          onFindPrevious={onFindPrevious}
          onRemoveFilter={handleRemoveFilter}
          onRetryQuery={onRetryQuery}
          onSearchChange={handleSearchChange}
          plan={queryPlan}
          status={queryStatus}
        />
      )}
      <div className="column-toolbar" aria-label="Column tools">
        <div className="column-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Search columns"
            onChange={(event) => {
              setSearchInput(event.target.value);
              setColumnSearch(event.target.value);
            }}
            placeholder="Find column"
            type="search"
            value={searchInput}
          />
        </div>
        <button
          aria-expanded={chooserOpen}
          aria-label="Choose columns"
          className="column-tool-button"
          onClick={() => setChooserOpen((open) => !open)}
          title="Choose columns"
          type="button"
        >
          <Columns3 aria-hidden="true" />
        </button>
        <span className="column-count">
          {visibleColumns.length.toLocaleString()} / {allColumns.length.toLocaleString()} columns
        </span>
        <div className="copy-controls">
          <button
            aria-label={copyProgress ? "Cancel copy" : "Copy selection"}
            className="copy-selection-button"
            disabled={rowCount === 0}
            onClick={copyProgress ? cancelCopy : () => void copySelection()}
            title={copyProgress ? "Cancel copy" : `Copy selection as ${copyOptions.preset}`}
            type="button"
          >
            {copyProgress ? <X aria-hidden="true" /> : <ClipboardCopy aria-hidden="true" />}
            <span>{copyProgress ? "Cancel" : `Copy (${copyOptions.preset.toUpperCase()})`}</span>
          </button>
          <div className="copy-split-menu" ref={copyMenuRef}>
            <button
              aria-expanded={copyMenuOpen}
              aria-haspopup="menu"
              aria-label="Copy options"
              className="copy-options-button"
              disabled={Boolean(copyProgress) || copyPresetSaving}
              onClick={() => setCopyMenuOpen((open) => !open)}
              ref={copyMenuTriggerRef}
              title="Copy options"
              type="button"
            >
              <ChevronDown aria-hidden="true" />
            </button>
            {copyMenuOpen && (
              <div
                aria-label="Copy options"
                onKeyDown={handleCopyMenuKeyDown}
                ref={copyMenuPanelRef}
                role="menu"
              >
                <button
                  onClick={() => {
                    setCopyMenuOpen(false);
                    void copySelection(true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  Copy with column headers
                </button>
                {(["excel", "tsv", "csv", "custom"] as const).map((preset) => (
                  <button
                    aria-checked={copyOptions.preset === preset}
                    disabled={!onCopyPresetChange || copyPresetSaving}
                    key={preset}
                    onClick={() => {
                      setCopyMenuOpen(false);
                      onCopyPresetChange?.(preset);
                    }}
                    role="menuitemradio"
                    type="button"
                  >
                    <span className="copy-preset-check">
                      {copyOptions.preset === preset ? <Check aria-hidden="true" /> : null}
                    </span>
                    <span>
                      {preset === "excel"
                        ? "Excel"
                        : preset === "custom"
                          ? "Custom"
                          : preset.toUpperCase()}
                    </span>
                  </button>
                ))}
                {onOpenCopySettings && (
                  <button
                    onClick={() => {
                      setCopyMenuOpen(false);
                      onOpenCopySettings();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Settings2 aria-hidden="true" /> Copy settings
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {(copyProgress || copyMessage) && (
          <span className="copy-status" role="status" aria-live="polite">
            {copyProgress
              ? `${copyProgress.state === "cancelling" ? "Cancelling" : "Copying"} ${copyProgress.copiedRows.toLocaleString()} / ${copyProgress.totalRows.toLocaleString()} rows`
              : copyMessage}
          </span>
        )}
        {copyPresetSaving ? (
          <span className="copy-status" role="status" aria-live="polite">
            Saving copy preset...
          </span>
        ) : copyPresetError ? (
          <span className="copy-status copy-status--error" role="alert">
            {copyPresetError}
          </span>
        ) : null}
        {chooserOpen && (
          <div className="column-chooser" role="dialog" aria-label="Column chooser">
            <div className="column-chooser__header">
              <strong>Columns</strong>
              <button
                aria-label="Close column chooser"
                className="icon-button"
                onClick={() => setChooserOpen(false)}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="column-chooser__list">
              {filteredColumns.map((column) => (
                <button
                  aria-pressed={column.getIsVisible()}
                  key={column.id}
                  onClick={column.getToggleVisibilityHandler()}
                  title={column.id}
                  type="button"
                >
                  {column.getIsVisible() ? (
                    <Eye aria-hidden="true" />
                  ) : (
                    <EyeOff aria-hidden="true" />
                  )}
                  <span>{column.id}</span>
                </button>
              ))}
              {filteredColumns.length === 0 && (
                <span className="column-chooser__empty">No columns</span>
              )}
            </div>
            <button
              className="show-all-columns"
              disabled={visibleColumns.length === allColumns.length}
              onClick={() => setColumnVisibility({})}
              type="button"
            >
              Show all
            </button>
          </div>
        )}
      </div>

      <div
        aria-colcount={visibleColumns.length}
        aria-label="Data preview"
        aria-rowcount={knownCount ?? -1}
        className="virtual-grid"
        data-active-column={selection.active.column}
        data-active-row={selection.active.row}
        data-mounted-cells={mountedCellCount}
        data-mounted-columns={columnVirtualItems.length}
        data-mounted-rows={virtualRows.length}
        data-selection-bottom={selection.rect.bottom}
        data-selection-kind={selection.kind}
        data-selection-left={selection.rect.left}
        data-selection-right={selection.rect.right}
        data-selection-top={selection.rect.top}
        data-testid="data-scroll"
        onKeyDown={handleGridKeyDown}
        ref={(element) => {
          gridRef.current = element;
          scrollRef.current = element;
        }}
        role="grid"
        tabIndex={0}
      >
        {visibleColumns.length === 0 ? (
          <div className="virtual-grid__empty-columns" role="status">
            All columns are hidden. Use the column chooser to restore them.
          </div>
        ) : rowCount === 0 ? (
          <div
            className={`virtual-grid__empty${queryHasConditions ? " virtual-grid__empty-query" : ""}`}
            role="status"
          >
            <span>
              {queryHasConditions ? "No rows match the current query" : "No rows in file"}
            </span>
            {queryHasConditions && queryPlan && onQueryPlanChange && (
              <button
                onClick={() => onQueryPlanChange({ ...queryPlan, filters: [], search: null })}
                type="button"
              >
                Clear query
              </button>
            )}
          </div>
        ) : (
          <div
            className="virtual-grid__canvas"
            style={{
              height: GRID_HEADER_HEIGHT + rowVirtualizer.getTotalSize(),
              width: GRID_ROW_NUMBER_WIDTH + totalColumnWidth,
            }}
          >
            <div className="virtual-grid__header" role="row">
              <div
                aria-label="Row number"
                className="virtual-grid__row-number virtual-grid__corner"
                onClick={() => dispatchSelection({ type: "all", bounds: selectionBounds })}
                role="columnheader"
              />
              {columnVirtualItems.map((virtualColumn) => {
                const column = visibleColumns[virtualColumn.index];
                const logicalColumn = visibleColumnIndexes[virtualColumn.index];
                const columnFilter = queryPlan?.filters.find(
                  (filter) => filter.columnId === column.id,
                );
                const sortIndex = queryPlan?.sort.findIndex((sort) => sort.columnId === column.id);
                const columnSort =
                  sortIndex !== undefined && sortIndex >= 0
                    ? queryPlan?.sort[sortIndex]
                    : undefined;
                return (
                  <div
                    aria-colindex={virtualColumn.index + 1}
                    aria-label={column.id}
                    className={`virtual-grid__column-header${queryEnabled ? " virtual-grid__column-header--query" : ""}${selection.kind === "column" && logicalColumn >= selection.rect.left && logicalColumn <= selection.rect.right ? " is-selected" : ""}`}
                    data-column-index={logicalColumn}
                    key={column.id}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          ".column-resizer, .query-column-actions",
                        )
                      )
                        return;
                      dispatchSelection({
                        type: "column",
                        column: logicalColumn,
                        bounds: selectionBounds,
                      });
                      gridRef.current?.focus();
                    }}
                    role="columnheader"
                    style={{
                      left: GRID_ROW_NUMBER_WIDTH + virtualColumn.start,
                      width: column.getSize(),
                    }}
                    title={column.id}
                  >
                    <span>{column.id}</span>
                    {queryEnabled && queryPlan && onQueryPlanChange && (
                      <div className="query-column-actions">
                        <button
                          aria-label={`Filter ${column.id}`}
                          aria-pressed={Boolean(columnFilter)}
                          className={columnFilter ? "is-active" : undefined}
                          onClick={(event) => {
                            event.stopPropagation();
                            const trigger = event.currentTarget;
                            const rect = trigger.getBoundingClientRect();
                            filterTriggerRef.current = trigger;
                            onOpenDistinctValues?.(column.id);
                            setFilterPopover((current) =>
                              current?.columnId === column.id
                                ? null
                                : { columnId: column.id, left: rect.left, top: rect.bottom + 4 },
                            );
                          }}
                          title={`Filter ${column.id}`}
                          type="button"
                        >
                          <Filter aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`Sort ${column.id}: ${
                            columnSort
                              ? `${columnSort.direction}, priority ${(sortIndex ?? 0) + 1}`
                              : "not sorted"
                          }`}
                          aria-pressed={Boolean(columnSort)}
                          className={columnSort ? "is-active" : undefined}
                          onClick={(event) => {
                            event.stopPropagation();
                            onQueryPlanChange(toggleSort(queryPlan, column.id, event.shiftKey));
                          }}
                          title={`Sort ${column.id}${columnSort ? ` (${columnSort.direction})` : ""}`}
                          type="button"
                        >
                          {columnSort?.direction === "ascending" ? (
                            <ArrowUp aria-hidden="true" />
                          ) : columnSort?.direction === "descending" ? (
                            <ArrowDown aria-hidden="true" />
                          ) : (
                            <ArrowUpDown aria-hidden="true" />
                          )}
                          {columnSort && sortIndex !== undefined && (
                            <span
                              aria-label={`Sort priority ${sortIndex + 1}`}
                              className="query-sort-priority"
                            >
                              {sortIndex + 1}
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                    <div
                      aria-label={`Resize ${column.id}`}
                      aria-orientation="vertical"
                      aria-valuemax={GRID_MAX_COLUMN_WIDTH}
                      aria-valuemin={GRID_MIN_COLUMN_WIDTH}
                      aria-valuenow={column.getSize()}
                      className="column-resizer"
                      onKeyDown={(event) => resizeColumnWithKeyboard(event, column.id)}
                      onPointerDown={(event) => resizeColumn(event, column.id, column.getSize())}
                      role="separator"
                      tabIndex={0}
                    />
                  </div>
                );
              })}
            </div>
            {virtualRows.map((virtualRow) => {
              const offset = pageOffsetFor(virtualRow.index, page.limit);
              const pageKey = projectedPageKey(offset, activeProjection);
              const mountedColumnNames = columnVirtualItems.map(
                (virtualColumn) => visibleColumns[virtualColumn.index].id,
              );
              const loaded =
                pages.get(pageKey) ??
                [...pages.values()].find(
                  (candidate) =>
                    candidate.offset === offset &&
                    mountedColumnNames.every((column) => candidate.columns.includes(column)),
                );
              const row = loaded?.rows[virtualRow.index - offset];
              const pending =
                !row && (loadingPageKeys.has(pageKey) || inFlight.current.has(pageKey));
              return (
                <div
                  aria-rowindex={virtualRow.index + 1}
                  className={`virtual-grid__row${virtualRow.index % 2 ? " virtual-grid__row--alternate" : ""}`}
                  data-row-index={virtualRow.index}
                  key={`${summary.sessionId}:${virtualRow.index}`}
                  role="row"
                  style={{
                    height: GRID_ROW_HEIGHT,
                    transform: `translateY(${GRID_HEADER_HEIGHT + virtualRow.start}px)`,
                  }}
                >
                  <div
                    className={`virtual-grid__row-number${selection.kind === "row" && virtualRow.index >= selection.rect.top && virtualRow.index <= selection.rect.bottom ? " is-selected" : ""}`}
                    onClick={() => {
                      dispatchSelection({
                        type: "row",
                        row: virtualRow.index,
                        bounds: selectionBounds,
                      });
                      gridRef.current?.focus();
                    }}
                    role="rowheader"
                  >
                    {virtualRow.index + 1}
                  </div>
                  {columnVirtualItems.map((virtualColumn) => {
                    const logicalColumn = visibleColumnIndexes[virtualColumn.index];
                    const column = visibleColumns[virtualColumn.index];
                    const projectedColumn = loaded?.columns.indexOf(column.id) ?? -1;
                    const value = projectedColumn >= 0 ? row?.[projectedColumn] : undefined;
                    const coordinate = { row: virtualRow.index, column: logicalColumn };
                    const selected = isSelected(selection, coordinate);
                    const active =
                      selection.active.row === coordinate.row &&
                      selection.active.column === coordinate.column;
                    return (
                      <div
                        aria-colindex={virtualColumn.index + 1}
                        aria-label={
                          value?.state === "invalid"
                            ? `invalid value${value.diagnostic?.message ? `: ${value.diagnostic.message}` : ""}`
                            : value?.kind === "null"
                              ? "null value"
                              : value?.kind === "string" && value.display === ""
                                ? "empty string"
                                : undefined
                        }
                        aria-selected={selected}
                        className={`${
                          value
                            ? cellClass(value)
                            : "virtual-grid__cell virtual-grid__cell--loading"
                        }${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
                        data-grid-column={logicalColumn}
                        data-grid-row={virtualRow.index}
                        key={`${virtualRow.index}:${column.id}`}
                        onClick={(event) => {
                          dispatchSelection({
                            type: "click",
                            coordinate,
                            shiftKey: event.shiftKey,
                            bounds: selectionBounds,
                          });
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => inspect(coordinate)}
                        onContextMenu={(event) => openContextMenu(event, coordinate)}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          dragging.current = true;
                          dispatchSelection({
                            type: "click",
                            coordinate,
                            shiftKey: event.shiftKey,
                            bounds: selectionBounds,
                          });
                          gridRef.current?.focus();
                        }}
                        onPointerEnter={() => {
                          if (!dragging.current) return;
                          dispatchSelection({ type: "drag", coordinate, bounds: selectionBounds });
                        }}
                        role="gridcell"
                        style={{
                          left: GRID_ROW_NUMBER_WIDTH + virtualColumn.start,
                          width: column.getSize(),
                        }}
                        title={value?.display ?? undefined}
                      >
                        {value ? (
                          value.state === "invalid" ? (
                            <>
                              <TriangleAlert aria-hidden="true" className="invalid-cell-icon" />
                              <span>{dataCellText(value)}</span>
                            </>
                          ) : (
                            dataCellText(value)
                          )
                        ) : pending ? (
                          <span aria-label="Loading row" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="paging-bar"
        aria-busy={isLoading || loadingPageKeys.size > 0}
        aria-label="Page navigation"
      >
        <button
          aria-label="Previous page"
          className="paging-button"
          disabled={activePage.offset === 0}
          onClick={() => {
            const offset = Math.max(0, activePage.offset - activePage.limit);
            onPageChange(offset);
          }}
          title="Previous page"
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <span className="page-status">{pageStatus(activePage)}</span>
        {(isLoading || loadingPageKeys.size > 0) && (
          <span className="page-loading" role="status">
            <LoaderCircle aria-hidden="true" />
            <span>Loading page</span>
          </span>
        )}
        <button
          aria-label="Next page"
          className="paging-button"
          disabled={!activePage.hasMore}
          onClick={() => {
            const offset = activePage.offset + activePage.limit;
            onPageChange(offset);
          }}
          title="Next page"
          type="button"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>

      {inspected && (
        <div
          aria-label="Full cell value"
          aria-modal="true"
          className="value-inspector"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setInspected(null);
              window.requestAnimationFrame(() => gridRef.current?.focus());
            }
          }}
          role="dialog"
        >
          <header>
            <div>
              <strong>Cell value</strong>
              <span>
                Row {inspected.coordinate.row + 1},{" "}
                {logicalColumnNames[inspected.coordinate.column]}
              </span>
            </div>
            <button
              aria-label="Close value inspector"
              autoFocus
              className="icon-button"
              onClick={() => {
                setInspected(null);
                window.requestAnimationFrame(() => gridRef.current?.focus());
              }}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <pre>{inspected.value.display === null ? "null" : inspected.value.display}</pre>
        </div>
      )}
      {contextMenu &&
        createPortal(
          <div
            aria-label="Cell actions"
            className="cell-context-menu"
            onKeyDown={(event) => {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Escape") {
                event.preventDefault();
                closeContextMenu();
              } else if (event.key === "Tab") {
                closeContextMenu(false);
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (Math.max(0, current) +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
                items[next]?.focus();
              }
            }}
            ref={contextMenuRef}
            role="menu"
            style={contextMenuPosition}
          >
            <button
              disabled={Boolean(copyProgress)}
              onClick={() => {
                closeContextMenu();
                void copySelection();
              }}
              role="menuitem"
              type="button"
            >
              <span>Copy</span>
              <kbd>Ctrl+C</kbd>
            </button>
            <button
              disabled={Boolean(copyProgress)}
              onClick={() => {
                closeContextMenu();
                void copySelection(true);
              }}
              role="menuitem"
              type="button"
            >
              <span>Copy with column headers</span>
            </button>
            <div className="cell-context-menu__separator" role="separator" />
            <button
              disabled={!valueAt(contextMenu.coordinate.row, contextMenu.coordinate.column)}
              onClick={() => {
                const target = contextMenu.coordinate;
                closeContextMenu();
                void copyContextCell(target);
              }}
              role="menuitem"
              type="button"
            >
              <span>Copy cell value</span>
            </button>
            <button
              disabled={!valueAt(contextMenu.coordinate.row, contextMenu.coordinate.column)}
              onClick={() => {
                inspect(contextMenu.coordinate);
                closeContextMenu(false);
              }}
              role="menuitem"
              type="button"
            >
              <span>View full value</span>
            </button>
          </div>,
          document.body,
        )}
      {filterPopover &&
        queryPlan &&
        onQueryPlanChange &&
        createPortal(
          <div
            className="column-filter-popover-host"
            ref={filterPopoverRef}
            style={filterPopoverPosition}
          >
            {(() => {
              const initialFilter =
                queryPlan.filters.find((filter) => filter.columnId === filterPopover.columnId) ??
                null;
              const scalarType =
                queryScalarTypes?.[filterPopover.columnId] ??
                inferQueryScalarType(summary, filterPopover.columnId);
              return (
                <ColumnFilterPopover
                  columnId={filterPopover.columnId}
                  columnLabel={filterPopover.columnId}
                  distinct={distinctValuesForColumn?.(filterPopover.columnId)}
                  initialFilter={initialFilter}
                  onApply={(filter) => {
                    const normalized = {
                      ...filter,
                      id: initialFilter?.id ?? `filter:${filterPopover.columnId}`,
                    };
                    onQueryPlanChange(upsertFilter(queryPlan, normalized));
                    closeFilterPopover();
                  }}
                  onCancel={() => closeFilterPopover()}
                  onClear={() => {
                    if (initialFilter) {
                      onQueryPlanChange(removeFilter(queryPlan, initialFilter.id));
                    }
                    closeFilterPopover();
                  }}
                  scalarType={scalarType}
                />
              );
            })()}
          </div>,
          document.body,
        )}
    </div>
  );
}
