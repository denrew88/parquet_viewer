import { CacheLocationControls } from "./CacheLocationControls";
import type { CacheManagementBackend } from "../column-values/backend";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Copy, Database, FileType2, FolderOpen, LoaderCircle, Terminal, X } from "lucide-react";
import { COPY_PRESETS } from "../copy/presets";
import type { QueryTempUsage } from "../backend";
import {
  MAX_COPY_MAX_BYTES,
  MAX_COPY_MAX_CELLS,
  MIN_COPY_MAX_BYTES,
  MIN_COPY_MAX_CELLS,
  defaultAppSettings,
  parseAppSettings,
  parseStorageGiB,
  DEFAULT_SQL_TEMP_LIMIT_BYTES,
  type AppSettings,
  type CsvDefaultParsingMode,
  type DisplayFormats,
} from "./model";
import { ValueDisplayFormatsSection } from "./ValueDisplayFormatsSection";
import type { StorageFolderBackend } from "./storageFolders";
import "./AppSettingsDialog.css";

const categories = ["CSV", "SQL", "Copy", "Display", "Storage"] as const;
type SettingsCategory = (typeof categories)[number];
type StorageKind = "csvCache" | "queryTemp";
type StorageLocations = Awaited<ReturnType<StorageFolderBackend["getLocations"]>>;

function isFocusable(element: HTMLElement): boolean {
  return !element.closest("[hidden]") && element.tabIndex >= 0;
}

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
function editableGiB(bytes: number): string {
  for (let digits = 0; digits <= 10; digits += 1) {
    const value = Number((bytes / GIB).toFixed(digits));
    if (Math.round(value * GIB) === bytes) return String(value);
  }
  return String(bytes / GIB);
}
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const csvModes: readonly {
  value: CsvDefaultParsingMode;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Infer useful column types when a new CSV file is opened.",
  },
  {
    value: "allText",
    label: "All Text",
    description: "Keep every column as text when a new CSV file is opened.",
  },
  {
    value: "askEveryTime",
    label: "Ask Every Time",
    description: "Show parsing choices before each new CSV file is opened.",
  },
];

function delimiterLabel(delimiter: string): string {
  if (delimiter === "\t") return "Tab";
  if (delimiter === ",") return "Comma";
  if (delimiter === ";") return "Semicolon";
  if (delimiter === "|") return "Pipe";
  return delimiter;
}

function presetLabel(preset: AppSettings["copyPreset"]): string {
  if (preset === "tsv") return "TSV";
  if (preset === "csv") return "CSV";
  return preset[0].toLocaleUpperCase() + preset.slice(1);
}

function formatStorage(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export interface AppSettingsDialogProps {
  storageFolders?: StorageFolderBackend;
  cacheBackend?: CacheManagementBackend;
  openDocumentCount?: number;
  onCacheLocationChanged?(): Promise<void>;
  initialSettings: AppSettings;
  isObscured?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
  tempUsage?: QueryTempUsage | null;
  tempUsageError?: string | null;
  queryTempClearMessage?: string | null;
  csvCacheClearMessage?: string | null;
  tempUsageLoading?: boolean;
  queryTempClearing?: boolean;
  csvCacheClearing?: boolean;
  onApply(settings: AppSettings): void;
  onCancel(): void;
  onOpenCopySettings(): void;
  onClearTemp?(): void;
  onClearCsvCache?(): void;
}

export function AppSettingsDialog({
  initialSettings,
  storageFolders,
  cacheBackend,
  openDocumentCount = 0,
  onCacheLocationChanged,
  isObscured = false,
  isSaving = false,
  saveError = null,
  tempUsage = null,
  tempUsageError = null,
  queryTempClearMessage = null,
  csvCacheClearMessage = null,
  tempUsageLoading = false,
  queryTempClearing = false,
  csvCacheClearing = false,
  onApply,
  onCancel,
  onOpenCopySettings,
  onClearTemp,
  onClearCsvCache,
}: AppSettingsDialogProps) {
  const [category, setCategory] = useState<SettingsCategory>("CSV");
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const folderGeneration = useRef(0);
  const folderLifetime = useRef(0);
  const folderFocusRestore = useRef<Partial<Record<StorageKind, HTMLButtonElement>>>({});
  const folderFocusFallback = useRef<HTMLButtonElement | null>(null);
  const [locations, setLocations] = useState<StorageLocations | null>(null);
  const [locationsLoading, setLocationsLoading] = useState(Boolean(storageFolders));
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState<Partial<Record<StorageKind, boolean>>>({});
  const [folderErrors, setFolderErrors] = useState<Partial<Record<StorageKind, string>>>({});
  const refreshLocations = useCallback(async () => {
    const generation = ++folderGeneration.current;
    setLocationsLoading(Boolean(storageFolders));
    setLocationsError(null);
    if (!storageFolders) {
      setLocations(null);
      return;
    }
    try {
      const next = await storageFolders.getLocations();
      if (generation !== folderGeneration.current) return;
      setLocations(next);
      setFolderErrors({});
    } catch (error) {
      if (generation !== folderGeneration.current) return;
      setLocationsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === folderGeneration.current) setLocationsLoading(false);
    }
  }, [storageFolders]);
  const invalidateFolderRequests = useCallback(() => {
    folderGeneration.current++;
    folderLifetime.current++;
    folderFocusRestore.current = {};
    folderFocusFallback.current = null;
  }, []);
  useEffect(() => {
    setLocations(null);
    setFolderBusy({});
    setFolderErrors({});
    void refreshLocations();
    return invalidateFolderRequests;
  }, [invalidateFolderRequests, refreshLocations]);
  async function openFolder(kind: StorageKind, trigger: HTMLButtonElement): Promise<void> {
    if (!storageFolders || folderBusy[kind] || !locations?.[kind].available) return;
    const generation = folderLifetime.current;
    folderFocusRestore.current[kind] = trigger;
    if (document.activeElement === trigger || document.activeElement === document.body) {
      folderFocusFallback.current = trigger;
      dialogRef.current?.focus({ preventScroll: true });
    }
    setFolderBusy((current) => ({ ...current, [kind]: true }));
    setFolderErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      await storageFolders.openFolder(kind);
    } catch (error) {
      if (generation !== folderLifetime.current) return;
      setFolderErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (generation === folderLifetime.current)
        setFolderBusy((current) => ({ ...current, [kind]: false }));
    }
  }
  const handleCacheLocationChanged = useCallback(async () => {
    try {
      await onCacheLocationChanged?.();
    } finally {
      await refreshLocations();
    }
  }, [onCacheLocationChanged, refreshLocations]);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [sqlLimitGiB, setSqlLimitGiB] = useState(editableGiB(initialSettings.sqlTempLimitBytes));
  const sqlLimitBytes = parseStorageGiB(sqlLimitGiB);
  const sqlLimitError =
    sqlLimitBytes === null ? "Enter a limit from 0.0625 GiB (64 MiB) to 10 GiB." : null;
  const [cacheLimitGiB, setCacheLimitGiB] = useState(
    editableGiB(initialSettings.csvCacheLimitBytes),
  );
  const cacheLimitBytes = parseStorageGiB(cacheLimitGiB) ?? NaN;
  const cacheLimitError = !Number.isSafeInteger(cacheLimitBytes)
    ? "Enter a limit from 0.0625 GiB (64 MiB) to 10 GiB."
    : null;
  const dialogRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const kind of ["csvCache", "queryTemp"] as const) {
      const trigger = folderFocusRestore.current[kind];
      if (!trigger || folderBusy[kind]) continue;
      delete folderFocusRestore.current[kind];
      const ownsFallback = folderFocusFallback.current === trigger;
      if (ownsFallback) folderFocusFallback.current = null;
      if (!trigger.isConnected || trigger.disabled || !isFocusable(trigger)) continue;
      if (
        document.activeElement === document.body ||
        document.activeElement === trigger ||
        (ownsFallback && document.activeElement === dialogRef.current)
      )
        trigger.focus({ preventScroll: true });
    }
  }, [folderBusy]);
  const csvCacheClearButtonRef = useRef<HTMLButtonElement>(null);
  const csvCacheConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const queryTempClearButtonRef = useRef<HTMLButtonElement>(null);
  const wasCsvCacheClearing = useRef(false);
  const wasQueryTempClearing = useRef(false);
  const wasConfirmingCsvCacheClear = useRef(false);
  const [confirmingCsvCacheClear, setConfirmingCsvCacheClear] = useState(false);
  const [csvMode, setCsvMode] = useState(initialSettings.csvDefaultParsingMode);
  const [sqlCompletionMode, setSqlCompletionMode] = useState(initialSettings.sqlCompletionMode);
  const [queryLimitGiB, setQueryLimitGiB] = useState(
    editableGiB(initialSettings.queryTempLimitBytes),
  );
  const [copyMaxCells, setCopyMaxCells] = useState(String(initialSettings.copyLimits.maxCells));
  const [copyMaxMiB, setCopyMaxMiB] = useState(String(initialSettings.copyLimits.maxBytes / MIB));
  const [displayFormats, setDisplayFormats] = useState<DisplayFormats>(() =>
    structuredClone(initialSettings.displayFormats),
  );
  const queryLimitBytes = parseStorageGiB(queryLimitGiB) ?? NaN;
  const copyMaxCellsValue = Number(copyMaxCells);
  const copyMaxBytesValue = Number(copyMaxMiB) * MIB;
  const queryLimitError = useMemo(() => {
    if (!Number.isSafeInteger(queryLimitBytes)) {
      return "Enter a limit from 0.0625 GiB (64 MiB) to 10 GiB.";
    }
    return null;
  }, [queryLimitBytes]);
  const copyMaxCellsError = useMemo(() => {
    if (
      copyMaxCells.trim() === "" ||
      !Number.isSafeInteger(copyMaxCellsValue) ||
      copyMaxCellsValue < MIN_COPY_MAX_CELLS ||
      copyMaxCellsValue > MAX_COPY_MAX_CELLS
    ) {
      return "Enter an integer from 1,000 to 10,000,000 cells.";
    }
    return null;
  }, [copyMaxCells, copyMaxCellsValue]);
  const copyMaxBytesError = useMemo(() => {
    if (
      copyMaxMiB.trim() === "" ||
      !Number.isSafeInteger(copyMaxBytesValue) ||
      copyMaxBytesValue < MIN_COPY_MAX_BYTES ||
      copyMaxBytesValue > MAX_COPY_MAX_BYTES
    ) {
      return "Enter an integer from 1 to 256 MiB.";
    }
    return null;
  }, [copyMaxBytesValue, copyMaxMiB]);
  const invalidCategories: SettingsCategory[] = [
    ...(copyMaxCellsError || copyMaxBytesError ? (["Copy"] as const) : []),
    ...(cacheLimitError || sqlLimitError || queryLimitError ? (["Storage"] as const) : []),
  ];

  const selectedMode = csvModes.find((mode) => mode.value === csvMode)!;
  const copyOptions =
    initialSettings.copyPreset === "custom"
      ? initialSettings.copyCustomOptions
      : COPY_PRESETS[initialSettings.copyPreset];

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
        .find(isFocusable)
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (confirmingCsvCacheClear) {
      const button = csvCacheConfirmButtonRef.current;
      if (button && isFocusable(button)) button.focus();
    } else if (wasConfirmingCsvCacheClear.current) {
      const button = csvCacheClearButtonRef.current;
      if (button && isFocusable(button)) button.focus();
    }
    wasConfirmingCsvCacheClear.current = confirmingCsvCacheClear;
  }, [confirmingCsvCacheClear]);

  useEffect(() => {
    if (wasCsvCacheClearing.current && !csvCacheClearing) {
      const button = csvCacheClearButtonRef.current;
      if (button && isFocusable(button)) button.focus();
    }
    wasCsvCacheClearing.current = csvCacheClearing;
  }, [csvCacheClearing]);

  useEffect(() => {
    if (wasQueryTempClearing.current && !queryTempClearing) {
      const button = queryTempClearButtonRef.current;
      if (button && isFocusable(button)) button.focus();
    }
    wasQueryTempClearing.current = queryTempClearing;
  }, [queryTempClearing]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (
      event.key === "Escape" &&
      !isSaving &&
      !queryTempClearing &&
      !csvCacheClearing &&
      !migrationBusy
    ) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    ).filter(isFocusable);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleCategoryKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const nextIndex =
      event.key === "ArrowDown"
        ? (index + 1) % categories.length
        : event.key === "ArrowUp"
          ? (index + categories.length - 1) % categories.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? categories.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    setCategory(categories[nextIndex]);
    categoryRefs.current[nextIndex]?.focus();
  }

  function folderLocation(kind: StorageKind) {
    const location = locations?.[kind];
    const path = location?.path ?? (kind === "csvCache" ? tempUsage?.csvCachePath : null);
    return (
      <div className="settings-folder-location">
        <div className="storage-path">
          <span>Location</span>
          <code title={path ?? undefined}>{path ?? "Location unavailable"}</code>
        </div>
        <button
          type="button"
          disabled={
            !location?.available ||
            locationsLoading ||
            Boolean(locationsError) ||
            Boolean(folderBusy[kind])
          }
          onClick={(event) => void openFolder(kind, event.currentTarget)}
        >
          <FolderOpen aria-hidden="true" />
          {folderBusy[kind] ? "Opening…" : "Open folder"}
        </button>
        {location && !location.available && (
          <p className="settings-field-description">This folder is missing or unavailable.</p>
        )}
        {folderErrors[kind] && (
          <p className="settings-field-error" role="alert">
            {folderErrors[kind]}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" data-testid="settings-backdrop" hidden={isObscured}>
      <div
        aria-label="Application settings"
        aria-modal="true"
        className="app-settings-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="settings-dialog__header">
          <div>
            <h2>Settings</h2>
            <p>Defaults for new files and copy operations.</p>
          </div>
          <button
            aria-label="Close settings"
            className="dialog-icon-button"
            disabled={isSaving || queryTempClearing || csvCacheClearing || migrationBusy}
            onClick={onCancel}
            title="Close settings"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav
            aria-label="Settings categories"
            aria-orientation="vertical"
            className="settings-categories"
            role="tablist"
          >
            {categories.map((name, index) => (
              <button
                aria-controls={`settings-panel-${name.toLowerCase()}`}
                aria-selected={category === name}
                id={`settings-tab-${name.toLowerCase()}`}
                key={name}
                onClick={() => setCategory(name)}
                onKeyDown={(event) => handleCategoryKeyDown(event, index)}
                ref={(element) => {
                  categoryRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={category === name ? 0 : -1}
                type="button"
              >
                {name}
              </button>
            ))}
          </nav>
          <div className="settings-dialog__content">
            <section
              aria-labelledby="settings-tab-csv"
              className="settings-section"
              hidden={category !== "CSV"}
              id="settings-panel-csv"
              role="tabpanel"
            >
              <div className="settings-section__heading">
                <FileType2 aria-hidden="true" />
                <div>
                  <h3 id="csv-default-heading">CSV default parsing</h3>
                  <p>Applies only to CSV documents opened after this setting is saved.</p>
                </div>
              </div>
              <div
                aria-label="Default CSV parsing mode"
                className="settings-segmented"
                role="group"
              >
                {csvModes.map((mode) => (
                  <button
                    aria-pressed={csvMode === mode.value}
                    key={mode.value}
                    onClick={() => setCsvMode(mode.value)}
                    type="button"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <p className="settings-field-description">{selectedMode.description}</p>
            </section>

            <section
              aria-labelledby="settings-tab-sql"
              className="settings-section"
              hidden={category !== "SQL"}
              id="settings-panel-sql"
              role="tabpanel"
            >
              <div className="settings-section__heading">
                <Terminal aria-hidden="true" />
                <div>
                  <h3 id="sql-completion-heading">SQL suggestions</h3>
                  <p>
                    Changes apply to the SQL editor after saving. Ctrl+Space always requests
                    suggestions.
                  </p>
                </div>
              </div>
              <label className="settings-field">
                <span>SQL suggestion mode</span>
                <select
                  aria-label="SQL suggestion mode"
                  value={sqlCompletionMode}
                  onChange={(event) =>
                    setSqlCompletionMode(event.target.value as typeof sqlCompletionMode)
                  }
                >
                  <option value="contextual">Contextual (default)</option>
                  <option value="automatic">Automatic (2+ characters)</option>
                  <option value="manual">Manual (Ctrl+Space)</option>
                </select>
              </label>
              <p className="settings-field-description">
                Contextual suggests tables, columns after a dot or in HAVING, and JOIN conditions
                based on column names and types. Enter or Tab accepts a suggestion. Shift+Enter
                starts a new line.
              </p>
            </section>

            <section
              aria-labelledby="settings-tab-copy"
              className="settings-section"
              hidden={category !== "Copy"}
              id="settings-panel-copy"
              role="tabpanel"
            >
              <div className="settings-section__heading">
                <Copy aria-hidden="true" />
                <div>
                  <h3 id="copy-default-heading">Copy</h3>
                  <p>The active preset is shared by toolbar, keyboard, and context-menu copy.</p>
                </div>
              </div>
              <div className="copy-setting-summary">
                <div>
                  <strong>{presetLabel(initialSettings.copyPreset)}</strong>
                  <span>
                    {delimiterLabel(copyOptions.delimiter)} delimiter
                    {copyOptions.includeHeaders ? ", headers included" : ", no headers"}
                  </span>
                </div>
                <button onClick={onOpenCopySettings} type="button">
                  Copy settings
                </button>
              </div>
              <label className="settings-number-field">
                Maximum cells
                <span>
                  <input
                    aria-describedby="copy-max-cells-help"
                    aria-invalid={copyMaxCellsError !== null}
                    aria-label="Maximum cells"
                    max={MAX_COPY_MAX_CELLS}
                    min={MIN_COPY_MAX_CELLS}
                    onChange={(event) => setCopyMaxCells(event.target.value)}
                    step="1"
                    type="number"
                    value={copyMaxCells}
                  />
                  cells
                </span>
              </label>
              <p
                className={
                  copyMaxCellsError ? "settings-field-error" : "settings-field-description"
                }
                id="copy-max-cells-help"
                role={copyMaxCellsError ? "alert" : undefined}
              >
                {copyMaxCellsError ?? "Allowed range: 1,000 to 10,000,000 cells."}
              </p>
              <label className="settings-number-field">
                Maximum clipboard size
                <span>
                  <input
                    aria-describedby="copy-max-bytes-help"
                    aria-invalid={copyMaxBytesError !== null}
                    aria-label="Maximum clipboard size"
                    max={MAX_COPY_MAX_BYTES / MIB}
                    min={MIN_COPY_MAX_BYTES / MIB}
                    onChange={(event) => setCopyMaxMiB(event.target.value)}
                    step="1"
                    type="number"
                    value={copyMaxMiB}
                  />
                  MiB
                </span>
              </label>
              <p
                className={
                  copyMaxBytesError ? "settings-field-error" : "settings-field-description"
                }
                id="copy-max-bytes-help"
                role={copyMaxBytesError ? "alert" : undefined}
              >
                {copyMaxBytesError ?? "Allowed range: 1 to 256 MiB."}
              </p>
            </section>

            <section
              aria-labelledby="settings-tab-display"
              className="settings-section"
              hidden={category !== "Display"}
              id="settings-panel-display"
              role="tabpanel"
            >
              <div className="settings-section__heading">
                <FileType2 aria-hidden="true" />
                <div>
                  <h3 id="display-format-heading">Value display formats</h3>
                  <p>
                    Global formatting for cells and display-mode copy. Source values remain
                    unchanged.
                  </p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() =>
                    setDisplayFormats(structuredClone(defaultAppSettings().displayFormats))
                  }
                  type="button"
                >
                  Reset display formats
                </button>
              </div>
              <ValueDisplayFormatsSection value={displayFormats} onChange={setDisplayFormats} />
              <div hidden>
                <div className="display-format-grid">
                  <label>
                    Integer grouping
                    <select
                      aria-label="Integer grouping"
                      value={displayFormats.integer.grouping}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          integer: {
                            grouping: event.target.value as DisplayFormats["integer"]["grouping"],
                          },
                        }))
                      }
                    >
                      <option value="none">None (1234567)</option>
                      <option value="comma">Comma (1,234,567)</option>
                      <option value="dot">Dot (1.234.567)</option>
                    </select>
                  </label>
                  <label>
                    Floating notation
                    <select
                      aria-label="Floating notation"
                      value={displayFormats.floatingPoint.notation}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          floatingPoint: {
                            ...current.floatingPoint,
                            notation: event.target
                              .value as DisplayFormats["floatingPoint"]["notation"],
                          },
                        }))
                      }
                    >
                      <option value="general">General</option>
                      <option value="fixed">Fixed</option>
                      <option value="scientific">Scientific</option>
                    </select>
                  </label>
                  <label>
                    Float precision
                    <input
                      aria-label="Float precision"
                      max="17"
                      min="1"
                      type="number"
                      value={displayFormats.floatingPoint.precision}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          floatingPoint: {
                            ...current.floatingPoint,
                            precision: Math.min(17, Math.max(1, Number(event.target.value) || 1)),
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Decimal scale
                    <select
                      aria-label="Decimal scale mode"
                      value={displayFormats.decimal.scale.mode}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          decimal: {
                            ...current.decimal,
                            scale:
                              event.target.value === "preserve"
                                ? { mode: "preserve" }
                                : { mode: "fixed", digits: 2 },
                          },
                        }))
                      }
                    >
                      <option value="preserve">Preserve</option>
                      <option value="fixed">Fixed</option>
                    </select>
                  </label>
                  {displayFormats.decimal.scale.mode === "fixed" && (
                    <label>
                      Decimal digits
                      <input
                        aria-label="Decimal fixed digits"
                        max="38"
                        min="0"
                        type="number"
                        value={displayFormats.decimal.scale.digits}
                        onChange={(event) =>
                          setDisplayFormats((current) => ({
                            ...current,
                            decimal: {
                              ...current.decimal,
                              scale: {
                                mode: "fixed",
                                digits: Math.min(38, Math.max(0, Number(event.target.value) || 0)),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                  )}
                  <label>
                    Decimal grouping
                    <select
                      aria-label="Decimal grouping"
                      value={displayFormats.decimal.grouping}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          decimal: {
                            ...current.decimal,
                            grouping: event.target.value as DisplayFormats["decimal"]["grouping"],
                          },
                        }))
                      }
                    >
                      <option value="none">None</option>
                      <option value="comma">Comma</option>
                      <option value="dot">Dot</option>
                    </select>
                  </label>
                  <label>
                    Date
                    <select
                      aria-label="Date display format"
                      value={displayFormats.date.format}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          date: { format: event.target.value as DisplayFormats["date"]["format"] },
                        }))
                      }
                    >
                      {(["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY", "MM-DD-YYYY"] as const).map(
                        (format) => (
                          <option key={format} value={format}>
                            {format}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Timestamp fraction
                    <select
                      aria-label="Timestamp fractional digits mode"
                      value={displayFormats.timestamp.fractionalDigits.mode}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          timestamp: {
                            ...current.timestamp,
                            fractionalDigits:
                              event.target.value === "preserve"
                                ? { mode: "preserve" }
                                : { mode: "fixed", digits: 9 },
                          },
                        }))
                      }
                    >
                      <option value="preserve">Preserve</option>
                      <option value="fixed">Fixed</option>
                    </select>
                  </label>
                  {displayFormats.timestamp.fractionalDigits.mode === "fixed" && (
                    <label>
                      Timestamp digits
                      <input
                        aria-label="Timestamp fractional digits"
                        max="9"
                        min="0"
                        type="number"
                        value={displayFormats.timestamp.fractionalDigits.digits}
                        onChange={(event) =>
                          setDisplayFormats((current) => ({
                            ...current,
                            timestamp: {
                              ...current.timestamp,
                              fractionalDigits: {
                                mode: "fixed",
                                digits: Math.min(9, Math.max(0, Number(event.target.value) || 0)),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                  )}
                  <label>
                    Boolean
                    <select
                      aria-label="Boolean display format"
                      value={displayFormats.boolean.representation}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          boolean: {
                            representation: event.target
                              .value as DisplayFormats["boolean"]["representation"],
                          },
                        }))
                      }
                    >
                      <option value="lowercase">true / false</option>
                      <option value="uppercase">TRUE / FALSE</option>
                      <option value="numeric">1 / 0</option>
                    </select>
                  </label>
                  <label>
                    Binary
                    <select
                      aria-label="Binary display encoding"
                      value={displayFormats.binary.encoding}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          binary: {
                            ...current.binary,
                            encoding: event.target.value as DisplayFormats["binary"]["encoding"],
                          },
                        }))
                      }
                    >
                      <option value="hex">Hex</option>
                      <option value="base64">Base64</option>
                    </select>
                  </label>
                  <label>
                    Binary preview bytes
                    <input
                      aria-label="Binary preview bytes"
                      max="256"
                      min="1"
                      type="number"
                      value={displayFormats.binary.previewBytes}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          binary: {
                            ...current.binary,
                            previewBytes: Math.min(
                              256,
                              Math.max(1, Number(event.target.value) || 1),
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Nested values
                    <select
                      aria-label="Nested value display format"
                      value={displayFormats.nested.format}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          nested: {
                            format: event.target.value as DisplayFormats["nested"]["format"],
                          },
                        }))
                      }
                    >
                      <option value="compact">Compact</option>
                      <option value="pretty">Pretty</option>
                    </select>
                  </label>
                </div>
                <div className="display-format-checks">
                  <label>
                    <input
                      checked={displayFormats.string.renderLineBreaks}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          string: { ...current.string, renderLineBreaks: event.target.checked },
                        }))
                      }
                      type="checkbox"
                    />{" "}
                    Render string line breaks (maximum 2 visible lines)
                  </label>
                  <label>
                    <input
                      checked={displayFormats.string.wrapLongLines}
                      onChange={(event) =>
                        setDisplayFormats((current) => ({
                          ...current,
                          string: { ...current.string, wrapLongLines: event.target.checked },
                        }))
                      }
                      type="checkbox"
                    />{" "}
                    Wrap long strings
                  </label>
                </div>
                <p className="settings-field-description">
                  Timestamp example: 2025-12-18 01:23:34.111111111 (timezone hidden)
                </p>
              </div>
            </section>

            <section
              aria-labelledby="settings-tab-storage"
              className="settings-section"
              hidden={category !== "Storage"}
              id="settings-panel-storage"
              role="tabpanel"
            >
              <div className="settings-section__heading">
                <Database aria-hidden="true" />
                <div>
                  <h3 id="storage-heading">Storage</h3>
                  <p>
                    Temporary working data and reusable CSV cache share the overall storage limit.
                  </p>
                </div>
              </div>
              {locationsLoading && (
                <p className="settings-field-description" role="status">
                  Reading folder locations…
                </p>
              )}
              {locationsError && (
                <div className="settings-location-error">
                  <p className="settings-field-error" role="alert">
                    {locationsError}
                  </p>
                  <button type="button" onClick={() => void refreshLocations()}>
                    Retry folder locations
                  </button>
                </div>
              )}
              <label className="settings-number-field">
                Overall managed storage limit
                <span>
                  <input
                    aria-label="Overall managed storage limit"
                    aria-describedby="query-temp-limit-help"
                    aria-invalid={queryLimitError !== null}
                    max="10"
                    min="0.0625"
                    onChange={(event) => setQueryLimitGiB(event.target.value)}
                    step="any"
                    type="number"
                    value={queryLimitGiB}
                  />
                  GiB
                </span>
              </label>
              <p
                className={queryLimitError ? "settings-field-error" : "settings-field-description"}
                id="query-temp-limit-help"
                role={queryLimitError ? "alert" : undefined}
              >
                {queryLimitError ?? "Allowed range: 64 MiB to 10 GiB."}
              </p>
              {tempUsageLoading ? (
                <div className="storage-loading" role="status">
                  <LoaderCircle aria-hidden="true" /> Reading storage usage
                </div>
              ) : tempUsageError ? (
                <p className="storage-error" role="alert">
                  {tempUsageError}
                </p>
              ) : null}
              {tempUsage ? (
                <p className="storage-total">
                  Total app-managed storage:{" "}
                  <strong>{formatStorage(tempUsage.processBytes)}</strong>
                </p>
              ) : null}
              <label className="settings-number-field">
                SQL temporary storage per query (GiB)
                <span>
                  <input
                    aria-label="SQL temporary storage per query (GiB)"
                    aria-describedby="sql-temp-limit-help"
                    aria-invalid={sqlLimitError !== null}
                    type="number"
                    min="0.0625"
                    max="10"
                    step="any"
                    value={sqlLimitGiB}
                    onChange={(event) => setSqlLimitGiB(event.target.value)}
                    disabled={migrationBusy}
                  />
                  GiB
                </span>
              </label>
              <p
                id="sql-temp-limit-help"
                className={sqlLimitError ? "settings-field-error" : "settings-field-description"}
                role={sqlLimitError ? "alert" : undefined}
              >
                {sqlLimitError ??
                  `Limits spill files and saved results together. The actual allowance is the smaller of this limit, remaining overall managed storage, and safe free disk space. Applies to new queries only; active queries and existing results keep their allowance.`}
              </p>
              <button
                type="button"
                disabled={migrationBusy}
                onClick={() => setSqlLimitGiB(editableGiB(DEFAULT_SQL_TEMP_LIMIT_BYTES))}
              >
                Reset SQL temporary storage
              </button>
              <div className="storage-groups">
                <section aria-labelledby="query-temp-storage-heading" className="storage-group">
                  <div className="storage-group__summary">
                    <div>
                      <h4 id="query-temp-storage-heading">Query temporary data</h4>
                      <p>Working files created for active filter and sort operations.</p>
                    </div>
                    <strong>{tempUsage ? formatStorage(tempUsage.queryTempBytes) : "—"}</strong>
                  </div>
                  {folderLocation("queryTemp")}
                  {tempUsage ? (
                    <div className="storage-facts">
                      <span>{tempUsage.activeQueries.toLocaleString()} active queries</span>
                      <span>{formatStorage(tempUsage.availableBytes)} available on disk</span>
                      <span>
                        {formatStorage(tempUsage.safetyReserveBytes)} safety reserve ·{" "}
                        {formatStorage(tempUsage.hardCapBytes)} hard cap
                      </span>
                    </div>
                  ) : null}
                  <p className="storage-consequence">
                    Clearing removes inactive query working files only. Reusable CSV cache is kept.
                  </p>
                  <div className="storage-action">
                    <button
                      disabled={
                        tempUsageLoading || queryTempClearing || csvCacheClearing || !onClearTemp
                      }
                      onClick={onClearTemp}
                      ref={queryTempClearButtonRef}
                      type="button"
                    >
                      {queryTempClearing ? (
                        <>
                          <LoaderCircle aria-hidden="true" /> Clearing query data...
                        </>
                      ) : (
                        "Clear inactive query data"
                      )}
                    </button>
                  </div>
                  <div aria-live="polite" aria-atomic="true" className="storage-result">
                    {queryTempClearMessage ? (
                      <span role="status">{queryTempClearMessage}</span>
                    ) : null}
                  </div>
                </section>

                <section aria-labelledby="csv-cache-storage-heading" className="storage-group">
                  <div className="storage-group__summary">
                    <div>
                      <h4 id="csv-cache-storage-heading">Reusable CSV cache</h4>
                      <p>
                        Prepared CSV data is kept between app launches to make later opens faster.
                      </p>
                    </div>
                    <strong>
                      {tempUsage
                        ? `${formatStorage(tempUsage.csvCacheBytes)} · ${tempUsage.csvCacheEntries.toLocaleString()} ${tempUsage.csvCacheEntries === 1 ? "item" : "items"}`
                        : "—"}
                    </strong>
                  </div>
                  <label className="settings-number-field">
                    CSV cache maximum size
                    <span>
                      <input
                        aria-label="CSV cache maximum size"
                        type="number"
                        min="0.0625"
                        max="10"
                        step="any"
                        value={cacheLimitGiB}
                        onChange={(event) => setCacheLimitGiB(event.target.value)}
                        aria-invalid={cacheLimitError !== null}
                        disabled={migrationBusy}
                      />
                      <span>GiB</span>
                    </span>
                  </label>
                  <p
                    className={
                      cacheLimitError ? "settings-field-error" : "settings-field-description"
                    }
                    role={cacheLimitError ? "alert" : undefined}
                  >
                    {cacheLimitError ??
                      `Effective cache limit: ${formatStorage(Math.min(cacheLimitBytes, queryLimitBytes))}. The overall storage limit also applies.`}
                  </p>
                  {tempUsage && (
                    <p className="settings-field-description">
                      In use: {formatStorage(tempUsage.csvCacheActiveBytes ?? 0)} · Reclaimable:{" "}
                      {formatStorage(
                        Math.max(0, tempUsage.csvCacheBytes - (tempUsage.csvCacheActiveBytes ?? 0)),
                      )}
                      . Lowering the limit only removes inactive cache; active items are kept.
                    </p>
                  )}
                  {folderLocation("csvCache")}
                  {cacheBackend && onCacheLocationChanged && (
                    <CacheLocationControls
                      backend={cacheBackend}
                      openDocumentCount={openDocumentCount}
                      disabled={
                        isSaving ||
                        queryTempClearing ||
                        csvCacheClearing ||
                        queryLimitError !== null ||
                        cacheLimitError !== null ||
                        sqlLimitError !== null ||
                        sqlLimitBytes !== initialSettings.sqlTempLimitBytes ||
                        queryLimitBytes !== initialSettings.queryTempLimitBytes ||
                        cacheLimitBytes !== initialSettings.csvCacheLimitBytes
                      }
                      onBusyChange={setMigrationBusy}
                      onComplete={handleCacheLocationChanged}
                    />
                  )}
                  <p className="storage-consequence">
                    Clearing removes inactive prepared data. Source CSV files are never changed, but
                    the next open may need to prepare them again. Cache entries in active use are
                    skipped.
                  </p>
                  {confirmingCsvCacheClear ? (
                    <div
                      aria-labelledby="csv-cache-confirmation-title"
                      className="storage-confirmation"
                      role="group"
                    >
                      <strong id="csv-cache-confirmation-title">Clear inactive CSV cache?</strong>
                      <span>Source files stay unchanged. The next open may take longer.</span>
                      <div>
                        <button
                          onClick={() => {
                            setConfirmingCsvCacheClear(false);
                          }}
                          type="button"
                        >
                          Cancel cache clear
                        </button>
                        <button
                          onClick={() => {
                            setConfirmingCsvCacheClear(false);
                            onClearCsvCache?.();
                          }}
                          ref={csvCacheConfirmButtonRef}
                          type="button"
                        >
                          Confirm clear inactive CSV cache
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="storage-action">
                      <button
                        disabled={
                          tempUsageLoading ||
                          queryTempClearing ||
                          csvCacheClearing ||
                          !onClearCsvCache
                        }
                        onClick={() => setConfirmingCsvCacheClear(true)}
                        ref={csvCacheClearButtonRef}
                        type="button"
                      >
                        {csvCacheClearing ? (
                          <>
                            <LoaderCircle aria-hidden="true" /> Clearing CSV cache...
                          </>
                        ) : (
                          "Clear inactive CSV cache"
                        )}
                      </button>
                    </div>
                  )}
                  <div aria-live="polite" aria-atomic="true" className="storage-result">
                    {csvCacheClearMessage ? (
                      <span role="status">{csvCacheClearMessage}</span>
                    ) : null}
                  </div>
                </section>
              </div>
            </section>
          </div>
        </div>

        {saveError && (
          <p className="settings-save-error" role="alert">
            {saveError}
          </p>
        )}

        <footer className="settings-dialog__actions">
          {invalidCategories.length > 0 && (
            <div className="settings-invalid-drafts" role="status">
              <span>Fix invalid values in</span>
              {invalidCategories.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    setCategory(name);
                    categoryRefs.current[categories.indexOf(name)]?.focus();
                  }}
                  type="button"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <button
            disabled={isSaving || queryTempClearing || csvCacheClearing || migrationBusy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            disabled={
              isSaving ||
              queryTempClearing ||
              csvCacheClearing ||
              migrationBusy ||
              cacheLimitError !== null ||
              sqlLimitError !== null ||
              queryLimitError !== null ||
              copyMaxCellsError !== null ||
              copyMaxBytesError !== null
            }
            onClick={() =>
              onApply(
                parseAppSettings({
                  ...initialSettings,
                  csvDefaultParsingMode: csvMode,
                  queryTempLimitBytes: queryLimitBytes,
                  sqlTempLimitBytes: sqlLimitBytes,
                  sqlCompletionMode,
                  csvCacheLimitBytes: cacheLimitBytes,
                  copyLimits: {
                    maxCells: copyMaxCellsValue,
                    maxBytes: copyMaxBytesValue,
                  },
                  displayFormats,
                }),
              )
            }
            type="button"
          >
            {isSaving && <LoaderCircle aria-hidden="true" />}
            {isSaving ? "Saving..." : "Apply"}
          </button>
        </footer>
      </div>
    </div>
  );
}
