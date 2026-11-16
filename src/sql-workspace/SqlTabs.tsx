import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import type {
  ChartColumn,
  ChartSelection,
  ChartSourceOption,
  ChartSqlSource,
} from "../chart-workspace/contract";
import type { SqlNavigationRequest } from "../workspaceNavigation";
import { SqlWorkspace } from "./SqlWorkspace";
import type { SqlSourceIdentity, SqlStatus } from "./backend";
import { createSqlRunQueue } from "./runQueue";

interface Props extends Omit<
  ComponentProps<typeof SqlWorkspace>,
  "workspaceId" | "initialSource" | "onResultChange" | "onSendChart" | "onChartSelection"
> {
  onSourcesChange(sources: ChartSourceOption[]): void;
  onSendChart(sourceId: string): void;
  onChartSelection(
    source: ChartSqlSource,
    selection: ChartSelection,
    columns: ChartColumn[],
    label: string,
  ): void;
  navigation?: SqlNavigationRequest | null;
  onNavigationHandled?(id: number): void;
  onTabCapacityChange?(canAdd: boolean): void;
}

const MAX_SQL_TABS = 8;
interface SqlTab {
  id: string;
  name: string;
  origin?: SqlSourceIdentity;
}
const first: SqlTab = { id: "query-1", name: "Query 1" };
const chartId = (id: string) => `sql:${id}`;

export function SqlTabs({
  active,
  onSourcesChange,
  onSendChart,
  onChartSelection,
  navigation,
  onNavigationHandled,
  onTabCapacityChange,
  ...workspace
}: Props) {
  const [tabs, setTabs] = useState([first]);
  const [activeId, setActiveId] = useState(first.id);
  const [results, setResults] = useState<Record<string, { status: SqlStatus; statement: string }>>(
    {},
  );
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(1);
  const [runQueue] = useState(createSqlRunQueue);
  const focusId = useRef<string | null>(null);
  const handledNavigation = useRef<number | null>(null);
  const editingId = rename?.id;

  useEffect(() => {
    onSourcesChange(
      tabs.map((tab) => {
        const result = results[tab.id]?.status;
        return {
          id: chartId(tab.id),
          name: tab.name,
          kind: "sql",
          columns: result?.columns ?? [],
          source: result?.resultId
            ? { kind: "sql", runId: result.runId, resultId: result.resultId }
            : null,
          sqlReference:
            result || tab.origin
              ? {
                  statement: results[tab.id]?.statement ?? "",
                  referencedSources: result?.referencedSources ?? [],
                  origin: tab.origin,
                }
              : undefined,
        };
      }),
    );
  }, [onSourcesChange, results, tabs]);

  const canAdd = tabs.length < MAX_SQL_TABS;
  useEffect(() => {
    onTabCapacityChange?.(canAdd);
  }, [canAdd, onTabCapacityChange]);

  useEffect(() => {
    if (!active || !navigation || handledNavigation.current === navigation.id) return;
    handledNavigation.current = navigation.id;
    if (navigation.kind === "new" && canAdd) {
      const n = ++sequence.current;
      const tab = { id: `query-${n}`, name: `Query ${n}`, origin: navigation.source };
      setTabs((previous) => [...previous, tab]);
      setRename(null);
      focusId.current = tab.id;
      setActiveId(tab.id);
    } else if (navigation.kind === "tab" && tabs.some((tab) => tab.id === navigation.tabId)) {
      setRename(null);
      focusId.current = navigation.tabId;
      setActiveId(navigation.tabId);
    }
    onNavigationHandled?.(navigation.id);
  }, [active, canAdd, navigation, onNavigationHandled, tabs]);

  useEffect(() => {
    const element = document.getElementById(`sql-tab-${activeId}`);
    if (active && !editingId && element && focusId.current === activeId) {
      element.focus();
      focusId.current = null;
    }
    if (active) element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, activeId, editingId]);

  useEffect(() => {
    if (!active || !editingId) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [active, editingId]);

  function beginRename(tab: SqlTab) {
    setActiveId(tab.id);
    setRename({ id: tab.id, value: tab.name });
  }

  function finishRename(save: boolean) {
    if (!rename) return;
    if (save) {
      const name = rename.value.trim();
      if (!name) return;
      setTabs((old) => old.map((tab) => (tab.id === rename.id ? { ...tab, name } : tab)));
    }
    focusId.current = rename.id;
    setRename(null);
  }

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
      beginRename(tabs[index]);
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
              <div className="sql-tabs__title" data-editing={editingId === tab.id}>
                <button
                  type="button"
                  role="tab"
                  id={`sql-tab-${tab.id}`}
                  aria-controls={`sql-tab-panel-${tab.id}`}
                  aria-description="Double-click or press F2 to rename"
                  aria-selected={activeId === tab.id}
                  tabIndex={activeId === tab.id && !editingId ? 0 : -1}
                  title={tab.name}
                  onClick={() => {
                    setActiveId(tab.id);
                    if (activeId !== tab.id) setRename(null);
                  }}
                  onDoubleClick={() => beginRename(tab)}
                  onKeyDown={(event) => tabKey(event, index)}
                >
                  {tab.name}
                </button>
                {rename?.id === tab.id && (
                  <input
                    ref={renameInput}
                    className="sql-tabs__rename"
                    aria-label="SQL tab name"
                    maxLength={64}
                    value={rename.value}
                    onBlur={() => setRename((old) => (old?.id === tab.id ? null : old))}
                    onChange={(event) => setRename({ id: tab.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                        return;
                      if (event.key === "Enter" || event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        finishRename(event.key === "Enter");
                      }
                    }}
                  />
                )}
              </div>
              <button type="button" aria-label={`Close ${tab.name}`} onClick={() => close(tab.id)}>
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={add} disabled={!canAdd}>
          <Plus aria-hidden="true" /> New SQL tab
        </button>
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
            initialSource={tab.origin}
            runQueue={runQueue}
            active={active && activeId === tab.id}
            onResultChange={(status, statement) =>
              setResults((old) => {
                if (status && statement !== undefined)
                  return { ...old, [tab.id]: { status, statement } };
                if (!(tab.id in old)) return old;
                const next = { ...old };
                delete next[tab.id];
                return next;
              })
            }
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
