import type { FileSummary } from "../backend";
import type { QueryScalarType } from "./model";

export function inferQueryScalarType(summary: FileSummary, columnId: string): QueryScalarType {
  const schema = summary.columns.find((column) => column.name === columnId);
  const value = `${schema?.logicalType ?? ""} ${schema?.physicalType ?? ""}`.toLocaleLowerCase();
  if (value.includes("timestamp") || value.includes("datetime")) return "timestamp";
  if (value.includes("duration")) return "duration";
  if (value.includes("date")) return "date";
  if (value.includes("decimal")) return "decimal";
  if (value.includes("bool")) return "boolean";
  if (/int|uint|float|double|number/.test(value)) return "number";
  if (/utf|string|char|text/.test(value)) return "text";
  return "other";
}
