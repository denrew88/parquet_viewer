import { ArrowUpRight } from "lucide-react";
import type { RelatedChart } from "../workspaceNavigation";

function MiniPlot({ chart }: { chart: RelatedChart }) {
  const preview = chart.getPreview?.();
  if (!preview) return null;
  const { kind, data } = preview;
  const points = data.points;
  const values =
    data.bins?.map((bin) => bin.count) ??
    (kind === "bar" ? data.groups?.map((group) => group.value ?? group.count) : undefined);
  const width = 220;
  const height = 70;
  const label = `${chart.title} preview`;
  if (values?.length) {
    const scale = Math.max(1, ...values.map(Math.abs));
    const scaled = values.map((value) => value / scale);
    const minimum = Math.min(0, ...scaled);
    const maximum = Math.max(0, ...scaled);
    const span = maximum - minimum || 1;
    const y = (value: number) => height - ((value - minimum) / span) * height;
    const step = width / values.length;
    return (
      <svg
        className="linked-chart__plot"
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
      >
        {scaled.map((value, index) => (
          <rect
            key={index}
            x={index * step}
            y={Math.min(y(value), y(0))}
            width={step - 1}
            height={Math.abs(y(value) - y(0))}
            fill="currentColor"
          />
        ))}
      </svg>
    );
  }
  if (!points?.length) return null;
  const step = Math.ceil(points.length / 100);
  const sample: [number, number][] = [];
  for (let index = 0; index < points.length; index += step) {
    if (points[index].every(Number.isFinite)) sample.push(points[index]);
  }
  if (!sample.length) return null;
  const xs = sample.map(([x]) => x);
  const ys = sample.map(([, y]) => y);
  const [xMin, xMax, yMin, yMax] = data.scatterExtent ?? [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const fraction = (value: number, min: number, max: number) => {
    if (max === min) return 0.5;
    const scale = Math.max(1, Math.abs(min), Math.abs(max));
    return (value / scale - min / scale) / (max / scale - min / scale);
  };
  const plot = sample.map(([x, y]) => [
    fraction(x, xMin, xMax) * width,
    (1 - fraction(y, yMin, yMax)) * height,
  ]);
  return (
    <svg
      className="linked-chart__plot"
      role="img"
      aria-label={label}
      viewBox={`-2 -2 ${width + 4} ${height + 4}`}
    >
      {kind === "line" ? (
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          points={plot.map((point) => point.join(",")).join(" ")}
        />
      ) : (
        plot.map(([x, y], index) => (
          <circle key={index} cx={x} cy={y} r="1.6" fill="currentColor" />
        ))
      )}
    </svg>
  );
}

export function LinkedCharts({
  charts,
  onOpen,
}: {
  charts: readonly RelatedChart[];
  onOpen(chart: RelatedChart): void;
}) {
  if (charts.length === 0) return <p>No charts are linked to this SQL tab.</p>;
  return (
    <ul className="linked-charts">
      {charts.map((chart) => (
        <li key={chart.cardId}>
          <strong title={chart.title}>{chart.title}</strong>
          <span title={chart.sheetName}>{chart.sheetName}</span>
          <MiniPlot chart={chart} />
          <button
            type="button"
            aria-label={`Open ${chart.title} in Charts`}
            onClick={() => onOpen(chart)}
          >
            <ArrowUpRight aria-hidden="true" /> Open in Charts
          </button>
        </li>
      ))}
    </ul>
  );
}
