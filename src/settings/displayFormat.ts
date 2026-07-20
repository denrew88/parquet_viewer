import type { DataValue } from "../backend";
import type { DigitGrouping, DisplayFormats, FixedDigits } from "./model";

function groupInteger(value: string, grouping: DigitGrouping): string {
  if (grouping === "none") return value;
  const match = /^([+-]?)(\d+)(.*)$/.exec(value);
  if (!match) return value;
  const separator = grouping === "comma" ? "," : ".";
  return `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, separator)}${match[3]}`;
}

function fixedFraction(value: string, setting: FixedDigits): string {
  if (setting.mode === "preserve") return value;
  const match = /^(.*?)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  if (setting.digits === 0) return match[1];
  return `${match[1]}.${(match[2] ?? "").padEnd(setting.digits, "0").slice(0, setting.digits)}`;
}

function formatDate(value: string, format: DisplayFormats["date"]["format"]): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(value);
  if (!match) return value;
  const [, year, month, day, suffix] = match;
  if (format === "YYYY/MM/DD") return `${year}/${month}/${day}${suffix}`;
  if (format === "DD-MM-YYYY") return `${day}-${month}-${year}${suffix}`;
  if (format === "MM-DD-YYYY") return `${month}-${day}-${year}${suffix}`;
  return value;
}

function formatTimestamp(value: string, setting: FixedDigits): string {
  const normalized = value.replace("T", " ").replace(/Z(?: \[.*\])?$/, "");
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(normalized);
  if (!match) return value;
  return fixedFraction(`${match[1]}${match[2] ? `.${match[2]}` : ""}`, setting);
}

function formatBinary(value: string, formats: DisplayFormats["binary"]): string {
  const match = /^base64:([^ ]+) \((\d+) bytes\)$/.exec(value);
  if (!match) return value;
  try {
    const decoded = globalThis.atob(match[1]);
    const preview = decoded.slice(0, formats.previewBytes);
    const totalBytes = Number(match[2]);
    const truncated = totalBytes > preview.length ? "…" : "";
    if (formats.encoding === "base64") {
      return `base64:${globalThis.btoa(preview)}${truncated} (${match[2]} bytes)`;
    }
    const hex = [...preview]
      .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    return `hex:${hex}${truncated} (${match[2]} bytes)`;
  } catch {
    return value;
  }
}

export function formatDataValue(value: DataValue, formats: DisplayFormats): DataValue {
  if (value.display === null || value.state === "invalid") return value;
  const raw = value.rawDisplay ?? value.display;
  const source = value.display;
  let display = source;
  switch (value.kind) {
    case "int":
      display = groupInteger(source, formats.integer.grouping);
      break;
    case "float": {
      const number = Number(source);
      if (Number.isFinite(number)) {
        if (formats.floatingPoint.notation === "fixed") {
          display = number.toFixed(formats.floatingPoint.precision);
        } else if (formats.floatingPoint.notation === "scientific") {
          display = number.toExponential(formats.floatingPoint.precision);
        } else {
          display = source;
        }
      }
      break;
    }
    case "decimal":
      display = fixedFraction(source, formats.decimal.scale);
      display = groupInteger(display, formats.decimal.grouping);
      break;
    case "date":
      display = formatDate(source, formats.date.format);
      break;
    case "timestamp":
      display = formatTimestamp(value.display, formats.timestamp.fractionalDigits);
      break;
    case "boolean":
      display =
        formats.boolean.representation === "numeric"
          ? source.toLowerCase() === "true"
            ? "1"
            : "0"
          : formats.boolean.representation === "uppercase"
            ? source.toUpperCase()
            : source.toLowerCase();
      break;
    case "binary":
      display = formatBinary(source, formats.binary);
      break;
    case "string":
      display = formats.string.renderLineBreaks
        ? source
        : source.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      break;
    case "list":
    case "struct":
    case "map":
      if (formats.nested.format === "pretty") {
        try {
          display = JSON.stringify(JSON.parse(source), null, 2);
        } catch {
          display = source;
        }
      }
      break;
  }
  return display === value.display ? value : { ...value, display, rawDisplay: raw };
}
