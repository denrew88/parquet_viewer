import { ChevronDown } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { DataValue } from "../backend";
import { formatDataValue } from "./displayFormat";
import type { DisplayFormats } from "./model";

type FormatType =
  "string" | "integer" | "decimal" | "date" | "timestamp" | "duration" | "boolean" | "binary";

const types: readonly FormatType[] = [
  "string",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "duration",
  "boolean",
  "binary",
];
const labels: Record<FormatType, string> = {
  string: "String",
  integer: "Integer",
  decimal: "Decimal",
  date: "Date",
  timestamp: "Timestamp",
  duration: "Duration",
  boolean: "Boolean",
  binary: "Binary",
};
const hasDetails = new Set<FormatType>(["string", "decimal", "timestamp", "duration", "binary"]);
const samples: Record<FormatType, DataValue> = {
  string: { kind: "string", display: "First line\nSecond line", state: "valid", rawDisplay: null },
  integer: { kind: "int", display: "1234567", state: "valid", rawDisplay: null },
  decimal: { kind: "decimal", display: "1234.567890", state: "valid", rawDisplay: null },
  date: { kind: "date", display: "2025-12-18", state: "valid", rawDisplay: null },
  timestamp: {
    kind: "timestamp",
    display: "2025-12-18T01:23:34.111111111+09:00",
    state: "valid",
    sourceDisplay: "1766017414111111111",
    unit: "ns",
    timezone: "+09:00",
    rawDisplay: "1766017414111111111 [unit=ns, timezone=+09:00]",
    diagnostic: null,
  },
  duration: {
    kind: "duration",
    display: "2d 03:04:05.123456789",
    state: "valid",
    sourceDisplay: "183845123456789",
    unit: "ns",
    timezone: null,
    rawDisplay: "183845123456789 [unit=ns]",
    diagnostic: null,
  },
  boolean: { kind: "boolean", display: "true", state: "valid", rawDisplay: null },
  binary: {
    kind: "binary",
    display: "base64:AQIDBA== (4 bytes)",
    state: "valid",
    rawDisplay: null,
  },
};

function preview(type: FormatType, formats: DisplayFormats): string {
  try {
    return formatDataValue(samples[type], formats).display ?? "";
  } catch {
    return samples[type].display ?? "";
  }
}

function timestampPreset(
  value: DisplayFormats["timestamp"],
): "standard" | "iso" | "dateOnly" | "custom" {
  if (value.timeFormat === "hidden") return "dateOnly";
  if (
    value.dateFormat === "YYYY-MM-DD" &&
    value.dateTimeSeparator === "space" &&
    value.timeFormat === "hourMinuteSecond" &&
    value.fractionalDigits.mode === "preserve" &&
    value.timezoneSuffix === "hidden"
  )
    return "standard";
  if (
    value.dateFormat === "YYYY-MM-DD" &&
    value.dateTimeSeparator === "t" &&
    value.timeFormat === "hourMinuteSecond" &&
    value.fractionalDigits.mode === "preserve" &&
    value.timezoneSuffix === "offset"
  )
    return "iso";
  return "custom";
}

function durationPreset(
  value: DisplayFormats["duration"],
): DisplayFormats["duration"]["style"] | "custom" {
  return value.fractionalDigits.mode === "preserve" && value.unitSuffix === "hidden"
    ? value.style
    : "custom";
}

export interface ValueDisplayFormatsSectionProps {
  value: DisplayFormats;
  onChange(value: DisplayFormats): void;
}

export function ValueDisplayFormatsSection({ value, onChange }: ValueDisplayFormatsSectionProps) {
  const [expanded, setExpanded] = useState<FormatType | null>(null);
  const examples = useMemo(
    () =>
      Object.fromEntries(types.map((type) => [type, preview(type, value)])) as Record<
        FormatType,
        string
      >,
    [value],
  );
  const update = <K extends keyof DisplayFormats>(key: K, next: DisplayFormats[K]) =>
    onChange({ ...value, [key]: next });

  function primary(type: FormatType): ReactNode {
    if (type === "string")
      return (
        <label>
          <input
            type="checkbox"
            checked={value.string.renderLineBreaks}
            onChange={(event) =>
              update("string", { ...value.string, renderLineBreaks: event.target.checked })
            }
          />{" "}
          Render line breaks
        </label>
      );
    if (type === "integer")
      return (
        <label>
          Grouping
          <select
            aria-label="Integer grouping"
            value={value.integer.grouping}
            onChange={(event) =>
              update("integer", {
                grouping: event.target.value as DisplayFormats["integer"]["grouping"],
              })
            }
          >
            <option value="none">None</option>
            <option value="comma">Comma</option>
            <option value="dot">Dot</option>
          </select>
        </label>
      );
    if (type === "decimal")
      return (
        <>
          <label>
            Notation
            <select
              aria-label="Floating notation"
              value={value.floatingPoint.notation}
              onChange={(event) =>
                update("floatingPoint", {
                  ...value.floatingPoint,
                  notation: event.target.value as DisplayFormats["floatingPoint"]["notation"],
                })
              }
            >
              <option value="general">General</option>
              <option value="fixed">Fixed</option>
              <option value="scientific">Scientific</option>
            </select>
          </label>
          <label>
            Grouping
            <select
              aria-label="Decimal grouping"
              value={value.decimal.grouping}
              onChange={(event) =>
                update("decimal", {
                  ...value.decimal,
                  grouping: event.target.value as DisplayFormats["decimal"]["grouping"],
                })
              }
            >
              <option value="none">None</option>
              <option value="comma">Comma</option>
              <option value="dot">Dot</option>
            </select>
          </label>
        </>
      );
    if (type === "date")
      return (
        <label>
          Format
          <select
            aria-label="Date display format"
            value={value.date.format}
            onChange={(event) =>
              update("date", { format: event.target.value as DisplayFormats["date"]["format"] })
            }
          >
            {["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY", "MM-DD-YYYY"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
      );
    if (type === "timestamp")
      return (
        <label>
          Preset
          <select
            aria-label="Timestamp preset"
            value={timestampPreset(value.timestamp)}
            onChange={(event) => {
              if (event.target.value === "standard")
                update("timestamp", {
                  dateFormat: "YYYY-MM-DD",
                  dateTimeSeparator: "space",
                  timeFormat: "hourMinuteSecond",
                  fractionalDigits: { mode: "preserve" },
                  timezoneSuffix: "hidden",
                });
              else if (event.target.value === "iso")
                update("timestamp", {
                  dateFormat: "YYYY-MM-DD",
                  dateTimeSeparator: "t",
                  timeFormat: "hourMinuteSecond",
                  fractionalDigits: { mode: "preserve" },
                  timezoneSuffix: "offset",
                });
              else if (event.target.value === "dateOnly")
                update("timestamp", { ...value.timestamp, timeFormat: "hidden" });
            }}
          >
            <option value="standard">Standard</option>
            <option value="iso">ISO</option>
            <option value="dateOnly">Date only</option>
            <option disabled value="custom">
              Custom
            </option>
          </select>
        </label>
      );
    if (type === "duration")
      return (
        <label>
          Style
          <select
            aria-label="Duration preset"
            value={durationPreset(value.duration)}
            onChange={(event) => {
              if (event.target.value !== "custom")
                update("duration", {
                  style: event.target.value as DisplayFormats["duration"]["style"],
                  fractionalDigits: { mode: "preserve" },
                  unitSuffix: "hidden",
                });
            }}
          >
            <option value="daysClock">Days + clock</option>
            <option value="totalHours">Total hours</option>
            <option value="totalSeconds">Total seconds</option>
            <option disabled value="custom">
              Custom
            </option>
          </select>
        </label>
      );
    if (type === "boolean")
      return (
        <label>
          Format
          <select
            aria-label="Boolean display format"
            value={value.boolean.representation}
            onChange={(event) =>
              update("boolean", {
                representation: event.target.value as DisplayFormats["boolean"]["representation"],
              })
            }
          >
            <option value="lowercase">true / false</option>
            <option value="uppercase">TRUE / FALSE</option>
            <option value="numeric">1 / 0</option>
          </select>
        </label>
      );
    return (
      <label>
        Encoding
        <select
          aria-label="Binary display encoding"
          value={value.binary.encoding}
          onChange={(event) =>
            update("binary", {
              ...value.binary,
              encoding: event.target.value as DisplayFormats["binary"]["encoding"],
            })
          }
        >
          <option value="hex">Hex</option>
          <option value="base64">Base64</option>
        </select>
      </label>
    );
  }

  function details(type: FormatType): ReactNode {
    if (type === "string")
      return (
        <>
          <label>
            <input
              type="checkbox"
              checked={value.string.wrapLongLines}
              onChange={(event) =>
                update("string", { ...value.string, wrapLongLines: event.target.checked })
              }
            />{" "}
            Wrap long strings
          </label>
          <label>
            Nested values
            <select
              aria-label="Nested value display format"
              value={value.nested.format}
              onChange={(event) =>
                update("nested", {
                  format: event.target.value as DisplayFormats["nested"]["format"],
                })
              }
            >
              <option value="compact">Compact</option>
              <option value="pretty">Pretty</option>
            </select>
          </label>
        </>
      );
    if (type === "decimal")
      return (
        <>
          <label>
            Float precision
            <input
              aria-label="Float precision"
              max="17"
              min="1"
              type="number"
              value={value.floatingPoint.precision}
              onChange={(event) =>
                update("floatingPoint", {
                  ...value.floatingPoint,
                  precision: Math.min(17, Math.max(1, Number(event.target.value) || 1)),
                })
              }
            />
          </label>
          <label>
            Scale
            <select
              aria-label="Decimal scale mode"
              value={value.decimal.scale.mode}
              onChange={(event) =>
                update("decimal", {
                  ...value.decimal,
                  scale:
                    event.target.value === "preserve"
                      ? { mode: "preserve" }
                      : { mode: "fixed", digits: 2 },
                })
              }
            >
              <option value="preserve">Preserve</option>
              <option value="fixed">Fixed</option>
            </select>
          </label>
          {value.decimal.scale.mode === "fixed" && (
            <label>
              Digits
              <input
                aria-label="Decimal fixed digits"
                min="0"
                max="38"
                type="number"
                value={value.decimal.scale.digits}
                onChange={(event) =>
                  update("decimal", {
                    ...value.decimal,
                    scale: {
                      mode: "fixed",
                      digits: Math.min(38, Math.max(0, Number(event.target.value) || 0)),
                    },
                  })
                }
              />
            </label>
          )}
        </>
      );
    if (type === "timestamp")
      return (
        <>
          <label>
            Date format
            <select
              aria-label="Timestamp date format"
              value={value.timestamp.dateFormat}
              onChange={(event) =>
                update("timestamp", {
                  ...value.timestamp,
                  dateFormat: event.target.value as DisplayFormats["timestamp"]["dateFormat"],
                })
              }
            >
              {["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY", "MM-DD-YYYY"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            Time format
            <select
              aria-label="Timestamp time format"
              value={value.timestamp.timeFormat}
              onChange={(event) =>
                update("timestamp", {
                  ...value.timestamp,
                  timeFormat: event.target.value as DisplayFormats["timestamp"]["timeFormat"],
                })
              }
            >
              <option value="hourMinuteSecond">HH:MI:SS</option>
              <option value="hourMinute">HH:MI</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          {value.timestamp.timeFormat !== "hidden" && (
            <>
              <label>
                Separator
                <select
                  aria-label="Timestamp separator"
                  value={value.timestamp.dateTimeSeparator}
                  onChange={(event) =>
                    update("timestamp", {
                      ...value.timestamp,
                      dateTimeSeparator: event.target
                        .value as DisplayFormats["timestamp"]["dateTimeSeparator"],
                    })
                  }
                >
                  <option value="space">Space</option>
                  <option value="t">T</option>
                </select>
              </label>
              <FixedDigitsControl
                label="Timestamp"
                value={value.timestamp.fractionalDigits}
                onChange={(fractionalDigits) =>
                  update("timestamp", { ...value.timestamp, fractionalDigits })
                }
              />
              <label>
                Timezone suffix
                <select
                  aria-label="Timestamp timezone suffix"
                  value={value.timestamp.timezoneSuffix}
                  onChange={(event) =>
                    update("timestamp", {
                      ...value.timestamp,
                      timezoneSuffix: event.target
                        .value as DisplayFormats["timestamp"]["timezoneSuffix"],
                    })
                  }
                >
                  <option value="hidden">Hidden</option>
                  <option value="offset">Offset</option>
                  <option value="name">Name</option>
                </select>
              </label>
            </>
          )}
        </>
      );
    if (type === "duration")
      return (
        <>
          <FixedDigitsControl
            label="Duration"
            value={value.duration.fractionalDigits}
            onChange={(fractionalDigits) =>
              update("duration", { ...value.duration, fractionalDigits })
            }
          />
          <label>
            Unit suffix
            <select
              aria-label="Duration unit suffix"
              value={value.duration.unitSuffix}
              onChange={(event) =>
                update("duration", {
                  ...value.duration,
                  unitSuffix: event.target.value as DisplayFormats["duration"]["unitSuffix"],
                })
              }
            >
              <option value="hidden">Hidden</option>
              <option value="source">Source unit</option>
            </select>
          </label>
        </>
      );
    if (type === "binary")
      return (
        <label>
          Preview bytes
          <input
            aria-label="Binary preview bytes"
            type="number"
            min="1"
            max="256"
            value={value.binary.previewBytes}
            onChange={(event) =>
              update("binary", {
                ...value.binary,
                previewBytes: Math.min(256, Math.max(1, Number(event.target.value) || 1)),
              })
            }
          />
        </label>
      );
    return null;
  }

  return (
    <div aria-label="Value display format types" className="display-format-list">
      {types.map((type) => {
        const open = expanded === type;
        return (
          <section className="display-format-row" data-format-type={type} key={type}>
            <div className="display-format-row__summary">
              <strong>{labels[type]}</strong>
              <div className="display-format-row__primary">{primary(type)}</div>
              <output>{examples[type]}</output>
              {hasDetails.has(type) ? (
                <button
                  aria-expanded={open}
                  aria-label={`${open ? "Hide" : "Show"} ${labels[type]} details`}
                  onClick={() => setExpanded(open ? null : type)}
                  type="button"
                >
                  <ChevronDown aria-hidden="true" /> {open ? "Hide details" : "More options"}
                </button>
              ) : (
                <span className="display-format-row__toggle-space" />
              )}
            </div>
            {open && (
              <div aria-label={`${labels[type]} details`} className="display-format-row__details">
                {details(type)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FixedDigitsControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DisplayFormats["timestamp"]["fractionalDigits"];
  onChange(value: DisplayFormats["timestamp"]["fractionalDigits"]): void;
}) {
  return (
    <>
      <label>
        Fraction
        <select
          aria-label={`${label} fractional digits mode`}
          value={value.mode}
          onChange={(event) =>
            onChange(
              event.target.value === "preserve"
                ? { mode: "preserve" }
                : { mode: "fixed", digits: 9 },
            )
          }
        >
          <option value="preserve">Preserve</option>
          <option value="fixed">Fixed</option>
        </select>
      </label>
      {value.mode === "fixed" && (
        <label>
          Digits
          <input
            aria-label={`${label} fractional digits`}
            min="0"
            max="9"
            type="number"
            value={value.digits}
            onChange={(event) =>
              onChange({
                mode: "fixed",
                digits: Math.min(9, Math.max(0, Number(event.target.value) || 0)),
              })
            }
          />
        </label>
      )}
    </>
  );
}
