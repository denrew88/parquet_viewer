import {
  snapshotCopyOptions,
  validateCopyOptions,
  type BooleanRepresentation,
  type CopyEscapeMode,
  type CopyLineEnding,
  type CopyOptions,
  type CopyPreset,
  type CopyQuoteMode,
  type DateTimeRepresentation,
  type EmptyStringRepresentation,
} from "../copy/model";
import { COPY_PRESETS, DEFAULT_COPY_PRESET } from "../copy/presets";

export const APP_SETTINGS_SCHEMA_VERSION = 4 as const;
export const DEFAULT_QUERY_TEMP_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export const MIN_QUERY_TEMP_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_QUERY_TEMP_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_COPY_MAX_CELLS = 1_000_000;
export const MIN_COPY_MAX_CELLS = 1_000;
export const MAX_COPY_MAX_CELLS = 10_000_000;
export const DEFAULT_COPY_MAX_BYTES = 64 * 1024 * 1024;
export const MIN_COPY_MAX_BYTES = 1024 * 1024;
export const MAX_COPY_MAX_BYTES = 256 * 1024 * 1024;

export type CsvDefaultParsingMode = "auto" | "allText" | "askEveryTime";

export interface CopyLimits {
  readonly maxCells: number;
  readonly maxBytes: number;
}

export const DEFAULT_COPY_LIMITS: CopyLimits = Object.freeze({
  maxCells: DEFAULT_COPY_MAX_CELLS,
  maxBytes: DEFAULT_COPY_MAX_BYTES,
});

export interface AppSettingsV1 {
  readonly schemaVersion: 1;
  readonly copyPreset: CopyPreset;
  readonly copyCustomOptions: CopyOptions;
  readonly csvDefaultParsingMode: CsvDefaultParsingMode;
  readonly queryTempLimitBytes: number;
}

export interface AppSettingsV2 {
  readonly schemaVersion: 2;
  readonly copyPreset: CopyPreset;
  readonly copyCustomOptions: CopyOptions;
  readonly csvDefaultParsingMode: CsvDefaultParsingMode;
  readonly queryTempLimitBytes: number;
  readonly copyLimits: CopyLimits;
}

export type DigitGrouping = "none" | "comma" | "dot";
export type FloatingNotation = "general" | "fixed" | "scientific";
export type FixedDigits =
  { readonly mode: "preserve" } | { readonly mode: "fixed"; readonly digits: number };
export type DateDisplayFormat = "YYYY-MM-DD" | "YYYY/MM/DD" | "DD-MM-YYYY" | "MM-DD-YYYY";
export type TimestampDateTimeSeparator = "space" | "t";
export type TimestampTimeFormat = "hourMinuteSecond" | "hourMinute" | "hidden";
export type TimestampTimezoneSuffix = "hidden" | "offset" | "name";
export type DurationDisplayStyle = "daysClock" | "totalHours" | "totalSeconds";
export type DurationUnitSuffix = "hidden" | "source";
export type BinaryDisplayEncoding = "hex" | "base64";
export type NestedDisplayFormat = "compact" | "pretty";

export interface DisplayFormats {
  readonly integer: { readonly grouping: DigitGrouping };
  readonly floatingPoint: { readonly notation: FloatingNotation; readonly precision: number };
  readonly decimal: { readonly scale: FixedDigits; readonly grouping: DigitGrouping };
  readonly date: { readonly format: DateDisplayFormat };
  readonly timestamp: {
    readonly dateFormat: DateDisplayFormat;
    readonly dateTimeSeparator: TimestampDateTimeSeparator;
    readonly timeFormat: TimestampTimeFormat;
    readonly fractionalDigits: FixedDigits;
    readonly timezoneSuffix: TimestampTimezoneSuffix;
  };
  readonly duration: {
    readonly style: DurationDisplayStyle;
    readonly fractionalDigits: FixedDigits;
    readonly unitSuffix: DurationUnitSuffix;
  };
  readonly boolean: { readonly representation: BooleanRepresentation };
  readonly binary: { readonly encoding: BinaryDisplayEncoding; readonly previewBytes: number };
  readonly string: {
    readonly renderLineBreaks: boolean;
    readonly wrapLongLines: boolean;
    readonly maximumVisibleLines: 2;
  };
  readonly nested: { readonly format: NestedDisplayFormat };
}

export interface LegacyDisplayFormatsV3 extends Omit<DisplayFormats, "timestamp" | "duration"> {
  readonly timestamp: { readonly fractionalDigits: FixedDigits };
}

export interface AppSettingsV3 extends Omit<AppSettingsV2, "schemaVersion"> {
  readonly schemaVersion: 3;
  readonly displayFormats: LegacyDisplayFormatsV3;
}

export interface AppSettingsV4 extends Omit<AppSettingsV2, "schemaVersion"> {
  readonly schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  readonly displayFormats: DisplayFormats;
}

export type AppSettings = AppSettingsV4;

export interface SettingsValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidAppSettingsError extends Error {
  readonly code = "InvalidAppSettings";

  constructor(readonly issues: readonly SettingsValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "));
    this.name = "InvalidAppSettingsError";
  }
}

export interface RecoveredAppSettings {
  readonly settings: AppSettings;
  readonly warning: InvalidAppSettingsError | null;
}

type UnknownRecord = Record<string, unknown>;

const copyPresets: readonly CopyPreset[] = ["excel", "tsv", "csv", "custom"];
const quoteModes: readonly CopyQuoteMode[] = ["minimal", "always", "none"];
const escapeModes: readonly CopyEscapeMode[] = ["double", "backslash"];
const lineEndings: readonly CopyLineEnding[] = ["crlf", "lf"];
const emptyRepresentations: readonly EmptyStringRepresentation[] = ["empty", "quoted-empty"];
const booleanRepresentations: readonly BooleanRepresentation[] = [
  "lowercase",
  "uppercase",
  "numeric",
];
const csvModes: readonly CsvDefaultParsingMode[] = ["auto", "allText", "askEveryTime"];

const settingsKeys = [
  "schemaVersion",
  "copyPreset",
  "copyCustomOptions",
  "csvDefaultParsingMode",
  "queryTempLimitBytes",
  "copyLimits",
  "displayFormats",
] as const;
const v2SettingsKeys = settingsKeys.filter((key) => key !== "displayFormats");
const v1SettingsKeys = v2SettingsKeys.filter((key) => key !== "copyLimits");
const copyLimitKeys = ["maxCells", "maxBytes"] as const;
const copyOptionKeys = [
  "preset",
  "delimiter",
  "includeHeaders",
  "quoteMode",
  "quoteCharacter",
  "escapeMode",
  "lineEnding",
  "nullRepresentation",
  "emptyStringRepresentation",
  "booleanRepresentation",
  "dateTimeRepresentation",
] as const;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
): SettingsValidationIssue[] {
  const actual = Object.keys(value);
  const issues: SettingsValidationIssue[] = [];
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({ path: `${path}.${key}`, message: "Required setting is missing." });
    }
  }
  for (const key of actual) {
    if (!expected.includes(key)) {
      issues.push({ path: `${path}.${key}`, message: "Unknown setting is not allowed." });
    }
  }
  return issues;
}

function parseDateTimeRepresentation(
  value: unknown,
  issues: SettingsValidationIssue[],
): DateTimeRepresentation | null {
  const item = record(value);
  if (!item || typeof item.mode !== "string") {
    issues.push({
      path: "settings.copyCustomOptions.dateTimeRepresentation",
      message: "Invalid value.",
    });
    return null;
  }
  if (item.mode === "display" || item.mode === "iso8601") {
    issues.push(...exactKeys(item, ["mode"], "settings.copyCustomOptions.dateTimeRepresentation"));
    return { mode: item.mode };
  }
  if (item.mode === "custom") {
    issues.push(
      ...exactKeys(item, ["mode", "format"], "settings.copyCustomOptions.dateTimeRepresentation"),
    );
    if (typeof item.format !== "string") {
      issues.push({
        path: "settings.copyCustomOptions.dateTimeRepresentation.format",
        message: "Expected a string.",
      });
      return null;
    }
    return { mode: "custom", format: item.format };
  }
  issues.push({
    path: "settings.copyCustomOptions.dateTimeRepresentation.mode",
    message: "Unknown date/time representation.",
  });
  return null;
}

function parseCustomOptions(value: unknown, issues: SettingsValidationIssue[]): CopyOptions | null {
  const item = record(value);
  if (!item) {
    issues.push({ path: "settings.copyCustomOptions", message: "Expected an object." });
    return null;
  }
  issues.push(...exactKeys(item, copyOptionKeys, "settings.copyCustomOptions"));
  const dateTimeRepresentation = parseDateTimeRepresentation(item.dateTimeRepresentation, issues);
  if (
    item.preset !== "custom" ||
    typeof item.delimiter !== "string" ||
    typeof item.includeHeaders !== "boolean" ||
    !quoteModes.includes(item.quoteMode as CopyQuoteMode) ||
    typeof item.quoteCharacter !== "string" ||
    !escapeModes.includes(item.escapeMode as CopyEscapeMode) ||
    !lineEndings.includes(item.lineEnding as CopyLineEnding) ||
    typeof item.nullRepresentation !== "string" ||
    !emptyRepresentations.includes(item.emptyStringRepresentation as EmptyStringRepresentation) ||
    !booleanRepresentations.includes(item.booleanRepresentation as BooleanRepresentation) ||
    !dateTimeRepresentation
  ) {
    issues.push({ path: "settings.copyCustomOptions", message: "One or more fields are invalid." });
    return null;
  }
  const options: CopyOptions = {
    preset: "custom",
    delimiter: item.delimiter,
    includeHeaders: item.includeHeaders,
    quoteMode: item.quoteMode as CopyQuoteMode,
    quoteCharacter: item.quoteCharacter,
    escapeMode: item.escapeMode as CopyEscapeMode,
    lineEnding: item.lineEnding as CopyLineEnding,
    nullRepresentation: item.nullRepresentation,
    emptyStringRepresentation: item.emptyStringRepresentation as EmptyStringRepresentation,
    booleanRepresentation: item.booleanRepresentation as BooleanRepresentation,
    dateTimeRepresentation,
  };
  for (const issue of validateCopyOptions(options)) {
    issues.push({ path: `settings.copyCustomOptions.${issue.field}`, message: issue.message });
  }
  return options;
}

function parseCopyLimits(value: unknown, issues: SettingsValidationIssue[]): CopyLimits | null {
  const item = record(value);
  if (!item) {
    issues.push({ path: "settings.copyLimits", message: "Expected an object." });
    return null;
  }
  issues.push(...exactKeys(item, copyLimitKeys, "settings.copyLimits"));
  if (
    typeof item.maxCells !== "number" ||
    !Number.isSafeInteger(item.maxCells) ||
    item.maxCells < MIN_COPY_MAX_CELLS ||
    item.maxCells > MAX_COPY_MAX_CELLS
  ) {
    issues.push({
      path: "settings.copyLimits.maxCells",
      message: `Expected an integer from ${MIN_COPY_MAX_CELLS} to ${MAX_COPY_MAX_CELLS}.`,
    });
  }
  if (
    typeof item.maxBytes !== "number" ||
    !Number.isSafeInteger(item.maxBytes) ||
    item.maxBytes < MIN_COPY_MAX_BYTES ||
    item.maxBytes > MAX_COPY_MAX_BYTES
  ) {
    issues.push({
      path: "settings.copyLimits.maxBytes",
      message: `Expected an integer from ${MIN_COPY_MAX_BYTES} to ${MAX_COPY_MAX_BYTES}.`,
    });
  }
  if (issues.some((issue) => issue.path.startsWith("settings.copyLimits"))) return null;
  return { maxCells: item.maxCells as number, maxBytes: item.maxBytes as number };
}

export const DEFAULT_DISPLAY_FORMATS: DisplayFormats = Object.freeze({
  integer: Object.freeze({ grouping: "none" }),
  floatingPoint: Object.freeze({ notation: "general", precision: 17 }),
  decimal: Object.freeze({ scale: Object.freeze({ mode: "preserve" }), grouping: "none" }),
  date: Object.freeze({ format: "YYYY-MM-DD" }),
  timestamp: Object.freeze({
    dateFormat: "YYYY-MM-DD",
    dateTimeSeparator: "space",
    timeFormat: "hourMinuteSecond",
    fractionalDigits: Object.freeze({ mode: "preserve" }),
    timezoneSuffix: "hidden",
  }),
  duration: Object.freeze({
    style: "daysClock",
    fractionalDigits: Object.freeze({ mode: "preserve" }),
    unitSuffix: "hidden",
  }),
  boolean: Object.freeze({ representation: "lowercase" }),
  binary: Object.freeze({ encoding: "hex", previewBytes: 32 }),
  string: Object.freeze({ renderLineBreaks: true, wrapLongLines: true, maximumVisibleLines: 2 }),
  nested: Object.freeze({ format: "compact" }),
});

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: SettingsValidationIssue[],
): value is T {
  if (typeof value === "string" && allowed.includes(value as T)) return true;
  issues.push({ path, message: "Invalid value." });
  return false;
}

function parseFixedDigits(
  value: unknown,
  path: string,
  maximum: number,
  issues: SettingsValidationIssue[],
): FixedDigits | null {
  const item = record(value);
  if (!item || (item.mode !== "preserve" && item.mode !== "fixed")) {
    issues.push({ path, message: "Expected preserve or fixed digits." });
    return null;
  }
  issues.push(...exactKeys(item, item.mode === "fixed" ? ["mode", "digits"] : ["mode"], path));
  if (item.mode === "preserve") return { mode: "preserve" };
  if (
    !Number.isSafeInteger(item.digits) ||
    (item.digits as number) < 0 ||
    (item.digits as number) > maximum
  ) {
    issues.push({ path: `${path}.digits`, message: `Expected an integer from 0 to ${maximum}.` });
    return null;
  }
  return { mode: "fixed", digits: item.digits as number };
}

function parseDisplayFormats(
  value: unknown,
  issues: SettingsValidationIssue[],
): DisplayFormats | null {
  const root = record(value);
  const path = "settings.displayFormats";
  const keys = [
    "integer",
    "floatingPoint",
    "decimal",
    "date",
    "timestamp",
    "duration",
    "boolean",
    "binary",
    "string",
    "nested",
  ];
  if (!root) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  issues.push(...exactKeys(root, keys, path));
  const integer = record(root.integer);
  const floating = record(root.floatingPoint);
  const decimal = record(root.decimal);
  const date = record(root.date);
  const timestamp = record(root.timestamp);
  const duration = record(root.duration);
  const boolean = record(root.boolean);
  const binary = record(root.binary);
  const string = record(root.string);
  const nested = record(root.nested);
  for (const [name, item] of Object.entries({
    integer,
    floatingPoint: floating,
    decimal,
    date,
    timestamp,
    duration,
    boolean,
    binary,
    string,
    nested,
  })) {
    if (!item) issues.push({ path: `${path}.${name}`, message: "Expected an object." });
  }
  if (
    !integer ||
    !floating ||
    !decimal ||
    !date ||
    !timestamp ||
    !duration ||
    !boolean ||
    !binary ||
    !string ||
    !nested
  )
    return null;
  issues.push(...exactKeys(integer, ["grouping"], `${path}.integer`));
  issues.push(...exactKeys(floating, ["notation", "precision"], `${path}.floatingPoint`));
  issues.push(...exactKeys(decimal, ["scale", "grouping"], `${path}.decimal`));
  issues.push(...exactKeys(date, ["format"], `${path}.date`));
  issues.push(
    ...exactKeys(
      timestamp,
      ["dateFormat", "dateTimeSeparator", "timeFormat", "fractionalDigits", "timezoneSuffix"],
      `${path}.timestamp`,
    ),
  );
  issues.push(
    ...exactKeys(duration, ["style", "fractionalDigits", "unitSuffix"], `${path}.duration`),
  );
  issues.push(...exactKeys(boolean, ["representation"], `${path}.boolean`));
  issues.push(...exactKeys(binary, ["encoding", "previewBytes"], `${path}.binary`));
  issues.push(
    ...exactKeys(
      string,
      ["renderLineBreaks", "wrapLongLines", "maximumVisibleLines"],
      `${path}.string`,
    ),
  );
  issues.push(...exactKeys(nested, ["format"], `${path}.nested`));
  const grouping = ["none", "comma", "dot"] as const;
  const integerGrouping = enumValue(integer.grouping, grouping, `${path}.integer.grouping`, issues);
  const notation = enumValue(
    floating.notation,
    ["general", "fixed", "scientific"],
    `${path}.floatingPoint.notation`,
    issues,
  );
  const floatPrecision =
    Number.isSafeInteger(floating.precision) &&
    (floating.precision as number) >= 1 &&
    (floating.precision as number) <= 17;
  if (!floatPrecision)
    issues.push({
      path: `${path}.floatingPoint.precision`,
      message: "Expected an integer from 1 to 17.",
    });
  const decimalScale = parseFixedDigits(decimal.scale, `${path}.decimal.scale`, 38, issues);
  const decimalGrouping = enumValue(decimal.grouping, grouping, `${path}.decimal.grouping`, issues);
  const dateFormat = enumValue(
    date.format,
    ["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY", "MM-DD-YYYY"],
    `${path}.date.format`,
    issues,
  );
  const fractionalDigits = parseFixedDigits(
    timestamp.fractionalDigits,
    `${path}.timestamp.fractionalDigits`,
    9,
    issues,
  );
  const timestampDateFormat = enumValue(
    timestamp.dateFormat,
    ["YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY", "MM-DD-YYYY"],
    `${path}.timestamp.dateFormat`,
    issues,
  );
  const dateTimeSeparator = enumValue(
    timestamp.dateTimeSeparator,
    ["space", "t"],
    `${path}.timestamp.dateTimeSeparator`,
    issues,
  );
  const timeFormat = enumValue(
    timestamp.timeFormat,
    ["hourMinuteSecond", "hourMinute", "hidden"],
    `${path}.timestamp.timeFormat`,
    issues,
  );
  const timezoneSuffix = enumValue(
    timestamp.timezoneSuffix,
    ["hidden", "offset", "name"],
    `${path}.timestamp.timezoneSuffix`,
    issues,
  );
  const durationStyle = enumValue(
    duration.style,
    ["daysClock", "totalHours", "totalSeconds"],
    `${path}.duration.style`,
    issues,
  );
  const durationFractionalDigits = parseFixedDigits(
    duration.fractionalDigits,
    `${path}.duration.fractionalDigits`,
    9,
    issues,
  );
  const durationUnitSuffix = enumValue(
    duration.unitSuffix,
    ["hidden", "source"],
    `${path}.duration.unitSuffix`,
    issues,
  );
  const booleanRepresentation = enumValue(
    boolean.representation,
    booleanRepresentations,
    `${path}.boolean.representation`,
    issues,
  );
  const binaryEncoding = enumValue(
    binary.encoding,
    ["hex", "base64"],
    `${path}.binary.encoding`,
    issues,
  );
  const previewBytes =
    Number.isSafeInteger(binary.previewBytes) &&
    (binary.previewBytes as number) >= 1 &&
    (binary.previewBytes as number) <= 256;
  if (!previewBytes)
    issues.push({
      path: `${path}.binary.previewBytes`,
      message: "Expected an integer from 1 to 256.",
    });
  const validString =
    typeof string.renderLineBreaks === "boolean" &&
    typeof string.wrapLongLines === "boolean" &&
    string.maximumVisibleLines === 2;
  if (!validString)
    issues.push({
      path: `${path}.string`,
      message: "Expected booleans and maximumVisibleLines equal to 2.",
    });
  const nestedFormat = enumValue(
    nested.format,
    ["compact", "pretty"],
    `${path}.nested.format`,
    issues,
  );
  if (
    !integerGrouping ||
    !notation ||
    !floatPrecision ||
    !decimalScale ||
    !decimalGrouping ||
    !dateFormat ||
    !fractionalDigits ||
    !timestampDateFormat ||
    !dateTimeSeparator ||
    !timeFormat ||
    !timezoneSuffix ||
    !durationStyle ||
    !durationFractionalDigits ||
    !durationUnitSuffix ||
    !booleanRepresentation ||
    !binaryEncoding ||
    !previewBytes ||
    !validString ||
    !nestedFormat
  )
    return null;
  return {
    integer: { grouping: integer.grouping as DigitGrouping },
    floatingPoint: {
      notation: floating.notation as FloatingNotation,
      precision: floating.precision as number,
    },
    decimal: { scale: decimalScale, grouping: decimal.grouping as DigitGrouping },
    date: { format: date.format as DateDisplayFormat },
    timestamp: {
      dateFormat: timestamp.dateFormat as DateDisplayFormat,
      dateTimeSeparator: timestamp.dateTimeSeparator as TimestampDateTimeSeparator,
      timeFormat: timestamp.timeFormat as TimestampTimeFormat,
      fractionalDigits,
      timezoneSuffix: timestamp.timezoneSuffix as TimestampTimezoneSuffix,
    },
    duration: {
      style: duration.style as DurationDisplayStyle,
      fractionalDigits: durationFractionalDigits,
      unitSuffix: duration.unitSuffix as DurationUnitSuffix,
    },
    boolean: { representation: boolean.representation as BooleanRepresentation },
    binary: {
      encoding: binary.encoding as BinaryDisplayEncoding,
      previewBytes: binary.previewBytes as number,
    },
    string: {
      renderLineBreaks: string.renderLineBreaks as boolean,
      wrapLongLines: string.wrapLongLines as boolean,
      maximumVisibleLines: 2,
    },
    nested: { format: nested.format as NestedDisplayFormat },
  };
}

function parseLegacyV3DisplayFormats(
  value: unknown,
  issues: SettingsValidationIssue[],
): DisplayFormats | null {
  const path = "settings.displayFormats";
  const root = record(value);
  if (!root) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  issues.push(
    ...exactKeys(
      root,
      [
        "integer",
        "floatingPoint",
        "decimal",
        "date",
        "timestamp",
        "boolean",
        "binary",
        "string",
        "nested",
      ],
      path,
    ),
  );
  const timestamp = record(root.timestamp);
  if (!timestamp) {
    issues.push({ path: `${path}.timestamp`, message: "Expected an object." });
    return null;
  }
  issues.push(...exactKeys(timestamp, ["fractionalDigits"], `${path}.timestamp`));
  return parseDisplayFormats(
    {
      ...root,
      timestamp: {
        ...DEFAULT_DISPLAY_FORMATS.timestamp,
        fractionalDigits: timestamp.fractionalDigits,
      },
      duration: DEFAULT_DISPLAY_FORMATS.duration,
    },
    issues,
  );
}

function freezeSettings(settings: AppSettings): AppSettings {
  return Object.freeze({
    ...settings,
    copyCustomOptions: snapshotCopyOptions(settings.copyCustomOptions),
    copyLimits: Object.freeze({ ...settings.copyLimits }),
    displayFormats: structuredClone(settings.displayFormats),
  });
}

export function defaultAppSettings(): AppSettings {
  return freezeSettings({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    copyPreset: DEFAULT_COPY_PRESET,
    copyCustomOptions: COPY_PRESETS.custom,
    csvDefaultParsingMode: "auto",
    queryTempLimitBytes: DEFAULT_QUERY_TEMP_LIMIT_BYTES,
    copyLimits: DEFAULT_COPY_LIMITS,
    displayFormats: DEFAULT_DISPLAY_FORMATS,
  });
}

export function parseAppSettings(value: unknown): AppSettings {
  const item = record(value);
  if (!item)
    throw new InvalidAppSettingsError([{ path: "settings", message: "Expected an object." }]);
  const isV1 = item.schemaVersion === 1;
  const isV2 = item.schemaVersion === 2;
  const isV3 = item.schemaVersion === 3;
  const issues = exactKeys(
    item,
    isV1 ? v1SettingsKeys : isV2 ? v2SettingsKeys : settingsKeys,
    "settings",
  );
  const customOptions = parseCustomOptions(item.copyCustomOptions, issues);
  const copyLimits = isV1 ? DEFAULT_COPY_LIMITS : parseCopyLimits(item.copyLimits, issues);
  const displayFormats =
    isV1 || isV2
      ? DEFAULT_DISPLAY_FORMATS
      : isV3
        ? parseLegacyV3DisplayFormats(item.displayFormats, issues)
        : parseDisplayFormats(item.displayFormats, issues);
  if (!isV1 && !isV2 && !isV3 && item.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
    issues.push({ path: "settings.schemaVersion", message: "Unsupported settings version." });
  }
  if (!copyPresets.includes(item.copyPreset as CopyPreset)) {
    issues.push({ path: "settings.copyPreset", message: "Unknown copy preset." });
  }
  if (!csvModes.includes(item.csvDefaultParsingMode as CsvDefaultParsingMode)) {
    issues.push({ path: "settings.csvDefaultParsingMode", message: "Unknown CSV parsing mode." });
  }
  if (
    typeof item.queryTempLimitBytes !== "number" ||
    !Number.isSafeInteger(item.queryTempLimitBytes) ||
    item.queryTempLimitBytes < MIN_QUERY_TEMP_LIMIT_BYTES ||
    item.queryTempLimitBytes > MAX_QUERY_TEMP_LIMIT_BYTES
  ) {
    issues.push({
      path: "settings.queryTempLimitBytes",
      message: `Expected an integer from ${MIN_QUERY_TEMP_LIMIT_BYTES} to ${MAX_QUERY_TEMP_LIMIT_BYTES}.`,
    });
  }
  if (issues.length > 0 || !customOptions || !copyLimits || !displayFormats)
    throw new InvalidAppSettingsError(issues);
  return freezeSettings({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    copyPreset: item.copyPreset as CopyPreset,
    copyCustomOptions: customOptions,
    csvDefaultParsingMode: item.csvDefaultParsingMode as CsvDefaultParsingMode,
    queryTempLimitBytes: item.queryTempLimitBytes as number,
    copyLimits,
    displayFormats,
  });
}

export function parseAppSettingsJson(json: string): AppSettings {
  try {
    return parseAppSettings(JSON.parse(json) as unknown);
  } catch (error) {
    if (error instanceof InvalidAppSettingsError) throw error;
    throw new InvalidAppSettingsError([
      { path: "settings", message: "Settings JSON is malformed." },
    ]);
  }
}

export function recoverAppSettings(value: unknown): RecoveredAppSettings {
  try {
    return { settings: parseAppSettings(value), warning: null };
  } catch (error) {
    const warning =
      error instanceof InvalidAppSettingsError
        ? error
        : new InvalidAppSettingsError([{ path: "settings", message: "Settings are invalid." }]);
    return { settings: defaultAppSettings(), warning };
  }
}

export function activeCopyOptions(settings: AppSettings): CopyOptions {
  return settings.copyPreset === "custom"
    ? snapshotCopyOptions(settings.copyCustomOptions)
    : snapshotCopyOptions(COPY_PRESETS[settings.copyPreset]);
}
