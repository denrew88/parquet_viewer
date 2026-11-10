import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { Pencil, Plus, X } from "lucide-react";
import type {
  ChartColumn,
  ChartSelection,
  ChartSourceOption,
  ChartSqlSource,
} from "../chart-workspace/contract";
import { SqlWorkspace } from "./SqlWorkspace";
import type { SqlStatus } from "./backend";
import { createSqlRunQueue } from "./runQueue";

interface Props extends Omit<
  ComponentProps<typeof SqlWorkspace>,
  "workspaceId" | "onResultChange" | "onSendChart" | "onChartSelection"
> {
  onSourcesChange(sources: ChartSourceOption[]): void;
  onSendChart(sourceId: string): void;
  onChartSelection(
    source: ChartSqlSource,
    selection: ChartSelection,
    columns: ChartColumn[],
    label: string,
  ): void;
}

const MAX_SQL_TABS = 8;
const first = { id: "query-1", name: "Query 1" };
const chartId = (id: string) => `sql:${id}`;

export function SqlTabs({
  active,
  onSourcesChange,
  onSendChart,
  onChartSelection,
  ...workspace
}: Props) {
  const [tabs, setTabs] = useState([first]);
  const [activeId, setActiveId] = useState(first.id);
  const [results, setResults] = useState<Record<string, SqlStatus | null>>({});
  const [rename, setRename] = useState<string | null>(null);
  const sequence = useRef(1);
  const [runQueue] = useState(createSqlRunQueue);
  const focusId = useRef<string | null>(null);
  const current = tabs.find((tab) => tab.id === activeId)!;

  useEffect(() => {
    onSourcesChange(
      tabs.map((tab) => {
        const result = results[tab.id];
        return {
          id: chartId(tab.id),
          name: tab.name,
          kind: "sql",
          columns: result?.columns ?? [],
          source: result?.resultId
            ? { kind: "sql", runId: result.runId, resultId: result.resultId }
            : null,
        };
      }),
    );
  }, [onSourcesChange, results, tabs]);

  useEffect(() => {
    const element = document.getElementById(`sql-tab-${activeId}`);
    if (active && element && focusId.current === activeId) {
      element.focus();
      focusId.current = null;
    }
    if (active) element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, activeId]);

  function add() {
    if (tabs.length >= MAX_SQL_TABS) return;
    const n = ++sequence.current;
    const tab = { id: `query-${n}`, name: `Query ${n}` };
    setTabs([...tabs, tab]);
    setRename(null);
    focusId.current = tab.id;
    setActiveId(tab.id);
  }

  function close(id: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (!remaining.length) {
      const n = ++sequence.current;
      remaining.push({ id: `query-${n}`, name: `Query ${n}` });
    }
    setTabs(remaining);
    setResults((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (activeId === id) {
      const next = remaining[Math.min(index, remaining.length - 1)]!;
      focusId.current = next.id;
      setRename(null);
      setActiveId(next.id);
    }
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "F2") {
      event.preventDefault();
      setRename(tabs[index].name);
      return;
    }
    let next: number;
    if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setRename(null);
    const tab = tabs[next]!;
    if (tab.id === activeId) return;
    focusId.current = tab.id;
    setActiveId(tab.id);
  }

  return (
    <div className="sql-tabs" hidden={!active}>
      <nav className="sql-tabs__bar" aria-label="SQL tab controls">
        <div className="sql-tabs__list" role="tablist" aria-label="SQL tabs">
          {tabs.map((tab, index) => (
            <div className="sql-tabs__item" key={tab.id}>
              <button
                type="button"
                role="tab"
                id={`sql-tab-${tab.id}`}
                aria-controls={`sql-tab-panel-${tab.id}`}
                aria-selected={activeId === tab.id}
                tabIndex={activeId === tab.id ? 0 : -1}
                title={tab.name}
                onClick={() => {
                  setActiveId(tab.id);
                  if (activeId !== tab.id) setRename(null);
                }}
                onDoubleClick={() => setRename(tab.name)}
                onKeyDown={(event) => tabKey(event, index)}
              >
                {tab.name}
              </button>
              <button type="button" aria-label={`Close ${tab.name}`} onClick={() => close(tab.id)}>
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={add} disabled={tabs.length >= MAX_SQL_TABS}>
          <Plus aria-hidden="true" /> New SQL tab
        </button>
        {rename === null ? (
          <button
            type="button"
            title={`Rename ${current.name} (F2)`}
            onClick={() => setRename(current.name)}
          >
            <Pencil aria-hidden="true" /> Rename tab
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = rename.trim();
              if (!name) return;
              setTabs(tabs.map((tab) => (tab.id === activeId ? { ...tab, name } : tab)));
              setRename(null);
              document.getElementById(`sql-tab-${activeId}`)?.focus();
            }}
          >
            <input
              aria-label="SQL tab name"
              autoFocus
              maxLength={64}
              value={rename}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  setRename(null);
                  document.getElementById(`sql-tab-${activeId}`)?.focus();
                }
              }}
            />
            <button type="submit" disabled={!rename.trim()}>
              Save
            </button>
          </form>
        )}
      </nav>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`sql-tab-panel-${tab.id}`}
          aria-labelledby={`sql-tab-${tab.id}`}
          hidden={activeId !== tab.id}
          className="sql-tabs__panel"
        >
          <SqlWorkspace
            {...workspace}
            workspaceId={tab.id}
            runQueue={runQueue}
            active={active && activeId === tab.id}
            onResultChange={(status) => setResults((old) => ({ ...old, [tab.id]: status }))}
            onSendChart={() => onSendChart(chartId(tab.id))}
            onChartSelection={(source, selection, columns) =>
              onChartSelection(source, selection, columns, tab.name)
            }
          />
        </div>
      ))}
    </div>
  );
}
