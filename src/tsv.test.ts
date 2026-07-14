import { describe, expect, it } from "vitest";
import type { DataValue } from "./backend";
import {
  COPY_HARD_BYTE_LIMIT,
  CopyLimitExceededError,
  serializeTsv,
  serializeTsvField,
  TsvAccumulator,
} from "./tsv";

const value = (kind: DataValue["kind"], display: string | null): DataValue => ({ kind, display });

describe("TSV serializer", () => {
  it("uses tabs, CRLF, and no trailing row terminator", () => {
    expect(
      serializeTsv([
        [value("string", "a"), value("int", "1")],
        [value("string", "b"), value("int", "2")],
      ]),
    ).toBe("a\t1\r\nb\t2");
  });

  it.each([
    ["tab", "a\tb", '"a\tb"'],
    ["CR", "a\rb", '"a\rb"'],
    ["LF", "a\nb", '"a\nb"'],
    ["CRLF", "a\r\nb", '"a\r\nb"'],
    ["quote", 'a"b', '"a""b"'],
  ])("escapes %s fields", (_name, input, expected) => {
    expect(serializeTsvField(value("string", input))).toBe(expected);
  });

  it("distinguishes null, empty string, and literal null", () => {
    expect(
      serializeTsv([[value("null", null), value("string", ""), value("string", "null")]]),
    ).toBe('\t""\tnull');
  });

  it("preserves UTF-8 and exact typed display strings and quotes headers", () => {
    expect(
      serializeTsv(
        [[value("int", "9223372036854775807"), value("string", "한글😀")]],
        ["integer", "display\nname"],
      ),
    ).toBe('integer\t"display\nname"\r\n9223372036854775807\t한글😀');
  });

  it("joins chunks without duplicate or missing CRLF", () => {
    const writer = new TsvAccumulator();
    writer.appendRows([[value("string", "a")]], ["header"]);
    writer.appendRows([[value("string", "b")]]);
    expect(writer.finish()).toBe("header\r\na\r\nb");
    expect(writer.byteLength).toBe(new TextEncoder().encode(writer.finish()).byteLength);
  });

  it("rejects output above the hard byte limit", () => {
    const writer = new TsvAccumulator();
    const oversized = "x".repeat(COPY_HARD_BYTE_LIMIT + 1);
    expect(() => writer.appendRows([[value("string", oversized)]])).toThrow(CopyLimitExceededError);
  });
});
