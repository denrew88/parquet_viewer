import type { DataValue } from "../backend";
import {
  assertValidCopyOptions,
  copyOptionWarnings,
  snapshotCopyOptions,
  type CopyOptions,
  type CopyWarning,
} from "./model";

export const COPY_HARD_BYTE_LIMIT = 64 * 1024 * 1024;

export class UnsafeUnquotedFieldError extends Error {
  readonly code = "UnsafeUnquotedField";

  constructor() {
    super("The value contains a delimiter or line break and cannot be copied without quoting.");
    this.name = "UnsafeUnquotedFieldError";
  }
}

export class CopyByteLimitExceededError extends Error {
  readonly code = "CopyByteLimitExceeded";

  constructor(readonly limit: number) {
    super(`The selection exceeds the ${limit.toLocaleString()}-byte clipboard limit.`);
    this.name = "CopyByteLimitExceededError";
  }
}

export class CopyValueFormatError extends Error {
  readonly code = "CopyValueFormat";

  constructor(message: string) {
    super(message);
    this.name = "CopyValueFormatError";
  }
}

interface CopyField {
  readonly text: string;
  readonly forceQuote: boolean;
  readonly neverQuote: boolean;
}

const isoDateTimePattern =
  /^(?<year>[+-]?\d{4,6})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?(?<zone>Z|[+-]\d{2}:\d{2})?)?$/;

function booleanText(value: DataValue, options: CopyOptions): string {
  const normalized = value.display?.toLocaleLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    throw new CopyValueFormatError("Boolean display value must be true or false.");
  }
  if (options.booleanRepresentation === "uppercase") return normalized.toLocaleUpperCase();
  if (options.booleanRepresentation === "numeric") return normalized === "true" ? "1" : "0";
  return normalized;
}

function customDateTimeText(display: string, format: string): string {
  const match = isoDateTimePattern.exec(display);
  if (!match?.groups) {
    throw new CopyValueFormatError(
      "Custom date/time formatting requires an ISO 8601 display value.",
    );
  }
  const values: Readonly<Record<string, string>> = {
    YYYY: match.groups.year,
    MM: match.groups.month,
    DD: match.groups.day,
    HH: match.groups.hour ?? "00",
    mm: match.groups.minute ?? "00",
    ss: match.groups.second ?? "00",
    SSS: (match.groups.fraction ?? "").padEnd(3, "0").slice(0, 3),
    S: match.groups.fraction ?? "",
    XXX: match.groups.zone ?? "",
  };
  return format.replace(/YYYY|SSS|XXX|MM|DD|HH|mm|ss|S/g, (token) => values[token]);
}

function dateTimeText(value: DataValue, options: CopyOptions): string {
  const display = value.display;
  if (display === null) return "";
  const representation = options.dateTimeRepresentation;
  if (representation.mode === "display") return display;
  if (!isoDateTimePattern.test(display)) {
    throw new CopyValueFormatError("ISO 8601 output requires an ISO 8601 display value.");
  }
  return representation.mode === "iso8601"
    ? display
    : customDateTimeText(display, representation.format);
}

function fieldValue(value: DataValue, options: CopyOptions): CopyField {
  if (value.kind === "null" || value.display === null) {
    return { text: options.nullRepresentation, forceQuote: false, neverQuote: true };
  }
  if (value.kind === "string" && value.display === "") {
    return {
      text: "",
      forceQuote: options.emptyStringRepresentation === "quoted-empty",
      neverQuote: false,
    };
  }
  const text =
    value.kind === "boolean"
      ? booleanText(value, options)
      : value.kind === "date" || value.kind === "timestamp"
        ? dateTimeText(value, options)
        : value.display;
  return {
    text,
    forceQuote:
      value.kind === "string" &&
      options.nullRepresentation !== "" &&
      text === options.nullRepresentation,
    neverQuote: false,
  };
}

function escapeQuoted(text: string, options: CopyOptions): string {
  if (options.escapeMode === "double") {
    return text.split(options.quoteCharacter).join(options.quoteCharacter.repeat(2));
  }
  return text
    .split("\\")
    .join("\\\\")
    .split(options.quoteCharacter)
    .join(`\\${options.quoteCharacter}`);
}

function serializeField(field: CopyField, options: CopyOptions): string {
  const structurallyUnsafe =
    field.text.includes(options.delimiter) ||
    field.text.includes("\r") ||
    field.text.includes("\n");
  if (field.neverQuote && structurallyUnsafe) {
    throw new CopyValueFormatError(
      "Null representation cannot contain the delimiter or a line break.",
    );
  }
  if (options.quoteMode === "none") {
    if (structurallyUnsafe || field.forceQuote || field.text.includes(options.quoteCharacter)) {
      throw new UnsafeUnquotedFieldError();
    }
    return field.text;
  }
  const quoted =
    !field.neverQuote &&
    (options.quoteMode === "always" ||
      field.forceQuote ||
      structurallyUnsafe ||
      field.text.includes(options.quoteCharacter));
  return quoted
    ? `${options.quoteCharacter}${escapeQuoted(field.text, options)}${options.quoteCharacter}`
    : field.text;
}

function serializeHeader(header: string, options: CopyOptions): string {
  return serializeField(
    {
      text: header,
      forceQuote:
        header === "" ||
        (options.nullRepresentation !== "" && header === options.nullRepresentation),
      neverQuote: false,
    },
    options,
  );
}

export function serializeCopyField(value: DataValue, options: CopyOptions): string {
  assertValidCopyOptions(options);
  return serializeField(fieldValue(value, options), options);
}

export function serializeCopyRows(
  rows: readonly (readonly DataValue[])[],
  options: CopyOptions,
  headers?: readonly string[],
): string {
  assertValidCopyOptions(options);
  if (options.includeHeaders && !headers) {
    throw new CopyValueFormatError("Column headers are required by the active copy settings.");
  }
  const lines: string[] = [];
  if (options.includeHeaders && headers) {
    lines.push(headers.map((header) => serializeHeader(header, options)).join(options.delimiter));
  }
  for (const row of rows) {
    lines.push(
      row
        .map((value) => serializeField(fieldValue(value, options), options))
        .join(options.delimiter),
    );
  }
  return lines.join(options.lineEnding === "crlf" ? "\r\n" : "\n");
}

export interface CopyPreview {
  readonly text: string;
  readonly warnings: readonly CopyWarning[];
}

export function serializeCopyPreview(
  rows: readonly (readonly DataValue[])[],
  options: CopyOptions,
  headers?: readonly string[],
): CopyPreview {
  return {
    text: serializeCopyRows(rows, options, headers),
    warnings: copyOptionWarnings(options),
  };
}

export class CopyAccumulator {
  private readonly options: CopyOptions;
  private readonly parts: string[] = [];
  private readonly encoder = new TextEncoder();
  private byteLengthValue = 0;
  private hasContent = false;
  private headersWritten = false;

  constructor(
    options: CopyOptions,
    private readonly hardByteLimit = COPY_HARD_BYTE_LIMIT,
  ) {
    if (!Number.isSafeInteger(hardByteLimit) || hardByteLimit < 1) {
      throw new RangeError("Copy byte limit must be a positive safe integer.");
    }
    assertValidCopyOptions(options);
    this.options = snapshotCopyOptions(options);
  }

  get byteLength(): number {
    return this.byteLengthValue;
  }

  appendRows(rows: readonly (readonly DataValue[])[], headers?: readonly string[]): void {
    const writeHeaders = this.options.includeHeaders && !this.headersWritten;
    const chunkOptions = writeHeaders
      ? this.options
      : snapshotCopyOptions({ ...this.options, includeHeaders: false });
    const chunk = serializeCopyRows(rows, chunkOptions, headers);
    if (chunk === "") return;
    const separator = this.hasContent ? (this.options.lineEnding === "crlf" ? "\r\n" : "\n") : "";
    const next = separator + chunk;
    const nextBytes = this.encoder.encode(next).byteLength;
    if (this.byteLengthValue + nextBytes > this.hardByteLimit) {
      throw new CopyByteLimitExceededError(this.hardByteLimit);
    }
    this.parts.push(next);
    this.byteLengthValue += nextBytes;
    this.hasContent = true;
    if (writeHeaders) this.headersWritten = true;
  }

  finish(): string {
    return this.parts.join("");
  }
}
