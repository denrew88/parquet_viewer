// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureSqlExecution, sqlOutputContext } from "./workspaceState";
import type { StartSqlRequest, SqlStatus } from "./backend";

const request = (): StartSqlRequest => ({
  runId: "run-a",
  sql: "SELECT 1",
  action: "execute",
  tables: [
    { documentId: "a", sessionId: "a1", alias: "orders", columnMode: "name" },
    { documentId: "b", sessionId: "b1", alias: "customers", columnMode: "ordinal" },
  ],
});
describe("SQL output execution provenance", () => {
  it("copies and freezes the exact submitted request before later mutation", () => {
    const input = request(),
      mutable = { ...input.tables[0] };
    const snapshot = captureSqlExecution({ ...input, tables: [mutable, input.tables[1]] });
    mutable.alias = "changed";
    expect(snapshot.sql).toBe("SELECT 1");
    expect(snapshot.tables[0].alias).toBe("orders");
    expect(Object.isFrozen(snapshot.tables[0])).toBe(true);
  });
  it("ignores binding/source ordering but detects exact SQL, mode, alias and session changes", () => {
    const input = request(),
      snapshot = captureSqlExecution(input);
    const state = (sql = input.sql, tables = input.tables, sources = input.tables) =>
      sqlOutputContext(snapshot, "result", sql, tables, sources, null, false);
    expect(state(input.sql, [...input.tables].reverse(), [...input.tables].reverse()).current).toBe(
      true,
    );
    expect(state(input.sql + " ").labels).toContain("SQL changed · previous result");
    for (const override of [
      { alias: "other" },
      { columnMode: "ordinal" as const },
      { sessionId: "a2" },
    ])
      expect(state(input.sql, [{ ...input.tables[0], ...override }, input.tables[1]]).current).toBe(
        false,
      );
    expect(state(input.sql, input.tables, [input.tables[0]]).current).toBe(false);
    expect(state().current).toBe(true);
  });
  it.each(["failed", "cancelled"] as const)(
    "restores SQL matching independently of latest %s attempt",
    (state) => {
      const input = request(),
        snapshot = captureSqlExecution(input);
      const status = { runId: "run-b", state } as SqlStatus;
      const result = sqlOutputContext(
        snapshot,
        "result",
        input.sql,
        input.tables,
        input.tables,
        status,
        false,
      );
      expect(result.current).toBe(true);
      expect(result.labels).toContain("Current result");
      expect(result.labels).toContain(`Latest execution ${state} · previous successful result`);
    },
  );
});
