import { describe, expect, it } from "vitest";
import type { ColumnSchema, FileSummary } from "../backend";
import { inferQueryScalarType } from "./scalarType";

function summaryWith(column: ColumnSchema): FileSummary {
  return {
    sessionId: "dictionary-session",
    fileName: "dictionary.parquet",
    path: "C:\\fixtures\\dictionary.parquet",
    format: "parquet",
    fileSize: 1,
    rowCount: 1,
    rowCountStatus: {
      state: "complete",
      rowsScanned: 1,
      bytesScanned: 1,
      totalBytes: 1,
      generation: 0,
      message: null,
    },
    columnCount: 1,
    rowGroupCount: 0,
    columns: [column],
    rowGroups: [],
    csvMetadata: null,
  };
}

describe("inferQueryScalarType", () => {
  it.each([
    ["Utf8", "text"],
    ["Int64", "number"],
    ["Decimal128(28, 9)", "decimal"],
    ["Date32", "date"],
    ["Timestamp(Nanosecond, UTC)", "timestamp"],
    ["Duration(Millisecond)", "duration"],
    ["Boolean", "boolean"],
    ["Binary", "other"],
  ] as const)("classifies dictionary value type %s as %s", (valueLogicalType, expected) => {
    expect(
      inferQueryScalarType(
        summaryWith({
          name: "category",
          logicalType: `Dictionary(Int8, ${valueLogicalType})`,
          valueLogicalType,
          nullable: true,
          physicalType: "INT8 UTF8 NUMBER",
        }),
        "category",
      ),
    ).toBe(expected);
  });

  it("does not inspect dictionary keys, the original wrapper, or physical type", () => {
    expect(
      inferQueryScalarType(
        summaryWith({
          name: "payload",
          logicalType: "Dictionary(Int8, Binary)",
          valueLogicalType: "Binary",
          nullable: false,
          physicalType: "UTF8 NUMBER",
        }),
        "payload",
      ),
    ).toBe("other");
  });
});
