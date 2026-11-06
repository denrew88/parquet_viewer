import { describe, expect, it } from "vitest";
import cursorWireCases from "../../fixtures/phase-21/column-values-cursor-wire.json";
import type { ColumnValuesPageRequest } from "./backend";
import {
  parseColumnValuesPage,
  parseColumnValuesStatus,
  validateColumnValuesPageRequest,
  parseCacheMigrationStatus,
  parseCacheSelection,
} from "./backend";
const identity = { operationId: "op", documentId: "doc", sessionId: "session" };
describe("Phase 21 wire boundaries", () => {
  it.each(cursorWireCases)("matches Rust cursor wire case $id", ({ request, valid }) => {
    const validate = () => validateColumnValuesPageRequest(request as ColumnValuesPageRequest);
    if (valid) expect(validate().cursor).toBe("cursor" in request ? request.cursor : null);
    else expect(validate).toThrow();
  });
  it("defaults missing source availability and validates the optional recovery flag", () => {
    const selection = {
      selectionId: "chosen",
      preview: {
        sourcePath: "C:/cache",
        targetPath: "D:/cache",
        bytes: 0,
        entries: 0,
        activeEntries: 0,
        availableBytes: 100,
        requiredFreeBytes: 10,
      },
    };
    expect(parseCacheSelection(selection)?.preview.sourceUnavailable).toBe(false);
    expect(
      parseCacheSelection({
        ...selection,
        preview: { ...selection.preview, sourceUnavailable: true },
      })?.preview.sourceUnavailable,
    ).toBe(true);
    expect(() =>
      parseCacheSelection({
        ...selection,
        preview: { ...selection.preview, sourceUnavailable: "true" },
      }),
    ).toThrow();
  });
  it.each([0, 201, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects page limit %s", (limit) =>
    expect(() =>
      validateColumnValuesPageRequest({
        ...identity,
        search: null,
        order: "valueAscending",
        offset: 0,
        limit,
      }),
    ).toThrow(),
  );
  it.each([1, 100, 200])("accepts page limit %s", (limit) =>
    expect(
      validateColumnValuesPageRequest({
        ...identity,
        search: null,
        order: "valueAscending",
        offset: 0,
        limit,
      }).limit,
    ).toBe(limit),
  );
  it("preserves precise scalar strings and rejects unsafe counters", () => {
    const response = {
      ...identity,
      queryId: null,
      columnId: "id",
      totalCount: 1,
      matchedCount: 1,
      values: [
        {
          value: "18446744073709551615",
          isNull: false,
          isEmpty: false,
          isInvalid: false,
          count: 1,
          truncated: false,
        },
      ],
      hasMore: false,
      nextCursor: null,
      previousCursor: null,
    };
    expect(parseColumnValuesPage(response).values[0].value).toBe("18446744073709551615");
    expect(() =>
      parseColumnValuesPage({ ...response, totalCount: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => parseColumnValuesPage({ ...response, matchedCount: 2 })).toThrow();
    expect(() => parseColumnValuesPage({ ...response, nextCursor: "unexpected" })).toThrow();
    for (const field of ["nextCursor", "previousCursor"] as const) {
      const missing = { ...response } as Record<string, unknown>;
      delete missing[field];
      expect(() => parseColumnValuesPage(missing)).toThrow();
      for (const invalid of ["", " ", "bad\0cursor", "é".repeat(65), 7, false])
        expect(() => parseColumnValuesPage({ ...response, [field]: invalid })).toThrow();
    }
  });
  it("rejects invalid status and migration progress", () => {
    expect(() =>
      parseColumnValuesStatus({
        ...identity,
        queryId: null,
        columnId: "id",
        state: "complete",
        stage: "complete",
        totalCount: 1,
        matchedCount: 1,
        error: null,
      }),
    ).toThrow();
    expect(() =>
      parseCacheMigrationStatus({
        operationId: "op",
        state: "running",
        sourcePath: "C:/old",
        targetPath: "D:/new",
        progress: {
          copiedBytes: -1,
          totalBytes: 1,
          copiedEntries: 0,
          totalEntries: 1,
          phase: "copy",
        },
        error: null,
        result: null,
      }),
    ).toThrow();
  });
});
