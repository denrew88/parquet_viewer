import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY_PLAN,
  clearFilters,
  isValidDurationLiteral,
  operatorsForType,
  removeFilter,
  requiredFilterValueCount,
  resultKey,
  setSearch,
  toggleSort,
  moveSort,
  setSort,
  upsertFilter,
  validateFilter,
  type QueryFilter,
} from "./model";

function textFilter(overrides: Partial<QueryFilter> = {}): QueryFilter {
  return {
    id: "name-filter",
    columnId: "name",
    scalarType: "text",
    operator: "contains",
    values: ["kim"],
    ...overrides,
  };
}

describe("query model", () => {
  it("exposes only typed operators and keeps invalid distinct from null", () => {
    expect(operatorsForType("text")).toContain("contains");
    expect(operatorsForType("text")).not.toContain("greaterThan");
    expect(operatorsForType("number")).toContain("between");
    expect(operatorsForType("text")).toContain("oneOf");
    expect(operatorsForType("boolean")).toContain("isTrue");
    for (const type of ["text", "number", "decimal", "date", "timestamp", "boolean"] as const) {
      expect(operatorsForType(type)).toEqual(
        expect.arrayContaining(["isNull", "isNotNull", "isInvalid", "isNotInvalid"]),
      );
    }
  });

  it("validates the operator and exact value arity", () => {
    expect(validateFilter(textFilter())).toBeNull();
    expect(validateFilter(textFilter({ operator: "greaterThan" }))).toContain("not valid");
    expect(validateFilter(textFilter({ values: [] }))).toContain("requires 1 value");
    expect(
      validateFilter(textFilter({ operator: "between", scalarType: "number", values: ["1"] })),
    ).toContain("requires 2 values");
    expect(requiredFilterValueCount("isNull")).toBe(0);
    expect(validateFilter(textFilter({ operator: "oneOf", values: ["kim", "lee"] }))).toBeNull();
  });

  it("rejects malformed typed literals before a query starts", () => {
    expect(
      validateFilter(textFilter({ scalarType: "number", operator: "equals", values: ["1x"] })),
    ).toContain("valid number");
    expect(
      validateFilter(
        textFilter({ scalarType: "date", operator: "equals", values: ["2025-02-31"] }),
      ),
    ).toContain("valid date");
    expect(
      validateFilter(
        textFilter({ scalarType: "timestamp", operator: "equals", values: ["yesterday"] }),
      ),
    ).toContain("valid timestamp");
    expect(
      validateFilter(textFilter({ scalarType: "boolean", operator: "oneOf", values: ["yes"] })),
    ).toContain("true or false");
  });

  it("matches Duration clock, exact-unit, and i64 boundaries", () => {
    expect(isValidDurationLiteral("1d 02:03:04.005", "ms")).toBe(true);
    expect(isValidDurationLiteral("00:00:00.000001", "ms")).toBe(false);
    expect(isValidDurationLiteral("1ms", "s")).toBe(false);
    expect(isValidDurationLiteral("2s", "ms")).toBe(true);
    expect(isValidDurationLiteral("24:00:00", "ns")).toBe(false);
    expect(isValidDurationLiteral("00:60:00", "ns")).toBe(false);
    expect(isValidDurationLiteral("00:00:60", "ns")).toBe(false);
    expect(isValidDurationLiteral("9223372036854775808ns", "ns")).toBe(false);
    expect(
      validateFilter(
        textFilter({ scalarType: "duration", operator: "equals", values: ["99:99:99"] }),
        "ns",
      ),
    ).toContain("valid duration");
  });

  it("upserts and removes filters without mutating the previous plan", () => {
    const first = upsertFilter(EMPTY_QUERY_PLAN, textFilter());
    const replaced = upsertFilter(first, textFilter({ values: ["lee"] }));
    expect(first.filters[0].values).toEqual(["kim"]);
    expect(replaced.filters).toHaveLength(1);
    expect(replaced.filters[0].values).toEqual(["lee"]);
    expect(removeFilter(replaced, "name-filter").filters).toEqual([]);
    expect(clearFilters(first).filters).toEqual([]);
  });

  it("normalizes empty search and preserves explicit search options", () => {
    expect(
      setSearch(EMPTY_QUERY_PLAN, {
        text: "   ",
        mode: "filter",
        caseSensitive: false,
        exact: false,
        targetColumnIds: [],
      }).search,
    ).toBeNull();
    expect(
      setSearch(EMPTY_QUERY_PLAN, {
        text: "  Alice  ",
        mode: "find",
        caseSensitive: true,
        exact: true,
        targetColumnIds: ["name"],
      }).search,
    ).toEqual({
      text: "Alice",
      mode: "find",
      caseSensitive: true,
      exact: true,
      targetColumnIds: ["name"],
    });
  });

  it("cycles single and stable multi-column sorts with nulls last", () => {
    const first = toggleSort(EMPTY_QUERY_PLAN, "group", false);
    expect(first.sort).toEqual([{ columnId: "group", direction: "ascending", nullsLast: true }]);
    const second = toggleSort(first, "value", true);
    expect(second.sort.map((sort) => sort.columnId)).toEqual(["group", "value"]);
    const descending = toggleSort(second, "group", true);
    expect(descending.sort).toEqual([
      { columnId: "value", direction: "ascending", nullsLast: true },
      { columnId: "group", direction: "descending", nullsLast: true },
    ]);
    expect(toggleSort(descending, "group", true).sort.map((sort) => sort.columnId)).toEqual([
      "value",
    ]);
  });

  it("normalizes and reorders a multi-sort draft", () => {
    const sort = [
      { columnId: "group", direction: "ascending" as const, nullsLast: true as const },
      { columnId: "value", direction: "descending" as const, nullsLast: true as const },
    ];
    expect(moveSort(sort, "value", -1).map((entry) => entry.columnId)).toEqual(["value", "group"]);
    expect(setSort(EMPTY_QUERY_PLAN, [...sort, sort[0]]).sort).toEqual(sort);
  });

  it("includes query identity in the grid result key", () => {
    expect(resultKey("session-1", null)).toBe("session-1:source");
    expect(resultKey("session-1", "query-1")).toBe("session-1:query-1");
    expect(resultKey("session-1", "query-2")).not.toBe(resultKey("session-1", "query-1"));
  });
});
