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

export const APP_SETTINGS_SCHEMA_VERSION = 2 as const;
export const DEFAULT_QUERY_TEMP_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export const MIN_QUERY_TEMP_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_QUERY_TEMP_LIMIT_BYTES = 1024 * 1024 * 1024 * 1024;
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
  readonly schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  readonly copyPreset: CopyPreset;
  readonly copyCustomOptions: CopyOptions;
  readonly csvDefaultParsingMode: CsvDefaultParsingMode;
  readonly queryTempLimitBytes: number;
  readonly copyLimits: CopyLimits;
}

export type AppSettings = AppSettingsV2;

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
] as const;
const v1SettingsKeys = settingsKeys.filter((key) => key !== "copyLimits");
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

function freezeSettings(settings: AppSettings): AppSettings {
  return Object.freeze({
    ...settings,
    copyCustomOptions: snapshotCopyOptions(settings.copyCustomOptions),
    copyLimits: Object.freeze({ ...settings.copyLimits }),
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
  });
}

export function parseAppSettings(value: unknown): AppSettings {
  const item = record(value);
  if (!item)
    throw new InvalidAppSettingsError([{ path: "settings", message: "Expected an object." }]);
  const isV1 = item.schemaVersion === 1;
  const issues = exactKeys(item, isV1 ? v1SettingsKeys : settingsKeys, "settings");
  const customOptions = parseCustomOptions(item.copyCustomOptions, issues);
  const copyLimits = isV1 ? DEFAULT_COPY_LIMITS : parseCopyLimits(item.copyLimits, issues);
  if (!isV1 && item.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
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
  if (issues.length > 0 || !customOptions || !copyLimits) throw new InvalidAppSettingsError(issues);
  return freezeSettings({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    copyPreset: item.copyPreset as CopyPreset,
    copyCustomOptions: customOptions,
    csvDefaultParsingMode: item.csvDefaultParsingMode as CsvDefaultParsingMode,
    queryTempLimitBytes: item.queryTempLimitBytes as number,
    copyLimits,
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
