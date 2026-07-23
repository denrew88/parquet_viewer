import {
  Check,
  Copy,
  ListChecks,
  Minus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  CSV_PROFILE_TYPES,
  applyBulkSettings,
  copyColumnSettings,
  createCsvProfileDraft,
  getMixedSetting,
  matchesCurrentGeneration,
  profileRequest,
  resetSelectedToRecommended,
  undoLastBulkChange,
  type CsvColumnProfile,
  type CsvProfileIdentity,
  type CsvProfilePreview,
  type CsvProfileRequest,
  type CsvProfileRequestContext,
  type CsvProfileType,
  type CsvProfileValidation,
  type CsvFailurePolicy,
} from "./model";
import { EMPTY_CSV_COLUMN_SELECTION, csvColumnSelectionReducer } from "./selection";

const COLUMN_ROW_HEIGHT = 40;
const COLUMN_VIEWPORT_HEIGHT = 320;
const COLUMN_OVERSCAN = 4;
const PREVIEW_ROW_HEIGHT = 34;
const PREVIEW_COLUMN_WIDTH = 160;
const PREVIEW_VIEWPORT_HEIGHT = 238;
const PREVIEW_VIEWPORT_WIDTH = 780;
const PREVIEW_OVERSCAN = 2;
const PREVIEW_DEBOUNCE_MS = 200;
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface CsvProfileDialogProps {
  identity: CsvProfileIdentity;
  columns: readonly CsvColumnProfile[];
  initialGeneration?: number;
  preview?: CsvProfilePreview | null;
  validation?: CsvProfileValidation | null;
  isApplying?: boolean;
  requestError?: string | null;
  structuralError?: string | null;
  restoreFocusTo?: HTMLElement | null;
  onPreviewRequest: (request: CsvProfileRequest) => void;
  onValidate: (request: CsvProfileRequest) => void;
  onCancelValidation?: (context: CsvProfileRequestContext) => void;
  onApply: (request: CsvProfileRequest) => void;
  onCancel: (context: CsvProfileRequestContext) => void;
}

type ColumnStatusFilter = "all" | "valid" | "invalid";
type PreviewMode = "raw" | "converted";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function currentContext(
  identity: CsvProfileIdentity,
  generation: number,
): CsvProfileRequestContext {
  return { ...identity, generation };
}

function timezonePolicy(timezone: string): "Preserve" | "UTC" | "Fixed" {
  return timezone === "Preserve" ? "Preserve" : timezone === "UTC" ? "UTC" : "Fixed";
}

function timezoneOffset(timezone: string): string {
  return /^UTC[+-]\d{2}:\d{2}$/.test(timezone) ? timezone.slice(3) : "+00:00";
}

function validTimezoneOffset(value: string): boolean {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[2]) <= 23 && Number(match[3]) <= 59);
}

function PreviewGrid({ preview, mode }: { preview: CsvProfilePreview; mode: PreviewMode }) {
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const rowStart = clamp(
    Math.floor(scroll.top / PREVIEW_ROW_HEIGHT) - PREVIEW_OVERSCAN,
    0,
    Math.max(0, preview.rows.length - 1),
  );
  const rowCount = Math.ceil(PREVIEW_VIEWPORT_HEIGHT / PREVIEW_ROW_HEIGHT) + PREVIEW_OVERSCAN * 2;
  const rowEnd = Math.min(preview.rows.length, rowStart + rowCount);
  const columnStart = clamp(
    Math.floor(scroll.left / PREVIEW_COLUMN_WIDTH) - PREVIEW_OVERSCAN,
    0,
    Math.max(0, preview.columns.length - 1),
  );
  const columnCount =
    Math.ceil(PREVIEW_VIEWPORT_WIDTH / PREVIEW_COLUMN_WIDTH) + PREVIEW_OVERSCAN * 2;
  const columnEnd = Math.min(preview.columns.length, columnStart + columnCount);
  const visibleColumns = preview.columns.slice(columnStart, columnEnd);
  const visibleRows = preview.rows.slice(rowStart, rowEnd);
  const totalWidth = Math.max(
    PREVIEW_VIEWPORT_WIDTH,
    preview.columns.length * PREVIEW_COLUMN_WIDTH,
  );
  const totalHeight = Math.max(
    PREVIEW_VIEWPORT_HEIGHT,
    (preview.rows.length + 1) * PREVIEW_ROW_HEIGHT,
  );

  return (
    <div
      aria-label="CSV sample preview"
      className="csv-profile-preview-grid"
      data-testid="csv-profile-preview-grid"
      onScroll={(event: UIEvent<HTMLDivElement>) =>
        setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })
      }
      role="grid"
      style={{ overflow: "auto", position: "relative" }}
    >
      <div style={{ height: totalHeight, position: "relative", width: totalWidth }}>
        {visibleColumns.map((column, visibleIndex) => {
          const columnIndex = columnStart + visibleIndex;
          return (
            <div
              className="csv-profile-preview-grid__header"
              key={column.columnId}
              role="columnheader"
              style={{
                height: PREVIEW_ROW_HEIGHT,
                left: columnIndex * PREVIEW_COLUMN_WIDTH,
                position: "absolute",
                top: 0,
                width: PREVIEW_COLUMN_WIDTH,
              }}
              title={`${column.stats.success} success, ${column.stats.null} null, ${column.stats.invalid} invalid`}
            >
              <strong>{column.name}</strong>
              <span>
                {column.recommendedType === column.configuredType
                  ? column.configuredType
                  : `${column.recommendedType} -> ${column.configuredType}`}
              </span>
            </div>
          );
        })}
        {visibleRows.flatMap((row, visibleRowIndex) => {
          const rowIndex = rowStart + visibleRowIndex;
          return visibleColumns.map((column, visibleColumnIndex) => {
            const columnIndex = columnStart + visibleColumnIndex;
            const cell = row.cells.find((candidate) => candidate.columnId === column.columnId);
            const display =
              cell?.status === "null"
                ? "NULL"
                : mode === "raw"
                  ? (cell?.raw ?? "")
                  : (cell?.converted ?? cell?.raw ?? "");
            const status = cell?.status ?? "success";
            return (
              <div
                aria-label={`${column.name}, row ${row.rowIndex + 1}, ${status}`}
                className={`csv-profile-preview-grid__cell csv-profile-preview-grid__cell--${status}`}
                key={`${row.rowIndex}:${column.columnId}`}
                role="gridcell"
                style={{
                  height: PREVIEW_ROW_HEIGHT,
                  left: columnIndex * PREVIEW_COLUMN_WIDTH,
                  position: "absolute",
                  top: (rowIndex + 1) * PREVIEW_ROW_HEIGHT,
                  width: PREVIEW_COLUMN_WIDTH,
                }}
                title={cell?.error ?? display}
              >
                {status === "invalid" && <TriangleAlert aria-hidden="true" />}
                <span>{display}</span>
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}

export function CsvProfileDialog({
  identity,
  columns,
  initialGeneration = 1,
  preview = null,
  validation = null,
  isApplying = false,
  requestError = null,
  structuralError = null,
  restoreFocusTo = null,
  onPreviewRequest,
  onValidate,
  onCancelValidation,
  onApply,
  onCancel,
}: CsvProfileDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    restoreFocusTo ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  const { documentId, sessionId } = identity;
  const [draft, setDraft] = useState(() => createCsvProfileDraft(columns, initialGeneration));
  const [selection, dispatchSelection] = useReducer(
    csvColumnSelectionReducer,
    EMPTY_CSV_COLUMN_SELECTION,
  );
  const [search, setSearch] = useState("");
  const [recommendedFilter, setRecommendedFilter] = useState<CsvProfileType | "all">("all");
  const [currentFilter, setCurrentFilter] = useState<CsvProfileType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<ColumnStatusFilter>("all");
  const [columnScrollTop, setColumnScrollTop] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("converted");
  const [reviewColumnId, setReviewColumnId] = useState<string | null>(null);
  const [acknowledgedValidationKey, setAcknowledgedValidationKey] = useState<string | null>(null);
  const previewRequestRef = useRef(onPreviewRequest);
  previewRequestRef.current = onPreviewRequest;

  const visibleColumns = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return draft.columns.filter((column) => {
      if (normalizedSearch && !column.name.toLocaleLowerCase().includes(normalizedSearch)) {
        return false;
      }
      if (recommendedFilter !== "all" && column.recommendedType !== recommendedFilter) return false;
      if (currentFilter !== "all" && column.settings.type !== currentFilter) return false;
      if (statusFilter === "invalid" && column.stats.invalid === 0) return false;
      if (statusFilter === "valid" && column.stats.invalid > 0) return false;
      return true;
    });
  }, [currentFilter, draft.columns, recommendedFilter, search, statusFilter]);
  const visibleIds = useMemo(() => visibleColumns.map((column) => column.id), [visibleColumns]);
  const firstVisibleIndex = clamp(
    Math.floor(columnScrollTop / COLUMN_ROW_HEIGHT) - COLUMN_OVERSCAN,
    0,
    Math.max(0, visibleColumns.length - 1),
  );
  const mountedRowCount =
    Math.ceil(COLUMN_VIEWPORT_HEIGHT / COLUMN_ROW_HEIGHT) + COLUMN_OVERSCAN * 2;
  const mountedColumns = visibleColumns.slice(
    firstVisibleIndex,
    Math.min(visibleColumns.length, firstVisibleIndex + mountedRowCount),
  );
  const mixedType = getMixedSetting(draft.columns, selection.selectedIds, "type");
  const mixedNullTokens = getMixedSetting(draft.columns, selection.selectedIds, "nullTokens");
  const mixedTrueTokens = getMixedSetting(draft.columns, selection.selectedIds, "trueTokens");
  const mixedFalseTokens = getMixedSetting(draft.columns, selection.selectedIds, "falseTokens");
  const mixedTrim = getMixedSetting(draft.columns, selection.selectedIds, "trim");
  const mixedDecimal = getMixedSetting(draft.columns, selection.selectedIds, "decimalSeparator");
  const mixedThousands = getMixedSetting(draft.columns, selection.selectedIds, "thousandSeparator");
  const selectedColumns = draft.columns.filter((column) => selection.selectedIds.has(column.id));
  const selectedTypes = selectedColumns.map((column) =>
    column.settings.type === "Auto" ? column.recommendedType : column.settings.type,
  );
  const hasSelection = selectedTypes.length > 0;
  const showCommonSettings = hasSelection && selectedTypes.some((type) => type !== "Skip");
  const showBooleanSettings = hasSelection && selectedTypes.every((type) => type === "Boolean");
  const showThousandsSetting =
    hasSelection &&
    selectedTypes.every((type) => ["Int64", "UInt64", "Float64", "Decimal"].includes(type));
  const showDecimalSetting =
    hasSelection && selectedTypes.every((type) => ["Float64", "Decimal"].includes(type));
  const showTemporalSettings =
    hasSelection && selectedTypes.every((type) => ["Date", "Timestamp"].includes(type));
  const showTimezoneSettings = hasSelection && selectedTypes.every((type) => type === "Timestamp");
  const showDurationSettings = hasSelection && selectedTypes.every((type) => type === "Duration");
  const showFailureSetting =
    hasSelection && selectedTypes.every((type) => !["Text", "Skip"].includes(type));
  const fractionalColumns = selectedColumns.filter((column) => {
    const type = column.settings.type === "Auto" ? column.recommendedType : column.settings.type;
    return type === "Float64" || type === "Decimal";
  });
  const decimalConflicts = new Set(
    fractionalColumns.map((column) => column.settings.thousandSeparator).filter(Boolean),
  );
  const thousandsConflicts = new Set(
    fractionalColumns.map((column) => column.settings.decimalSeparator),
  );
  const mixedDateFormats = getMixedSetting(draft.columns, selection.selectedIds, "dateFormats");
  const mixedTimezone = getMixedSetting(draft.columns, selection.selectedIds, "timezone");
  const mixedDurationUnit = getMixedSetting(draft.columns, selection.selectedIds, "durationUnit");
  const mixedDurationInputFormat = getMixedSetting(
    draft.columns,
    selection.selectedIds,
    "durationInputFormat",
  );
  const mixedFailure = getMixedSetting(draft.columns, selection.selectedIds, "failurePolicy");
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selection.selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selection.selectedIds.has(id));
  const activeColumn = draft.columns.find((column) => column.id === selection.activeId);
  const freshPreview = matchesCurrentGeneration(preview, identity, draft.generation)
    ? preview
    : null;
  const freshValidation = matchesCurrentGeneration(validation, identity, draft.generation)
    ? validation
    : null;
  const selectionKey = useMemo(
    () => [...selection.selectedIds].sort().join("\u0000"),
    [selection.selectedIds],
  );
  const validationReviewKey = freshValidation
    ? [
        freshValidation.documentId,
        freshValidation.sessionId,
        freshValidation.generation,
        freshValidation.state,
        freshValidation.invalid,
        freshValidation.columns
          .map(
            (column) =>
              `${column.columnId}:${column.invalid}:${column.firstErrorRow ?? ""}:${column.errorSamples
                .map((sample) => `${sample.rowIndex}:${sample.raw}:${sample.message}`)
                .join(",")}`,
          )
          .join("|"),
      ].join("\u0000")
    : null;
  const validationAcknowledged =
    validationReviewKey !== null && validationReviewKey === acknowledgedValidationKey;
  const invalidValidationColumns =
    freshValidation?.columns.filter((column) => column.invalid > 0) ?? [];
  const invalidSamples = (freshPreview?.rows ?? [])
    .flatMap((row) =>
      row.cells
        .filter((cell) => cell.columnId === reviewColumnId && cell.status === "invalid")
        .map((cell) => ({ rowIndex: row.rowIndex, raw: cell.raw, error: cell.error })),
    )
    .slice(0, 20);

  useEffect(() => {
    const restoreFocus = restoreFocusRef.current;
    const frame = window.requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus(),
    );
    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (!freshPreview) return;
    const previewById = new Map(freshPreview.columns.map((column) => [column.columnId, column]));
    setDraft((current) => {
      let changed = false;
      const nextColumns = current.columns.map((column) => {
        const next = previewById.get(column.id);
        if (!next) return column;
        const sampleValues = freshPreview.rows
          .map((row) => row.cells.find((cell) => cell.columnId === column.id)?.raw)
          .filter((value): value is string => value !== undefined)
          .slice(0, 3);
        if (
          column.recommendedType === next.recommendedType &&
          column.stats.success === next.stats.success &&
          column.stats.null === next.stats.null &&
          column.stats.invalid === next.stats.invalid &&
          column.sampleValues.length === sampleValues.length &&
          column.sampleValues.every((value, index) => value === sampleValues[index])
        ) {
          return column;
        }
        changed = true;
        return {
          ...column,
          recommendedType: next.recommendedType,
          sampleValues,
          stats: { ...next.stats },
        };
      });
      return changed ? { ...current, columns: nextColumns } : current;
    });
  }, [freshPreview]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => previewRequestRef.current(profileRequest({ documentId, sessionId }, draft)),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [documentId, draft, sessionId]);

  function toggleColumn(columnId: string, event: Pick<MouseEvent, "shiftKey">) {
    dispatchSelection({
      type: "click",
      columnId,
      visibleIds,
      ctrl: true,
      shift: event.shiftKey,
    });
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLocaleLowerCase() === "a"
    ) {
      event.preventDefault();
      dispatchSelection({ type: "select-visible", visibleIds });
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !isApplying) {
      event.preventDefault();
      onCancel(currentContext(identity, draft.generation));
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateFilter(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value);
      setColumnScrollTop(0);
    };
  }

  function applyType(type: CsvProfileType) {
    setDraft((current) => applyBulkSettings(current, selection.selectedIds, { type }));
  }

  function applySelected(patch: Parameters<typeof applyBulkSettings>[2]) {
    setDraft((current) => applyBulkSettings(current, selection.selectedIds, patch));
  }

  function request(validationAcknowledged = false): CsvProfileRequest {
    return { ...profileRequest(identity, draft), validationAcknowledged };
  }

  const validationRunning = freshValidation?.state === "running";
  const validationReviewRequired = Boolean(
    freshValidation && freshValidation.invalid > 0 && !validationAcknowledged,
  );
  const context = currentContext(identity, draft.generation);

  return (
    <div
      aria-labelledby="csv-profile-title"
      aria-modal="true"
      aria-busy={isApplying}
      className={`csv-profile-dialog${isApplying ? " is-applying" : ""}`}
      data-generation={draft.generation}
      onKeyDown={handleDialogKeyDown}
      ref={dialogRef}
      role="dialog"
    >
      <header className="csv-profile-dialog__header">
        <div>
          <h2 id="csv-profile-title">CSV Parsing Profile</h2>
          <span>{draft.columns.length} columns</span>
        </div>
        <div className="csv-profile-dialog__header-actions">
          {validationRunning ? (
            <button
              disabled={isApplying || !onCancelValidation}
              onClick={() => onCancelValidation?.(context)}
              type="button"
            >
              <X aria-hidden="true" /> Cancel validation
            </button>
          ) : (
            <button disabled={isApplying} onClick={() => onValidate(request())} type="button">
              <ShieldCheck aria-hidden="true" /> Validate entire file
            </button>
          )}
          <button
            aria-label="Close CSV Parsing Profile"
            disabled={isApplying}
            onClick={() => onCancel(context)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <section aria-label="Column profile settings" className="csv-profile-dialog__settings">
        <div className="csv-profile-filters">
          <label>
            <span>Column name</span>
            <input
              disabled={isApplying}
              onChange={updateFilter(setSearch)}
              placeholder="Search columns"
              type="search"
              value={search}
            />
          </label>
          <label>
            <span>Recommended</span>
            <select
              disabled={isApplying}
              onChange={(event) => {
                setRecommendedFilter(event.target.value as CsvProfileType | "all");
                setColumnScrollTop(0);
              }}
              value={recommendedFilter}
            >
              <option value="all">All</option>
              {CSV_PROFILE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Current</span>
            <select
              disabled={isApplying}
              onChange={(event) => {
                setCurrentFilter(event.target.value as CsvProfileType | "all");
                setColumnScrollTop(0);
              }}
              value={currentFilter}
            >
              <option value="all">All</option>
              {CSV_PROFILE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select
              disabled={isApplying}
              onChange={(event) => {
                setStatusFilter(event.target.value as ColumnStatusFilter);
                setColumnScrollTop(0);
              }}
              value={statusFilter}
            >
              <option value="all">All</option>
              <option value="valid">Valid</option>
              <option value="invalid">Invalid</option>
            </select>
          </label>
        </div>

        <div aria-label="Bulk column settings" className="csv-profile-bulk-toolbar" role="toolbar">
          <div
            aria-label={`${selection.selectedIds.size} selected; ${visibleIds.length} shown of ${draft.columns.length} total`}
            className="csv-profile-selection-summary"
          >
            <span aria-label={`${selection.selectedIds.size} selected`} aria-live="polite">
              <strong>{selection.selectedIds.size}</strong> selected
            </span>
            <button
              aria-label="Select shown"
              disabled={isApplying || visibleIds.length === 0 || allVisibleSelected}
              onClick={() => dispatchSelection({ type: "select-visible", visibleIds })}
              title="Select all shown columns"
              type="button"
            >
              <ListChecks aria-hidden="true" />
            </button>
            <button
              aria-label="Clear"
              disabled={isApplying || selection.selectedIds.size === 0}
              onClick={() => dispatchSelection({ type: "clear" })}
              title="Clear column selection"
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <label>
            <span>Type</span>
            <select
              aria-label="Type for selected columns"
              disabled={isApplying || selection.selectedIds.size === 0}
              onChange={(event) => applyType(event.target.value as CsvProfileType)}
              value={mixedType.kind === "single" ? mixedType.value : ""}
            >
              {mixedType.kind !== "single" ? (
                <option disabled value="">
                  {mixedType.kind === "mixed" ? "Mixed" : "Select type"}
                </option>
              ) : null}
              {CSV_PROFILE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          {showCommonSettings ? (
            <>
              <label>
                <span>Trim</span>
                <button
                  aria-checked={
                    mixedTrim.kind === "mixed"
                      ? "mixed"
                      : mixedTrim.kind === "single" && mixedTrim.value
                  }
                  aria-label="Trim whitespace for selected columns"
                  className="csv-profile-setting-checkbox"
                  disabled={isApplying || selection.selectedIds.size === 0}
                  onClick={() =>
                    applySelected({ trim: mixedTrim.kind === "single" ? !mixedTrim.value : true })
                  }
                  role="checkbox"
                  type="button"
                >
                  {mixedTrim.kind === "mixed" ? (
                    <Minus aria-hidden="true" />
                  ) : mixedTrim.kind === "single" && mixedTrim.value ? (
                    <Check aria-hidden="true" />
                  ) : null}
                </button>
              </label>
              <label>
                <span>Null tokens</span>
                <input
                  aria-label="Null tokens for selected columns"
                  defaultValue={
                    mixedNullTokens.kind === "single"
                      ? mixedNullTokens.value.map((token) => token || "(empty)").join(" | ")
                      : ""
                  }
                  disabled={isApplying || selection.selectedIds.size === 0}
                  key={`null:${draft.generation}:${selectionKey}`}
                  onBlur={(event) =>
                    applySelected({
                      nullTokens: event.currentTarget.value
                        .split("|")
                        .map((token) => token.trim())
                        .map((token) => (token === "(empty)" ? "" : token)),
                    })
                  }
                  placeholder={mixedNullTokens.kind === "mixed" ? "Mixed" : "(empty) | NULL"}
                  type="text"
                />
              </label>
            </>
          ) : null}
          {showBooleanSettings ? (
            <>
              <label>
                <span>Boolean true</span>
                <input
                  aria-label="Boolean true tokens for selected columns"
                  defaultValue={
                    mixedTrueTokens.kind === "single" ? mixedTrueTokens.value.join(" | ") : ""
                  }
                  disabled={isApplying || selection.selectedIds.size === 0}
                  key={`true:${draft.generation}:${selectionKey}`}
                  onBlur={(event) =>
                    applySelected({
                      trueTokens: event.currentTarget.value
                        .split("|")
                        .map((token) => token.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder={mixedTrueTokens.kind === "mixed" ? "Mixed" : "true | 1"}
                  type="text"
                />
              </label>
              <label>
                <span>Boolean false</span>
                <input
                  aria-label="Boolean false tokens for selected columns"
                  defaultValue={
                    mixedFalseTokens.kind === "single" ? mixedFalseTokens.value.join(" | ") : ""
                  }
                  disabled={isApplying || selection.selectedIds.size === 0}
                  key={`false:${draft.generation}:${selectionKey}`}
                  onBlur={(event) =>
                    applySelected({
                      falseTokens: event.currentTarget.value
                        .split("|")
                        .map((token) => token.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder={mixedFalseTokens.kind === "mixed" ? "Mixed" : "false | 0"}
                  type="text"
                />
              </label>
            </>
          ) : null}
          {showDecimalSetting ? (
            <label>
              <span>Decimal separator</span>
              <select
                aria-label="Decimal separator for selected columns"
                disabled={isApplying}
                onChange={(event) =>
                  applySelected({ decimalSeparator: event.target.value as "." | "," })
                }
                value={mixedDecimal.kind === "single" ? mixedDecimal.value : ""}
              >
                {mixedDecimal.kind !== "single" ? (
                  <option disabled value="">
                    {mixedDecimal.kind === "mixed" ? "Mixed" : "Select"}
                  </option>
                ) : null}
                {!decimalConflicts.has(".") ? <option value=".">.</option> : null}
                {!decimalConflicts.has(",") ? <option value=",">,</option> : null}
              </select>
            </label>
          ) : null}
          {showThousandsSetting ? (
            <label>
              <span>Thousands separator</span>
              <select
                aria-label="Thousands separator for selected columns"
                disabled={isApplying}
                onChange={(event) =>
                  applySelected({
                    thousandSeparator: event.target.value as "" | "," | "." | " ",
                  })
                }
                value={mixedThousands.kind === "single" ? mixedThousands.value : "mixed"}
              >
                {mixedThousands.kind === "mixed" ? (
                  <option disabled value="mixed">
                    Mixed
                  </option>
                ) : null}
                <option value="">None</option>
                {[",", ".", " "]
                  .filter(
                    (separator) =>
                      separator === " " || !thousandsConflicts.has(separator as "," | "."),
                  )
                  .map((separator) => (
                    <option key={separator} value={separator}>
                      {separator === " " ? "Space" : separator}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {showTemporalSettings ? (
            <label>
              <span>Date formats</span>
              <input
                aria-label="Date formats for selected columns"
                defaultValue={
                  mixedDateFormats.kind === "single" ? mixedDateFormats.value.join("; ") : ""
                }
                disabled={isApplying || selection.selectedIds.size === 0}
                key={`date:${draft.generation}:${selectionKey}`}
                onBlur={(event) =>
                  applySelected({
                    dateFormats: event.currentTarget.value
                      .split(";")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={mixedDateFormats.kind === "mixed" ? "Mixed" : "YYYY-MM-DD"}
                type="text"
              />
            </label>
          ) : null}
          {showTimezoneSettings ? (
            <>
              <label>
                <span>Timezone policy</span>
                <select
                  aria-label="Timezone policy for selected columns"
                  disabled={isApplying || selection.selectedIds.size === 0}
                  onChange={(event) => {
                    const policy = event.target.value;
                    applySelected({
                      timezone:
                        policy === "Preserve"
                          ? "Preserve"
                          : policy === "UTC"
                            ? "UTC"
                            : mixedTimezone.kind === "single" &&
                                timezonePolicy(mixedTimezone.value) === "Fixed"
                              ? mixedTimezone.value
                              : "UTC+00:00",
                    });
                  }}
                  value={mixedTimezone.kind === "single" ? timezonePolicy(mixedTimezone.value) : ""}
                >
                  {mixedTimezone.kind !== "single" ? (
                    <option disabled value="">
                      {mixedTimezone.kind === "mixed" ? "Mixed" : "Select"}
                    </option>
                  ) : null}
                  <option value="Preserve">Preserve source</option>
                  <option value="UTC">Assume UTC</option>
                  <option value="Fixed">Fixed offset</option>
                </select>
              </label>
              <label>
                <span>Timezone offset</span>
                <input
                  aria-label="Timezone offset for selected columns"
                  defaultValue={
                    mixedTimezone.kind === "single" ? timezoneOffset(mixedTimezone.value) : ""
                  }
                  disabled={
                    isApplying ||
                    selection.selectedIds.size === 0 ||
                    mixedTimezone.kind !== "single" ||
                    timezonePolicy(mixedTimezone.value) !== "Fixed"
                  }
                  key={`timezone:${draft.generation}:${selectionKey}`}
                  onBlur={(event) => {
                    const value = event.currentTarget.value.trim();
                    if (validTimezoneOffset(value)) applySelected({ timezone: `UTC${value}` });
                  }}
                  pattern="[+-][0-9]{2}:[0-9]{2}"
                  placeholder="+09:00"
                  type="text"
                />
              </label>
            </>
          ) : null}
          {showDurationSettings ? (
            <>
              <label>
                <span>Duration source unit</span>
                <select
                  aria-label="Duration source unit for selected columns"
                  disabled={isApplying || selection.selectedIds.size === 0}
                  onChange={(event) =>
                    applySelected({
                      durationUnit: event.target.value as "s" | "ms" | "us" | "ns",
                    })
                  }
                  value={mixedDurationUnit.kind === "single" ? mixedDurationUnit.value : ""}
                >
                  {mixedDurationUnit.kind !== "single" ? (
                    <option disabled value="">
                      {mixedDurationUnit.kind === "mixed" ? "Mixed" : "Select"}
                    </option>
                  ) : null}
                  <option value="s">Seconds (s)</option>
                  <option value="ms">Milliseconds (ms)</option>
                  <option value="us">Microseconds (us)</option>
                  <option value="ns">Nanoseconds (ns)</option>
                </select>
              </label>
              <label>
                <span>Duration input format</span>
                <select
                  aria-label="Duration input format for selected columns"
                  disabled={isApplying || selection.selectedIds.size === 0}
                  onChange={(event) =>
                    applySelected({
                      durationInputFormat: event.target.value as "rawInteger" | "daysClock",
                    })
                  }
                  value={
                    mixedDurationInputFormat.kind === "single" ? mixedDurationInputFormat.value : ""
                  }
                >
                  {mixedDurationInputFormat.kind !== "single" ? (
                    <option disabled value="">
                      {mixedDurationInputFormat.kind === "mixed" ? "Mixed" : "Select"}
                    </option>
                  ) : null}
                  <option value="rawInteger">Raw integer count</option>
                  <option value="daysClock">Days + clock</option>
                </select>
              </label>
            </>
          ) : null}
          {showFailureSetting ? (
            <label>
              <span>Failure policy</span>
              <select
                aria-label="Failure policy for selected columns"
                disabled={isApplying || selection.selectedIds.size === 0}
                onChange={(event) =>
                  applySelected({ failurePolicy: event.target.value as CsvFailurePolicy })
                }
                value={mixedFailure.kind === "single" ? mixedFailure.value : ""}
              >
                {mixedFailure.kind !== "single" ? (
                  <option disabled value="">
                    {mixedFailure.kind === "mixed" ? "Mixed" : "Select"}
                  </option>
                ) : null}
                <option value="preserve-invalid">Preserve original</option>
                <option value="replace-null">Replace with null</option>
                <option value="reject-profile">Reject profile</option>
              </select>
            </label>
          ) : null}
          <button
            disabled={isApplying || !activeColumn || selection.selectedIds.size === 0}
            onClick={() =>
              activeColumn &&
              setDraft((current) =>
                copyColumnSettings(current, activeColumn.id, selection.selectedIds),
              )
            }
            title="Copy settings from active column"
            type="button"
          >
            <Copy aria-hidden="true" /> Copy settings
          </button>
          <button
            disabled={isApplying || selection.selectedIds.size === 0}
            onClick={() =>
              setDraft((current) => resetSelectedToRecommended(current, selection.selectedIds))
            }
            title="Reset selected columns to inferred types"
            type="button"
          >
            <RotateCcw aria-hidden="true" /> Reset to inferred
          </button>
          <button
            disabled={isApplying || !draft.lastUndo}
            onClick={() => setDraft(undoLastBulkChange)}
            title="Undo last bulk change"
            type="button"
          >
            <Undo2 aria-hidden="true" /> Undo
          </button>
        </div>

        <div className="csv-profile-column-grid__header" role="row">
          <button
            aria-checked={allVisibleSelected ? true : someVisibleSelected ? "mixed" : false}
            aria-label="Select all filtered columns"
            className="csv-profile-selection-checkbox"
            disabled={isApplying}
            onClick={() => dispatchSelection({ type: "toggle-visible", visibleIds })}
            role="checkbox"
            title="Select or clear all shown columns"
            type="button"
          >
            {allVisibleSelected ? (
              <Check aria-hidden="true" />
            ) : someVisibleSelected ? (
              <Minus aria-hidden="true" />
            ) : null}
          </button>
          <span>Column</span>
          <span>Sample</span>
          <span>Recommended</span>
          <span>Type</span>
          <span>Status</span>
        </div>
        <div
          aria-label="CSV profile columns"
          aria-multiselectable="true"
          className="csv-profile-column-grid"
          data-mounted-rows={mountedColumns.length}
          onKeyDown={handleGridKeyDown}
          onScroll={(event: UIEvent<HTMLDivElement>) =>
            setColumnScrollTop(event.currentTarget.scrollTop)
          }
          role="grid"
          style={{ overflow: "auto", position: "relative" }}
          tabIndex={0}
        >
          <div style={{ height: visibleColumns.length * COLUMN_ROW_HEIGHT, position: "relative" }}>
            {mountedColumns.map((column, mountedIndex) => {
              const rowIndex = firstVisibleIndex + mountedIndex;
              const selected = selection.selectedIds.has(column.id);
              return (
                <div
                  aria-rowindex={rowIndex + 1}
                  aria-selected={selected}
                  className={`csv-profile-column-grid__row${selected ? " is-selected" : ""}`}
                  data-testid="csv-profile-column-row"
                  key={column.id}
                  onClick={(event) => toggleColumn(column.id, event)}
                  role="row"
                  style={{
                    height: COLUMN_ROW_HEIGHT,
                    position: "absolute",
                    top: rowIndex * COLUMN_ROW_HEIGHT,
                    width: "100%",
                  }}
                >
                  <button
                    aria-checked={selected}
                    aria-label={`Select ${column.name}`}
                    className="csv-profile-selection-checkbox"
                    disabled={isApplying}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleColumn(column.id, event);
                    }}
                    role="checkbox"
                    type="button"
                  >
                    {selected ? <Check aria-hidden="true" /> : null}
                  </button>
                  <strong role="gridcell">{column.name}</strong>
                  <span role="gridcell" title={column.sampleValues[0] ?? ""}>
                    {column.sampleValues[0] ?? ""}
                  </span>
                  <span role="gridcell">
                    {column.recommendedType} ({Math.round(column.confidence * 100)}%)
                  </span>
                  <label role="gridcell">
                    <span className="visually-hidden">Type for {column.name}</span>
                    <select
                      aria-label={`Type for ${column.name}`}
                      disabled={isApplying}
                      onChange={(event) =>
                        setDraft((current) =>
                          applyBulkSettings(current, new Set([column.id]), {
                            type: event.target.value as CsvProfileType,
                          }),
                        )
                      }
                      onClick={(event) => event.stopPropagation()}
                      value={column.settings.type}
                    >
                      {CSV_PROFILE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span role="gridcell">
                    {column.stats.invalid > 0 && (
                      <button
                        aria-label={`Review invalid values for ${column.name}`}
                        disabled={isApplying}
                        onClick={(event) => {
                          event.stopPropagation();
                          setReviewColumnId(column.id);
                          setPreviewMode("raw");
                        }}
                        type="button"
                      >
                        <TriangleAlert aria-hidden="true" />
                      </button>
                    )}
                    {column.stats.invalid > 0
                      ? `${column.stats.invalid} invalid`
                      : `${column.stats.success} success, ${column.stats.null} null`}
                    {column.changed ? " · Changed" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section aria-label="Sample preview" className="csv-profile-dialog__preview">
        <div className="csv-profile-preview-toolbar">
          <div aria-label="Preview value mode" role="group">
            <button
              aria-pressed={previewMode === "raw"}
              disabled={isApplying}
              onClick={() => setPreviewMode("raw")}
              type="button"
            >
              Raw
            </button>
            <button
              aria-pressed={previewMode === "converted"}
              disabled={isApplying}
              onClick={() => setPreviewMode("converted")}
              type="button"
            >
              Converted
            </button>
          </div>
          {freshPreview ? (
            <span role="status">
              {freshPreview.stage === "head" ? "Head sample" : "Distributed sample"} · generation{" "}
              {freshPreview.generation}
            </span>
          ) : (
            <span role="status">Updating preview</span>
          )}
          <button
            disabled={isApplying || !freshPreview}
            onClick={() => onPreviewRequest(request())}
            type="button"
          >
            <RefreshCcw aria-hidden="true" /> Refresh preview
          </button>
        </div>
        {freshPreview ? <PreviewGrid mode={previewMode} preview={freshPreview} /> : null}
        {reviewColumnId && (
          <aside aria-label="Invalid value samples" className="csv-profile-invalid-samples">
            <strong>Representative invalid originals</strong>
            {invalidSamples.length === 0 ? (
              <span>No invalid values are present in this sample.</span>
            ) : (
              <ul>
                {invalidSamples.map((sample) => (
                  <li key={`${sample.rowIndex}:${sample.raw}`}>
                    <span>Row {sample.rowIndex + 1}</span>
                    <code>{sample.raw}</code>
                    <span>{sample.error ?? "Conversion failed"}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              aria-label="Close invalid samples"
              disabled={isApplying}
              onClick={() => setReviewColumnId(null)}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </aside>
        )}
        {freshValidation ? (
          <div aria-live="polite" className="csv-profile-validation" role="status">
            <strong>{freshValidation.state}</strong>
            <span>
              {freshValidation.rowsScanned.toLocaleString()} /{" "}
              {freshValidation.totalRows?.toLocaleString() ?? "?"} rows
            </span>
            <span>{freshValidation.success.toLocaleString()} success</span>
            <span>{freshValidation.invalid.toLocaleString()} invalid</span>
            {freshValidation.message ? <span>{freshValidation.message}</span> : null}
            {invalidValidationColumns.length > 0 ? (
              <div className="csv-profile-validation__diagnostics">
                {invalidValidationColumns.map((column) => (
                  <section key={column.columnId}>
                    <strong>
                      {column.name}: {column.invalid.toLocaleString()} failures
                    </strong>
                    {column.firstErrorRow !== null ? (
                      <span>First failure row {column.firstErrorRow + 1}</span>
                    ) : null}
                    {column.errorSamples.slice(0, 3).map((sample) => (
                      <div key={`${sample.rowIndex}:${sample.raw}`}>
                        <span>Row {sample.rowIndex + 1}</span>
                        <code>{sample.raw}</code>
                        <span>{sample.message}</span>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
            {freshValidation.invalid > 0 ? (
              <label className="csv-profile-validation__acknowledgement">
                <input
                  aria-label="Acknowledge full-file validation failures"
                  checked={validationAcknowledged}
                  disabled={isApplying || validationRunning}
                  onChange={(event) =>
                    setAcknowledgedValidationKey(
                      event.currentTarget.checked ? validationReviewKey : null,
                    )
                  }
                  type="checkbox"
                />
                <span>I reviewed the full-file validation failures.</span>
              </label>
            ) : null}
          </div>
        ) : null}
        {structuralError ? <div role="alert">{structuralError}</div> : null}
        {requestError ? <div role="alert">{requestError}</div> : null}
      </section>

      <footer className="csv-profile-dialog__footer">
        <button disabled={isApplying} onClick={() => onCancel(context)} type="button">
          Cancel
        </button>
        <button
          disabled={
            isApplying || Boolean(structuralError) || validationRunning || validationReviewRequired
          }
          onClick={() => onApply(request(validationAcknowledged))}
          type="button"
        >
          {isApplying ? "Applying..." : "Apply"}
        </button>
      </footer>
    </div>
  );
}

export default CsvProfileDialog;
