import { useState } from "react";
import { AnalyticalOptions } from "./AnalyticalOptions";
import { MAX_HISTOGRAM_BINS, type ChartRequest, type ChartScale } from "./contract";
import {
  appearanceSettings,
  chartScales,
  hasAppearance,
  hasScaleControl,
  parseChartNumber,
  resolveColumn,
  suggestedAxes,
  supportsNonlinearScale,
  type ChartCardModel,
  type ChartOptions,
  type ResolvedSource,
} from "./chartModel";

type Histogram = ChartRequest["histogram"];
type BinMode = "auto" | NonNullable<Histogram>["mode"];

function HistogramOptions({
  current,
  scale,
  apply,
}: {
  current: Histogram;
  scale: ChartScale;
  apply(histogram: Histogram): void;
}) {
  const [mode, setMode] = useState<BinMode>(current?.mode ?? "auto");
  const [count, setCount] = useState(current?.mode === "count" ? String(current.count) : "20");
  const [width, setWidth] = useState(current?.mode === "width" ? String(current.width) : "1");
  const [error, setError] = useState("");
  const pending =
    mode !== (current?.mode ?? "auto") ||
    (mode === "count" && count !== String(current?.mode === "count" ? current.count : 20)) ||
    (mode === "width" && width !== String(current?.mode === "width" ? current.width : 1));

  return (
    <form
      className="chart-parameter-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === "auto") {
          apply(undefined);
          return;
        }
        if (mode === "count") {
          const value = parseChartNumber(count, 1, MAX_HISTOGRAM_BINS, true);
          if (value === null) {
            setError(`Enter a whole bin count from 1 to ${MAX_HISTOGRAM_BINS}.`);
          } else {
            setCount(String(value));
            apply({ mode, count: value });
          }
          return;
        }
        const value = parseChartNumber(width, Number.MIN_VALUE, Number.MAX_VALUE);
        if (value === null) {
          setError("Enter a finite bin width greater than 0.");
        } else {
          setWidth(String(value));
          apply({ mode, width: value });
        }
      }}
    >
      <label>
        Histogram bins
        <select
          value={mode}
          onChange={(event) => {
            setMode(event.currentTarget.value as BinMode);
            setError("");
          }}
        >
          <option value="auto">Auto</option>
          <option value="count">Number of bins</option>
          <option value="width">Bin width</option>
        </select>
      </label>
      {mode === "count" && (
        <label>
          Bin count
          <input
            type="number"
            min={1}
            max={MAX_HISTOGRAM_BINS}
            value={count}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setCount(event.currentTarget.value);
              setError("");
            }}
          />
        </label>
      )}
      {mode === "width" && (
        <>
          <label>
            Bin width
            <input
              type="number"
              step="any"
              min={0}
              value={width}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setWidth(event.currentTarget.value);
                setError("");
              }}
            />
          </label>
          {scale !== "linear" && (
            <p className="chart-parameter-hint">
              Bin width uses transformed {chartScales[scale]} units.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="chart-parameter-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={!pending}>
        Apply histogram bins
      </button>
    </form>
  );
}

function BandwidthOption({ current, apply }: { current: number; apply(value: number): void }) {
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState(false);
  return (
    <form
      className="chart-parameter-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const value = parseChartNumber(draft, 0.25, 4);
        if (value === null) {
          setError(true);
        } else {
          setDraft(String(value));
          apply(value);
        }
      }}
    >
      <label>
        Violin bandwidth
        <input
          type="number"
          min={0.25}
          max={4}
          step="any"
          value={draft}
          aria-invalid={error}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(false);
          }}
        />
      </label>
      <p className="chart-parameter-hint">Multiplier 0.25–4. Larger values smooth the density.</p>
      {error && (
        <p className="chart-parameter-error" role="alert">
          Enter a bandwidth from 0.25 to 4.
        </p>
      )}
      <button type="submit" disabled={draft === String(current)}>
        Apply bandwidth
      </button>
    </form>
  );
}

export function ChartParameters({
  card,
  source,
  onOptions,
}: {
  card: ChartCardModel;
  source: ResolvedSource;
  onOptions(options: Partial<ChartOptions>): void;
}) {
  const { kind, options } = card;
  if (!kind) return null;
  const axes = suggestedAxes(card, source);
  const hasScale = (axis: "x" | "y") =>
    supportsNonlinearScale(kind, axis, resolveColumn(axes[axis], source));
  const appearance = hasAppearance(kind)
    ? {
        setting: appearanceSettings[kind],
        kind,
        value: options.appearance?.[kind] ?? appearanceSettings[kind].initial,
      }
    : null;
  const histogram = options.histogram;
  return (
    <div className="chart-inspector-section">
      <h4>Chart parameters</h4>
      {(["x", "y"] as const).map((axis) => {
        if (!hasScaleControl(kind, axis)) return null;
        const enabled = hasScale(axis);
        const field = axis === "x" ? "xScale" : "yScale";
        const scale = enabled ? (options[field] ?? "linear") : "linear";
        return (
          <div key={axis}>
            <label>
              {axis === "x" ? "X scale" : "Y scale"}
              <select
                value={scale}
                disabled={!enabled}
                onChange={(event) =>
                  onOptions({ [field]: event.currentTarget.value as ChartScale })
                }
              >
                {Object.entries(chartScales).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!enabled && (
              <p className="chart-parameter-hint">Log scales require a numeric column.</p>
            )}
            {(scale === "log" || scale === "log10") && (
              <p className="chart-parameter-hint">Includes values greater than 0.</p>
            )}
            {scale === "log1p" && (
              <p className="chart-parameter-hint">Includes values greater than −1.</p>
            )}
          </div>
        );
      })}
      {kind === "histogram" && (
        <HistogramOptions
          key={JSON.stringify(histogram ?? null)}
          current={histogram}
          scale={hasScale("x") ? (options.xScale ?? "linear") : "linear"}
          apply={(value) => onOptions({ histogram: value })}
        />
      )}
      {kind === "violin" && (
        <BandwidthOption
          key={options.violinBandwidth ?? 1}
          current={options.violinBandwidth ?? 1}
          apply={(value) => onOptions({ violinBandwidth: value })}
        />
      )}
      <AnalyticalOptions card={card} source={source} onOptions={onOptions} />
      {appearance && (
        <div className="chart-appearance">
          <label>
            {appearance.setting.label}
            <input
              type="range"
              min={appearance.setting.min}
              max={appearance.setting.max}
              step={1}
              value={appearance.value}
              onChange={(event) =>
                onOptions({
                  appearance: {
                    ...options.appearance,
                    [appearance.kind]: event.currentTarget.valueAsNumber,
                  },
                })
              }
            />
          </label>
          <output>
            {appearance.value}
            {appearance.setting.unit}
          </output>
        </div>
      )}
    </div>
  );
}
