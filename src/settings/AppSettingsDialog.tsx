import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Copy, Database, FileType2, LoaderCircle, X } from "lucide-react";
import { COPY_PRESETS } from "../copy/presets";
import type { QueryTempUsage } from "../backend";
import {
  MAX_QUERY_TEMP_LIMIT_BYTES,
  MAX_COPY_MAX_BYTES,
  MAX_COPY_MAX_CELLS,
  MIN_QUERY_TEMP_LIMIT_BYTES,
  MIN_COPY_MAX_BYTES,
  MIN_COPY_MAX_CELLS,
  defaultAppSettings,
  parseAppSettings,
  type AppSettings,
  type CsvDefaultParsingMode,
  type DisplayFormats,
} from "./model";
import { ValueDisplayFormatsSection } from "./ValueDisplayFormatsSection";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
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
  initialSettings: AppSettings;
  isObscured?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
  tempUsage?: QueryTempUsage | null;
  tempUsageError?: string | null;
  tempClearMessage?: string | null;
  tempUsageLoading?: boolean;
  onApply(settings: AppSettings): void;
  onCancel(): void;
  onOpenCopySettings(): void;
  onClearTemp?(): void;
}

export function AppSettingsDialog({
  initialSettings,
  isObscured = false,
  isSaving = false,
  saveError = null,
  tempUsage = null,
  tempUsageError = null,
  tempClearMessage = null,
  tempUsageLoading = false,
  onApply,
  onCancel,
  onOpenCopySettings,
  onClearTemp,
}: AppSettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [csvMode, setCsvMode] = useState(initialSettings.csvDefaultParsingMode);
  const [queryLimitGiB, setQueryLimitGiB] = useState(
    String(initialSettings.queryTempLimitBytes / GIB),
  );
  const [copyMaxCells, setCopyMaxCells] = useState(String(initialSettings.copyLimits.maxCells));
  const [copyMaxMiB, setCopyMaxMiB] = useState(String(initialSettings.copyLimits.maxBytes / MIB));
  const [displayFormats, setDisplayFormats] = useState<DisplayFormats>(() =>
    structuredClone(initialSettings.displayFormats),
  );
  const queryLimitBytes = Number(queryLimitGiB) * GIB;
  const copyMaxCellsValue = Number(copyMaxCells);
  const copyMaxBytesValue = Number(copyMaxMiB) * MIB;
  const queryLimitError = useMemo(() => {
    if (
      queryLimitGiB.trim() === "" ||
      !Number.isSafeInteger(queryLimitBytes) ||
      queryLimitBytes < MIN_QUERY_TEMP_LIMIT_BYTES ||
      queryLimitBytes > MAX_QUERY_TEMP_LIMIT_BYTES
    ) {
      return "Enter a limit from 0.0625 GiB (64 MiB) to 10 GiB.";
    }
    return null;
  }, [queryLimitBytes, queryLimitGiB]);
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

  const selectedMode = csvModes.find((mode) => mode.value === csvMode)!;
  const copyOptions =
    initialSettings.copyPreset === "custom"
      ? initialSettings.copyCustomOptions
      : COPY_PRESETS[initialSettings.copyPreset];

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocus?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && !isSaving) {
      event.preventDefault();
      onCancel();
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

  return (
    <div className="dialog-backdrop" data-testid="settings-backdrop" hidden={isObscured}>
      <div
        aria-label="Application settings"
        aria-modal="true"
        className="app-settings-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="settings-dialog__header">
          <div>
            <h2>Settings</h2>
            <p>Defaults for new files and copy operations.</p>
          </div>
          <button
            aria-label="Close settings"
            className="dialog-icon-button"
            disabled={isSaving}
            onClick={onCancel}
            title="Close settings"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-dialog__content">
          <section aria-labelledby="csv-default-heading" className="settings-section">
            <div className="settings-section__heading">
              <FileType2 aria-hidden="true" />
              <div>
                <h3 id="csv-default-heading">CSV default parsing</h3>
                <p>Applies only to CSV documents opened after this setting is saved.</p>
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
            <div aria-label="Default CSV parsing mode" className="settings-segmented" role="group">
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

          <section aria-labelledby="copy-default-heading" className="settings-section">
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
              className={copyMaxCellsError ? "settings-field-error" : "settings-field-description"}
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
              className={copyMaxBytesError ? "settings-field-error" : "settings-field-description"}
              id="copy-max-bytes-help"
              role={copyMaxBytesError ? "alert" : undefined}
            >
              {copyMaxBytesError ?? "Allowed range: 1 to 256 MiB."}
            </p>
          </section>

          <section aria-labelledby="display-format-heading" className="settings-section">
            <div className="settings-section__heading">
              <FileType2 aria-hidden="true" />
              <div>
                <h3 id="display-format-heading">Value display formats</h3>
                <p>
                  Global formatting for cells and display-mode copy. Source values remain unchanged.
                </p>
              </div>
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
                          previewBytes: Math.min(256, Math.max(1, Number(event.target.value) || 1)),
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

          <section aria-labelledby="storage-heading" className="settings-section">
            <div className="settings-section__heading">
              <Database aria-hidden="true" />
              <div>
                <h3 id="storage-heading">Temporary storage</h3>
                <p>Maximum disk space available to query processing in this application process.</p>
              </div>
            </div>
            <label className="settings-number-field">
              Query temporary storage limit
              <span>
                <input
                  aria-label="Query temporary storage limit"
                  aria-describedby="query-temp-limit-help"
                  aria-invalid={queryLimitError !== null}
                  max="10"
                  min="0.0625"
                  onChange={(event) => setQueryLimitGiB(event.target.value)}
                  step="0.0625"
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
            <div className="query-temp-usage" aria-live="polite">
              {tempUsageLoading ? (
                <span role="status">
                  <LoaderCircle aria-hidden="true" /> Reading temporary storage
                </span>
              ) : tempUsageError ? (
                <span role="alert">{tempUsageError}</span>
              ) : tempUsage ? (
                <>
                  <span>
                    {formatStorage(tempUsage.processBytes)} used ·{" "}
                    {tempUsage.activeQueries.toLocaleString()} active
                  </span>
                  <span>{formatStorage(tempUsage.availableBytes)} available on disk</span>
                  <span>
                    {formatStorage(tempUsage.safetyReserveBytes)} safety reserve ·{" "}
                    {formatStorage(tempUsage.hardCapBytes)} hard cap
                  </span>
                </>
              ) : null}
              {tempClearMessage ? <span role="status">{tempClearMessage}</span> : null}
              <button
                disabled={tempUsageLoading || !onClearTemp}
                onClick={onClearTemp}
                type="button"
              >
                Clear inactive query data
              </button>
            </div>
          </section>
        </div>

        {saveError && (
          <p className="settings-save-error" role="alert">
            {saveError}
          </p>
        )}

        <footer className="settings-dialog__actions">
          <button disabled={isSaving} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            disabled={
              isSaving ||
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
