import { Fragment, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { SqlStatus } from "./backend";
import "./SqlPlan.css";

type PlanNode = {
  name: string;
  depth: number;
  value: Record<string, unknown>;
  timeMs: number | null;
};

function planNodes(tree: unknown) {
  const nodes: PlanNode[] = [];
  function visit(value: unknown, depth: number, level: number) {
    if (!value || typeof value !== "object" || level > 40 || nodes.length >= 1000) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth, level + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.operator_name === "string" ? record.operator_name : record.name;
    if (typeof name === "string") {
      const seconds = record.operator_timing;
      const milliseconds = typeof seconds === "number" ? seconds * 1000 : NaN;
      nodes.push({
        name,
        depth,
        value: record,
        timeMs: Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null,
      });
      depth += 1;
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) visit(child, depth, level + 1);
    }
  }
  visit(tree, 0, 0);

  let totalMs = 0;
  let slowest: PlanNode | undefined;
  for (const node of nodes) {
    const timeMs = node.timeMs ?? 0;
    totalMs += timeMs;
    if (timeMs > (slowest?.timeMs ?? 0)) slowest = node;
  }
  return { nodes, totalMs, slowest };
}

function formatTime(timeMs: number) {
  return timeMs > 0 && timeMs < 0.001 ? "<0.001 ms" : `${Number(timeMs.toFixed(3))} ms`;
}

function formatShare(share: number) {
  return share < 0.1 ? "<0.1%" : `${Number(share.toFixed(1))}%`;
}

function detailText(value: unknown): string {
  if (value == null) return "Not provided";
  if (Array.isArray(value)) return value.map(detailText).join("\n");
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function SqlPlan({ status }: { status: Pick<SqlStatus, "planText" | "planJson"> | null }) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlanNode | null>(null);
  const tree = useMemo(() => {
    if (typeof status?.planJson !== "string") return status?.planJson;
    try {
      return JSON.parse(status.planJson) as unknown;
    } catch {
      return null;
    }
  }, [status?.planJson]);
  const { nodes, totalMs, slowest } = useMemo(() => planNodes(tree), [tree]);
  const rawPlan = useMemo(
    () => status?.planText ?? (tree ? JSON.stringify(tree, null, 2) : ""),
    [status?.planText, tree],
  );
  if (!rawPlan)
    return (
      <div className="sql-empty">Choose Explain or Analyze to inspect the execution plan.</div>
    );

  const selectedNode = selected && nodes.includes(selected) ? selected : nodes[0];
  const info = selectedNode?.value.extra_info;
  const extraInfo =
    info && typeof info === "object" && !Array.isArray(info)
      ? (info as Record<string, unknown>)
      : {};
  const shareFor = (node: PlanNode) =>
    node.timeMs !== null && node.timeMs > 0 && Number.isFinite(totalMs)
      ? (node.timeMs / totalMs) * 100
      : null;
  const slowestShare = slowest && shareFor(slowest);

  async function copyPlan() {
    try {
      if ("__TAURI_INTERNALS__" in window) await writeText(rawPlan);
      else await navigator.clipboard.writeText(rawPlan);
      setCopyMessage("Execution plan copied.");
    } catch (cause) {
      setCopyMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="sql-plan">
      <div className="sql-plan__toolbar">
        <button type="button" onClick={() => void copyPlan()}>
          Copy execution plan
        </button>
        {copyMessage && <span role="status">{copyMessage}</span>}
      </div>
      {slowest && slowest.timeMs !== null && slowestShare != null && (
        <div className="sql-plan__summary" role="region" aria-label="Operator timing summary">
          <span>
            <strong>Slowest operator</strong> <span title={slowest.name}>{slowest.name}</span>
          </span>
          <strong>
            {formatTime(slowest.timeMs)} · {formatShare(slowestShare)}
          </strong>
          <span className="sql-plan__share-note">Share of total measured operator time</span>
        </div>
      )}
      <div className="sql-plan__panes" data-structured={nodes.length > 0}>
        {nodes.length > 0 && (
          <div
            className="sql-plan__nodes"
            role="region"
            aria-label="Execution plan nodes"
            tabIndex={0}
          >
            {nodes.map((node, index) => {
              const share = shareFor(node);
              return (
                <button
                  type="button"
                  key={index}
                  style={{ marginInlineStart: Math.min(node.depth, 8) * 7 }}
                  aria-pressed={selectedNode === node}
                  data-slowest={node === slowest}
                  onClick={() => setSelected(node)}
                >
                  <span className="sql-plan__node-name">{node.name}</span>
                  {node.timeMs !== null && (
                    <span className="sql-plan__node-timing">
                      {node === slowest && <strong className="sql-plan__slowest">Slowest</strong>}
                      <span>{formatTime(node.timeMs)}</span>
                      {share != null && <strong>{formatShare(share)}</strong>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div
          className="sql-plan__detail-pane"
          role="region"
          aria-label="Execution plan detail"
          tabIndex={0}
        >
          {selectedNode && (
            <dl className="sql-plan__detail">
              <dt>Operator</dt>
              <dd>{selectedNode.name}</dd>
              <dt>Estimated rows</dt>
              <dd>{detailText(extraInfo["Estimated Cardinality"])}</dd>
              <dt>Actual rows</dt>
              <dd>{detailText(selectedNode.value.operator_cardinality)}</dd>
              <dt>Operator time</dt>
              <dd>
                {selectedNode.timeMs === null ? "Not provided" : formatTime(selectedNode.timeMs)}
              </dd>
              {Object.entries(extraInfo).map(([key, value]) =>
                key === "Estimated Cardinality" ? null : (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{detailText(value)}</dd>
                  </Fragment>
                ),
              )}
            </dl>
          )}
          <details open={!nodes.length}>
            <summary>Raw execution plan</summary>
            <pre>{rawPlan}</pre>
          </details>
          <p className="sql-plan__share-note">
            Analyze executes the query. Parallel operator times need not add up to total elapsed
            time.
          </p>
        </div>
      </div>
    </div>
  );
}
