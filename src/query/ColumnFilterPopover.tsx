import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Search, X } from "lucide-react";
import {
  operatorsForType,
  requiredFilterValueCount,
  validateFilter,
  type FilterOperator,
  type QueryFilter,
  type QueryScalarType,
} from "./model";
import type { DurationUnit } from "../backend";
import "./query.css";

export interface DistinctValue {
  value: string;
  count: number | null;
}

export interface DistinctValuesState {
  values: DistinctValue[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onSearch(text: string): void;
  onLoadMore(): void;
}

interface ColumnFilterPopoverProps {
  columnId: string;
  columnLabel: string;
  scalarType: QueryScalarType;
  durationUnit?: DurationUnit;
  initialFilter: QueryFilter | null;
  distinct?: DistinctValuesState;
  onApply(filter: QueryFilter): void;
  onCancel(): void;
  onClear(): void;
}

const operatorLabels: Record<FilterOperator, string> = {
  equals: "Equals",
  notEquals: "Does not equal",
  oneOf: "Is one of",
  contains: "Contains",
  startsWith: "Starts with",
  endsWith: "Ends with",
  greaterThan: "Greater than",
  greaterThanOrEqual: "Greater than or equal",
  lessThan: "Less than",
  lessThanOrEqual: "Less than or equal",
  between: "Between",
  isTrue: "Is true",
  isFalse: "Is false",
  isNull: "Is null",
  isNotNull: "Is not null",
  isInvalid: "Is invalid",
  isNotInvalid: "Is not invalid",
};

function defaultOperator(type: QueryScalarType): FilterOperator {
  if (type === "text") return "contains";
  if (type === "boolean") return "isTrue";
  if (type === "other") return "isNull";
  return "equals";
}

function newDraft(
  columnId: string,
  scalarType: QueryScalarType,
  initial: QueryFilter | null,
): QueryFilter {
  return initial
    ? { ...initial, values: [...initial.values] }
    : {
        id: `filter:${columnId}`,
        columnId,
        scalarType,
        operator: defaultOperator(scalarType),
        values: scalarType === "boolean" || scalarType === "other" ? [] : [""],
      };
}

export function ColumnFilterPopover({
  columnId,
  columnLabel,
  scalarType,
  durationUnit,
  initialFilter,
  distinct,
  onApply,
  onCancel,
  onClear,
}: ColumnFilterPopoverProps) {
  const [draft, setDraft] = useState(() => newDraft(columnId, scalarType, initialFilter));
  const [distinctSearch, setDistinctSearch] = useState("");

  useEffect(() => {
    setDraft(newDraft(columnId, scalarType, initialFilter));
    setDistinctSearch("");
  }, [columnId, initialFilter, scalarType]);

  const error = validateFilter(draft, durationUnit);
  const operators = useMemo(() => operatorsForType(scalarType), [scalarType]);
  const valueCount = requiredFilterValueCount(draft.operator);

  function changeOperator(operator: FilterOperator): void {
    const count = requiredFilterValueCount(operator);
    setDraft((current) => ({
      ...current,
      operator,
      values: operator === "oneOf" ? [] : Array.from({ length: count }, () => ""),
    }));
  }

  function updateValue(index: number, value: string): void {
    setDraft((current) => ({
      ...current,
      values: current.values.map((item, itemIndex) => (itemIndex === index ? value : item)),
    }));
  }

  function toggleDistinct(value: string): void {
    setDraft((current) => {
      const values = current.operator === "oneOf" ? current.values : [];
      return {
        ...current,
        operator: "oneOf",
        values: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  }

  return (
    <div
      aria-label={`Filter ${columnLabel}`}
      className="column-filter-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      role="dialog"
    >
      <header>
        <strong>{columnLabel}</strong>
        <button aria-label="Close filter" onClick={onCancel} title="Close" type="button">
          <X aria-hidden="true" />
        </button>
      </header>
      <label>
        Operator
        <select
          aria-label="Filter operator"
          onChange={(event) => changeOperator(event.target.value as FilterOperator)}
          value={draft.operator}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {operatorLabels[operator]}
            </option>
          ))}
        </select>
      </label>
      {draft.operator !== "oneOf" && valueCount > 0 && (
        <div className="column-filter-popover__values">
          {Array.from({ length: valueCount }, (_, index) => (
            <label key={index}>
              {valueCount === 2 ? (index === 0 ? "From" : "To") : "Value"}
              <input
                aria-invalid={Boolean(error)}
                aria-label={valueCount === 2 ? (index === 0 ? "From value" : "To value") : "Value"}
                onChange={(event) => updateValue(index, event.target.value)}
                type={
                  scalarType === "date"
                    ? "date"
                    : scalarType === "timestamp"
                      ? "datetime-local"
                      : "text"
                }
                value={draft.values[index] ?? ""}
              />
            </label>
          ))}
        </div>
      )}
      {distinct && (
        <section aria-label="Distinct values" className="distinct-values">
          <label className="distinct-values__search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search distinct values"
              onChange={(event) => {
                setDistinctSearch(event.target.value);
                distinct.onSearch(event.target.value);
              }}
              type="search"
              value={distinctSearch}
            />
          </label>
          <div className="distinct-values__list">
            {distinct.values.map((item) => {
              const selected = draft.operator === "oneOf" && draft.values.includes(item.value);
              return (
                <button
                  aria-pressed={selected}
                  key={item.value}
                  onClick={() => toggleDistinct(item.value)}
                  type="button"
                >
                  <span className="distinct-values__check">
                    {selected && <Check aria-hidden="true" />}
                  </span>
                  <span title={item.value}>{item.value}</span>
                  {item.count !== null && <small>{item.count.toLocaleString()}</small>}
                </button>
              );
            })}
            {distinct.loading && (
              <span role="status">
                <LoaderCircle aria-hidden="true" /> Loading values
              </span>
            )}
            {distinct.error && <span role="alert">{distinct.error}</span>}
          </div>
          {distinct.hasMore && (
            <button disabled={distinct.loading} onClick={distinct.onLoadMore} type="button">
              Load more
            </button>
          )}
        </section>
      )}
      {error && <span role="alert">{error}</span>}
      <footer>
        <button disabled={!initialFilter} onClick={onClear} type="button">
          Clear
        </button>
        <span />
        <button onClick={onCancel} type="button">
          Cancel
        </button>
        <button disabled={Boolean(error)} onClick={() => onApply(draft)} type="button">
          Apply
        </button>
      </footer>
    </div>
  );
}
