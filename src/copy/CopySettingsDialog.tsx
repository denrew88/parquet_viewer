import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DataValue } from "../backend";
import {
  snapshotCopyOptions,
  validateCopyOptions,
  type BooleanRepresentation,
  type CopyEscapeMode,
  type CopyLineEnding,
  type CopyOptions,
  type CopyPreset,
  type CopyQuoteMode,
  type EmptyStringRepresentation,
} from "./model";
import { COPY_PRESETS } from "./presets";
import { serializeCopyPreview } from "./serializer";

export const COPY_PREVIEW_ROW_LIMIT = 20;
export const COPY_PREVIEW_BYTE_LIMIT = 64 * 1024;

export interface CopySettingsValue {
  readonly preset: CopyPreset;
  readonly customOptions: CopyOptions;
}

interface CopySettingsDialogProps {
  initialPreset: CopyPreset;
  initialCustomOptions: CopyOptions;
  sampleRows: readonly (readonly DataValue[])[];
  headers?: readonly string[];
  isApplying?: boolean;
  applyError?: string | null;
  onApply(value: CopySettingsValue): void;
  onCancel(): void;
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const presetLabels: Readonly<Record<CopyPreset, string>> = {
  excel: "Excel",
  tsv: "TSV",
  csv: "CSV",
  custom: "Custom",
};

function truncateUtf8(text: string, byteLimit: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= byteLimit) return { text, truncated: false };
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > byteLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return { text: result, truncated: true };
}

function selectDelimiterKind(delimiter: string): string {
  if (delimiter === "\t") return "tab";
  if (delimiter === ",") return "comma";
  if (delimiter === ";") return "semicolon";
  if (delimiter === "|") return "pipe";
  return "custom";
}

function delimiterForKind(kind: string, current: string): string {
  if (kind === "tab") return "\t";
  if (kind === "comma") return ",";
  if (kind === "semicolon") return ";";
  if (kind === "pipe") return "|";
  return selectDelimiterKind(current) === "custom" ? current : "^";
}

export function CopySettingsDialog({
  initialPreset,
  initialCustomOptions,
  isApplying = false,
  applyError = null,
  sampleRows,
  headers,
  onApply,
  onCancel,
}: CopySettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState(initialPreset);
  const [customOptions, setCustomOptions] = useState<CopyOptions>(() => ({
    ...initialCustomOptions,
    preset: "custom",
    dateTimeRepresentation: { ...initialCustomOptions.dateTimeRepresentation },
  }));

  const activeOptions = preset === "custom" ? customOptions : COPY_PRESETS[preset];
  const preview = useMemo(() => {
    const validationIssues = validateCopyOptions(activeOptions);
    if (validationIssues.length > 0) {
      return {
        error: validationIssues.map((issue) => issue.message).join(" "),
        text: "",
        truncated: false,
        warnings: [],
      };
    }
    try {
      const result = serializeCopyPreview(
        sampleRows.slice(0, COPY_PREVIEW_ROW_LIMIT),
        activeOptions,
        headers,
      );
      const truncated = truncateUtf8(result.text, COPY_PREVIEW_BYTE_LIMIT);
      return {
        error: null,
        text: truncated.text,
        truncated: truncated.truncated || sampleRows.length > COPY_PREVIEW_ROW_LIMIT,
        warnings: result.warnings,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Preview could not be generated.",
        text: "",
        truncated: false,
        warnings: [],
      };
    }
  }, [activeOptions, headers, sampleRows]);

  function updateCustom(update: Partial<CopyOptions>): void {
    setCustomOptions((current) => ({ ...current, ...update, preset: "custom" }));
  }

  const delimiterKind = selectDelimiterKind(customOptions.delimiter);
  const customDateTime = customOptions.dateTimeRepresentation.mode === "custom";

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
    if (event.key === "Escape" && !isApplying) {
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
    <div className="dialog-backdrop">
      <div
        aria-label="Copy settings"
        aria-modal="true"
        className="copy-settings-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="copy-settings-dialog__header">
          <h2>Copy settings</h2>
        </header>

        <div aria-label="Copy preset" className="copy-settings-dialog__presets" role="group">
          {(Object.keys(presetLabels) as CopyPreset[]).map((candidate) => (
            <button
              aria-pressed={preset === candidate}
              key={candidate}
              onClick={() => setPreset(candidate)}
              type="button"
            >
              {presetLabels[candidate]}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <div className="copy-settings-dialog__custom">
            <label>
              Delimiter
              <select
                aria-label="Delimiter"
                onChange={(event) =>
                  updateCustom({
                    delimiter: delimiterForKind(event.target.value, customOptions.delimiter),
                  })
                }
                value={delimiterKind}
              >
                <option value="tab">Tab</option>
                <option value="comma">Comma</option>
                <option value="semicolon">Semicolon</option>
                <option value="pipe">Pipe</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {delimiterKind === "custom" && (
              <label>
                Custom delimiter
                <input
                  aria-label="Custom delimiter"
                  onChange={(event) => updateCustom({ delimiter: event.target.value })}
                  value={customOptions.delimiter}
                />
              </label>
            )}
            <label>
              <input
                checked={customOptions.includeHeaders}
                onChange={(event) => updateCustom({ includeHeaders: event.target.checked })}
                type="checkbox"
              />
              Include column headers
            </label>
            <label>
              Quote mode
              <select
                aria-label="Quote mode"
                onChange={(event) =>
                  updateCustom({ quoteMode: event.target.value as CopyQuoteMode })
                }
                value={customOptions.quoteMode}
              >
                <option value="minimal">When needed</option>
                <option value="always">Always</option>
                <option value="none">Never</option>
              </select>
            </label>
            <label>
              Quote character
              <input
                aria-label="Quote character"
                onChange={(event) => updateCustom({ quoteCharacter: event.target.value })}
                value={customOptions.quoteCharacter}
              />
            </label>
            <label>
              Escape
              <select
                aria-label="Escape"
                onChange={(event) =>
                  updateCustom({ escapeMode: event.target.value as CopyEscapeMode })
                }
                value={customOptions.escapeMode}
              >
                <option value="double">Double quote</option>
                <option value="backslash">Backslash</option>
              </select>
            </label>
            <fieldset>
              <legend>Line ending</legend>
              {(["crlf", "lf"] as CopyLineEnding[]).map((lineEnding) => (
                <button
                  aria-pressed={customOptions.lineEnding === lineEnding}
                  key={lineEnding}
                  onClick={() => updateCustom({ lineEnding })}
                  type="button"
                >
                  {lineEnding.toLocaleUpperCase()}
                </button>
              ))}
            </fieldset>
            <label>
              Null
              <input
                aria-label="Null representation"
                onChange={(event) => updateCustom({ nullRepresentation: event.target.value })}
                value={customOptions.nullRepresentation}
              />
            </label>
            <label>
              Empty string
              <select
                aria-label="Empty string representation"
                onChange={(event) =>
                  updateCustom({
                    emptyStringRepresentation: event.target.value as EmptyStringRepresentation,
                  })
                }
                value={customOptions.emptyStringRepresentation}
              >
                <option value="empty">Empty field</option>
                <option value="quoted-empty">Quoted empty string</option>
              </select>
            </label>
            <label>
              Boolean
              <select
                aria-label="Boolean representation"
                onChange={(event) =>
                  updateCustom({
                    booleanRepresentation: event.target.value as BooleanRepresentation,
                  })
                }
                value={customOptions.booleanRepresentation}
              >
                <option value="lowercase">true/false</option>
                <option value="uppercase">TRUE/FALSE</option>
                <option value="numeric">1/0</option>
              </select>
            </label>
            <label>
              Date and timestamp
              <select
                aria-label="Date and timestamp representation"
                onChange={(event) => {
                  const mode = event.target.value;
                  updateCustom({
                    dateTimeRepresentation:
                      mode === "custom"
                        ? { mode: "custom", format: "YYYY-MM-DD HH:mm:ss" }
                        : { mode: mode as "display" | "iso8601" },
                  });
                }}
                value={customOptions.dateTimeRepresentation.mode}
              >
                <option value="display">Current display</option>
                <option value="iso8601">ISO 8601</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {customDateTime && (
              <label>
                Date and timestamp format
                <input
                  aria-label="Date and timestamp format"
                  onChange={(event) =>
                    updateCustom({
                      dateTimeRepresentation: { mode: "custom", format: event.target.value },
                    })
                  }
                  value={customOptions.dateTimeRepresentation.format}
                />
              </label>
            )}
          </div>
        )}

        <section aria-labelledby="copy-preview-heading" className="copy-settings-dialog__preview">
          <h3 id="copy-preview-heading">Preview</h3>
          {preview.warnings.map((warning) => (
            <p className="copy-settings-dialog__warning" key={warning.code} role="status">
              {warning.message}
            </p>
          ))}
          {preview.error && (
            <p className="copy-settings-dialog__error" role="alert">
              {preview.error}
            </p>
          )}
          <pre aria-label="Copy preview">{preview.text}</pre>
          {preview.truncated && <span role="status">Preview truncated</span>}
        </section>

        {applyError && (
          <p className="copy-settings-dialog__error copy-settings-dialog__save-error" role="alert">
            {applyError}
          </p>
        )}

        <footer className="copy-settings-dialog__actions">
          <button disabled={isApplying} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            disabled={preview.error !== null || isApplying}
            onClick={() =>
              onApply({
                preset,
                customOptions: snapshotCopyOptions(customOptions),
              })
            }
            type="button"
          >
            {isApplying ? "Saving..." : "Apply"}
          </button>
        </footer>
      </div>
    </div>
  );
}
