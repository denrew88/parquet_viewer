import type { DurationUnit } from "../backend";

export type QueryScalarType =
  "text" | "number" | "decimal" | "date" | "timestamp" | "duration" | "boolean" | "other";

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
  duration: [
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

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const durationUnitNanoseconds: Record<DurationUnit, bigint> = {
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
};

function inI64(value: bigint): boolean {
  return value >= I64_MIN && value <= I64_MAX;
}

export function isValidDurationLiteral(value: string, targetUnit?: DurationUnit): boolean {
  const suffixed = /^([+-]?\d+)(ms|us|ns|s)$/.exec(value);
  if (suffixed) {
    try {
      const count = BigInt(suffixed[1]);
      if (!inI64(count)) return false;
      if (!targetUnit) return true;
      const nanoseconds = count * durationUnitNanoseconds[suffixed[2] as DurationUnit];
      const divisor = durationUnitNanoseconds[targetUnit];
      return nanoseconds % divisor === 0n && inI64(nanoseconds / divisor);
    } catch {
      return false;
    }
  }

  const clock = /^([+-]?)(?:(\d+)d )?(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(value);
  if (!clock) return false;
  const hours = Number(clock[3]);
  const minutes = Number(clock[4]);
  const seconds = Number(clock[5]);
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  try {
    const days = BigInt(clock[2] ?? "0");
    const fraction = clock[6] ?? "";
    const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0");
    let nanoseconds =
      (((days * 24n + BigInt(hours)) * 60n + BigInt(minutes)) * 60n + BigInt(seconds)) *
        1_000_000_000n +
      fractionNanoseconds;
    if (clock[1] === "-") nanoseconds = -nanoseconds;
    const units = targetUnit ? [targetUnit] : (["s", "ms", "us", "ns"] as const);
    return units.some((unit) => {
      const divisor = durationUnitNanoseconds[unit];
      return nanoseconds % divisor === 0n && inI64(nanoseconds / divisor);
    });
  } catch {
    return false;
  }
}

export function validateFilter(filter: QueryFilter, durationUnit?: DurationUnit): string | null {
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
  if (filter.scalarType === "duration") {
    const invalid = filter.values.find((value) => !isValidDurationLiteral(value, durationUnit));
    if (invalid !== undefined) return `“${invalid}” is not a valid duration.`;
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

export function setSort(plan: QueryPlan, sort: readonly QuerySort[]): QueryPlan {
  const seen = new Set<string>();
  const normalized = sort.filter((entry) => {
    if (!entry.columnId.trim() || seen.has(entry.columnId)) return false;
    seen.add(entry.columnId);
    return true;
  });
  return { ...plan, sort: normalized.map((entry) => ({ ...entry, nullsLast: true })) };
}

export function moveSort(
  sort: readonly QuerySort[],
  columnId: string,
  direction: -1 | 1,
): QuerySort[] {
  const index = sort.findIndex((entry) => entry.columnId === columnId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sort.length) return [...sort];
  const next = [...sort];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function resultKey(sessionId: string, queryId: string | null): string {
  return `${sessionId}:${queryId ?? "source"}`;
}
