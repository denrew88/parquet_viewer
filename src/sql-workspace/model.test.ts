import { describe, expect, it } from "vitest";
import {
  reconcileSqlTables,
  sqlAliasConflict,
  sqlColumnName,
  sqlExample,
  sqlTableName,
} from "./model";
import type { SqlTableDescriptor } from "./backend";

const descriptor = (id: string, fileName = "orders.csv"): SqlTableDescriptor => ({
  documentId: id,
  sessionId: `${id}-session`,
  fileName,
  path: `C:/${id}/${fileName}`,
  defaultColumnMode: "name",
  nameModeAllowed: true,
  nameModeReason: null,
  columns: [
    { id: "s0", sourceIndex: 0, originalName: '商品 "名前"', sqlType: "VARCHAR", nullable: false },
    {
      id: "s7",
      sourceIndex: 7,
      originalName: "결제 금액",
      sqlType: "DECIMAL(18,2)",
      nullable: true,
    },
  ],
});
describe("SQL table naming and examples", () => {
  it("allocates unique aliases for different paths and pre-existing suffix names", () => {
    const tables = reconcileSqlTables(
      [descriptor("a"), descriptor("b"), descriptor("c", "orders_2.parquet")],
      [],
    );
    expect(tables.map((t) => t.alias)).toEqual(["orders", "orders_2", "orders_2_2"]);
    expect(tables.map((t) => t.path)).toEqual([
      "C:/a/orders.csv",
      "C:/b/orders.csv",
      "C:/c/orders_2.parquet",
    ]);
  });
  it("preserves user choices after another file closes and assigns a fresh default on session replacement", () => {
    const first = reconcileSqlTables([descriptor("a"), descriptor("b")], []);
    first[1] = { ...first[1], alias: "archive", columnMode: "ordinal" };
    expect(reconcileSqlTables([descriptor("b")], first)[0]).toMatchObject({
      alias: "archive",
      columnMode: "ordinal",
    });
    expect(
      reconcileSqlTables([{ ...descriptor("b"), sessionId: "new-session" }], first)[0],
    ).toMatchObject({ alias: "orders", columnMode: "name" });
  });
  it("uses authoritative defaults/eligibility and switches impossible retained names mode to ordinal", () => {
    const first = reconcileSqlTables([descriptor("a")], []);
    const changed = {
      ...descriptor("a"),
      nameModeAllowed: false,
      defaultColumnMode: "ordinal" as const,
      nameModeReason: "Duplicate raw headers",
    };
    expect(reconcileSqlTables([changed], first)[0].columnMode).toBe("ordinal");
  });
  it("quotes identifiers including reserved aliases and embedded quotes", () => {
    expect(sqlTableName("select")).toBe('"select"');
    expect(sqlTableName('x"y')).toBe('"x""y"');
    expect(sqlColumnName(descriptor("a").columns[0], "name")).toBe('"商品 ""名前"""');
  });
  it("keeps original ordinal gaps after profile skip/reorder", () => {
    expect(sqlColumnName(descriptor("a").columns[1], "ordinal")).toBe("c8");
  });
  it("generates mixed-mode JOIN examples only from the chosen modes", () => {
    const tables = reconcileSqlTables([descriptor("a"), descriptor("b")], []);
    tables[0].columnMode = "ordinal";
    const sql = sqlExample("join", tables, tables[0]);
    expect(sql).toContain('ON a.c1 = b."商品 ""名前"""');
    expect(sql).toContain("FROM orders AS a");
    expect(sql).not.toContain("b.c1");
  });
  it("updates generated examples after rename without owning/replacing the editor SQL", () => {
    const tables = reconcileSqlTables([descriptor("a")], []);
    tables[0].alias = "current_orders";
    expect(sqlExample("basic", tables, tables[0])).toContain("FROM current_orders");
    expect(sqlExample("filter", tables, tables[0])).toContain("IS NOT NULL");
  });
  it("validates alias conflicts ignoring ASCII case and allows its own unchanged name", () => {
    const tables = reconcileSqlTables([descriptor("a"), descriptor("b")], []);
    expect(sqlAliasConflict("ORDERS_2", tables[0], tables)).toMatch(/already/);
    expect(sqlAliasConflict("ORDERS", tables[0], tables)).toBeNull();
  });
});
