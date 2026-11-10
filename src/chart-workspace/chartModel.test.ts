import { describe, expect, it } from "vitest";
import type { ChartSourceOption } from "./contract";
import {
  bindSource,
  configureChartKind,
  newChart,
  parseChartNumber,
  planChart,
  resolveSource,
} from "./chartModel";

const sql = (resultId: string, columns: ChartSourceOption["columns"]): ChartSourceOption => ({
  kind: "sql",
  id: "orders",
  name: "Orders",
  columns,
  source: { kind: "sql", runId: resultId, resultId },
});
const amount = { id: "r1", name: "amount", logicalType: "DECIMAL(18, 2)" };
const category = { id: "r0", name: "category", logicalType: "VARCHAR" };

describe("chart schema and source bindings", () => {
  it("chooses axes for the selected type and follows column names across reordered IDs", () => {
    const initial = sql("old", [category, amount]);
    const binding = bindSource(initial);
    const chart = configureChartKind(
      newChart("chart-1", binding),
      "violin",
      resolveSource(binding, [initial]),
    );

    const next = sql("new", [
      { ...amount, id: "r0" },
      { ...category, id: "r1" },
    ]);
    expect(planChart(chart, resolveSource(binding, [next]))).toMatchObject({
      request: { source: { resultId: "new" }, x: "r1", y: "r0" },
    });
  });

  it("requires manual selection for duplicate names, changed logical types, and missing columns", () => {
    const initial = sql("old", [category, amount]);
    const binding = bindSource(initial);
    const chart = configureChartKind(
      newChart("chart-1", binding),
      "violin",
      resolveSource(binding, [initial]),
    );
    for (const columns of [
      [category, amount, { ...amount, id: "r2", logicalType: "VARCHAR" }],
      [category, { ...amount, logicalType: "DOUBLE" }],
      [category],
    ]) {
      expect(planChart(chart, resolveSource(binding, [sql("new", columns)]))).toEqual({
        message: "Select axis columns again. The result schema changed.",
      });
    }
  });

  it("disconnects when a file's session changes and keeps its stored axis configuration", () => {
    const initial: ChartSourceOption = {
      kind: "file",
      id: "orders",
      name: "orders.csv",
      columns: [amount],
      source: { kind: "file", documentId: "doc", sessionId: "original" },
    };
    const binding = bindSource(initial);
    const chart = configureChartKind(
      newChart("chart-1", binding),
      "histogram",
      resolveSource(binding, [initial]),
    );
    const changed = {
      ...initial,
      source: { kind: "file" as const, documentId: "doc", sessionId: "new" },
    };
    expect(planChart(chart, resolveSource(binding, [changed]))).toEqual({
      message: "Reconnect data source.",
    });
    expect(chart.x?.column).toEqual(amount);
  });

  it("keeps temporal X and category axes linear while sending numeric transforms", () => {
    const initial = sql("old", [{ id: "r2", name: "day", logicalType: "DATE" }, category, amount]);
    const binding = bindSource(initial);
    const source = resolveSource(binding, [initial]);
    const card = {
      ...configureChartKind(newChart("chart-1", binding), "line", source),
      options: { xScale: "log10" as const, yScale: "log1p" as const, appearance: { line: 4 } },
    };
    const plan = planChart(card, source);
    expect(plan).toMatchObject({ request: { x: "r2", yScale: "log1p" } });
    expect(plan).not.toHaveProperty("request.xScale");
    expect(plan).not.toHaveProperty("request.appearance");
    expect(planChart(configureChartKind(card, "bar", source), source)).not.toHaveProperty(
      "request.yScale",
    );
  });

  it("validates numeric drafts at finite, positive, and integer boundaries", () => {
    expect(parseChartNumber("", 0.25, 4)).toBeNull();
    expect(parseChartNumber("0.25", 0.25, 4)).toBe(0.25);
    expect(parseChartNumber("4", 0.25, 4)).toBe(4);
    expect(parseChartNumber("4.01", 0.25, 4)).toBeNull();
    expect(parseChartNumber("3.5", 1, 48, true)).toBeNull();
    expect(parseChartNumber("49", 1, 48, true)).toBeNull();
    expect(parseChartNumber("1e309", Number.MIN_VALUE, Number.MAX_VALUE)).toBeNull();
    expect(parseChartNumber("0", Number.MIN_VALUE, Number.MAX_VALUE)).toBeNull();
  });
});
