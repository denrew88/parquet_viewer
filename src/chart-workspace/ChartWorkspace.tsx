import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChartNoAxesCombined, PanelRight, Plus } from "lucide-react";
import type { ChartSeed, ChartWorkspaceProps } from "./contract";
import { ChartCard } from "./ChartCard";
import { ChartInspector } from "./ChartInspector";
import {
  bindSource,
  columnBinding,
  configureChartKind,
  defaultAxes,
  newChart,
  rebindAxes,
  resolveSource,
  sourceIdentity,
  type ChartBinding,
  type ChartCardModel,
  type ChartSheet,
} from "./chartModel";
import { ChartScheduler, type RenderedChart } from "./useChartJob";
import type { PlotZoomCache } from "./usePlotZoom";
import "./ChartWorkspace.css";

const MAX_SHEETS = 12;
const MAX_CARDS_PER_SHEET = 24;

interface WorkspaceState {
  sheets: ChartSheet[];
  active: string;
  selected: Record<string, string | undefined>;
}

function firstSheet(): WorkspaceState {
  const first = { id: "sheet-1", name: "Sheet 1", cards: [] };
  return { sheets: [first], active: first.id, selected: {} };
}

function findCard(state: WorkspaceState, id: string) {
  for (const sheet of state.sheets) {
    const found = sheet.cards.find((card) => card.id === id);
    if (found) return found;
  }
  return undefined;
}

function mapCard(
  state: WorkspaceState,
  id: string,
  update: (card: ChartCardModel) => ChartCardModel,
) {
  return {
    ...state,
    sheets: state.sheets.map((sheet) =>
      sheet.cards.some((card) => card.id === id)
        ? { ...sheet, cards: sheet.cards.map((card) => (card.id === id ? update(card) : card)) }
        : sheet,
    ),
  };
}

function addToSheet(state: WorkspaceState, sheetId: string, card: ChartCardModel): WorkspaceState {
  return {
    ...state,
    active: sheetId,
    selected: { ...state.selected, [sheetId]: card.id },
    sheets: state.sheets.map((sheet) =>
      sheet.id === sheetId ? { ...sheet, cards: [...sheet.cards, card] } : sheet,
    ),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return typeof error === "string" ? error : "The chart operation failed.";
}

function DestinationDialog({
  seed,
  sheets,
  activeSheet,
  onAdd,
  onClose,
}: {
  seed: ChartSeed;
  sheets: ChartSheet[];
  activeSheet: string;
  onAdd(sheetId: string): void;
  onClose(): void;
}) {
  const initial = sheets.find(
    (sheet) => sheet.id === activeSheet && sheet.cards.length < MAX_CARDS_PER_SHEET,
  );
  const [destination, setDestination] = useState(
    initial?.id ?? (sheets.length < MAX_SHEETS ? "new" : ""),
  );
  const selectedRows = seed.block?.rowCount ?? seed.fileSelection?.rowCount;
  const selectedColumns = seed.block?.columns.length ?? seed.fileSelection?.columnIds.length;
  const target = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    target.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div className="chart-destination-backdrop">
      <form
        className="chart-destination-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chart-destination-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (destination) onAdd(destination);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("select,button:not(:disabled)"),
          ];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id="chart-destination-title">Add chart to sheet</h2>
        {selectedRows !== undefined && (
          <p>
            Selected cells · {selectedRows.toLocaleString()} rows · {selectedColumns}{" "}
            {selectedColumns === 1 ? "column" : "columns"}
          </p>
        )}
        <label>
          Destination sheet
          <select
            ref={target}
            value={destination}
            onChange={(event) => setDestination(event.currentTarget.value)}
          >
            <option value="" disabled>
              Select a sheet
            </option>
            {sheets.map((sheet) => (
              <option
                key={sheet.id}
                value={sheet.id}
                disabled={sheet.cards.length >= MAX_CARDS_PER_SHEET}
              >
                {sheet.name}
              </option>
            ))}
            {sheets.length < MAX_SHEETS && <option value="new">New sheet</option>}
          </select>
        </label>
        <div className="chart-destination-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="chart-primary" disabled={!destination}>
            Add chart
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ChartWorkspace({
  active,
  sources,
  seed,
  backend,
  onSeedHandled,
}: ChartWorkspaceProps) {
  const [state, setState] = useState(firstSheet);
  const latest = useRef(state);
  const [scheduler] = useState(() => new ChartScheduler());
  const [cache] = useState(() => new Map<string, RenderedChart>());
  const zoomCache = useRef<PlotZoomCache>(new Map());
  const [showSettings, setShowSettings] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingIds = useRef(new Set<string>());
  const sheetCounter = useRef(1);
  const cardCounter = useRef(0);
  const tabs = useRef<HTMLDivElement>(null);

  const commit = useCallback(
    (update: (previous: WorkspaceState) => WorkspaceState) => {
      const previous = latest.current;
      const next = update(previous);
      if (next === previous) return;
      latest.current = next;
      setState(next);
      const after = next.sheets.flatMap((sheet) => sheet.cards);
      const afterById = new Map(after.map((card) => [card.id, card]));
      const usedBlocks = new Set(
        after.flatMap((card) =>
          card.binding?.kind === "block" ? [card.binding.block.blockId] : [],
        ),
      );
      const releasedBlocks = new Set<string>();
      for (const card of previous.sheets.flatMap((sheet) => sheet.cards)) {
        const replacement = afterById.get(card.id);
        if (!replacement) {
          cache.delete(card.id);
          zoomCache.current.delete(card.id);
        }
        if (card.binding?.kind === "pinned") {
          const nextBinding = replacement?.binding;
          if (
            nextBinding?.kind !== "pinned" ||
            sourceIdentity(nextBinding.source) !== sourceIdentity(card.binding.source)
          ) {
            void backend
              .releaseResult(card.binding.source)
              .catch((cause) => setError(errorText(cause)));
          }
        } else if (card.binding?.kind === "block") {
          const { blockId } = card.binding.block;
          if (!usedBlocks.has(blockId) && !releasedBlocks.has(blockId)) {
            releasedBlocks.add(blockId);
            void backend.releaseBlock(blockId).catch((cause) => setError(errorText(cause)));
          }
        }
      }
    },
    [backend, cache],
  );

  // A chart may start following an SQL tab before its first successful result.
  // Bind its defaults as soon as that first schema exists, including on inactive sheets.
  useEffect(() => {
    commit((previous) => {
      let changed = false;
      const sheets = previous.sheets.map((sheet) => {
        let sheetChanged = false;
        const cards = sheet.cards.map((card) => {
          if (!card.kind || card.x || card.y || card.binding?.kind !== "follow") return card;
          const source = resolveSource(card.binding, sources);
          if (source.status !== "ready") return card;
          const axes = defaultAxes(card.kind, source.columns, source.source);
          if (!axes.x && !axes.y) return card;
          changed = sheetChanged = true;
          return { ...card, ...axes };
        });
        return sheetChanged ? { ...sheet, cards } : sheet;
      });
      return changed ? { ...previous, sheets } : previous;
    });
  }, [commit, sources]);

  const sheet = state.sheets.find((candidate) => candidate.id === state.active)!;
  const selected =
    sheet.cards.find((card) => card.id === state.selected[sheet.id]) ?? sheet.cards[0];
  const selectedSource = selected ? resolveSource(selected.binding, sources) : null;

  function makeSheet(): ChartSheet {
    const number = ++sheetCounter.current;
    return { id: `sheet-${number}`, name: `Sheet ${number}`, cards: [] };
  }

  function switchSheet(id: string) {
    setEditingName(false);
    commit((previous) => ({ ...previous, active: id }));
  }

  function newSheet() {
    if (latest.current.sheets.length >= MAX_SHEETS) return;
    const created = makeSheet();
    commit((previous) => ({
      ...previous,
      sheets: [...previous.sheets, created],
      active: created.id,
    }));
    setEditingName(false);
    requestAnimationFrame(() =>
      tabs.current?.querySelector<HTMLButtonElement>(`[data-sheet-id="${created.id}"]`)?.focus(),
    );
  }

  function renameSheet() {
    const value = name.trim();
    if (value)
      commit((previous) => ({
        ...previous,
        sheets: previous.sheets.map((candidate) =>
          candidate.id === sheet.id ? { ...candidate, name: value } : candidate,
        ),
      }));
    setEditingName(false);
  }

  function closeSheet() {
    commit((previous) => {
      if (previous.sheets.length <= 1) return previous;
      const index = previous.sheets.findIndex((candidate) => candidate.id === sheet.id);
      const sheets = previous.sheets.filter((candidate) => candidate.id !== sheet.id);
      const selected = { ...previous.selected };
      delete selected[sheet.id];
      return { sheets, active: sheets[Math.min(index, sheets.length - 1)].id, selected };
    });
    setEditingName(false);
  }

  function keyboardSheet(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const count = state.sheets.length;
    const next =
      state.sheets[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : (index + (event.key === "ArrowLeft" ? -1 : 1) + count) % count
      ];
    switchSheet(next.id);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-sheet-id="${next.id}"]`)?.focus();
  }

  function insertCard(sheetId: string, binding: ChartBinding | null) {
    const existing = latest.current.sheets.find((candidate) => candidate.id === sheetId);
    if (existing && existing.cards.length >= MAX_CARDS_PER_SHEET) return false;
    if (!existing && (sheetId !== "new" || latest.current.sheets.length >= MAX_SHEETS))
      return false;
    const createdSheet = existing ? null : makeSheet();
    const destination = existing ?? createdSheet!;
    const card = newChart(`card-${++cardCounter.current}`, binding);
    commit((previous) =>
      addToSheet(
        createdSheet ? { ...previous, sheets: [...previous.sheets, createdSheet] } : previous,
        destination.id,
        card,
      ),
    );
    setShowSettings(true);
    return true;
  }

  function placeSeed(sheetId: string) {
    if (!seed) return;
    const option = sources.find((source) => source.id === seed.sourceId);
    const binding = seed.block
      ? { kind: "block" as const, block: seed.block }
      : option
        ? bindSource(option)
        : null;
    if (
      !binding ||
      (seed.fileSelection &&
        (binding.kind !== "file" || binding.sessionId !== seed.fileSelection.sessionId))
    ) {
      setError("The source was closed. Reopen it and try again.");
      onSeedHandled();
      return;
    }
    const selected =
      binding.kind === "file" && seed.fileSelection
        ? { ...binding, selection: seed.fileSelection }
        : binding;
    if (insertCard(sheetId, selected)) onSeedHandled();
  }

  function dismissSeed() {
    if (seed?.block)
      void backend.releaseBlock(seed.block.blockId).catch((cause) => setError(errorText(cause)));
    onSeedHandled();
  }

  function selectCard(id: string) {
    commit((previous) => ({ ...previous, selected: { ...previous.selected, [sheet.id]: id } }));
    setShowSettings(true);
  }

  function reorder(movedId: string, targetId: string) {
    if (movedId === targetId) return;
    commit((previous) => ({
      ...previous,
      sheets: previous.sheets.map((candidate) => {
        if (candidate.id !== sheet.id) return candidate;
        const source = candidate.cards.findIndex((card) => card.id === movedId);
        const target = candidate.cards.findIndex((card) => card.id === targetId);
        if (source < 0 || target < 0) return candidate;
        const cards = [...candidate.cards];
        cards.splice(target, 0, cards.splice(source, 1)[0]);
        return { ...candidate, cards };
      }),
    }));
  }

  function patchCard(id: string, patch: (card: ChartCardModel) => ChartCardModel) {
    commit((previous) => mapCard(previous, id, patch));
  }

  async function withRetainedResult(
    cardId: string,
    source: Extract<ChartBinding, { kind: "pinned" }>["source"],
    accept: () => boolean,
  ) {
    if (pendingIds.current.has(cardId)) return;
    pendingIds.current.add(cardId);
    setPending(new Set(pendingIds.current));
    setError("");
    try {
      await backend.retainResult(source);
      if (!accept()) await backend.releaseResult(source);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      pendingIds.current.delete(cardId);
      setPending(new Set(pendingIds.current));
    }
  }

  function setRefresh(card: ChartCardModel, mode: "follow" | "pin") {
    if (card.binding?.kind === "pinned" && mode === "follow") {
      const { sourceId, name } = card.binding;
      const option = sources.find((candidate) => candidate.id === sourceId);
      if (!option) {
        setError("The original SQL tab is closed. Choose another source to follow.");
        return;
      }
      patchCard(card.id, (current) => ({
        ...current,
        binding: { kind: "follow", sourceId, name },
      }));
      return;
    }
    if (card.binding?.kind !== "follow" || mode !== "pin") return;
    const source = resolveSource(card.binding, sources);
    if (source.status !== "ready" || source.source.kind !== "sql") return;
    const binding: ChartBinding = {
      kind: "pinned",
      sourceId: card.binding.sourceId,
      name: source.name,
      source: source.source,
      columns: source.columns,
    };
    void withRetainedResult(card.id, source.source, () => {
      const live = findCard(latest.current, card.id);
      if (live?.binding !== card.binding) return false;
      patchCard(card.id, (current) => ({ ...rebindAxes(current, source), binding }));
      return true;
    });
  }

  function duplicate(card: ChartCardModel) {
    if (sheet.cards.length >= MAX_CARDS_PER_SHEET) return;
    const add = () => {
      const destination = latest.current.sheets.find((candidate) => candidate.id === sheet.id);
      const source = findCard(latest.current, card.id);
      if (
        !destination ||
        destination.cards.length >= MAX_CARDS_PER_SHEET ||
        !source ||
        source.binding !== card.binding
      )
        return false;
      const copy = {
        ...source,
        id: `card-${++cardCounter.current}`,
        title: `${source.title} copy`.slice(0, 120),
      };
      commit((previous) => addToSheet(previous, destination.id, copy));
      return true;
    };
    if (card.binding?.kind === "pinned") void withRetainedResult(card.id, card.binding.source, add);
    else add();
  }

  return (
    <section className="chart-workspace" aria-label="Charts workspace" hidden={!active}>
      <div className="chart-sheet-bar">
        <div ref={tabs} className="chart-sheet-tabs" role="tablist" aria-label="Chart sheets">
          {state.sheets.map((candidate, index) => (
            <button
              key={candidate.id}
              id={`charts-tab-${candidate.id}`}
              type="button"
              role="tab"
              data-sheet-id={candidate.id}
              aria-selected={candidate.id === sheet.id}
              aria-controls="charts-sheet-panel"
              tabIndex={candidate.id === sheet.id ? 0 : -1}
              onClick={() => switchSheet(candidate.id)}
              onKeyDown={(event) => keyboardSheet(event, index)}
              title={candidate.name}
            >
              {candidate.name}
            </button>
          ))}
        </div>
        <button type="button" onClick={newSheet} disabled={state.sheets.length >= MAX_SHEETS}>
          <Plus aria-hidden="true" /> New sheet
        </button>
      </div>
      {error && (
        <div className="chart-workspace-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      <div
        id="charts-sheet-panel"
        role="tabpanel"
        aria-labelledby={`charts-tab-${sheet.id}`}
        className="chart-sheet-layout"
        data-settings={Boolean(showSettings && selected)}
      >
        <div className="chart-sheet-scroll">
          <header className="chart-sheet-heading">
            <div className="chart-sheet-title">
              {editingName ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameSheet();
                  }}
                >
                  <input
                    aria-label="Sheet name"
                    autoFocus
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingName(false);
                      }
                    }}
                  />
                  <button type="submit">Save</button>
                </form>
              ) : (
                <h2 title={sheet.name}>{sheet.name}</h2>
              )}
              <p>
                {sheet.cards.length} {sheet.cards.length === 1 ? "chart" : "charts"}
              </p>
            </div>
            <div className="chart-sheet-actions">
              <button
                type="button"
                onClick={() => {
                  setName(sheet.name);
                  setEditingName(true);
                }}
              >
                Rename sheet
              </button>
              <button type="button" onClick={closeSheet} disabled={state.sheets.length < 2}>
                Close sheet
              </button>
              <button
                type="button"
                className="chart-primary"
                disabled={sheet.cards.length >= MAX_CARDS_PER_SHEET}
                onClick={() => {
                  const initial = sources.find((candidate) => candidate.source) ?? sources[0];
                  insertCard(sheet.id, initial ? bindSource(initial) : null);
                }}
              >
                <Plus aria-hidden="true" /> Add chart
              </button>
              {selected && (
                <button
                  type="button"
                  aria-expanded={showSettings}
                  onClick={() => setShowSettings((visible) => !visible)}
                >
                  <PanelRight aria-hidden="true" />{" "}
                  {showSettings ? "Hide chart settings" : "Chart settings"}
                </button>
              )}
            </div>
          </header>
          {sheet.cards.length === 0 ? (
            <div className="chart-sheet-empty">
              <ChartNoAxesCombined aria-hidden="true" />
              <strong>No charts in this sheet</strong>
              <span>Add a chart or send data from a file or SQL result.</span>
            </div>
          ) : (
            <div className="chart-card-grid">
              {sheet.cards.map((card, index) => (
                <ChartCard
                  key={card.id}
                  card={card}
                  source={resolveSource(card.binding, sources)}
                  selected={showSettings && selected?.id === card.id}
                  active={active}
                  backend={backend}
                  scheduler={scheduler}
                  cache={cache}
                  zoomCache={zoomCache.current}
                  onSelect={() => selectCard(card.id)}
                  onMove={(direction) => {
                    const target = sheet.cards[index + direction];
                    if (target) reorder(card.id, target.id);
                  }}
                  onDrop={(id) => reorder(id, card.id)}
                  onResize={(width, height) =>
                    patchCard(card.id, (current) =>
                      current.width === width && current.height === height
                        ? current
                        : { ...current, width, height },
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
        {showSettings && selected && selectedSource && (
          <ChartInspector
            key={selected.id}
            card={selected}
            source={selectedSource}
            sources={sources}
            busy={pending.has(selected.id)}
            onTitle={(title) => patchCard(selected.id, (card) => ({ ...card, title }))}
            onSource={(id) => {
              const option = sources.find((candidate) => candidate.id === id);
              const binding = option ? bindSource(option) : null;
              const source = resolveSource(binding, sources);
              patchCard(selected.id, (card) => {
                if (selectedSource.status === "disconnected" && binding)
                  return { ...rebindAxes(card, source), binding };
                const axes =
                  card.kind && source.status === "ready"
                    ? defaultAxes(card.kind, source.columns, source.source)
                    : { x: null, y: null };
                return { ...card, binding, ...axes, filter: null };
              });
            }}
            onKind={(kind) =>
              patchCard(selected.id, (card) => configureChartKind(card, kind, selectedSource))
            }
            onAxis={(axis, id) =>
              patchCard(selected.id, (card) => {
                const column = selectedSource.columns.find((candidate) => candidate.id === id);
                const value =
                  column && selectedSource.status === "ready"
                    ? columnBinding(column, selectedSource.source)
                    : null;
                return { ...rebindAxes(card, selectedSource), [axis]: value };
              })
            }
            onOptions={(options) =>
              patchCard(selected.id, (card) => ({
                ...card,
                options: { ...card.options, ...options },
              }))
            }
            onFilter={(id, equals) =>
              patchCard(selected.id, (card) => {
                const column = selectedSource.columns.find((candidate) => candidate.id === id);
                return {
                  ...card,
                  filter:
                    column && selectedSource.status === "ready"
                      ? { column: columnBinding(column, selectedSource.source), equals }
                      : null,
                };
              })
            }
            onRefresh={(mode) => setRefresh(selected, mode)}
            onClose={() => setShowSettings(false)}
            onDuplicate={() => duplicate(selected)}
            onRemove={() =>
              commit((previous) => ({
                ...previous,
                sheets: previous.sheets.map((candidate) =>
                  candidate.id === sheet.id
                    ? {
                        ...candidate,
                        cards: candidate.cards.filter((card) => card.id !== selected.id),
                      }
                    : candidate,
                ),
              }))
            }
          />
        )}
      </div>
      {active && seed && (
        <DestinationDialog
          key={seed.id}
          seed={seed}
          sheets={state.sheets}
          activeSheet={sheet.id}
          onAdd={placeSeed}
          onClose={dismissSeed}
        />
      )}
    </section>
  );
}
