import { describe, expect, it } from "vitest";
import type { DataValue } from "../backend";
import { snapshotCopyOptions, type CopyOptions } from "./model";
import { COPY_PRESETS } from "./presets";
import {
  CopyAccumulator,
  CopyByteLimitExceededError,
  UnsafeUnquotedFieldError,
  serializeCopyPreview,
  serializeCopyRows,
} from "./serializer";

const value = (kind: DataValue["kind"], display: string | null): DataValue => ({ kind, display });
const text = (display: string): DataValue => value("string", display);

function options(overrides: Partial<CopyOptions>): CopyOptions {
  return snapshotCopyOptions({ ...COPY_PRESETS.custom, ...overrides });
}

describe("copy serializer", () => {
  it("CPY-001 serializes the four preset defaults", () => {
    const rows = [
      [text("alpha"), text("beta")],
      [value("null", null), text("")],
    ];

    expect(serializeCopyRows(rows, COPY_PRESETS.excel)).toBe("alpha\tbeta\r\n\t");
    expect(serializeCopyRows(rows, COPY_PRESETS.tsv)).toBe("alpha\tbeta\r\n\t");
    expect(serializeCopyRows(rows, COPY_PRESETS.csv)).toBe('alpha,beta\r\nNULL,""');
    expect(serializeCopyRows(rows, COPY_PRESETS.custom)).toBe('alpha|beta\r\nNULL|""');
  });

  it("CPY-002 serializes a Unicode delimiter as one structural character", () => {
    expect(
      serializeCopyRows([[text("left"), text("right🧪quoted")]], options({ delimiter: "🧪" })),
    ).toBe('left🧪"right🧪quoted"');
  });

  it("CPY-003 supports minimal and always quoting with both escape modes", () => {
    expect(
      serializeCopyRows(
        [[text("comma,value"), text('double " quote')]],
        options({ delimiter: ",", quoteMode: "minimal", escapeMode: "double" }),
      ),
    ).toBe('"comma,value","double "" quote"');
    expect(
      serializeCopyRows(
        [[text("plain"), text('slash \\ and " quote')]],
        options({ delimiter: ",", quoteMode: "always", escapeMode: "backslash" }),
      ),
    ).toBe('"plain","slash \\\\ and \\" quote"');
  });

  it("CPY-003 rejects fields and headers that require quoting in no-quote mode", () => {
    expect(
      serializeCopyRows(
        [[text("plain \\ value")]],
        options({ delimiter: ",", quoteMode: "none", escapeMode: "backslash" }),
      ),
    ).toBe("plain \\ value");
    expect(() =>
      serializeCopyRows(
        [[text('double " quote')]],
        options({ delimiter: ",", quoteMode: "none", escapeMode: "double" }),
      ),
    ).toThrow(UnsafeUnquotedFieldError);
    expect(() =>
      serializeCopyRows([[text("value")]], options({ includeHeaders: true, quoteMode: "none" }), [
        'header " quote',
      ]),
    ).toThrow(UnsafeUnquotedFieldError);
    expect(() =>
      serializeCopyRows([[text("comma,value")]], options({ delimiter: ",", quoteMode: "none" })),
    ).toThrow(UnsafeUnquotedFieldError);
    expect(() =>
      serializeCopyRows([[text("line one\nline two")]], options({ quoteMode: "none" })),
    ).toThrow(UnsafeUnquotedFieldError);
    expect(() =>
      serializeCopyRows([[text("NULL")]], options({ delimiter: ",", quoteMode: "none" })),
    ).toThrow(UnsafeUnquotedFieldError);
    expect(() =>
      serializeCopyRows([[text("")]], options({ delimiter: ",", quoteMode: "none" })),
    ).toThrow(UnsafeUnquotedFieldError);
  });

  it("CPY-004 keeps CSV null, empty string, and literal NULL distinct", () => {
    expect(
      serializeCopyRows(
        [[value("null", null), text(""), text("NULL"), text("ordinary")]],
        COPY_PRESETS.csv,
      ),
    ).toBe('NULL,"","NULL",ordinary');
    expect(
      serializeCopyRows([[value("null", null), text("NULL")]], {
        ...COPY_PRESETS.csv,
        quoteMode: "always",
      }),
    ).toBe('NULL,"NULL"');
  });

  it("CPY-005 reports Excel/TSV null-empty loss without changing table structure", () => {
    const rows = [[value("null", null), text(""), text("tail")]];
    for (const preset of [COPY_PRESETS.excel, COPY_PRESETS.tsv]) {
      const preview = serializeCopyPreview(rows, preset);
      expect(preview.text).toBe("\t\ttail");
      expect(preview.warnings).toEqual([
        expect.objectContaining({ code: "NullEmptyDistinctionLost" }),
      ]);
    }
  });

  it("CPY-006 preserves exact integer, decimal, and timestamp display values", () => {
    expect(
      serializeCopyRows(
        [
          [
            value("int", "-9223372036854775808"),
            value("int", "18446744073709551615"),
            value("decimal", "12345678901234567890.123456789"),
            value("timestamp", "2026-07-15T12:34:56.123456789+09:00"),
          ],
        ],
        COPY_PRESETS.csv,
      ),
    ).toBe(
      "-9223372036854775808,18446744073709551615,12345678901234567890.123456789,2026-07-15T12:34:56.123456789+09:00",
    );
  });

  it("applies boolean and date/time representations without numeric coercion", () => {
    expect(
      serializeCopyRows(
        [[value("boolean", "true"), value("boolean", "false")]],
        options({ booleanRepresentation: "numeric" }),
      ),
    ).toBe("1|0");
    expect(
      serializeCopyRows(
        [[value("date", "2026-07-15"), value("timestamp", "2026-07-15T12:34:56.987654321Z")]],
        options({
          dateTimeRepresentation: { mode: "custom", format: "YYYY/MM/DD HH:mm:ss.SSS XXX" },
        }),
      ),
    ).toBe("2026/07/15 00:00:00.000 |2026/07/15 12:34:56.987 Z");
  });

  it("includes headers once across accumulator chunks and honors line endings", () => {
    const accumulator = new CopyAccumulator(
      options({ includeHeaders: true, delimiter: ";", lineEnding: "lf" }),
    );
    accumulator.appendRows([[text("first")]], ["name"]);
    accumulator.appendRows([[text("second")]], ["ignored"]);

    expect(accumulator.finish()).toBe("name\nfirst\nsecond");
    expect(accumulator.byteLength).toBe(new TextEncoder().encode(accumulator.finish()).byteLength);
  });

  it("enforces the accumulator hard byte limit atomically using UTF-8 bytes", () => {
    const accumulator = new CopyAccumulator(COPY_PRESETS.csv, 5);
    accumulator.appendRows([[text("가")]]);

    expect(() => accumulator.appendRows([[text("나")]])).toThrow(CopyByteLimitExceededError);
    expect(accumulator.finish()).toBe("가");
    expect(accumulator.byteLength).toBe(3);
  });

  it("snapshots options when the accumulator starts", () => {
    const mutable = { ...COPY_PRESETS.custom, delimiter: ";" } as CopyOptions;
    const accumulator = new CopyAccumulator(mutable);
    (mutable as { delimiter: string }).delimiter = ",";
    accumulator.appendRows([[text("left"), text("right")]]);

    expect(accumulator.finish()).toBe("left;right");
  });
});
