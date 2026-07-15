import { describe, expect, it } from "vitest";

import {
  applyBulkSettings,
  copyColumnSettings,
  createCsvProfileDraft,
  defaultColumnSettings,
  getMixedSetting,
  resetSelectedToRecommended,
  uiRequestToWireProfile,
  undoLastBulkChange,
  wirePreviewToUi,
  wireProfileToColumns,
  wireValidationToUi,
  type CsvColumnProfile,
  type CsvProfileType,
} from "./model";
import type {
  CsvParsingProfileWire,
  CsvProfilePreviewResponse,
  CsvValidationStatusWire,
} from "../backend";
import {
  EMPTY_CSV_COLUMN_SELECTION,
  csvColumnSelectionReducer,
  type CsvColumnSelectionState,
} from "./selection";

function column(id: string, type: CsvProfileType, recommendedType = type): CsvColumnProfile {
  return {
    id,
    name: id,
    sampleValues: [`sample-${id}`],
    recommendedType,
    confidence: 0.9,
    settings: {
      ...defaultColumnSettings(type),
      nullTokens: ["", `${id}-null`],
      dateFormats: [`${id}-format`],
    },
    stats: { success: 10, null: 1, invalid: 0 },
    changed: false,
  };
}

describe("CSV profile column selection", () => {
  const visibleIds = ["a", "b", "c", "d", "e"];

  function click(
    state: CsvColumnSelectionState,
    columnId: string,
    options: { ctrl?: boolean; shift?: boolean } = {},
  ) {
    return csvColumnSelectionReducer(state, {
      type: "click",
      columnId,
      visibleIds,
      ctrl: options.ctrl ?? false,
      shift: options.shift ?? false,
    });
  }

  it("supports plain, Ctrl toggle, and anchor-based Shift ranges", () => {
    let state = click(EMPTY_CSV_COLUMN_SELECTION, "b");
    expect([...state.selectedIds]).toEqual(["b"]);

    state = click(state, "d", { ctrl: true });
    expect([...state.selectedIds]).toEqual(["b", "d"]);
    expect(state.anchorId).toBe("d");

    state = click(state, "b", { shift: true });
    expect([...state.selectedIds]).toEqual(["b", "c", "d"]);
    expect(state.activeId).toBe("b");

    state = click(state, "e", { ctrl: true, shift: true });
    expect([...state.selectedIds]).toEqual(["b", "c", "d", "e"]);
  });

  it("selects only the filtered result for Ctrl+A and toggles visible rows independently", () => {
    const filtered = ["b", "d"];
    let state = csvColumnSelectionReducer(EMPTY_CSV_COLUMN_SELECTION, {
      type: "select-visible",
      visibleIds: filtered,
    });
    expect([...state.selectedIds]).toEqual(filtered);

    state = csvColumnSelectionReducer(state, { type: "toggle-visible", visibleIds: ["d", "e"] });
    expect([...state.selectedIds]).toEqual(["b", "d", "e"]);

    state = csvColumnSelectionReducer(state, { type: "toggle-visible", visibleIds: ["d", "e"] });
    expect([...state.selectedIds]).toEqual(["b"]);
  });
});

describe("CSV profile bulk operations", () => {
  it("applies only explicit fields and reports mixed values", () => {
    const original = createCsvProfileDraft([column("a", "Text"), column("b", "Int64")], 9);
    const selected = new Set(["a", "b"]);
    expect(getMixedSetting(original.columns, selected, "type")).toEqual({ kind: "mixed" });

    const updated = applyBulkSettings(original, selected, { type: "Decimal" });
    expect(updated.generation).toBe(10);
    expect(updated.columns.map((item) => item.settings.type)).toEqual(["Decimal", "Decimal"]);
    expect(updated.columns.map((item) => item.settings.nullTokens)).toEqual([
      ["", "a-null"],
      ["", "b-null"],
    ]);
    expect(updated.columns.map((item) => item.settings.dateFormats)).toEqual([
      ["a-format"],
      ["b-format"],
    ]);
    expect(getMixedSetting(updated.columns, selected, "type")).toEqual({
      kind: "single",
      value: "Decimal",
    });
  });

  it("undoes the last bulk operation as one generation", () => {
    const original = createCsvProfileDraft([column("a", "Text"), column("b", "Int64")], 3);
    const updated = applyBulkSettings(original, new Set(["a", "b"]), {
      type: "Date",
      dateFormats: ["%d/%m/%Y"],
    });
    const undone = undoLastBulkChange(updated);
    expect(undone.generation).toBe(5);
    expect(undone.columns).toEqual(original.columns);
    expect(undone.lastUndo).toBeNull();
  });

  it("resets each selected type to its recommendation without changing other settings", () => {
    const draft = createCsvProfileDraft([
      column("a", "Text", "UInt64"),
      column("b", "Date", "Timestamp"),
    ]);
    const updated = resetSelectedToRecommended(draft, new Set(["a", "b"]));
    expect(updated.columns.map((item) => item.settings.type)).toEqual(["UInt64", "Timestamp"]);
    expect(updated.columns[0].settings.nullTokens).toEqual(["", "a-null"]);
    expect(updated.columns[1].settings.dateFormats).toEqual(["b-format"]);
  });

  it("copies one complete column setting to selected targets and remains undoable", () => {
    const draft = createCsvProfileDraft([column("source", "Decimal"), column("target", "Text")]);
    const copied = copyColumnSettings(draft, "source", new Set(["source", "target"]));
    expect(copied.columns[1].settings).toEqual(copied.columns[0].settings);
    expect(copied.columns[1].settings).not.toBe(copied.columns[0].settings);
    expect(undoLastBulkChange(copied).columns).toEqual(draft.columns);
  });
});

describe("CSV profile wire adapters", () => {
  const profile: CsvParsingProfileWire = {
    mode: "auto",
    generation: 7,
    columns: [
      {
        sourceIndex: 0,
        sourceName: "value",
        targetType: "int64",
        trim: false,
        nullTokens: ["NULL"],
        trueTokens: ["yes", "1"],
        falseTokens: ["no", "0"],
        decimalSeparator: ",",
        thousandSeparator: ".",
        temporalFormats: ["DD/MM/YYYY"],
        timezonePolicy: "fixedOffset",
        timezoneOffsetMinutes: 540,
        failurePolicy: "asNull",
      },
    ],
  };

  it("CSV-006 preserves settings not directly exposed by the bulk editor", () => {
    const columns = wireProfileToColumns(profile);
    const wire = uiRequestToWireProfile(
      {
        documentId: "document-1",
        sessionId: "session-1",
        generation: 8,
        columns,
        validationAcknowledged: false,
      },
      profile,
    );

    expect(wire).toMatchObject({ mode: "custom", generation: 8 });
    expect(wire.columns[0]).toMatchObject({
      trueTokens: ["yes", "1"],
      falseTokens: ["no", "0"],
      timezonePolicy: "fixedOffset",
      timezoneOffsetMinutes: 540,
      failurePolicy: "asNull",
    });
  });

  it("preserves editable boolean tokens and fixed timezone settings through the wire adapter", () => {
    const columns = wireProfileToColumns(profile);
    columns[0].settings = {
      ...columns[0].settings,
      trueTokens: ["Y", "yes"],
      falseTokens: ["N", "no"],
      timezone: "UTC-04:30",
    };
    const wire = uiRequestToWireProfile(
      {
        documentId: "document-1",
        sessionId: "session-1",
        generation: 9,
        columns,
        validationAcknowledged: false,
      },
      profile,
    );
    expect(wire.columns[0]).toMatchObject({
      trueTokens: ["Y", "yes"],
      falseTokens: ["N", "no"],
      timezonePolicy: "fixedOffset",
      timezoneOffsetMinutes: -270,
    });
  });

  it("keeps per-column full validation diagnostics", () => {
    const status: CsvValidationStatusWire = {
      taskId: "validation-1",
      documentId: "document-1",
      sessionId: "session-1",
      generation: 7,
      state: "complete",
      rowsScanned: 100,
      totalRows: 100,
      columns: [
        {
          sourceIndex: 0,
          sourceName: "value",
          successCount: 98,
          nullCount: 0,
          invalidCount: 2,
          firstErrorRow: 42,
          errorSamples: [{ sourceRow: 42, raw: "bad-int", message: "Expected Int64" }],
        },
      ],
      error: null,
    };
    expect(wireValidationToUi(status).columns[0]).toEqual({
      columnId: "csv-column-0",
      name: "value",
      success: 98,
      null: 0,
      invalid: 2,
      firstErrorRow: 42,
      errorSamples: [{ rowIndex: 42, raw: "bad-int", message: "Expected Int64" }],
    });
  });

  it("CSV-009 exposes raw, null, empty, and invalid preview semantics", () => {
    const response: CsvProfilePreviewResponse = {
      documentId: "document-1",
      sessionId: "session-1",
      preview: {
        generation: 7,
        stage: "distributed",
        profile,
        columns: [
          {
            sourceIndex: 0,
            sourceName: "value",
            recommendedType: "int64",
            confidence: 1,
            targetType: "int64",
            successCount: 1,
            nullCount: 1,
            invalidCount: 1,
          },
        ],
        rows: [
          {
            sourceRow: 0,
            cells: [
              {
                raw: "0007",
                converted: {
                  kind: "int",
                  display: "7",
                  state: "valid",
                  rawDisplay: "0007",
                  diagnostic: null,
                },
              },
            ],
          },
          {
            sourceRow: 1,
            cells: [
              {
                raw: "NULL",
                converted: {
                  kind: "null",
                  display: null,
                  state: "null",
                  rawDisplay: "NULL",
                  diagnostic: null,
                },
              },
            ],
          },
          {
            sourceRow: 2,
            cells: [
              {
                raw: "bad",
                converted: {
                  kind: "int",
                  display: "bad",
                  state: "invalid",
                  rawDisplay: "bad",
                  diagnostic: { code: "csvConversion", message: "Expected Int64" },
                },
              },
            ],
          },
        ],
      },
    };

    const preview = wirePreviewToUi(response);
    expect(preview.stage).toBe("distributed");
    expect(preview.rows.map((row) => row.cells[0].status)).toEqual(["success", "null", "invalid"]);
    expect(preview.rows[0].cells[0]).toMatchObject({ raw: "0007", converted: "7" });
    expect(preview.rows[2].cells[0].error).toBe("Expected Int64");
  });
});
