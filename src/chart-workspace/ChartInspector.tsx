import { useState } from "react";
import { CopyPlus, Trash2, X } from "lucide-react";
import { ChartParameters } from "./ChartParameters";
import type { ChartColumn, ChartSourceOption } from "./contract";
import {
  acceptsColumn,
  axesFor,
  chartKinds,
  defaultChartTitle,
  resolveColumn,
  sourceIdentity,
  suggestedAxes,
  type ChartCardModel,
  type ChartKind,
  type ChartOptions,
  type ResolvedSource,
} from "./chartModel";

interface Props {
  card: ChartCardModel;
  source: ResolvedSource;
  sources: readonly ChartSourceOption[];
  busy: boolean;
  onTitle(title: string): void;
  onSource(id: string): void;
  onKind(kind: ChartKind): void;
  onAxis(axis: "x" | "y", id: string): void;
  onOptions(options: Partial<ChartOptions>): void;
  onFilter(columnId: string, equals: string): void;
  onRefresh(mode: "follow" | "pin"): void;
  onClose(): void;
  onDuplicate(): void;
  onRemove(): void;
}

function options(columns: ChartColumn[]) {
  const counts = new Map<string, number>();
  for (const { name } of columns) counts.set(name, (counts.get(name) ?? 0) + 1);
  return columns.map((column) => (
    <option key={column.id} value={column.id}>
      {column.name || column.id}
      {(counts.get(column.name) ?? 0) > 1 && ` (${column.id})`}
    </option>
  ));
}

function ChartFilter({
  columns,
  columnId,
  equals,
  apply,
}: {
  columns: ChartColumn[];
  columnId: string;
  equals: string;
  apply(columnId: string, equals: string): void;
}) {
  const [column, setColumn] = useState(columnId);
  const [value, setValue] = useState(equals);
  return (
    <form
      className="chart-filter"
      onSubmit={(event) => {
        event.preventDefault();
        apply(column, value);
      }}
    >
      <label>
        Filter column
        <select value={column} onChange={(event) => setColumn(event.currentTarget.value)}>
          <option value="">No filter</option>
          {options(columns)}
        </select>
      </label>
      <label>
        Filter value
        <input
          disabled={!column}
          maxLength={1024}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={column === columnId && value === equals}>
        Apply filter
      </button>
    </form>
  );
}

export function ChartInspector({
  card,
  source,
  sources,
  busy,
  onTitle,
  onSource,
  onKind,
  onAxis,
  onOptions,
  onFilter,
  onRefresh,
  onClose,
  onDuplicate,
  onRemove,
}: Props) {
  const selected = card.binding;
  const disconnected = source.status === "disconnected";
  const detached =
    selected?.kind === "block" ||
    selected?.kind === "pinned" ||
    (selected?.kind === "file" && Boolean(selected.selection) && !disconnected);
  const current = detached ? "saved" : !disconnected && selected ? selected.sourceId : "";
  const axes = card.kind ? axesFor(card.kind) : null;
  const configured = suggestedAxes(card, source);
  const filterColumn = card.filter && resolveColumn(card.filter.column, source);
  return (
    <aside className="chart-inspector" aria-label="Chart settings">
      <header>
        <h3>Chart settings</h3>
        <button
          type="button"
          className="chart-icon-button"
          aria-label="Close chart settings"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <label>
        Chart title
        <input
          value={card.title}
          maxLength={120}
          onChange={(event) => onTitle(event.currentTarget.value)}
          onBlur={() => {
            if (!card.title.trim()) onTitle(defaultChartTitle(card.kind));
          }}
        />
      </label>
      <label>
        Data source
        <select
          value={current}
          disabled={busy}
          onChange={(event) => onSource(event.currentTarget.value)}
        >
          <option value="">
            {disconnected ? "Reconnect data source" : "Choose a data source"}
          </option>
          {detached && (
            <option value="saved">
              {selected.kind === "pinned" ? "Pinned SQL result" : "Selected cells"} · {source.name}
            </option>
          )}
          {sources.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.kind === "file" ? "File" : "SQL"} · {candidate.name}
            </option>
          ))}
        </select>
      </label>
      {(selected?.kind === "follow" || selected?.kind === "pinned") && (
        <label>
          Refresh mode
          <select
            value={selected.kind === "pinned" ? "pin" : "follow"}
            disabled={busy || (source.status !== "ready" && selected.kind !== "pinned")}
            onChange={(event) => onRefresh(event.currentTarget.value === "pin" ? "pin" : "follow")}
          >
            <option value="follow">Follow latest successful run</option>
            <option value="pin">Pin this result</option>
          </select>
        </label>
      )}
      {source.status === "waiting" && selected?.kind === "follow" && (
        <p className="chart-inspector-note">Run this SQL tab to get data.</p>
      )}
      {source.status === "disconnected" && (
        <p className="chart-inspector-note">Choose a source to reconnect this chart.</p>
      )}
      <div className="chart-inspector-section">
        <h4>Encoding</h4>
        <label>
          Chart type
          <select
            value={card.kind ?? ""}
            onChange={(event) => onKind(event.currentTarget.value as ChartKind)}
          >
            <option value="" disabled>
              Choose a chart type
            </option>
            {Object.entries(chartKinds).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(["x", "y"] as const).map((axis) => {
          const config = axes?.[axis];
          if (!config) return null;
          const explicitBar =
            card.kind === "bar" && axis === "y" ? card.options.bar?.aggregate : undefined;
          const countOnly = explicitBar === "count";
          const optional = config.optional && !explicitBar;
          const choices = source.columns.filter((column) => acceptsColumn(column, config.role));
          return (
            <label key={axis}>
              {config.label}
              <select
                value={countOnly ? "" : (resolveColumn(configured[axis], source)?.id ?? "")}
                disabled={countOnly || source.status !== "ready" || choices.length === 0}
                onChange={(event) => onAxis(axis, event.currentTarget.value)}
              >
                <option value="" disabled={!optional}>
                  {countOnly ? "Unused for count" : optional ? "Count rows" : "Select a column"}
                </option>
                {options(choices)}
              </select>
            </label>
          );
        })}
      </div>
      <ChartParameters card={card} source={source} onOptions={onOptions} />
      {source.status === "ready" && (
        <div className="chart-inspector-section">
          <h4>Exact-match filter</h4>
          {card.filter && !filterColumn && (
            <button type="button" onClick={() => onFilter("", "")}>
              Clear unavailable filter
            </button>
          )}
          <ChartFilter
            key={JSON.stringify([
              sourceIdentity(source.source),
              filterColumn?.id,
              card.filter?.equals,
            ])}
            columns={source.columns}
            columnId={filterColumn?.id ?? ""}
            equals={card.filter?.equals ?? ""}
            apply={onFilter}
          />
        </div>
      )}
      <div className="chart-inspector-actions">
        <button type="button" onClick={onDuplicate} disabled={busy}>
          <CopyPlus aria-hidden="true" /> Duplicate chart
        </button>
        <button type="button" onClick={onRemove}>
          <Trash2 aria-hidden="true" /> Remove chart
        </button>
      </div>
    </aside>
  );
}
