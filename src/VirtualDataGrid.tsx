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
  RotateCcw,
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
import type {
  CancelDataBoundaryNavigationRequest,
  DataBoundaryDirection,
  DataPage,
  DataValue,
  DurationUnit,
  FileSummary,
  FindBoundaryRequest,
  FindBoundaryResponse,
  CopyOperationHistory,
  CopyOperationIdentity,
  CopyOperationStatus,
  CopyRepresentation,
  ReadPageRequest,
  StartCopyRequest,
} from "./backend";
import {
  applyGridKey,
  createSelection,
  isSelected,
  selectionReducer,
  type GridBounds,
  type GridCoordinate,
  type SelectionAction,
  type SelectionState,
} from "./gridSelection";
import { serializeCopyField } from "./copy/serializer";
import { COPY_PRESETS } from "./copy/presets";
import type { CopyOptions, CopyPreset } from "./copy/model";
import {
  compatiblePageFor,
  orderedProjectionForWindow,
  sameProjectedColumns,
} from "./gridProjection";
import { ColumnFilterPopover, type DistinctValuesState } from "./query/ColumnFilterPopover";
import {
  clearFilters,
  removeFilter,
  setSort,
  setSearch,
  toggleSort,
  upsertFilter,
  type QueryPlan,
  type QueryScalarType,
} from "./query/model";
import { columnReflowOffsets, moveId, normalizedIdOrder, restoreSourceOrder } from "./gridOrdering";
import { reorderAtInsertion, usePointerReorder } from "./components/usePointerReorder";
import { inferQueryScalarType } from "./query/scalarType";
import {
  QueryToolbar,
  type QuerySearchColumn,
  type QueryToolbarStatus,
} from "./query/QueryToolbar";
import { formatDataValue } from "./settings/displayFormat";
import {
  DEFAULT_COPY_LIMITS,
  DEFAULT_DISPLAY_FORMATS,
  type CopyLimits,
  type DisplayFormats,
} from "./settings/model";

const EXCEL_WORKSHEET_MAX_ROWS = 1_048_576;
import {
  GRID_COLUMN_OVERSCAN,
  GRID_BOTTOM_CLEARANCE,
  GRID_DEFAULT_COLUMN_WIDTH,
  GRID_HEADER_HEIGHT,
  GRID_MAX_COLUMN_WIDTH,
  GRID_MAX_SEGMENT_ROWS,
  GRID_MIN_COLUMN_WIDTH,
  GRID_PREFETCH_DISTANCE,
  GRID_ROW_HEIGHT,
  GRID_ROW_NUMBER_WIDTH,
  GRID_ROW_OVERSCAN,
  autoFitColumnWidth,
  segmentStartForRow,
} from "./gridSizing";
const GRID_SEGMENT_EDGE_ROWS = 2_000;
const MAX_PAGE_WINDOW = 3;
const MAX_CONCURRENT_REQUESTS = 2;
const COPY_STATUS_POLL_MS = 100;

function durationUnitForColumn(summary: FileSummary, columnId: string): DurationUnit | undefined {
  const logicalType = summary.columns
    .find((column) => column.name === columnId)
    ?.logicalType.toLocaleLowerCase();
  if (!logicalType?.includes("duration")) return undefined;
  if (logicalType.includes("nanosecond") || logicalType.includes("duration(ns")) return "ns";
  if (logicalType.includes("microsecond") || logicalType.includes("duration(us")) return "us";
  if (logicalType.includes("millisecond") || logicalType.includes("duration(ms")) return "ms";
  return "s";
}

function rawValueMetadata(value: DataValue): { unit?: string; timezone?: string } {
  if (value.unit || value.timezone) {
    return {
      ...(value.unit ? { unit: value.unit } : {}),
      ...(value.timezone ? { timezone: value.timezone } : {}),
    };
  }
  const match = /\[unit=([^,\]]+)(?:, timezone=([^\]]+))?\]$/.exec(value.rawDisplay ?? "");
  return match ? { unit: match[1], ...(match[2] ? { timezone: match[2] } : {}) } : {};
}

function copyValuePreview(value: DataValue, options: CopyOptions): string {
  try {
    return serializeCopyField(value, options);
  } catch {
    return value.display ?? "";
  }
}

export interface VirtualDataGridProps {
  active?: boolean;
  copyOptions?: CopyOptions;
  displayFormats?: DisplayFormats;
  copyLimits?: CopyLimits;
  copyPresetError?: string | null;
  copyPresetSaving?: boolean;
  distinctValuesForColumn?(columnId: string): DistinctValuesState | undefined;
  documentId: string;
  findDataBoundary?(request: FindBoundaryRequest): Promise<FindBoundaryResponse>;
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
  queryActive?: boolean;
  queryPlan?: QueryPlan;
  queryScalarTypes?: Readonly<Record<string, QueryScalarType>>;
  queryStatus?: QueryToolbarStatus;
  readPage(request: ReadPageRequest): Promise<DataPage>;
  readCellValue?(row: number, columnId: string): Promise<DataValue>;
  cancelDataBoundaryNavigation?(request: CancelDataBoundaryNavigationRequest): Promise<void>;
  startCopy(request: StartCopyRequest): Promise<CopyOperationStatus>;
  getCopyStatus(request: CopyOperationIdentity): Promise<CopyOperationStatus>;
  cancelCopyOperation(request: CopyOperationIdentity): Promise<CopyOperationStatus>;
  getCopyHistory(documentId: string, sessionId: string): Promise<CopyOperationHistory>;
  queryId?: string;
  resultKey?: string;
  summary: FileSummary;
  writeClipboardText?: (text: string) => Promise<void>;
}

function projectedPageKey(offset: number, columns: readonly string[]): string {
  return `${offset}:${JSON.stringify(columns)}`;
}

type CopyRequestSnapshot = Omit<StartCopyRequest, "operationId">;

function copyIsActive(status: CopyOperationStatus | null): boolean {
  return Boolean(
    status && ["queued", "running", "cancelling", "committing"].includes(status.state),
  );
}

function copyOptionsSnapshot(
  options: CopyOptions,
  includeHeaders: boolean,
  representation: CopyRepresentation,
): StartCopyRequest["options"] {
  return {
    delimiter: options.delimiter,
    includeHeaders,
    quoteMode: options.quoteMode,
    quoteCharacter: options.quoteCharacter,
    escapeMode: options.escapeMode,
    lineEnding: options.lineEnding,
    nullRepresentation: options.nullRepresentation,
    emptyStringRepresentation: options.emptyStringRepresentation,
    booleanRepresentation: options.booleanRepresentation,
    dateTimeRepresentation: { ...options.dateTimeRepresentation },
    representation,
  };
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

function dataValueIsEmpty(value: DataValue): boolean {
  if (value.state === "invalid") return false;
  if (value.state === "null" || value.state === "empty") return true;
  if (value.state === "valid") return false;
  return value.display === null || value.display === "";
}

type ArrowDirection = readonly [rowDelta: -1 | 0 | 1, columnDelta: -1 | 0 | 1];

function arrowDirection(key: string): ArrowDirection | null {
  if (key === "ArrowUp") return [-1, 0];
  if (key === "ArrowDown") return [1, 0];
  if (key === "ArrowLeft") return [0, -1];
  if (key === "ArrowRight") return [0, 1];
  return null;
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
  copyLimits = DEFAULT_COPY_LIMITS,
  copyOptions = COPY_PRESETS.excel,
  displayFormats = DEFAULT_DISPLAY_FORMATS,
  copyPresetError = null,
  copyPresetSaving = false,
  cancelDataBoundaryNavigation = async () => undefined,
  startCopy,
  getCopyStatus,
  cancelCopyOperation,
  getCopyHistory,
  distinctValuesForColumn,
  documentId,
  findDataBoundary = async (request) => ({
    ...request,
    targetRow: request.row,
    targetColumnId: request.columnId,
    resolvedRowCount: null,
  }),
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
  queryActive = false,
  queryId,
  queryPlan,
  queryScalarTypes,
  queryStatus,
  readPage,
  readCellValue,
  resultKey,
  summary,
  writeClipboardText = defaultWriteClipboardText,
}: VirtualDataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const previousActive = useRef(active);
  const resumedVisibleOffset = useRef<number | null | undefined>(undefined);
  activeRef.current = active;
  const latestCancelBoundaryNavigation = useRef(cancelDataBoundaryNavigation);
  latestCancelBoundaryNavigation.current = cancelDataBoundaryNavigation;
  const latestPage = useRef(page);
  latestPage.current = page;
  const activeResultKey = resultKey ?? summary.sessionId;
  const latestResultKey = useRef(activeResultKey);
  latestResultKey.current = activeResultKey;
  const generation = useRef(0);
  const copyGeneration = useRef(0);
  const cellCopyGeneration = useRef(0);
  const copySequence = useRef(0);
  const copyPollTimer = useRef<number | null>(null);
  const inspectorGeneration = useRef(0);
  const mounted = useRef(true);
  const dragging = useRef(false);
  const navigationGeneration = useRef(0);
  const boundaryQueueEpoch = useRef(0);
  const boundaryNavigationQueue = useRef<Promise<void>>(Promise.resolve());
  const activeBoundaryRequest = useRef<FindBoundaryRequest | null>(null);
  const horizontalGeneration = useRef(0);
  const columnDragActiveRef = useRef(false);
  const previousColumnDragActive = useRef(false);
  const inFlight = useRef(new Map<string, Promise<DataPage>>());
  const pendingLogicalScroll = useRef<number | null>(null);
  const segmentRecentering = useRef(false);
  const skipAdjacentPrefetchOnce = useRef(false);
  const [pages, setPages] = useState<Map<string, DataPage>>(
    () => new Map([[projectedPageKey(page.offset, page.columns), page]]),
  );
  const [activeOffset, setActiveOffset] = useState(page.offset);
  const [activeProjection, setActiveProjection] = useState<string[]>(() => [...page.columns]);
  const [loadingPageKeys, setLoadingPageKeys] = useState<Set<string>>(new Set());
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [resolvedRowCountHint, setResolvedRowCountHint] = useState<number | null>(null);
  const [segmentStart, setSegmentStart] = useState(() =>
    segmentStartForRow(
      page.offset,
      summary.rowCount ?? Math.max(1, page.offset + page.rows.length),
    ),
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserRef = useRef<HTMLDivElement>(null);
  const chooserTriggerRef = useRef<HTMLButtonElement>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const copyMenuPanelRef = useRef<HTMLDivElement>(null);
  const copyMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [copyHistoryOpen, setCopyHistoryOpen] = useState(false);
  const copyHistoryRef = useRef<HTMLDivElement>(null);
  const copyHistoryTriggerRef = useRef<HTMLButtonElement>(null);
  const [searchInput, setSearchInput] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const sourceLogicalColumnNames = useMemo(
    () => logicalColumnNamesProp ?? summary.columns.map((column) => column.name),
    [logicalColumnNamesProp, summary.columns],
  );
  const sourceLogicalColumnsKey = JSON.stringify(sourceLogicalColumnNames);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => [...sourceLogicalColumnNames]);
  const logicalColumnNames = useMemo(
    () => normalizedIdOrder(sourceLogicalColumnNames, columnOrder),
    [columnOrder, sourceLogicalColumnNames],
  );
  const logicalColumnsKey = JSON.stringify(logicalColumnNames);
  const previousSessionId = useRef(summary.sessionId);
  const previousLogicalColumns = useRef<string[]>([...logicalColumnNames]);
  const initialBounds = {
    rowCount: Math.max(1, summary.rowCount ?? page.offset + page.rows.length),
    columnCount: Math.max(1, logicalColumnNames.length),
    pageStep: 10,
  };
  const [selection, reactDispatchSelection] = useReducer(
    selectionReducer,
    createSelection(activeResultKey, initialBounds),
  );
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  function dispatchSelection(action: SelectionAction): SelectionState {
    const next = selectionReducer(latestSelection.current, action);
    latestSelection.current = next;
    reactDispatchSelection(action);
    return next;
  }
  const [copyStatus, setCopyStatus] = useState<CopyOperationStatus | null>(null);
  const [copyHistory, setCopyHistory] = useState<CopyOperationHistory>({
    current: null,
    previous: [],
  });
  const [lastCopySnapshot, setLastCopySnapshot] = useState<CopyRequestSnapshot | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{
    coordinate: GridCoordinate;
    value: DataValue;
  } | null>(null);
  const displayedInspected = useMemo(
    () =>
      inspected ? { ...inspected, value: formatDataValue(inspected.value, displayFormats) } : null,
    [displayFormats, inspected],
  );
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
  const filterTriggerColumnId = useRef<string | null>(null);
  const [filterFocusTarget, setFilterFocusTarget] = useState<string | null>(null);
  const queryEnabled = Boolean(queryPlan && onQueryPlanChange);

  useEffect(() => {
    setColumnOrder((current) => {
      const next = normalizedIdOrder(sourceLogicalColumnNames, current);
      return sameProjectedColumns(current, next) ? current : next;
    });
  }, [sourceLogicalColumnsKey, sourceLogicalColumnNames]);

  const closeFilterPopover = useCallback(
    (restoreFocus = true) => {
      setFilterPopover(null);
      if (restoreFocus) {
        setFilterFocusTarget(filterPopover?.columnId ?? filterTriggerColumnId.current);
      }
    },
    [filterPopover],
  );

  useLayoutEffect(() => {
    if (!filterPopover && filterFocusTarget) filterTriggerRef.current?.focus();
  }, [filterFocusTarget, filterPopover]);

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
    const boundaryRequest = activeBoundaryRequest;
    const cancelBoundary = latestCancelBoundaryNavigation;
    return () => {
      mounted.current = false;
      generation.current += 1;
      copyGeneration.current += 1;
      cellCopyGeneration.current += 1;
      if (copyPollTimer.current !== null) window.clearTimeout(copyPollTimer.current);
      inspectorGeneration.current += 1;
      navigationGeneration.current += 1;
      boundaryQueueEpoch.current += 1;
      const pendingBoundary = boundaryRequest.current;
      boundaryRequest.current = null;
      if (pendingBoundary) {
        void cancelBoundary.current({
          navigationId: pendingBoundary.navigationId,
          documentId: pendingBoundary.documentId,
          sessionId: pendingBoundary.sessionId,
          ...(pendingBoundary.queryId ? { queryId: pendingBoundary.queryId } : {}),
        });
      }
      pendingRequests.clear();
    };
  }, []);

  useEffect(() => {
    inspectorGeneration.current += 1;
  }, [displayFormats]);

  useEffect(() => {
    const timer = window.setTimeout(() => setColumnSearch(searchInput), 100);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const generationId = ++copyGeneration.current;
    if (copyPollTimer.current !== null) window.clearTimeout(copyPollTimer.current);
    setCopyStatus(null);
    setCopyMessage(null);
    setLastCopySnapshot(null);
    setCopyHistory({ current: null, previous: [] });
    if (!getCopyHistory || !documentId) return;
    void getCopyHistory(documentId, summary.sessionId)
      .then((history) => {
        if (mounted.current && generationId === copyGeneration.current) setCopyHistory(history);
      })
      .catch((error) => {
        if (mounted.current && generationId === copyGeneration.current) {
          setCopyMessage(error instanceof Error ? error.message : "Copy history is unavailable.");
        }
      });
  }, [documentId, getCopyHistory, summary.sessionId]);

  useEffect(() => {
    const firstPage = latestPage.current;
    const previousSelection = latestSelection.current;
    const previousColumns = previousLogicalColumns.current;
    const previousActiveColumnId = previousColumns[previousSelection.active.column];
    const preserveLogicalCell = previousSessionId.current === summary.sessionId;
    const nextBounds = {
      rowCount: Math.max(1, firstPage.totalRows ?? firstPage.rows.length),
      columnCount: Math.max(1, logicalColumnNames.length),
      pageStep: 10,
    };
    const preservedCoordinate = {
      row: Math.max(0, Math.min(nextBounds.rowCount - 1, previousSelection.active.row)),
      column: Math.max(0, logicalColumnNames.indexOf(previousActiveColumnId)),
    };
    generation.current += 1;
    horizontalGeneration.current += 1;
    navigationGeneration.current += 1;
    boundaryQueueEpoch.current += 1;
    inFlight.current.clear();
    const pendingBoundary = activeBoundaryRequest.current;
    activeBoundaryRequest.current = null;
    if (pendingBoundary) {
      void latestCancelBoundaryNavigation.current({
        navigationId: pendingBoundary.navigationId,
        documentId: pendingBoundary.documentId,
        sessionId: pendingBoundary.sessionId,
        ...(pendingBoundary.queryId ? { queryId: pendingBoundary.queryId } : {}),
      });
    }
    setPages(new Map([[projectedPageKey(firstPage.offset, firstPage.columns), firstPage]]));
    setActiveOffset(firstPage.offset);
    setActiveProjection([...firstPage.columns]);
    setLoadingPageKeys(new Set());
    if (!preserveLogicalCell) setColumnVisibility({});
    setResolvedRowCountHint(null);
    skipAdjacentPrefetchOnce.current = false;
    inspectorGeneration.current += 1;
    setInspected(null);
    dispatchSelection({
      type: "reset",
      sessionId: activeResultKey,
      bounds: nextBounds,
    });
    if (preserveLogicalCell) {
      dispatchSelection({ type: "click", coordinate: preservedCoordinate, bounds: nextBounds });
      pendingLogicalScroll.current = preservedCoordinate.row;
      setSegmentStart(segmentStartForRow(preservedCoordinate.row, nextBounds.rowCount));
    } else if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
    previousSessionId.current = summary.sessionId;
    previousLogicalColumns.current = [...logicalColumnNames];
    if (activeRef.current) {
      window.requestAnimationFrame(() => {
        const grid = gridRef.current;
        if (grid && (document.activeElement === document.body || document.activeElement === grid)) {
          grid.focus();
        }
      });
    }
    // Column order changes remap selection separately and must not reset the result cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeResultKey, sourceLogicalColumnsKey, logicalColumnNames.length, summary.sessionId]);

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
    const close = (event: Event) => {
      if (event.target instanceof Node && copyMenuRef.current?.contains(event.target)) return;
      setCopyMenuOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setCopyMenuOpen(false);
      copyMenuTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [copyMenuOpen]);

  useEffect(() => {
    if (!chooserOpen) return;
    const close = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (chooserRef.current?.contains(target) || chooserTriggerRef.current?.contains(target))
      )
        return;
      setChooserOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setChooserOpen(false);
      chooserTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [chooserOpen]);

  useEffect(() => {
    if (!copyHistoryOpen) return;
    const close = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && copyHistoryRef.current?.contains(target)) return;
      setCopyHistoryOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setCopyHistoryOpen(false);
      copyHistoryTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [copyHistoryOpen]);

  useEffect(() => {
    setCopyHistoryOpen(false);
  }, [activeResultKey, active]);

  useEffect(() => {
    if (copyStatus?.state !== "complete") return;
    const timer = window.setTimeout(() => {
      setCopyStatus((current) =>
        current?.operationId === copyStatus.operationId ? null : current,
      );
      setCopyMessage((current) => (current?.includes(copyStatus.operationId) ? null : current));
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

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
    const total = queryActive
      ? (page.totalRows ?? page.offset + page.rows.length)
      : (summary.rowCount ?? page.offset + page.rows.length);
    const nextSegment = segmentStartForRow(page.offset, Math.max(1, total));
    pendingLogicalScroll.current = page.offset;
    setSegmentStart(nextSegment);
    window.requestAnimationFrame(() => {
      if (!scrollRef.current || pendingLogicalScroll.current !== page.offset) return;
      scrollRef.current.scrollTop = Math.max(0, page.offset - nextSegment) * GRID_ROW_HEIGHT;
      pendingLogicalScroll.current = null;
      scrollRef.current.dispatchEvent(new Event("scroll"));
    });
  }, [page, queryActive, summary.rowCount]);

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

  const knownCount = queryActive ? page.totalRows : summary.rowCount;
  const loadedEnd = Math.max(
    ...[...pages.values()].map((loaded) => loaded.offset + loaded.rows.length),
  );
  const finalLoadedPage = [...pages.values()].find((loaded) => !loaded.hasMore);
  const loadedRowCount = finalLoadedPage ? loadedEnd : loadedEnd + 1;
  const rowCount = knownCount ?? Math.max(resolvedRowCountHint ?? 0, loadedRowCount);
  const selectedExcelRows =
    selection.rect.bottom - selection.rect.top + 1 + (copyOptions.includeHeaders ? 1 : 0);
  const excelRowLimitExceeded =
    copyOptions.preset === "excel" && selectedExcelRows > EXCEL_WORKSHEET_MAX_ROWS;
  const maxSegmentStart = Math.max(0, rowCount - GRID_MAX_SEGMENT_ROWS);
  const boundedSegmentStart = Math.min(segmentStart, maxSegmentStart);
  const segmentRowCount = Math.max(
    0,
    Math.min(GRID_MAX_SEGMENT_ROWS, rowCount - boundedSegmentStart),
  );
  const pageStep = Math.max(
    1,
    Math.floor(((scrollRef.current?.clientHeight ?? 420) - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT),
  );
  const selectionBounds: GridBounds = useMemo(
    () => ({ rowCount, columnCount: logicalColumnNames.length, pageStep }),
    [logicalColumnNames.length, pageStep, rowCount],
  );

  function applyColumnOrder(nextOrder: readonly string[]): void {
    const next = normalizedIdOrder(sourceLogicalColumnNames, nextOrder);
    if (next.every((id, index) => id === logicalColumnNames[index])) return;
    dispatchSelection({
      type: "remapColumns",
      previousColumnIds: logicalColumnNames,
      nextColumnIds: next,
      bounds: { ...selectionBounds, columnCount: next.length },
    });
    previousLogicalColumns.current = [...next];
    setColumnOrder(next);
  }

  function moveColumn(columnId: string, direction: -1 | 1): void {
    applyColumnOrder(moveId(logicalColumnNames, columnId, direction));
  }

  const columnReorder = usePointerReorder({
    ids: logicalColumnNames,
    containerRef: scrollRef,
    orientation: "horizontal",
    onCommit: applyColumnOrder,
  });
  const columnDragActive = Boolean(columnReorder.state.movingId);
  columnDragActiveRef.current = columnDragActive;
  const visibleColumnIds = visibleColumns.map((column) => column.id);
  const columnWidths = Object.fromEntries(
    visibleColumns.map((column) => [column.id, column.getSize()]),
  );
  const previewVisibleOrder =
    columnReorder.state.movingId &&
    columnReorder.state.targetId &&
    visibleColumnIds.includes(columnReorder.state.movingId) &&
    visibleColumnIds.includes(columnReorder.state.targetId)
      ? reorderAtInsertion(
          visibleColumnIds,
          columnReorder.state.movingId,
          columnReorder.state.targetId,
          columnReorder.state.side ?? "before",
        )
      : visibleColumnIds;
  const columnPreviewOffsets = columnReflowOffsets(
    visibleColumnIds,
    previewVisibleOrder,
    columnWidths,
  );
  const restoredColumnOrder = restoreSourceOrder(sourceLogicalColumnNames, logicalColumnNames);
  const isSourceColumnOrder = restoredColumnOrder.every(
    (id, index) => id === logicalColumnNames[index],
  );

  useEffect(() => {
    const grid = scrollRef.current;
    if (!grid || !columnReorder.state.movingId) return;
    const lockVerticalWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) event.preventDefault();
    };
    grid.addEventListener("wheel", lockVerticalWheel, { passive: false });
    return () => grid.removeEventListener("wheel", lockVerticalWheel);
  }, [columnReorder.state.movingId]);

  useEffect(() => {
    if (columnDragActive && !previousColumnDragActive.current) {
      horizontalGeneration.current += 1;
      inFlight.current.clear();
      setLoadingPageKeys(new Set());
    }
    previousColumnDragActive.current = columnDragActive;
  }, [columnDragActive]);

  const rowVirtualizer = useVirtualizer({
    count: segmentRowCount,
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

  useEffect(() => {
    const resumedFromInactive = active && !previousActive.current;
    previousActive.current = active;
    if (active) {
      if (resumedFromInactive) resumedVisibleOffset.current = null;
      window.requestAnimationFrame(() => {
        rowVirtualizer.measure();
        columnVirtualizer.measure();
      });
      return;
    }
    cellCopyGeneration.current += 1;
    inspectorGeneration.current += 1;
    setInspected(null);
    setChooserOpen(false);
    setCopyMenuOpen(false);
    setCopyHistoryOpen(false);
    generation.current += 1;
    horizontalGeneration.current += 1;
    navigationGeneration.current += 1;
    inFlight.current.clear();
    setLoadingPageKeys(new Set());
  }, [active, columnVirtualizer, rowVirtualizer]);

  useEffect(() => {
    if (segmentStart !== boundedSegmentStart) setSegmentStart(boundedSegmentStart);
  }, [boundedSegmentStart, segmentStart]);

  useLayoutEffect(() => {
    const target = pendingLogicalScroll.current;
    const grid = scrollRef.current;
    if (
      target === null ||
      !grid ||
      target < boundedSegmentStart ||
      target >= boundedSegmentStart + segmentRowCount
    )
      return;
    grid.scrollTop = Math.max(0, target - boundedSegmentStart) * GRID_ROW_HEIGHT;
    pendingLogicalScroll.current = null;
    grid.dispatchEvent(new Event("scroll"));
  }, [boundedSegmentStart, segmentRowCount]);

  const scrollToCoordinate = useCallback(
    (coordinate: GridCoordinate, resolvedRowCount?: number) => {
      const grid = scrollRef.current;
      const movingDown = coordinate.row > selection.active.row;
      const movingRight = coordinate.column > selection.active.column;
      const effectiveRowCount = Math.max(rowCount, resolvedRowCount ?? 0, coordinate.row + 1);
      if (
        coordinate.row < boundedSegmentStart ||
        coordinate.row >= boundedSegmentStart + segmentRowCount
      ) {
        pendingLogicalScroll.current = coordinate.row;
        setSegmentStart(segmentStartForRow(coordinate.row, effectiveRowCount));
      } else {
        rowVirtualizer.scrollToIndex(coordinate.row - boundedSegmentStart, { align: "auto" });
      }
      const visibleIndex = visibleColumnIndexes.indexOf(coordinate.column);
      if (visibleIndex >= 0) columnVirtualizer.scrollToIndex(visibleIndex, { align: "auto" });
      if (grid && movingDown) {
        grid.scrollTop = Math.min(
          grid.scrollTop + GRID_HEADER_HEIGHT,
          grid.scrollHeight - grid.clientHeight,
        );
      }
      if (grid && movingRight) {
        grid.scrollLeft = Math.min(
          grid.scrollLeft + GRID_ROW_NUMBER_WIDTH,
          grid.scrollWidth - grid.clientWidth,
        );
      }
    },
    [
      columnVirtualizer,
      boundedSegmentStart,
      rowVirtualizer,
      rowCount,
      segmentRowCount,
      selection.active.column,
      selection.active.row,
      visibleColumnIndexes,
    ],
  );

  useEffect(() => columnVirtualizer.measure(), [columnSizing, columnVirtualizer]);

  const activeRow = selection.active.row;
  const activeColumn = selection.active.column;
  useLayoutEffect(() => {
    let frame = 0;
    let attempts = 0;
    const inspect = () => {
      attempts += 1;
      const grid = gridRef.current;
      const cell = grid?.querySelector<HTMLElement>(
        `[data-grid-row="${activeRow}"][data-grid-column="${activeColumn}"]`,
      );
      let adjusted = false;
      if (grid && cell) {
        const gridRect = grid.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        if (gridRect.width > 0 && gridRect.height > 0 && cellRect.width > 0) {
          const visibleTop = gridRect.top + GRID_HEADER_HEIGHT;
          const visibleBottom = gridRect.top + grid.clientHeight - GRID_BOTTOM_CLEARANCE;
          const visibleLeft = gridRect.left + GRID_ROW_NUMBER_WIDTH;
          const visibleRight = gridRect.left + grid.clientWidth;
          if (cellRect.top < visibleTop) {
            grid.scrollTop -= visibleTop - cellRect.top;
            adjusted = true;
          } else if (cellRect.bottom > visibleBottom) {
            grid.scrollTop += cellRect.bottom - visibleBottom;
            adjusted = true;
          }
          if (cellRect.left < visibleLeft) {
            grid.scrollLeft -= visibleLeft - cellRect.left;
            adjusted = true;
          } else if (cellRect.right > visibleRight) {
            grid.scrollLeft += cellRect.right - visibleRight;
            adjusted = true;
          }
        }
      }
      if (attempts < 30 && (!cell || adjusted)) frame = window.requestAnimationFrame(inspect);
    };
    frame = window.requestAnimationFrame(inspect);
    return () => window.cancelAnimationFrame(frame);
  }, [activeColumn, activeRow]);

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
      if (
        !activeRef.current ||
        columnDragActiveRef.current ||
        offset < 0 ||
        activeProjection.length === 0
      )
        return Promise.resolve(null);
      const key = projectedPageKey(offset, activeProjection);
      if (pages.has(key)) return Promise.resolve(pages.get(key) ?? null);
      const compatible = compatiblePageFor(pages.values(), page, offset, activeProjection);
      if (compatible) return Promise.resolve(compatible);
      const existing = inFlight.current.get(key);
      if (existing) return existing;
      if (inFlight.current.size >= MAX_CONCURRENT_REQUESTS) {
        if (!foreground) return Promise.resolve(null);
        generation.current += 1;
        inFlight.current.clear();
        setLoadingPageKeys(new Set());
      }
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
              columnDragActiveRef.current ||
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
    [activeProjection, onReadError, page, pages, readPage, summary.sessionId, trimPageWindow],
  );

  const virtualRows = rowVirtualizer
    .getVirtualItems()
    .map((virtualRow) => ({ ...virtualRow, index: virtualRow.index + boundedSegmentStart }));
  const columnVirtualItems = columnVirtualizer.getVirtualItems();
  const firstVisibleRow = virtualRows[0]?.index ?? 0;
  const lastVisibleRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  const mountedLogicalOrdinals = columnVirtualItems.map(
    (virtualColumn) => visibleColumnIndexes[virtualColumn.index],
  );
  const mountedLogicalOrdinalsKey = mountedLogicalOrdinals.join(",");
  const desiredProjection = orderedProjectionForWindow(
    logicalColumnNames,
    mountedLogicalOrdinals,
    activeProjection,
  );
  const desiredProjectionKey = JSON.stringify(desiredProjection);
  const activeProjectionSettled = sameProjectedColumns(activeProjection, desiredProjection);

  useEffect(() => {
    const grid = scrollRef.current;
    if (!grid || rowCount <= GRID_MAX_SEGMENT_ROWS) return;
    const onScroll = () => {
      if (segmentRecentering.current) return;
      const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight);
      const localTopRow = Math.floor(grid.scrollTop / GRID_ROW_HEIGHT);
      const logicalTopRow = Math.min(rowCount - 1, boundedSegmentStart + localTopRow);
      let nextStart: number | null = null;
      let targetRow = logicalTopRow;
      let alignToEnd = false;

      if (grid.scrollTop >= maxScrollTop - 1 && boundedSegmentStart < maxSegmentStart) {
        nextStart = maxSegmentStart;
        targetRow = rowCount - 1;
        alignToEnd = true;
      } else if (grid.scrollTop <= 1 && boundedSegmentStart > 0) {
        nextStart = 0;
        targetRow = 0;
      } else if (
        localTopRow >= segmentRowCount - GRID_SEGMENT_EDGE_ROWS &&
        boundedSegmentStart < maxSegmentStart
      ) {
        nextStart = Math.min(
          maxSegmentStart,
          Math.max(0, logicalTopRow - Math.floor(GRID_MAX_SEGMENT_ROWS / 2)),
        );
      } else if (localTopRow <= GRID_SEGMENT_EDGE_ROWS && boundedSegmentStart > 0) {
        nextStart = Math.max(
          0,
          Math.min(maxSegmentStart, logicalTopRow - Math.floor(GRID_MAX_SEGMENT_ROWS / 2)),
        );
      }

      if (nextStart === null || nextStart === boundedSegmentStart) return;
      segmentRecentering.current = true;
      setSegmentStart(nextStart);
      window.requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = alignToEnd
            ? scrollRef.current.scrollHeight
            : Math.max(0, targetRow - nextStart!) * GRID_ROW_HEIGHT;
          scrollRef.current.dispatchEvent(new Event("scroll"));
        }
        segmentRecentering.current = false;
      });
    };
    grid.addEventListener("scroll", onScroll, { passive: true });
    return () => grid.removeEventListener("scroll", onScroll);
  }, [boundedSegmentStart, maxSegmentStart, rowCount, segmentRowCount]);

  useEffect(() => {
    if (!active || columnDragActive || activeProjectionSettled) return;
    setActiveProjection(desiredProjection);
    // The key captures the virtual range without making this effect depend on a fresh array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    activeProjectionSettled,
    columnDragActive,
    desiredProjectionKey,
    logicalColumnsKey,
    mountedLogicalOrdinalsKey,
  ]);

  const activeProjectionKey = JSON.stringify(activeProjection);
  useEffect(() => {
    horizontalGeneration.current += 1;
    inFlight.current.clear();
    setLoadingPageKeys(new Set());
  }, [activeProjectionKey]);

  useEffect(() => {
    if (!active || columnDragActive || !activeProjectionSettled || rowCount === 0) return;
    const scrollRow = Math.min(
      rowCount - 1,
      boundedSegmentStart +
        Math.floor(
          (scrollRef.current?.scrollTop ??
            (firstVisibleRow - boundedSegmentStart) * GRID_ROW_HEIGHT) / GRID_ROW_HEIGHT,
        ),
    );
    const visibleOffset = pageOffsetFor(scrollRow, page.limit);
    const visibleKey = projectedPageKey(visibleOffset, activeProjection);
    const compatible = compatiblePageFor(pages.values(), page, visibleOffset, activeProjection);
    if (!pages.has(visibleKey) && !compatible) {
      void requestPage(visibleOffset, true);
    } else setActiveOffset(visibleOffset);

    const current = pages.get(visibleKey) ?? compatible;
    if (!current) return;
    if (resumedVisibleOffset.current !== undefined) {
      if (resumedVisibleOffset.current === null) resumedVisibleOffset.current = visibleOffset;
      if (resumedVisibleOffset.current === visibleOffset) return;
      resumedVisibleOffset.current = undefined;
    }
    if (skipAdjacentPrefetchOnce.current) {
      skipAdjacentPrefetchOnce.current = false;
      return;
    }
    const distanceToEnd = current.offset + current.rows.length - 1 - lastVisibleRow;
    if (current.hasMore && distanceToEnd <= GRID_PREFETCH_DISTANCE) {
      void requestPage(current.offset + page.limit, false);
    }
    const distanceToStart = firstVisibleRow - current.offset;
    if (current.offset > 0 && distanceToStart <= GRID_PREFETCH_DISTANCE) {
      void requestPage(Math.max(0, current.offset - page.limit), false);
    }
  }, [
    activeProjection,
    activeProjectionSettled,
    active,
    boundedSegmentStart,
    columnDragActive,
    firstVisibleRow,
    lastVisibleRow,
    page,
    pages,
    requestPage,
    rowCount,
  ]);

  const activePage =
    pages.get(projectedPageKey(activeOffset, activeProjection)) ??
    compatiblePageFor(pages.values(), page, activeOffset, activeProjection) ??
    page;

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

  function rawValueAt(rowIndex: number, columnIndex: number): DataValue | null {
    const offset = pageOffsetFor(rowIndex, page.limit);
    const columnName = logicalColumnNames[columnIndex];
    if (!columnName) return null;
    const loaded = compatiblePageFor(pages.values(), page, offset, [columnName]);
    if (!loaded) return null;
    const projectedIndex = loaded.columns.indexOf(columnName);
    return loaded.rows[rowIndex - offset]?.[projectedIndex] ?? null;
  }

  function valueAt(rowIndex: number, columnIndex: number): DataValue | null {
    const value = rawValueAt(rowIndex, columnIndex);
    return value ? formatDataValue(value, displayFormats) : null;
  }

  function inspect(coordinate: GridCoordinate) {
    const value = rawValueAt(coordinate.row, coordinate.column);
    if (!value) return;
    const requestGeneration = ++inspectorGeneration.current;
    setInspected({ coordinate, value });
    const columnId = logicalColumnNames[coordinate.column];
    const resultIdentity = activeResultKey;
    if (readCellValue && columnId) {
      void readCellValue(coordinate.row, columnId)
        .then((fullValue) => {
          if (
            mounted.current &&
            inspectorGeneration.current === requestGeneration &&
            latestResultKey.current === resultIdentity
          ) {
            setInspected({ coordinate, value: fullValue });
          }
        })
        .catch((error) => {
          if (
            mounted.current &&
            inspectorGeneration.current === requestGeneration &&
            latestResultKey.current === resultIdentity
          ) {
            setCopyMessage(
              error instanceof Error ? error.message : "The full value is unavailable.",
            );
          }
        });
    }
  }

  function closeInspector(): void {
    inspectorGeneration.current += 1;
    setInspected(null);
    window.requestAnimationFrame(() => gridRef.current?.focus());
  }

  function copyStatusMessage(status: CopyOperationStatus): string {
    const operation = `Copy ${status.operationId} (${status.startedAt})`;
    if (status.state === "complete") {
      return `${operation} completed: ${status.progress.rowsProcessed.toLocaleString()} rows copied.`;
    }
    if (status.state === "failed" && status.failure) {
      return `${operation} failed during ${status.stage} (${status.failure.reason}): ${status.failure.message}`;
    }
    if (status.state === "cancelled") {
      return `${operation} cancelled${status.failure ? ` (${status.failure.reason}): ${status.failure.message}` : "."}`;
    }
    return `${operation}: ${status.state} / ${status.stage}, ${status.progress.rowsProcessed.toLocaleString()} / ${status.progress.totalRows.toLocaleString()} rows.`;
  }

  async function refreshCopyHistory(expectedGeneration = copyGeneration.current): Promise<void> {
    try {
      const history = await getCopyHistory(documentId, summary.sessionId);
      if (mounted.current && expectedGeneration === copyGeneration.current) setCopyHistory(history);
    } catch (error) {
      if (mounted.current && expectedGeneration === copyGeneration.current) {
        setCopyMessage(error instanceof Error ? error.message : "Copy history is unavailable.");
      }
    }
  }

  function acceptCopyStatus(
    status: CopyOperationStatus,
    generationId: number,
    snapshot: CopyRequestSnapshot,
  ): void {
    if (!mounted.current || generationId !== copyGeneration.current) return;
    setCopyStatus(status);
    setCopyHistory((current) => ({ ...current, current: status }));
    setCopyMessage(copyStatusMessage(status));
    if (!copyIsActive(status)) {
      void refreshCopyHistory(generationId);
      return;
    }
    copyPollTimer.current = window.setTimeout(() => {
      if (generationId !== copyGeneration.current) return;
      void getCopyStatus({
        operationId: status.operationId,
        documentId: snapshot.documentId,
        sessionId: snapshot.sessionId,
      })
        .then((next) => acceptCopyStatus(next, generationId, snapshot))
        .catch((error) => {
          if (mounted.current && generationId === copyGeneration.current) {
            setCopyStatus(null);
            setCopyMessage(error instanceof Error ? error.message : "Copy status is unavailable.");
          }
        });
    }, COPY_STATUS_POLL_MS);
  }

  async function startCopySnapshot(snapshot: CopyRequestSnapshot): Promise<void> {
    const generationId = ++copyGeneration.current;
    if (copyPollTimer.current !== null) window.clearTimeout(copyPollTimer.current);
    const fallbackId = `${Date.now().toString(36)}-${(++copySequence.current).toString(36)}`;
    const operationId = `copy-${globalThis.crypto?.randomUUID?.() ?? fallbackId}`;
    setLastCopySnapshot(snapshot);
    setCopyMessage(`Starting copy ${operationId}...`);
    try {
      const status = await startCopy({ operationId, ...snapshot });
      acceptCopyStatus(status, generationId, snapshot);
    } catch (error) {
      if (mounted.current && generationId === copyGeneration.current) {
        setCopyStatus(null);
        setCopyMessage(
          error instanceof Error ? error.message : "The selection could not be copied.",
        );
      }
    }
  }

  async function copySelection(
    includeColumnHeaders?: boolean,
    options = copyOptions,
    representation: CopyRepresentation = "display",
  ) {
    if (copyIsActive(copyStatus) || rowCount === 0 || logicalColumnNames.length === 0) return;
    const { top, left, bottom, right } = latestSelection.current.rect;
    const selectedColumns = visibleColumns
      .map((column) => column.id)
      .filter((columnId) => {
        const logicalIndex = logicalColumnNames.indexOf(columnId);
        return logicalIndex >= left && logicalIndex <= right;
      });
    if (selectedColumns.length === 0) {
      setCopyMessage("The selection contains no visible columns.");
      return;
    }
    const snapshot: CopyRequestSnapshot = {
      documentId,
      sessionId: summary.sessionId,
      queryId: queryId ?? null,
      selection: {
        rowStart: top,
        rowEndExclusive: bottom + 1,
        columnIds: [...selectedColumns],
      },
      options: copyOptionsSnapshot(
        options,
        includeColumnHeaders ?? options.includeHeaders,
        representation,
      ),
      maxCells: copyLimits.maxCells,
      maxBytes: copyLimits.maxBytes,
    };
    await startCopySnapshot(snapshot);
  }

  async function cancelCopy() {
    if (!copyStatus || !copyIsActive(copyStatus)) return;
    const generationId = copyGeneration.current;
    if (copyPollTimer.current !== null) window.clearTimeout(copyPollTimer.current);
    setCopyStatus({ ...copyStatus, state: "cancelling" });
    try {
      const status = await cancelCopyOperation({
        operationId: copyStatus.operationId,
        documentId: copyStatus.documentId,
        sessionId: copyStatus.sessionId,
      });
      if (lastCopySnapshot) acceptCopyStatus(status, generationId, lastCopySnapshot);
    } catch (error) {
      if (mounted.current && generationId === copyGeneration.current) {
        setCopyMessage(error instanceof Error ? error.message : "Copy cancellation failed.");
      }
    }
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

  async function copyContextCell(
    coordinate: GridCoordinate,
    representation: "configured" | "display" | "raw" = "configured",
  ) {
    const requestGeneration = ++cellCopyGeneration.current;
    const resultIdentity = activeResultKey;
    const isCurrent = () =>
      mounted.current &&
      activeRef.current &&
      cellCopyGeneration.current === requestGeneration &&
      latestResultKey.current === resultIdentity;
    let value = valueAt(coordinate.row, coordinate.column);
    if (!value) return;
    try {
      const columnId = logicalColumnNames[coordinate.column];
      if (representation !== "display" && readCellValue && columnId) {
        value = formatDataValue(await readCellValue(coordinate.row, columnId), displayFormats);
      }
      if (!isCurrent()) return;
      const text =
        representation === "display"
          ? (value.display ?? "")
          : representation === "raw"
            ? (value.rawDisplay ?? value.sourceDisplay ?? value.display ?? "")
            : serializeCopyField(value, copyOptions);
      await writeClipboardText(text);
      if (isCurrent()) setCopyMessage("Copied cell value.");
    } catch (error) {
      if (isCurrent())
        setCopyMessage(error instanceof Error ? error.message : "The cell could not be copied.");
    }
  }

  function navigationIsCurrent(
    navigationId: number,
    resultIdentity: string,
    selectionGeneration: number,
  ): boolean {
    return (
      mounted.current &&
      navigationGeneration.current === navigationId &&
      latestResultKey.current === resultIdentity &&
      latestSelection.current.generation === selectionGeneration
    );
  }

  function cancelActiveBoundaryNavigation(): void {
    navigationGeneration.current += 1;
    const pending = activeBoundaryRequest.current;
    activeBoundaryRequest.current = null;
    if (!pending) return;
    void cancelDataBoundaryNavigation({
      navigationId: pending.navigationId,
      documentId: pending.documentId,
      sessionId: pending.sessionId,
      ...(pending.queryId ? { queryId: pending.queryId } : {}),
    });
  }

  function cancelPendingBoundaryNavigation(): void {
    boundaryQueueEpoch.current += 1;
    cancelActiveBoundaryNavigation();
  }

  async function navigateByResolvedBoundary(
    direction: ArrowDirection,
    shiftKey: boolean,
    absoluteBoundary: boolean,
  ): Promise<void> {
    cancelActiveBoundaryNavigation();
    const navigationId = ++navigationGeneration.current;
    const startSelection = latestSelection.current;
    const resultIdentity = latestResultKey.current;
    let expectedSelectionGeneration = startSelection.generation;
    const assertCurrent = () =>
      navigationIsCurrent(navigationId, resultIdentity, expectedSelectionGeneration);

    try {
      const visibleColumnIds = visibleColumns.map((column) => column.id);
      const startColumnId = logicalColumnNames[startSelection.active.column];
      const startVisibleColumn = visibleColumnIds.indexOf(startColumnId);
      if (startVisibleColumn < 0 || visibleColumnIds.length === 0) return;
      const boundaryDirection: DataBoundaryDirection =
        direction[0] < 0 ? "up" : direction[0] > 0 ? "down" : direction[1] < 0 ? "left" : "right";
      const request: FindBoundaryRequest = {
        navigationId: `${resultIdentity}:${navigationId}`,
        documentId: documentId ?? summary.sessionId,
        sessionId: summary.sessionId,
        ...(queryId ? { queryId } : {}),
        row: startSelection.active.row,
        columnId: startColumnId,
        visibleColumnIds,
        direction: boundaryDirection,
        mode: absoluteBoundary ? "tableBoundary" : "dataBoundary",
      };
      activeBoundaryRequest.current = request;
      const response = await findDataBoundary(request);
      if (!assertCurrent() || activeBoundaryRequest.current !== request) return;
      const targetVisibleColumn = visibleColumnIds.indexOf(response.targetColumnId);
      const responseMatches =
        response.navigationId === request.navigationId &&
        response.documentId === request.documentId &&
        response.sessionId === request.sessionId &&
        response.queryId === request.queryId;
      const directionalTarget =
        (direction[0] < 0 && response.targetRow <= request.row) ||
        (direction[0] > 0 && response.targetRow >= request.row) ||
        (direction[1] < 0 && targetVisibleColumn <= startVisibleColumn) ||
        (direction[1] > 0 && targetVisibleColumn >= startVisibleColumn);
      if (
        !responseMatches ||
        !Number.isSafeInteger(response.targetRow) ||
        response.targetRow < 0 ||
        targetVisibleColumn < 0 ||
        !directionalTarget ||
        (response.resolvedRowCount !== null &&
          (response.resolvedRowCount < 0 || response.targetRow >= response.resolvedRowCount))
      ) {
        throw new Error("The backend returned an invalid data-boundary target.");
      }
      const targetRow = response.targetRow;
      const targetColumnId = response.targetColumnId;
      const resolvedRowCount = response.resolvedRowCount;

      if (!assertCurrent()) return;
      const targetColumn = logicalColumnNames.indexOf(targetColumnId);
      const target = { row: targetRow, column: targetColumn };
      const targetOffset = pageOffsetFor(target.row, page.limit);
      const cached = compatiblePageFor(pages.values(), page, targetOffset, [targetColumnId]);
      if (!cached) {
        const projection = orderedProjectionForWindow(
          logicalColumnNames,
          [targetColumn],
          activeProjection,
        );
        const targetPage = await readPage({
          sessionId: summary.sessionId,
          offset: targetOffset,
          limit: page.limit,
          columns: projection,
        });
        if (!assertCurrent()) return;
        if (
          targetPage.sessionId !== summary.sessionId ||
          targetPage.offset !== targetOffset ||
          !sameProjectedColumns(targetPage.columns, projection) ||
          target.row >= targetPage.offset + targetPage.rows.length
        ) {
          throw new Error("The navigation target page does not match the resolved boundary.");
        }
        const targetPageKey = projectedPageKey(targetPage.offset, targetPage.columns);
        setActiveProjection(projection);
        setPages((current) => {
          const next = new Map(current);
          next.set(targetPageKey, targetPage);
          return trimPageWindow(next, targetPageKey);
        });
        skipAdjacentPrefetchOnce.current = true;
      }
      if (!assertCurrent()) return;
      activeBoundaryRequest.current = null;
      const targetBounds = {
        ...selectionBounds,
        rowCount: Math.max(selectionBounds.rowCount, resolvedRowCount ?? 0, target.row + 1),
      };
      if (knownCount === null) {
        setResolvedRowCountHint((current) => Math.max(current ?? 0, targetBounds.rowCount));
      }
      const committedSelection = dispatchSelection({
        type: "click",
        coordinate: target,
        shiftKey,
        bounds: targetBounds,
      });
      expectedSelectionGeneration = committedSelection.generation;
      scrollToCoordinate(target, targetBounds.rowCount);
      window.requestAnimationFrame(() => {
        const grid = gridRef.current;
        if (
          grid &&
          navigationIsCurrent(navigationId, resultIdentity, committedSelection.generation) &&
          document.activeElement === grid
        )
          grid.focus();
      });
    } catch (error) {
      if (assertCurrent()) {
        activeBoundaryRequest.current = null;
        onReadError(error, pageOffsetFor(startSelection.active.row, page.limit));
      }
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
    const direction = arrowDirection(event.key);
    const absoluteBoundary = Boolean(primary && event.altKey && direction);
    if (!handled || (event.altKey && !absoluteBoundary)) return;
    event.preventDefault();
    if (primary && direction) {
      const queueEpoch = boundaryQueueEpoch.current;
      boundaryNavigationQueue.current = boundaryNavigationQueue.current.then(async () => {
        if (!mounted.current || boundaryQueueEpoch.current !== queueEpoch) return;
        await navigateByResolvedBoundary(direction, event.shiftKey, absoluteBoundary);
      });
      return;
    }
    cancelPendingBoundaryNavigation();
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
        return value ? dataValueIsEmpty(value) : false;
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
        return value ? dataValueIsEmpty(value) : false;
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

  function autoFitColumn(columnId: string) {
    const displays: (string | null)[] = [];
    for (const loaded of pages.values()) {
      const projectedIndex = loaded.columns.indexOf(columnId);
      if (projectedIndex < 0) continue;
      for (const row of loaded.rows) {
        const value = row[projectedIndex];
        displays.push(value ? formatDataValue(value, displayFormats).display : null);
      }
    }
    const logicalIndex = logicalColumnNames.indexOf(columnId);
    const headerElement = gridRef.current?.querySelector<HTMLElement>(
      `.virtual-grid__column-header[data-column-index="${logicalIndex}"]`,
    );
    const cellElement = gridRef.current?.querySelector<HTMLElement>(
      `.virtual-grid__cell[data-grid-column="${logicalIndex}"]`,
    );
    const canvas = document.createElement("canvas");
    const context = navigator.userAgent.includes("jsdom") ? null : canvas.getContext("2d");
    const headerFont = headerElement
      ? window.getComputedStyle(headerElement).font
      : "650 12px sans-serif";
    const cellFont = cellElement ? window.getComputedStyle(cellElement).font : "12px sans-serif";
    const measure = (value: string, header: boolean) => {
      if (!context) return [...value].length * 7;
      context.font = header ? headerFont : cellFont;
      return context.measureText(value).width;
    };
    const allowance = queryEnabled ? 76 : 28;
    const width = autoFitColumnWidth(columnId, displays, measure, allowance);
    setColumnSizing((sizes) => ({ ...sizes, [columnId]: width }));
  }

  function resizeColumnWithKeyboard(event: KeyboardEvent<HTMLDivElement>, columnId: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      autoFitColumn(columnId);
      return;
    }
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
  const visibleColumnIdSet = new Set(visibleColumns.map((column) => column.id));
  const querySearchColumns: QuerySearchColumn[] = sourceLogicalColumnNames.map((columnId) => {
    const scalarType = queryScalarTypes?.[columnId] ?? inferQueryScalarType(summary, columnId);
    return {
      id: columnId,
      label: columnId,
      hidden: !visibleColumnIdSet.has(columnId),
      searchable: scalarType !== "other",
      disabledReason:
        scalarType === "other" ? "Search is unavailable for this column type." : undefined,
    };
  });
  const queryHasConditions = Boolean(
    queryPlan && (queryPlan.filters.length > 0 || queryPlan.search?.text.trim()),
  );
  const activeCopyStatus = copyIsActive(copyStatus) ? copyStatus : null;

  return (
    <div
      className="virtual-grid-shell"
      style={queryEnabled ? { gridTemplateRows: "38px 38px minmax(0, 1fr) 40px" } : undefined}
    >
      {queryEnabled && queryPlan && (
        <QueryToolbar
          active={active}
          columns={querySearchColumns}
          onCancelQuery={onCancelQuery}
          onClearFilters={handleClearFilters}
          onFindNext={onFindNext}
          onFindPrevious={onFindPrevious}
          onRemoveFilter={handleRemoveFilter}
          onRetryQuery={onRetryQuery}
          onSortChange={(sort) => {
            if (queryPlan && onQueryPlanChange) onQueryPlanChange(setSort(queryPlan, sort));
          }}
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
          onClick={() => {
            setCopyHistoryOpen(false);
            setCopyMenuOpen(false);
            setChooserOpen((open) => !open);
          }}
          title="Choose columns"
          ref={chooserTriggerRef}
          type="button"
        >
          <Columns3 aria-hidden="true" />
        </button>
        <span className="column-count">
          {visibleColumns.length.toLocaleString()} / {allColumns.length.toLocaleString()} columns
        </span>
        <button
          aria-label="Restore source column order"
          className="column-tool-button column-order-restore"
          disabled={isSourceColumnOrder || Boolean(columnReorder.state.movingId)}
          onClick={() => {
            const activeColumnId = logicalColumnNames[selection.active.column];
            applyColumnOrder(restoredColumnOrder);
            window.requestAnimationFrame(() => {
              if (!activeColumnId) return;
              const restoredVisibleIds = restoredColumnOrder.filter((id) =>
                table.getColumn(id)?.getIsVisible(),
              );
              const visibleIndex = restoredVisibleIds.indexOf(activeColumnId);
              if (visibleIndex >= 0)
                columnVirtualizer.scrollToIndex(visibleIndex, { align: "auto" });
            });
          }}
          title="Restore source column order"
          type="button"
        >
          <RotateCcw aria-hidden="true" />
        </button>
        <div className="copy-controls">
          <button
            aria-label={
              !activeCopyStatus
                ? "Copy selection"
                : ["queued", "running"].includes(activeCopyStatus.state)
                  ? "Cancel copy"
                  : "Finishing copy"
            }
            className="copy-selection-button"
            disabled={
              rowCount === 0 ||
              Boolean(activeCopyStatus && !["queued", "running"].includes(activeCopyStatus.state))
            }
            onClick={
              !activeCopyStatus
                ? () => void copySelection()
                : ["queued", "running"].includes(activeCopyStatus.state)
                  ? () => void cancelCopy()
                  : undefined
            }
            title={
              !activeCopyStatus
                ? `Copy selection as ${copyOptions.preset}`
                : ["queued", "running"].includes(activeCopyStatus.state)
                  ? "Cancel copy"
                  : "Finishing clipboard write"
            }
            type="button"
          >
            {activeCopyStatus ? (
              ["queued", "running"].includes(activeCopyStatus.state) ? (
                <X aria-hidden="true" />
              ) : (
                <LoaderCircle aria-hidden="true" />
              )
            ) : (
              <ClipboardCopy aria-hidden="true" />
            )}
            <span>
              {!activeCopyStatus
                ? `Copy (${copyOptions.preset.toUpperCase()})`
                : ["queued", "running"].includes(activeCopyStatus.state)
                  ? "Cancel"
                  : "Finishing"}
            </span>
          </button>
          <div className="copy-split-menu" ref={copyMenuRef}>
            <button
              aria-expanded={copyMenuOpen}
              aria-haspopup="menu"
              aria-label="Copy options"
              className="copy-options-button"
              disabled={Boolean(activeCopyStatus) || copyPresetSaving}
              onClick={() => {
                setChooserOpen(false);
                setCopyHistoryOpen(false);
                setCopyMenuOpen((open) => !open);
              }}
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
                <button
                  onClick={() => {
                    setCopyMenuOpen(false);
                    void copySelection(undefined, copyOptions, "rawCanonical");
                  }}
                  role="menuitem"
                  type="button"
                >
                  Copy raw values
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
        {excelRowLimitExceeded && (
          <span
            className="copy-warning"
            role="status"
            title={`${selectedExcelRows.toLocaleString()} selected rows exceed Excel's ${EXCEL_WORKSHEET_MAX_ROWS.toLocaleString()}-row worksheet limit. Copy is not truncated.`}
          >
            <TriangleAlert aria-hidden="true" /> Excel limit: {selectedExcelRows.toLocaleString()}{" "}
            rows exceed {EXCEL_WORKSHEET_MAX_ROWS.toLocaleString()}; copy is not truncated.
          </span>
        )}
        {(activeCopyStatus || copyMessage) && (
          <span className="copy-status" role="status" aria-live="polite">
            {activeCopyStatus ? copyStatusMessage(activeCopyStatus) : copyMessage}
          </span>
        )}
        {copyStatus && !activeCopyStatus && copyStatus.state !== "complete" && (
          <span className="copy-failure-actions">
            {lastCopySnapshot && (
              <button
                className="copy-retry"
                onClick={() => void startCopySnapshot(lastCopySnapshot)}
                type="button"
              >
                Retry
              </button>
            )}
            <button
              className="copy-retry"
              onClick={() => {
                setCopyStatus(null);
                setCopyMessage(null);
              }}
              type="button"
            >
              Dismiss
            </button>
          </span>
        )}
        {(copyHistory.current || copyHistory.previous.length > 0) && (
          <div className="copy-history" ref={copyHistoryRef}>
            <button
              aria-expanded={copyHistoryOpen}
              className="copy-history__trigger"
              onClick={() => {
                setChooserOpen(false);
                setCopyMenuOpen(false);
                setCopyHistoryOpen((open) => !open);
              }}
              ref={copyHistoryTriggerRef}
              type="button"
            >
              Copy history
            </button>
            {copyHistoryOpen && (
              <ol aria-label="Copy history">
                {[copyHistory.current, ...copyHistory.previous]
                  .filter((item): item is CopyOperationStatus => item !== null)
                  .filter(
                    (item, index, items) =>
                      items.findIndex((candidate) => candidate.operationId === item.operationId) ===
                      index,
                  )
                  .slice(0, 5)
                  .map((item, index) => (
                    <li key={item.operationId}>
                      <strong>{index === 0 ? "Current" : "Previous"}</strong>
                      <span>{item.operationId}</span>
                      <time>{item.startedAt}</time>
                      <span>{item.state}</span>
                      {item.failure && (
                        <span>
                          {item.failure.reason}: {item.failure.message}
                        </span>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </div>
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
          <div
            className="column-chooser"
            ref={chooserRef}
            role="dialog"
            aria-label="Column chooser"
          >
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
                <div className="column-chooser__item" key={column.id}>
                  <button
                    aria-pressed={column.getIsVisible()}
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
                  <button
                    aria-label={`Auto fit ${column.id}`}
                    disabled={!column.getIsVisible()}
                    onClick={() => autoFitColumn(column.id)}
                    title={`Auto fit ${column.id}`}
                    type="button"
                  >
                    Auto fit
                  </button>
                </div>
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
        data-bottom-clearance={GRID_BOTTOM_CLEARANCE}
        data-document-id={documentId}
        data-mounted-cells={mountedCellCount}
        data-mounted-columns={columnVirtualItems.length}
        data-mounted-rows={virtualRows.length}
        data-query-id={queryId ?? ""}
        data-session-id={summary.sessionId}
        data-selection-bottom={selection.rect.bottom}
        data-selection-kind={selection.kind}
        data-selection-left={selection.rect.left}
        data-selection-right={selection.rect.right}
        data-selection-top={selection.rect.top}
        data-testid="data-scroll"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            cancelPendingBoundaryNavigation();
          }
        }}
        onKeyDown={handleGridKeyDown}
        onPointerDownCapture={() => cancelPendingBoundaryNavigation()}
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
              height: GRID_HEADER_HEIGHT + rowVirtualizer.getTotalSize() + GRID_BOTTOM_CLEARANCE,
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
                    {...columnReorder.getItemProps(column.id)}
                    aria-colindex={virtualColumn.index + 1}
                    aria-label={column.id}
                    className={`virtual-grid__column-header virtual-grid__column-header--ordered${queryEnabled ? " virtual-grid__column-header--query" : ""}${selection.kind === "column" && logicalColumn >= selection.rect.left && logicalColumn <= selection.rect.right ? " is-selected" : ""}${columnReorder.state.movingId === column.id ? " is-reordering" : ""}${columnReorder.state.movingId && columnReorder.state.movingId !== column.id ? " is-live-reflowing" : ""}`}
                    data-column-index={logicalColumn}
                    key={column.id}
                    onClick={(event) => {
                      if (columnReorder.consumeSuppressedClick(column.id)) return;
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
                    onKeyDown={(event) => {
                      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey)
                        return;
                      const direction =
                        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
                      if (direction === null) return;
                      event.preventDefault();
                      moveColumn(column.id, direction);
                      window.requestAnimationFrame(() => {
                        Array.from(
                          gridRef.current?.querySelectorAll<HTMLElement>(
                            ".virtual-grid__column-header",
                          ) ?? [],
                        )
                          .find((header) => header.getAttribute("aria-label") === column.id)
                          ?.focus();
                      });
                    }}
                    role="columnheader"
                    style={{
                      left: GRID_ROW_NUMBER_WIDTH + virtualColumn.start,
                      transform: `translate3d(${columnPreviewOffsets[column.id] ?? 0}px, 0, 0)`,
                      width: column.getSize(),
                    }}
                    title={column.id}
                    tabIndex={0}
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
                            setFilterFocusTarget(null);
                            filterTriggerColumnId.current = column.id;
                            filterTriggerRef.current = trigger;
                            onOpenDistinctValues?.(column.id);
                            setFilterPopover((current) =>
                              current?.columnId === column.id
                                ? null
                                : { columnId: column.id, left: rect.left, top: rect.bottom + 4 },
                            );
                          }}
                          ref={
                            filterTriggerColumnId.current === column.id
                              ? filterTriggerRef
                              : undefined
                          }
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
                            onQueryPlanChange(toggleSort(queryPlan, column.id, false));
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
                      data-reorder-ignore
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        autoFitColumn(column.id);
                      }}
                      onKeyDown={(event) => resizeColumnWithKeyboard(event, column.id)}
                      onPointerDown={(event) => resizeColumn(event, column.id, column.getSize())}
                      role="separator"
                      tabIndex={0}
                      title={`Resize ${column.id}; double-click or press Enter to auto fit`}
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
                compatiblePageFor(pages.values(), page, offset, mountedColumnNames);
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
                    const rawValue = projectedColumn >= 0 ? row?.[projectedColumn] : undefined;
                    const value = rawValue ? formatDataValue(rawValue, displayFormats) : undefined;
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
                        }${
                          value?.kind === "string" && !displayFormats.string.wrapLongLines
                            ? " virtual-grid__cell--nowrap"
                            : ""
                        }${selected ? " is-selected" : ""}${active ? " is-active" : ""}${columnReorder.state.movingId === column.id ? " is-reordering" : ""}${columnReorder.state.movingId && columnReorder.state.movingId !== column.id ? " is-live-reflowing" : ""}`}
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
                          transform: `translate3d(${columnPreviewOffsets[column.id] ?? 0}px, 0, 0)`,
                          width: column.getSize(),
                        }}
                        title={value?.display ?? undefined}
                      >
                        {value ? (
                          value.state === "invalid" ? (
                            <>
                              <TriangleAlert aria-hidden="true" className="invalid-cell-icon" />
                              <span className="virtual-grid__cell-value">
                                {dataCellText(value)}
                              </span>
                            </>
                          ) : dataCellText(value).includes("\n") ||
                            dataCellText(value).includes("\r") ? (
                            <span className="virtual-grid__cell-value">{dataCellText(value)}</span>
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

      {displayedInspected && (
        <div
          aria-label="Full cell value"
          aria-modal="true"
          className="value-inspector"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeInspector();
            }
          }}
          role="dialog"
        >
          <header>
            <div>
              <strong>Cell value</strong>
              <span>
                Row {displayedInspected.coordinate.row + 1},{" "}
                {logicalColumnNames[displayedInspected.coordinate.column]}
              </span>
            </div>
            <button
              aria-label="Close value inspector"
              autoFocus
              className="icon-button"
              onClick={closeInspector}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="value-inspector__values">
            {(() => {
              const metadata = rawValueMetadata(displayedInspected.value);
              return (
                <section>
                  <strong>Type</strong>
                  <pre>{displayedInspected.value.kind}</pre>
                  {metadata.unit && <span>Unit: {metadata.unit}</span>}
                  {metadata.timezone && <span>Timezone: {metadata.timezone}</span>}
                </section>
              );
            })()}
            <section>
              <strong>Display</strong>
              <pre>
                {displayedInspected.value.display === null
                  ? "null"
                  : displayedInspected.value.display}
              </pre>
              <button
                onClick={() => void copyContextCell(displayedInspected.coordinate, "display")}
                type="button"
              >
                Copy displayed value
              </button>
            </section>
            <section>
              <strong>Copy value</strong>
              <pre>{copyValuePreview(displayedInspected.value, copyOptions)}</pre>
            </section>
            {displayedInspected.value.rawDisplay !== null &&
              displayedInspected.value.rawDisplay !== undefined && (
                <section>
                  <strong>Raw</strong>
                  <pre>{displayedInspected.value.rawDisplay}</pre>
                  <button
                    onClick={() => void copyContextCell(displayedInspected.coordinate, "raw")}
                    type="button"
                  >
                    Copy raw value
                  </button>
                </section>
              )}
            {displayedInspected.value.sourceDisplay !== null &&
              displayedInspected.value.sourceDisplay !== undefined &&
              displayedInspected.value.sourceDisplay !== displayedInspected.value.rawDisplay && (
                <section>
                  <strong>Source</strong>
                  <pre>{displayedInspected.value.sourceDisplay}</pre>
                </section>
              )}
          </div>
        </div>
      )}
      {columnReorder.state.movingId &&
        (() => {
          const grid = scrollRef.current;
          const movingId = columnReorder.state.movingId;
          const movingColumn = visibleColumns.find((column) => column.id === movingId);
          const logicalColumn = logicalColumnNames.indexOf(movingId);
          const clientX = columnReorder.state.clientX;
          const grabOffsetX = columnReorder.state.grabOffsetX;
          if (
            !grid ||
            !movingColumn ||
            logicalColumn < 0 ||
            clientX === null ||
            grabOffsetX === null
          )
            return null;
          const gridRect = grid.getBoundingClientRect();
          const width = movingColumn.getSize();
          const left = Math.max(
            0,
            Math.min(clientX - grabOffsetX - gridRect.left, gridRect.width - width),
          );
          const sortIndex = queryPlan?.sort.findIndex((sort) => sort.columnId === movingId) ?? -1;
          const sort = sortIndex >= 0 ? queryPlan?.sort[sortIndex] : undefined;
          const filtered = queryPlan?.filters.some((item) => item.columnId === movingId);
          return createPortal(
            <div
              aria-hidden="true"
              className="virtual-grid__column-drag-clip"
              data-testid="column-drag-overlay"
              style={{
                height: gridRect.height,
                left: gridRect.left,
                top: gridRect.top,
                width: gridRect.width,
              }}
            >
              <div
                className="virtual-grid__column-drag-strip"
                style={{
                  height: gridRect.height,
                  transform: `translate3d(${left}px, 0, 0)`,
                  width,
                }}
              >
                <div
                  className={`virtual-grid__column-header virtual-grid__column-header--ordered${queryEnabled ? " virtual-grid__column-header--query" : ""}`}
                  style={{ left: 0, width }}
                >
                  <span>{movingId}</span>
                  {queryEnabled && (
                    <div className="query-column-actions">
                      <span className={filtered ? "is-active" : undefined}>
                        <Filter aria-hidden="true" />
                      </span>
                      <span className={sort ? "is-active" : undefined}>
                        {sort?.direction === "ascending" ? (
                          <ArrowUp aria-hidden="true" />
                        ) : sort?.direction === "descending" ? (
                          <ArrowDown aria-hidden="true" />
                        ) : (
                          <ArrowUpDown aria-hidden="true" />
                        )}
                        {sort && <small>{sortIndex + 1}</small>}
                      </span>
                    </div>
                  )}
                </div>
                {virtualRows.map((virtualRow) => {
                  const top = GRID_HEADER_HEIGHT + virtualRow.start - grid.scrollTop;
                  if (top + GRID_ROW_HEIGHT < GRID_HEADER_HEIGHT || top > gridRect.height)
                    return null;
                  const value = valueAt(virtualRow.index, logicalColumn);
                  const coordinate = { row: virtualRow.index, column: logicalColumn };
                  const selected = isSelected(selection, coordinate);
                  const active =
                    selection.active.row === coordinate.row &&
                    selection.active.column === coordinate.column;
                  return (
                    <div
                      className={`${value ? cellClass(value) : "virtual-grid__cell virtual-grid__cell--loading"}${value?.kind === "string" && !displayFormats.string.wrapLongLines ? " virtual-grid__cell--nowrap" : ""}${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
                      key={virtualRow.index}
                      style={{ height: GRID_ROW_HEIGHT, left: 0, top, width }}
                    >
                      {value ? dataCellText(value) : null}
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          );
        })()}
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
              disabled={Boolean(activeCopyStatus)}
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
              disabled={Boolean(activeCopyStatus)}
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
              <span>Copy configured value</span>
            </button>
            <button
              disabled={!valueAt(contextMenu.coordinate.row, contextMenu.coordinate.column)}
              onClick={() => {
                const target = contextMenu.coordinate;
                closeContextMenu();
                void copyContextCell(target, "display");
              }}
              role="menuitem"
              type="button"
            >
              <span>Copy displayed value</span>
            </button>
            <button
              disabled={!valueAt(contextMenu.coordinate.row, contextMenu.coordinate.column)}
              onClick={() => {
                const target = contextMenu.coordinate;
                closeContextMenu();
                void copyContextCell(target, "raw");
              }}
              role="menuitem"
              type="button"
            >
              <span>Copy raw value</span>
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
                  durationUnit={durationUnitForColumn(summary, filterPopover.columnId)}
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
