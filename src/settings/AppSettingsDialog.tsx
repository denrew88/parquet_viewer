import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Copy, Database, FileType2, LoaderCircle, X } from "lucide-react";
import { COPY_PRESETS } from "../copy/presets";
import type { QueryTempUsage } from "../backend";
import {
  MAX_QUERY_TEMP_LIMIT_BYTES,
  MIN_QUERY_TEMP_LIMIT_BYTES,
  parseAppSettings,
  type AppSettingsV1,
  type CsvDefaultParsingMode,
} from "./model";

const GIB = 1024 * 1024 * 1024;
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

function presetLabel(preset: AppSettingsV1["copyPreset"]): string {
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
  initialSettings: AppSettingsV1;
  isObscured?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
  tempUsage?: QueryTempUsage | null;
  tempUsageError?: string | null;
  tempClearMessage?: string | null;
  tempUsageLoading?: boolean;
  onApply(settings: AppSettingsV1): void;
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
  const queryLimitBytes = Number(queryLimitGiB) * GIB;
  const queryLimitError = useMemo(() => {
    if (
      queryLimitGiB.trim() === "" ||
      !Number.isSafeInteger(queryLimitBytes) ||
      queryLimitBytes < MIN_QUERY_TEMP_LIMIT_BYTES ||
      queryLimitBytes > MAX_QUERY_TEMP_LIMIT_BYTES
    ) {
      return "Enter a limit from 0.0625 GiB (64 MiB) to 1,024 GiB (1 TiB).";
    }
    return null;
  }, [queryLimitBytes, queryLimitGiB]);

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
                  max="1024"
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
              {queryLimitError ?? "Allowed range: 64 MiB to 1 TiB."}
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
            disabled={isSaving || queryLimitError !== null}
            onClick={() =>
              onApply(
                parseAppSettings({
                  ...initialSettings,
                  csvDefaultParsingMode: csvMode,
                  queryTempLimitBytes: queryLimitBytes,
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
