import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY_PLAN,
  clearFilters,
  operatorsForType,
  removeFilter,
  requiredFilterValueCount,
  resultKey,
  setSearch,
  toggleSort,
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

  it("includes query identity in the grid result key", () => {
    expect(resultKey("session-1", null)).toBe("session-1:source");
    expect(resultKey("session-1", "query-1")).toBe("session-1:query-1");
    expect(resultKey("session-1", "query-2")).not.toBe(resultKey("session-1", "query-1"));
  });
});
