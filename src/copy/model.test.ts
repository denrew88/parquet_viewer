import { describe, expect, it } from "vitest";
import {
  copyOptionWarnings,
  snapshotCopyOptions,
  validateCopyOptions,
  type CopyOptions,
} from "./model";
import { COPY_PRESETS } from "./presets";

function customOptions(overrides: Partial<CopyOptions> = {}): CopyOptions {
  return snapshotCopyOptions({ ...COPY_PRESETS.custom, ...overrides });
}

describe("copy settings model", () => {
  it("CPY-002 accepts supported and single-code-point Unicode delimiters", () => {
    for (const delimiter of [",", "\t", ";", "|", "🧪"]) {
      expect(validateCopyOptions(customOptions({ delimiter }))).toEqual([]);
    }
  });

  it("CPY-002 rejects empty, multi-character, CR, LF, NUL, and ambiguous delimiters", () => {
    for (const delimiter of ["", "::", "\r", "\n", "\0"]) {
      expect(
        validateCopyOptions(customOptions({ delimiter })).map((issue) => issue.code),
      ).toContain("InvalidDelimiter");
    }
    expect(
      validateCopyOptions(customOptions({ delimiter: '"', quoteCharacter: '"' })).map(
        (issue) => issue.code,
      ),
    ).toContain("AmbiguousDelimiterAndQuote");
  });

  it("reports the intentional Excel and TSV null/empty distinction loss", () => {
    for (const preset of [COPY_PRESETS.excel, COPY_PRESETS.tsv]) {
      expect(copyOptionWarnings(preset)).toEqual([
        expect.objectContaining({ code: "NullEmptyDistinctionLost" }),
      ]);
    }
    expect(copyOptionWarnings(COPY_PRESETS.csv)).toEqual([]);
  });

  it("takes an immutable settings snapshot including nested date options", () => {
    const source: CopyOptions = {
      ...COPY_PRESETS.custom,
      dateTimeRepresentation: { mode: "custom", format: "YYYY/MM/DD" },
    };
    const snapshot = snapshotCopyOptions(source);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.dateTimeRepresentation)).toBe(true);
    expect(snapshot).toEqual(source);
  });
});
