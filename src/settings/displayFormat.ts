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

function timestampOffset(value: DataValue, parsedZone: string): string {
  if (parsedZone === "Z" || /^[+-]\d{2}:\d{2}$/.test(parsedZone)) return parsedZone;
  const timezone = value.timezone;
  if (!timezone) return "";
  if (timezone === "UTC" || timezone === "Etc/UTC") return "Z";
  if (/^(?:UTC)?[+-]\d{2}:\d{2}$/.test(timezone)) return timezone.replace(/^UTC/, "");
  if (!value.sourceDisplay || !value.unit || !/^[+-]?\d+$/.test(value.sourceDisplay)) return "";
  try {
    const count = BigInt(value.sourceDisplay);
    const divisor = value.unit === "ns" ? 1_000_000n : value.unit === "us" ? 1_000n : 1n;
    const multiplier = value.unit === "s" ? 1_000n : 1n;
    const milliseconds = Number((count * multiplier) / divisor);
    if (!Number.isSafeInteger(milliseconds)) return "";
    const zoneName = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(milliseconds))
      .find((part) => part.type === "timeZoneName")?.value;
    if (!zoneName) return "";
    if (zoneName === "GMT") return "Z";
    return zoneName.replace(/^GMT/, "");
  } catch {
    return "";
  }
}

function timestampDate(
  year: string,
  month: string,
  day: string,
  format: DisplayFormats["timestamp"]["dateFormat"],
): string {
  if (format === "YYYY/MM/DD") return `${year}/${month}/${day}`;
  if (format === "DD-MM-YYYY") return `${day}-${month}-${year}`;
  if (format === "MM-DD-YYYY") return `${month}-${day}-${year}`;
  return `${year}-${month}-${day}`;
}

function formatTimestamp(value: DataValue, setting: DisplayFormats["timestamp"]): string {
  const source = value.display ?? "";
  const normalized = source.replace("T", " ").replace(/ \[.*\]$/, "");
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      normalized,
    );
  if (!match) return source;
  const [, year, month, day, hour, minute, second, fraction = "", parsedZone = ""] = match;
  const date = timestampDate(year, month, day, setting.dateFormat);
  if (setting.timeFormat === "hidden") return date;
  const separator = setting.dateTimeSeparator === "t" ? "T" : " ";
  const clock =
    setting.timeFormat === "hourMinute" ? `${hour}:${minute}` : `${hour}:${minute}:${second}`;
  const fractionText =
    setting.timeFormat === "hourMinuteSecond"
      ? fixedFraction(`${clock}${fraction ? `.${fraction}` : ""}`, setting.fractionalDigits)
      : clock;
  const suffix =
    setting.timezoneSuffix === "hidden"
      ? ""
      : setting.timezoneSuffix === "name" && value.timezone
        ? /^(?:UTC)?[+-]\d{2}:\d{2}$/.test(value.timezone) || value.timezone === "UTC"
          ? timestampOffset(value, parsedZone)
          : ` [${value.timezone}]`
        : timestampOffset(value, parsedZone);
  return `${date}${separator}${fractionText}${suffix}`;
}

function formatDuration(value: DataValue, setting: DisplayFormats["duration"]): string {
  const source = value.sourceDisplay;
  const unit = value.unit;
  if (!source || !/^[+-]?\d+$/.test(source) || !unit || !["s", "ms", "us", "ns"].includes(unit)) {
    return value.display ?? "";
  }
  try {
    const count = BigInt(source);
    const negative = count < 0n;
    const absolute = negative ? -count : count;
    const multiplier =
      unit === "s" ? 1_000_000_000n : unit === "ms" ? 1_000_000n : unit === "us" ? 1_000n : 1n;
    const nanoseconds = absolute * multiplier;
    const seconds = nanoseconds / 1_000_000_000n;
    const fraction = (nanoseconds % 1_000_000_000n).toString().padStart(9, "0");
    const preservedDigits = unit === "s" ? 0 : unit === "ms" ? 3 : unit === "us" ? 6 : 9;
    const digits =
      setting.fractionalDigits.mode === "preserve"
        ? preservedDigits
        : setting.fractionalDigits.digits;
    const fractionText = digits === 0 ? "" : `.${fraction.slice(0, digits)}`;
    const sign = negative ? "-" : "";
    let display: string;
    if (setting.style === "totalSeconds") {
      display = `${sign}${seconds}${fractionText} s`;
    } else if (setting.style === "totalHours") {
      const hours = seconds / 3_600n;
      const minutes = (seconds % 3_600n) / 60n;
      const remainder = seconds % 60n;
      display = `${sign}${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fractionText}`;
    } else {
      const days = seconds / 86_400n;
      const hours = (seconds % 86_400n) / 3_600n;
      const minutes = (seconds % 3_600n) / 60n;
      const remainder = seconds % 60n;
      const clock = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fractionText}`;
      display = `${sign}${days > 0n ? `${days}d ` : ""}${clock}`;
    }
    return setting.unitSuffix === "source" ? `${display} [unit=${unit}]` : display;
  } catch {
    return value.display ?? "";
  }
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
      display = formatTimestamp(value, formats.timestamp);
      break;
    case "duration":
      display = formatDuration(value, formats.duration);
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
