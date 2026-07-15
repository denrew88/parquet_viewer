export type QueryScalarType =
  "text" | "number" | "decimal" | "date" | "timestamp" | "boolean" | "other";

export type FilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "between"
  | "oneOf"
  | "isTrue"
  | "isFalse"
  | "isNull"
  | "isNotNull"
  | "isInvalid"
  | "isNotInvalid";

export interface QueryFilter {
  id: string;
  columnId: string;
  scalarType: QueryScalarType;
  operator: FilterOperator;
  values: string[];
}

export interface QuerySearch {
  text: string;
  mode: "find" | "filter";
  caseSensitive: boolean;
  exact: boolean;
  targetColumnIds: string[];
}

export interface QuerySort {
  columnId: string;
  direction: "ascending" | "descending";
  nullsLast: true;
}

export interface QueryPlan {
  filters: QueryFilter[];
  search: QuerySearch | null;
  sort: QuerySort[];
  projection: string[];
}

export const EMPTY_QUERY_PLAN: QueryPlan = {
  filters: [],
  search: null,
  sort: [],
  projection: [],
};

const commonOperators: FilterOperator[] = ["isNull", "isNotNull", "isInvalid", "isNotInvalid"];

const operatorsByType: Record<QueryScalarType, FilterOperator[]> = {
  text: ["equals", "notEquals", "oneOf", "contains", "startsWith", "endsWith", ...commonOperators],
  number: [
    "equals",
    "notEquals",
    "greaterThan",
    "greaterThanOrEqual",
    "lessThan",
    "lessThanOrEqual",
    "between",
    "oneOf",
    ...commonOperators,
  ],
  decimal: [
    "equals",
    "notEquals",
    "greaterThan",
    "greaterThanOrEqual",
    "lessThan",
    "lessThanOrEqual",
    "between",
    "oneOf",
    ...commonOperators,
  ],
  date: [
    "equals",
    "notEquals",
    "greaterThan",
    "greaterThanOrEqual",
    "lessThan",
    "lessThanOrEqual",
    "between",
    "oneOf",
    ...commonOperators,
  ],
  timestamp: [
    "equals",
    "notEquals",
    "greaterThan",
    "greaterThanOrEqual",
    "lessThan",
    "lessThanOrEqual",
    "between",
    "oneOf",
    ...commonOperators,
  ],
  boolean: ["isTrue", "isFalse", "oneOf", ...commonOperators],
  other: commonOperators,
};

const operatorsWithoutValues = new Set<FilterOperator>([
  "isTrue",
  "isFalse",
  "isNull",
  "isNotNull",
  "isInvalid",
  "isNotInvalid",
]);

export function operatorsForType(type: QueryScalarType): readonly FilterOperator[] {
  return operatorsByType[type];
}

export function requiredFilterValueCount(operator: FilterOperator): 0 | 1 | 2 {
  if (operatorsWithoutValues.has(operator)) return 0;
  return operator === "between" ? 2 : 1;
}

export function validateFilter(filter: QueryFilter): string | null {
  if (!filter.id.trim()) return "Filter id is required.";
  if (!filter.columnId.trim()) return "Column is required.";
  if (!operatorsByType[filter.scalarType].includes(filter.operator)) {
    return `The ${filter.operator} operator is not valid for ${filter.scalarType} columns.`;
  }
  const expected = requiredFilterValueCount(filter.operator);
  const invalidArity =
    filter.operator === "oneOf" ? filter.values.length < 1 : filter.values.length !== expected;
  if (invalidArity || filter.values.some((value) => !value.trim())) {
    return expected === 0
      ? "This operator does not accept a value."
      : `This operator requires ${expected} value${expected === 1 ? "" : "s"}.`;
  }
  if (["number", "decimal"].includes(filter.scalarType)) {
    const invalid = filter.values.find((value) => !Number.isFinite(Number(value)));
    if (invalid !== undefined) return `“${invalid}” is not a valid number.`;
  }
  if (filter.scalarType === "date") {
    const invalid = filter.values.find((value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return true;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
      );
    });
    if (invalid !== undefined) return `“${invalid}” is not a valid date.`;
  }
  if (filter.scalarType === "timestamp") {
    const invalid = filter.values.find(
      (value) =>
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value) ||
        Number.isNaN(Date.parse(value)),
    );
    if (invalid !== undefined) return `“${invalid}” is not a valid timestamp.`;
  }
  if (
    filter.scalarType === "boolean" &&
    filter.values.some((value) => !["true", "false"].includes(value.toLocaleLowerCase()))
  ) {
    return "Boolean values must be true or false.";
  }
  return null;
}

export function upsertFilter(plan: QueryPlan, filter: QueryFilter): QueryPlan {
  const error = validateFilter(filter);
  if (error) throw new Error(error);
  const index = plan.filters.findIndex((candidate) => candidate.id === filter.id);
  const filters = [...plan.filters];
  if (index === -1) filters.push(filter);
  else filters[index] = filter;
  return { ...plan, filters };
}

export function removeFilter(plan: QueryPlan, filterId: string): QueryPlan {
  return { ...plan, filters: plan.filters.filter((filter) => filter.id !== filterId) };
}

export function clearFilters(plan: QueryPlan): QueryPlan {
  return plan.filters.length === 0 ? plan : { ...plan, filters: [] };
}

export function setSearch(plan: QueryPlan, search: QuerySearch | null): QueryPlan {
  const normalized = search?.text.trim() ? { ...search, text: search.text.trim() } : null;
  return { ...plan, search: normalized };
}

export function toggleSort(plan: QueryPlan, columnId: string, keepExisting: boolean): QueryPlan {
  const currentIndex = plan.sort.findIndex((sort) => sort.columnId === columnId);
  const current = currentIndex === -1 ? null : plan.sort[currentIndex];
  let next: QuerySort | null;
  if (!current) next = { columnId, direction: "ascending", nullsLast: true };
  else if (current.direction === "ascending") {
    next = { ...current, direction: "descending" };
  } else next = null;

  if (!keepExisting) return { ...plan, sort: next ? [next] : [] };
  const sort = plan.sort.filter((candidate) => candidate.columnId !== columnId);
  if (next) sort.push(next);
  return { ...plan, sort };
}

export function resultKey(sessionId: string, queryId: string | null): string {
  return `${sessionId}:${queryId ?? "source"}`;
}
