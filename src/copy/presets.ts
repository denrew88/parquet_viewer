import { snapshotCopyOptions, type CopyOptions, type CopyPreset } from "./model";

const excel = snapshotCopyOptions({
  preset: "excel",
  delimiter: "\t",
  includeHeaders: false,
  quoteMode: "minimal",
  quoteCharacter: '"',
  escapeMode: "double",
  lineEnding: "crlf",
  nullRepresentation: "",
  emptyStringRepresentation: "empty",
  booleanRepresentation: "lowercase",
  dateTimeRepresentation: { mode: "display" },
});

const tsv = snapshotCopyOptions({ ...excel, preset: "tsv" });

const csv = snapshotCopyOptions({
  preset: "csv",
  delimiter: ",",
  includeHeaders: false,
  quoteMode: "minimal",
  quoteCharacter: '"',
  escapeMode: "double",
  lineEnding: "crlf",
  nullRepresentation: "NULL",
  emptyStringRepresentation: "quoted-empty",
  booleanRepresentation: "lowercase",
  dateTimeRepresentation: { mode: "display" },
});

const custom = snapshotCopyOptions({ ...csv, preset: "custom", delimiter: "|" });

export const COPY_PRESETS: Readonly<Record<CopyPreset, CopyOptions>> = Object.freeze({
  excel,
  tsv,
  csv,
  custom,
});

export const DEFAULT_COPY_PRESET: CopyPreset = "excel";

export function copyPresetOptions(preset: CopyPreset): CopyOptions {
  return snapshotCopyOptions(COPY_PRESETS[preset]);
}
