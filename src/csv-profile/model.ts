import type {
  CsvColumnProfileWire,
  CsvParsingProfileWire,
  CsvProfileMode,
  CsvProfilePreviewResponse,
  CsvTargetType,
  CsvValidationStatusWire,
} from "../backend";

export const CSV_PROFILE_TYPES = [
  "Auto",
  "Text",
  "Boolean",
  "Int64",
  "UInt64",
  "Float64",
  "Decimal",
  "Date",
  "Timestamp",
  "Skip",
] as const;

export type CsvProfileType = (typeof CSV_PROFILE_TYPES)[number];
export type CsvFailurePolicy = "preserve-invalid" | "replace-null" | "reject-profile";

export interface CsvColumnSettings {
  type: CsvProfileType;
  trim: boolean;
  nullTokens: readonly string[];
  trueTokens: readonly string[];
  falseTokens: readonly string[];
  decimalSeparator: "." | ",";
  thousandSeparator: "" | "," | "." | " ";
  dateFormats: readonly string[];
  timezone: string;
  failurePolicy: CsvFailurePolicy;
}

export interface CsvColumnStats {
  success: number;
  null: number;
  invalid: number;
}

export interface CsvColumnProfile {
  id: string;
  name: string;
  sampleValues: readonly string[];
  recommendedType: CsvProfileType;
  confidence: number;
  settings: CsvColumnSettings;
  stats: CsvColumnStats;
  changed: boolean;
}

export interface CsvProfileIdentity {
  documentId: string;
  sessionId: string;
}

export interface CsvProfileRequestContext extends CsvProfileIdentity {
  generation: number;
}

export interface CsvProfileRequest extends CsvProfileRequestContext {
  columns: readonly CsvColumnProfile[];
  validationAcknowledged: boolean;
}

export interface CsvPreviewColumn {
  columnId: string;
  name: string;
  recommendedType: CsvProfileType;
  configuredType: CsvProfileType;
  stats: CsvColumnStats;
}

export type CsvPreviewCellStatus = "success" | "null" | "invalid";

export interface CsvPreviewCell {
  columnId: string;
  raw: string;
  converted: string | null;
  status: CsvPreviewCellStatus;
  error?: string;
}

export interface CsvPreviewRow {
  rowIndex: number;
  cells: readonly CsvPreviewCell[];
}

export interface CsvProfilePreview extends CsvProfileRequestContext {
  stage: "head" | "distributed";
  columns: readonly CsvPreviewColumn[];
  rows: readonly CsvPreviewRow[];
}

export interface CsvProfileValidation extends CsvProfileRequestContext {
  state: "idle" | "running" | "complete" | "cancelled" | "failed";
  rowsScanned: number;
  totalRows: number | null;
  success: number;
  invalid: number;
  columns: readonly CsvColumnValidation[];
  message?: string;
}

export interface CsvValidationErrorSample {
  rowIndex: number;
  raw: string;
  message: string;
}

export interface CsvColumnValidation {
  columnId: string;
  name: string;
  success: number;
  null: number;
  invalid: number;
  firstErrorRow: number | null;
  errorSamples: readonly CsvValidationErrorSample[];
}

interface CsvProfileUndoEntry {
  columnId: string;
  before: CsvColumnProfile;
}

export interface CsvProfileDraft {
  generation: number;
  columns: readonly CsvColumnProfile[];
  lastUndo: readonly CsvProfileUndoEntry[] | null;
}

export type CsvColumnSettingsPatch = Partial<CsvColumnSettings>;

export type MixedValue<T> = { kind: "none" } | { kind: "single"; value: T } | { kind: "mixed" };

export function defaultColumnSettings(type: CsvProfileType = "Auto"): CsvColumnSettings {
  return {
    type,
    trim: true,
    nullTokens: ["", "NULL", "N/A"],
    trueTokens: ["true", "TRUE", "1"],
    falseTokens: ["false", "FALSE", "0"],
    decimalSeparator: ".",
    thousandSeparator: "",
    dateFormats: ["YYYY-MM-DD"],
    timezone: "UTC",
    failurePolicy: "preserve-invalid",
  };
}

export function createCsvProfileDraft(
  columns: readonly CsvColumnProfile[],
  generation = 1,
): CsvProfileDraft {
  return {
    generation,
    columns: columns.map(cloneColumn),
    lastUndo: null,
  };
}

function cloneSettings(settings: CsvColumnSettings): CsvColumnSettings {
  return {
    ...settings,
    nullTokens: [...settings.nullTokens],
    trueTokens: [...settings.trueTokens],
    falseTokens: [...settings.falseTokens],
    dateFormats: [...settings.dateFormats],
  };
}

function cloneColumn(column: CsvColumnProfile): CsvColumnProfile {
  return {
    ...column,
    sampleValues: [...column.sampleValues],
    settings: cloneSettings(column.settings),
    stats: { ...column.stats },
  };
}

function settingsValueEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function replaceSelected(
  draft: CsvProfileDraft,
  selectedIds: ReadonlySet<string>,
  update: (column: CsvColumnProfile) => CsvColumnProfile,
): CsvProfileDraft {
  if (selectedIds.size === 0) return draft;
  const undo: CsvProfileUndoEntry[] = [];
  const columns = draft.columns.map((column) => {
    if (!selectedIds.has(column.id)) return column;
    const updated = update(column);
    if (updated === column) return column;
    undo.push({ columnId: column.id, before: cloneColumn(column) });
    return updated;
  });
  if (undo.length === 0) return draft;
  return { generation: draft.generation + 1, columns, lastUndo: undo };
}

export function applyBulkSettings(
  draft: CsvProfileDraft,
  selectedIds: ReadonlySet<string>,
  patch: CsvColumnSettingsPatch,
): CsvProfileDraft {
  const patchEntries = Object.entries(patch) as [
    keyof CsvColumnSettings,
    CsvColumnSettings[keyof CsvColumnSettings],
  ][];
  if (patchEntries.length === 0) return draft;
  return replaceSelected(draft, selectedIds, (column) => {
    const changed = patchEntries.some(
      ([key, value]) => !settingsValueEqual(column.settings[key], value),
    );
    if (!changed) return column;
    return {
      ...column,
      changed: true,
      settings: {
        ...column.settings,
        ...patch,
        nullTokens: patch.nullTokens ? [...patch.nullTokens] : column.settings.nullTokens,
        trueTokens: patch.trueTokens ? [...patch.trueTokens] : column.settings.trueTokens,
        falseTokens: patch.falseTokens ? [...patch.falseTokens] : column.settings.falseTokens,
        dateFormats: patch.dateFormats ? [...patch.dateFormats] : column.settings.dateFormats,
      },
    };
  });
}

export function resetSelectedToRecommended(
  draft: CsvProfileDraft,
  selectedIds: ReadonlySet<string>,
): CsvProfileDraft {
  return replaceSelected(draft, selectedIds, (column) => {
    if (column.settings.type === column.recommendedType) return column;
    return {
      ...column,
      changed: true,
      settings: { ...column.settings, type: column.recommendedType },
    };
  });
}

export function copyColumnSettings(
  draft: CsvProfileDraft,
  sourceColumnId: string,
  selectedIds: ReadonlySet<string>,
): CsvProfileDraft {
  const source = draft.columns.find((column) => column.id === sourceColumnId);
  if (!source) return draft;
  return replaceSelected(draft, selectedIds, (column) => {
    const nextSettings = cloneSettings(source.settings);
    const unchanged = (Object.keys(nextSettings) as (keyof CsvColumnSettings)[]).every((key) =>
      settingsValueEqual(column.settings[key], nextSettings[key]),
    );
    if (unchanged) return column;
    return { ...column, changed: true, settings: nextSettings };
  });
}

export function undoLastBulkChange(draft: CsvProfileDraft): CsvProfileDraft {
  if (!draft.lastUndo) return draft;
  const before = new Map(draft.lastUndo.map((entry) => [entry.columnId, entry.before]));
  return {
    generation: draft.generation + 1,
    columns: draft.columns.map((column) => cloneColumn(before.get(column.id) ?? column)),
    lastUndo: null,
  };
}

export function getMixedSetting<K extends keyof CsvColumnSettings>(
  columns: readonly CsvColumnProfile[],
  selectedIds: ReadonlySet<string>,
  key: K,
): MixedValue<CsvColumnSettings[K]> {
  const selected = columns.filter((column) => selectedIds.has(column.id));
  if (selected.length === 0) return { kind: "none" };
  const first = selected[0].settings[key];
  if (selected.slice(1).some((column) => !settingsValueEqual(first, column.settings[key]))) {
    return { kind: "mixed" };
  }
  return { kind: "single", value: first };
}

export function profileRequest(
  identity: CsvProfileIdentity,
  draft: CsvProfileDraft,
): CsvProfileRequest {
  return {
    ...identity,
    generation: draft.generation,
    columns: draft.columns.map(cloneColumn),
    validationAcknowledged: false,
  };
}

export function matchesCurrentGeneration(
  value: CsvProfileRequestContext | null | undefined,
  identity: CsvProfileIdentity,
  generation: number,
): boolean {
  return Boolean(
    value &&
    value.documentId === identity.documentId &&
    value.sessionId === identity.sessionId &&
    value.generation === generation,
  );
}

const uiTypeByWire: Readonly<Record<CsvTargetType, CsvProfileType>> = {
  auto: "Auto",
  text: "Text",
  boolean: "Boolean",
  int64: "Int64",
  uint64: "UInt64",
  float64: "Float64",
  decimal: "Decimal",
  date: "Date",
  timestamp: "Timestamp",
  skip: "Skip",
};

const wireTypeByUi: Readonly<Record<CsvProfileType, CsvTargetType>> = {
  Auto: "auto",
  Text: "text",
  Boolean: "boolean",
  Int64: "int64",
  UInt64: "uint64",
  Float64: "float64",
  Decimal: "decimal",
  Date: "date",
  Timestamp: "timestamp",
  Skip: "skip",
};

function timezoneLabel(column: CsvColumnProfileWire): string {
  if (column.timezonePolicy === "preserve") return "Preserve";
  if (column.timezonePolicy === "assumeUtc") return "UTC";
  const minutes = column.timezoneOffsetMinutes ?? 0;
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function timezoneWire(
  timezone: string,
): Pick<CsvColumnProfileWire, "timezonePolicy" | "timezoneOffsetMinutes"> {
  if (timezone === "Preserve") return { timezonePolicy: "preserve", timezoneOffsetMinutes: null };
  if (timezone === "UTC") return { timezonePolicy: "assumeUtc", timezoneOffsetMinutes: null };
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) return { timezonePolicy: "preserve", timezoneOffsetMinutes: null };
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return {
    timezonePolicy: "fixedOffset",
    timezoneOffsetMinutes: match[1] === "-" ? -minutes : minutes,
  };
}

export function wireProfileToColumns(profile: CsvParsingProfileWire): CsvColumnProfile[] {
  return profile.columns.map((column) => ({
    id: `csv-column-${column.sourceIndex}`,
    name: column.sourceName,
    sampleValues: [],
    recommendedType: uiTypeByWire[column.targetType],
    confidence: 0,
    settings: {
      type: uiTypeByWire[column.targetType],
      trim: column.trim,
      nullTokens: [...column.nullTokens],
      trueTokens: [...column.trueTokens],
      falseTokens: [...column.falseTokens],
      decimalSeparator: column.decimalSeparator as "." | ",",
      thousandSeparator: (column.thousandSeparator ?? "") as "" | "," | "." | " ",
      dateFormats: [...column.temporalFormats],
      timezone: timezoneLabel(column),
      failurePolicy:
        column.failurePolicy === "preserveInvalid"
          ? "preserve-invalid"
          : column.failurePolicy === "asNull"
            ? "replace-null"
            : "reject-profile",
    },
    stats: { success: 0, null: 0, invalid: 0 },
    changed: false,
  }));
}

export function uiRequestToWireProfile(
  request: CsvProfileRequest,
  base: CsvParsingProfileWire,
  mode: CsvProfileMode = "custom",
): CsvParsingProfileWire {
  if (request.columns.length !== base.columns.length) {
    throw new Error("CSV profile columns no longer match the source schema.");
  }
  return {
    mode,
    generation: request.generation,
    columns: request.columns.map((column, index) => {
      const original = base.columns[index];
      if (!original || original.sourceName !== column.name) {
        throw new Error("CSV profile columns no longer match the source schema.");
      }
      return {
        ...original,
        targetType: wireTypeByUi[column.settings.type],
        trim: column.settings.trim,
        nullTokens: [...column.settings.nullTokens],
        trueTokens: [...column.settings.trueTokens],
        falseTokens: [...column.settings.falseTokens],
        decimalSeparator: column.settings.decimalSeparator,
        thousandSeparator: column.settings.thousandSeparator || null,
        temporalFormats: [...column.settings.dateFormats],
        ...timezoneWire(column.settings.timezone),
        failurePolicy:
          column.settings.failurePolicy === "preserve-invalid"
            ? "preserveInvalid"
            : column.settings.failurePolicy === "replace-null"
              ? "asNull"
              : "fail",
      };
    }),
  };
}

export function wirePreviewToUi(response: CsvProfilePreviewResponse): CsvProfilePreview {
  const { preview } = response;
  return {
    documentId: response.documentId,
    sessionId: response.sessionId,
    generation: preview.generation,
    stage: preview.stage === "leading" ? "head" : "distributed",
    columns: preview.columns.map((column) => ({
      columnId: `csv-column-${column.sourceIndex}`,
      name: column.sourceName,
      recommendedType: uiTypeByWire[column.recommendedType],
      configuredType: uiTypeByWire[column.targetType],
      stats: {
        success: column.successCount,
        null: column.nullCount,
        invalid: column.invalidCount,
      },
    })),
    rows: preview.rows.map((row) => ({
      rowIndex: row.sourceRow,
      cells: row.cells.map((cell, index) => ({
        columnId: `csv-column-${index}`,
        raw: cell.raw,
        converted: cell.converted.display,
        status:
          cell.converted.state === "invalid"
            ? "invalid"
            : cell.converted.state === "null"
              ? "null"
              : "success",
        error: cell.converted.diagnostic?.message,
      })),
    })),
  };
}

export function wireValidationToUi(status: CsvValidationStatusWire): CsvProfileValidation {
  return {
    documentId: status.documentId,
    sessionId: status.sessionId,
    generation: status.generation,
    state:
      status.state === "queued" ? "running" : status.state === "running" ? "running" : status.state,
    rowsScanned: status.rowsScanned,
    totalRows: status.totalRows,
    success: status.columns.reduce((total, column) => total + column.successCount, 0),
    invalid: status.columns.reduce((total, column) => total + column.invalidCount, 0),
    columns: status.columns.map((column) => ({
      columnId: `csv-column-${column.sourceIndex}`,
      name: column.sourceName,
      success: column.successCount,
      null: column.nullCount,
      invalid: column.invalidCount,
      firstErrorRow: column.firstErrorRow,
      errorSamples: column.errorSamples.map((sample) => ({
        rowIndex: sample.sourceRow,
        raw: sample.raw,
        message: sample.message,
      })),
    })),
    message: status.error?.message,
  };
}
