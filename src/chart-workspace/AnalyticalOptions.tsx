import { useState } from "react";
import type { ChartColumn, ChartRequest } from "./contract";
import {
  barSettings,
  columnBinding,
  isBucketable,
  parseChartNumber,
  resolveColumn,
  suggestedAxes,
  type ChartCardModel,
  type ChartOptions,
  type ResolvedSource,
} from "./chartModel";

type HistogramRange = ChartRequest["histogramRange"];
type Line = NonNullable<ChartRequest["line"]>;

function OptionSelect<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: Record<T, string>;
  onChange(value: T): void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
        {(Object.keys(choices) as T[]).map((key) => (
          <option key={key} value={key}>
            {choices[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

function HistogramRangeOptions({
  current,
  transformed,
  apply,
}: {
  current: HistogramRange;
  transformed: boolean;
  apply(range: HistogramRange): void;
}) {
  const initialMin = current ? String(current.min) : "";
  const initialMax = current ? String(current.max) : "";
  const [min, setMin] = useState(initialMin);
  const [max, setMax] = useState(initialMax);
  const [error, setError] = useState(false);
  return (
    <form
      className="chart-parameter-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (min === "" && max === "") {
          apply(undefined);
          return;
        }
        const lower = parseChartNumber(min, -Number.MAX_VALUE, Number.MAX_VALUE);
        const upper = parseChartNumber(max, -Number.MAX_VALUE, Number.MAX_VALUE);
        if (lower === null || upper === null || lower >= upper || !Number.isFinite(upper - lower)) {
          setError(true);
          return;
        }
        setMin(String(lower));
        setMax(String(upper));
        apply({ min: lower, max: upper });
      }}
    >
      <label>
        Histogram minimum
        <input
          type="number"
          step="any"
          value={min}
          aria-invalid={error}
          onChange={(event) => {
            setMin(event.currentTarget.value);
            setError(false);
          }}
        />
      </label>
      <label>
        Histogram maximum
        <input
          type="number"
          step="any"
          value={max}
          aria-invalid={error}
          onChange={(event) => {
            setMax(event.currentTarget.value);
            setError(false);
          }}
        />
      </label>
      <p className="chart-parameter-hint">
        {transformed ? "Limits use transformed X coordinates. " : "Limits use plot X coordinates. "}
        Leave both blank for an automatic range.
      </p>
      {error && (
        <p className="chart-parameter-error" role="alert">
          Enter a finite minimum and a larger maximum.
        </p>
      )}
      <button type="submit" disabled={min === initialMin && max === initialMax}>
        Apply histogram range
      </button>
    </form>
  );
}

function LineOptions({
  line,
  gap,
  temporal,
  transformed,
  apply,
}: {
  line: Line;
  gap?: number;
  temporal: boolean;
  transformed: boolean;
  apply(options: Partial<ChartOptions>): void;
}) {
  const initialBucket = temporal && line.bucketSeconds ? String(line.bucketSeconds) : "";
  const initialGap = gap ? String(gap) : "";
  const [aggregate, setAggregate] = useState(line.aggregate);
  const [bucket, setBucket] = useState(initialBucket);
  const [gapText, setGapText] = useState(initialGap);
  const [error, setError] = useState("");
  const canBucket = temporal && aggregate !== "raw";
  return (
    <form
      className="chart-parameter-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const width =
          canBucket && bucket !== "" ? parseChartNumber(bucket, 1e-9, Number.MAX_VALUE) : null;
        const threshold =
          gapText !== "" ? parseChartNumber(gapText, Number.MIN_VALUE, Number.MAX_VALUE) : null;
        if (canBucket && bucket !== "" && width === null) {
          setError("Enter a bucket of at least one nanosecond in seconds.");
          return;
        }
        if (gapText !== "" && threshold === null) {
          setError("Enter a finite gap threshold greater than 0.");
          return;
        }
        setBucket(width === null ? "" : String(width));
        setGapText(threshold === null ? "" : String(threshold));
        apply({
          line: { aggregate, ...(width === null ? {} : { bucketSeconds: width }) },
          lineGap: threshold ?? undefined,
        });
      }}
    >
      <OptionSelect
        label="Line aggregation"
        value={aggregate}
        choices={{ raw: "Raw values", mean: "Mean", sum: "Sum" }}
        onChange={(value) => {
          setAggregate(value);
          setError("");
        }}
      />
      {temporal && (
        <label>
          Bucket seconds
          <input
            type="number"
            step="any"
            min={1e-9}
            value={bucket}
            disabled={!canBucket}
            onChange={(event) => {
              setBucket(event.currentTarget.value);
              setError("");
            }}
          />
        </label>
      )}
      <label>
        Gap threshold
        <input
          type="number"
          step="any"
          min={0}
          value={gapText}
          onChange={(event) => {
            setGapText(event.currentTarget.value);
            setError("");
          }}
        />
      </label>
      <p className="chart-parameter-hint">
        {temporal
          ? "Gap threshold in seconds."
          : transformed
            ? "Gap threshold in transformed X units."
            : "Gap threshold in plot X units."}{" "}
        Leave blank to connect points.
      </p>
      {error && (
        <p className="chart-parameter-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={
          aggregate === line.aggregate && bucket === initialBucket && gapText === initialGap
        }
      >
        Apply line options
      </button>
    </form>
  );
}

function BarOptions({
  options,
  y,
  onOptions,
}: {
  options: ChartOptions;
  y: ChartColumn | null;
  onOptions(options: Partial<ChartOptions>): void;
}) {
  const bar = barSettings(options, y);
  const [limit, setLimit] = useState(String(bar.limit));
  const [error, setError] = useState(false);
  return (
    <>
      <OptionSelect
        label="Bar orientation"
        value={options.barOrientation ?? "horizontal"}
        choices={{ horizontal: "Horizontal", vertical: "Vertical" }}
        onChange={(barOrientation) => onOptions({ barOrientation })}
      />
      <OptionSelect
        label="Bar aggregation"
        value={bar.aggregate}
        choices={{ count: "Count", sum: "Sum", mean: "Mean" }}
        onChange={(aggregate) => onOptions({ bar: { ...options.bar, aggregate } })}
      />
      <OptionSelect
        label="Bar order"
        value={bar.sort}
        choices={{ category: "Category", asc: "Value ascending", desc: "Value descending" }}
        onChange={(sort) => onOptions({ bar: { ...options.bar, sort } })}
      />
      <form
        className="chart-parameter-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseChartNumber(limit, 1, 32, true);
          if (value === null) setError(true);
          else {
            setLimit(String(value));
            onOptions({ bar: { ...options.bar, limit: value } });
          }
        }}
      >
        <label>
          Top N
          <input
            type="number"
            min={1}
            max={32}
            value={limit}
            aria-invalid={error}
            onChange={(event) => {
              setLimit(event.currentTarget.value);
              setError(false);
            }}
          />
        </label>
        {error && (
          <p className="chart-parameter-error" role="alert">
            Enter a whole category limit from 1 to 32.
          </p>
        )}
        <button type="submit" disabled={limit === String(bar.limit)}>
          Apply bar limit
        </button>
      </form>
      <label className="chart-checkbox">
        <input
          type="checkbox"
          checked={options.barShowValues ?? false}
          onChange={(event) => onOptions({ barShowValues: event.currentTarget.checked })}
        />
        Show values
      </label>
      <label className="chart-checkbox">
        <input
          type="checkbox"
          checked={bar.aggregate !== "mean" && (options.barShowShare ?? false)}
          disabled={bar.aggregate === "mean"}
          onChange={(event) => onOptions({ barShowShare: event.currentTarget.checked })}
        />
        Show share
      </label>
      {bar.aggregate === "mean" && (
        <p className="chart-parameter-hint">Share is available for count and sum.</p>
      )}
    </>
  );
}

export function AnalyticalOptions({
  card,
  source,
  onOptions,
}: {
  card: ChartCardModel;
  source: ResolvedSource;
  onOptions(options: Partial<ChartOptions>): void;
}) {
  const { kind, options } = card;
  const axes = suggestedAxes(card, source);
  const x = resolveColumn(axes.x, source);
  const y = resolveColumn(axes.y, source);
  const temporal = isBucketable(x);
  const transformed = !temporal && (options.xScale ?? "linear") !== "linear";
  const grouped = kind === "box" || kind === "violin";
  const pointLabel = resolveColumn(options.scatterLabel ?? null, source);
  return (
    <>
      {kind === "scatter" && source.status === "ready" && (
        <label>
          Point label
          <select
            value={pointLabel?.id ?? (options.scatterLabel ? "unavailable" : "")}
            onChange={(event) => {
              const column = source.columns.find((item) => item.id === event.currentTarget.value);
              onOptions({ scatterLabel: column ? columnBinding(column, source.source) : null });
            }}
          >
            {options.scatterLabel && !pointLabel && (
              <option value="unavailable" disabled>
                Select label again
              </option>
            )}
            <option value="">No label</option>
            {source.columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "line" && (
        <LineOptions
          key={JSON.stringify([temporal, options.line, options.lineGap])}
          line={options.line ?? { aggregate: "raw" }}
          gap={options.lineGap}
          temporal={temporal}
          transformed={transformed}
          apply={onOptions}
        />
      )}
      {kind === "histogram" && (
        <>
          <OptionSelect
            label="Histogram normalization"
            value={options.histogramNormalization ?? "count"}
            choices={{ count: "Count", percent: "Percent", density: "Density" }}
            onChange={(histogramNormalization) => onOptions({ histogramNormalization })}
          />
          <HistogramRangeOptions
            key={JSON.stringify(options.histogramRange)}
            current={options.histogramRange}
            transformed={transformed}
            apply={(histogramRange) => onOptions({ histogramRange })}
          />
        </>
      )}
      {(grouped || kind === "bar") && (
        <OptionSelect
          label="Category labels"
          value={options.categoryLabels ?? "auto"}
          choices={{ auto: "Auto", all: "All" }}
          onChange={(categoryLabels) => onOptions({ categoryLabels })}
        />
      )}
      {grouped && (
        <>
          <OptionSelect
            label="Category order"
            value={options.groupOrder ?? "label"}
            choices={{ label: "Label", median: "Median", count: "Count" }}
            onChange={(groupOrder) => onOptions({ groupOrder })}
          />
          <label className="chart-checkbox">
            <input
              type="checkbox"
              checked={options.showOutliers ?? true}
              onChange={(event) => onOptions({ showOutliers: event.currentTarget.checked })}
            />
            Show outlier points
          </label>
        </>
      )}
      {kind === "violin" && (
        <OptionSelect
          label="Violin width normalization"
          value={options.violinWidth ?? "peak"}
          choices={{ peak: "Peak", area: "Area", count: "Count" }}
          onChange={(violinWidth) => onOptions({ violinWidth })}
        />
      )}
      {kind === "box" && (
        <OptionSelect
          label="Box whiskers"
          value={options.whiskers ?? "iqr"}
          choices={{ iqr: "1.5 × IQR", minmax: "Minimum and maximum" }}
          onChange={(whiskers) => onOptions({ whiskers })}
        />
      )}
      {kind === "bar" && (
        <BarOptions key={options.bar?.limit ?? 32} options={options} y={y} onOptions={onOptions} />
      )}
    </>
  );
}
