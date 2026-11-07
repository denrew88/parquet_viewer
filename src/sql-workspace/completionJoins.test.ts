import { describe, expect, it } from "vitest";
import { sqlCompletions, sqlCompletionContext, MAX_COMPLETION_OPTIONS } from "./completionModel";
import type { SqlTable } from "./model";
const table = (
  alias: string,
  names: Array<string | [string, string, number]>,
  mode: "name" | "ordinal" = "name",
): SqlTable => ({
  alias,
  documentId: alias,
  sessionId: alias,
  fileName: alias + ".parquet",
  path: alias + ".parquet",
  columnMode: mode,
  defaultColumnMode: mode,
  nameModeAllowed: true,
  nameModeReason: null,
  columns: names.map((entry, i) => {
    const [name, type, index] = typeof entry === "string" ? [entry, "BIGINT", i] : entry;
    return {
      id: "s" + index,
      sourceIndex: index,
      originalName: name,
      sqlType: type,
      nullable: true,
    };
  }),
});
const query = (sql: string, tables: SqlTable[]) =>
  sqlCompletions(sql.replace("|", ""), sql.indexOf("|"), tables);
const context = (sql: string, tables: SqlTable[]) =>
  sqlCompletionContext(sql.replace("|", ""), sql.indexOf("|"), tables);
const inputs = [
  table("orders", ["order_id", "customer_id", "id"]),
  table("customers", ["customer_id", "id"]),
];
const joins = (sql: string, tables = inputs) =>
  query(sql, tables)?.options.filter((o) => o.type === "join") ?? [];

describe("HAVING SELECT aliases", () => {
  const aliases = (sql: string) =>
    query(sql, inputs)?.options.filter((option) => option.detail === "SELECT alias") ?? [];

  it("offers explicit output aliases with the correct SQL spelling", () => {
    const sql =
      'SELECT c.customer_id, count(*) AS cnt, max(c.id) AS "max id" FROM customers c GROUP BY c.customer_id HAVING |';
    expect(aliases(sql).map(({ label, insertText }) => [label, insertText])).toEqual([
      ["cnt", "cnt"],
      ["max id", '"max id"'],
    ]);
    expect(aliases(sql.replace("HAVING |", "HAVING cn|"))).toMatchObject([{ label: "cnt" }]);
    expect(aliases(sql.replace("HAVING |", "HAVING c.|"))).toEqual([]);
  });

  it("keeps aliases local and skips ambiguous duplicate names", () => {
    expect(aliases("SELECT CAST(id AS BIGINT) FROM orders HAVING |")).toEqual([]);
    expect(aliases("SELECT count(*) AS cnt, sum(id) AS CNT FROM orders HAVING |")).toEqual([]);
    expect(aliases("SELECT count(*) AS cnt FROM orders WHERE |")).toEqual([]);
    expect(
      aliases("SELECT (SELECT count(*) AS hidden FROM orders) AS visible FROM customers HAVING |"),
    ).toMatchObject([{ label: "visible" }]);
    expect(
      aliases(
        "SELECT count(*) AS prior FROM orders; SELECT count(*) AS current_count FROM customers HAVING |",
      ),
    ).toMatchObject([{ label: "current_count" }]);
  });
});

describe("conservative metadata JOIN recommendations", () => {
  it("offers a complete inferred predicate only at a fresh ON", () => {
    const result = joins("SELECT * FROM orders o JOIN customers c ON |");
    expect(result[0]).toMatchObject({
      label: "o.customer_id = c.customer_id",
      insertText: "o.customer_id = c.customer_id",
      manualOnly: false,
    });
    expect(result[0].info).toMatch(/not a verified foreign key/);
    expect(context("SELECT * FROM orders o JOIN customers c ON |", inputs).kind).toBe("join");
  });
  it("matches originals but inserts exclusive physical ordinals across mixed modes", () => {
    const a = table("orders", [["customer_id", "BIGINT", 3]], "ordinal"),
      b = table("customers", [["customer_id", "UBIGINT", 8]]);
    expect(joins("SELECT * FROM orders o JOIN customers c ON |", [a, b])[0].insertText).toBe(
      "o.c4 = c.customer_id",
    );
    b.columnMode = "ordinal";
    expect(joins("SELECT * FROM orders o JOIN customers c ON |", [a, b])[0].insertText).toBe(
      "o.c4 = c.c9",
    );
    expect(
      joins("SELECT * FROM orders o JOIN customers c ON |", [
        table("orders", ["order_id"], "ordinal"),
        table("customers", ["customer_id"], "ordinal"),
      ]),
    ).toEqual([]);
  });
  it("escapes aliases and original names", () => {
    const tables = [table("orders", ['customer "key"']), table("customers", ['customer "key"'])];
    expect(
      joins('SELECT * FROM orders "order lines" JOIN customers "customer group" ON |', tables)[0]
        .insertText,
    ).toBe('"order lines"."customer ""key""" = "customer group"."customer ""key"""');
  });
  it("keeps ambiguous generic names manual-only and behind meaningful names", () => {
    const result = joins("SELECT * FROM orders o JOIN customers c ON |");
    expect(result[1]).toMatchObject({ label: "o.id = c.id", manualOnly: true, boost: -100 });
    const tables = [table("orders", ["id"]), table("customers", ["id"])];
    expect(context("SELECT * FROM orders o JOIN customers c ON |", tables).kind).toBe("expression");
    expect(joins("SELECT * FROM orders o JOIN customers c ON |", tables)).toHaveLength(1);
  });
  it("rejects duplicate originals rather than guessing ordinal pairs", () => {
    expect(
      joins("SELECT * FROM orders o JOIN customers c ON |", [
        table("orders", ["customer_id", "customer_id"], "ordinal"),
        inputs[1],
      ]),
    ).toEqual([]);
  });
  it.each([
    ["BIGINT", "UBIGINT", true],
    ["SMALLINT", "INTEGER", true],
    ["FLOAT", "DOUBLE", true],
    ["VARCHAR", "STRING", true],
    ["DECIMAL(18,2)", "DECIMAL(18,2)", true],
    ["DATE", "DATE", true],
    ["TIMESTAMP_NS", "TIMESTAMP_NS", true],
    ["BIGINT", "DOUBLE", false],
    ["DECIMAL(18,0)", "BIGINT", false],
    ["DECIMAL(18,2)", "DECIMAL(18,3)", false],
    ["TIMESTAMP", "TIMESTAMPTZ", false],
    ["TIMESTAMP_NS", "TIMESTAMP", false],
    ["BOOLEAN", "BOOLEAN", false],
    ["BLOB", "BLOB", false],
    ["STRUCT(a INTEGER)", "STRUCT(a INTEGER)", false],
  ])("type compatibility %s / %s = %s", (a, b, valid) => {
    expect(
      joins("SELECT * FROM orders o JOIN customers c ON |", [
        table("orders", [["customer_id", a as string, 0]]),
        table("customers", [["customer_id", b as string, 0]]),
      ]).length > 0,
    ).toBe(valid);
  });
  it.each([
    "SELECT * FROM orders o JOIN customers c ON o|.customer_id = c.customer_id",
    "SELECT * FROM orders o JOIN customers c ON o.customer_id=c.customer_id AND |",
    "WITH customers AS (SELECT 1 AS private) SELECT * FROM orders o JOIN customers c ON |",
    "SELECT * FROM orders o JOIN (SELECT 1 AS private) c ON |",
    "SELECT * FROM orders x JOIN orders x ON |",
    "SELECT * FROM orders o CROSS JOIN customers c WHERE |",
  ])("suppresses uncertain or existing predicates: %s", (sql) => expect(joins(sql)).toEqual([]));
  it("does not borrow a future JOIN as the right side", () => {
    const tables = [...inputs, table("payments", ["customer_id"])];
    const result = joins(
      "SELECT * FROM orders o JOIN customers c ON o.customer_id=c.customer_id JOIN payments p ON | JOIN orders future ON true",
      tables,
    );
    expect(result).toHaveLength(2);
    expect(
      result.every((o) => o.label.includes("p.customer_id") && !o.label.includes("future")),
    ).toBe(true);
  });
  it("caps candidate work/output and filters original prefix", () => {
    const names = Array.from({ length: 600 }, (_, i) => "key_" + i),
      tables = [table("orders", names), table("customers", names)];
    expect(joins("SELECT * FROM orders o JOIN customers c ON |", tables)).toHaveLength(
      MAX_COMPLETION_OPTIONS,
    );
    expect(joins("SELECT * FROM orders o JOIN customers c ON key_599|", tables)[0].label).toContain(
      "key_599",
    );
  });
  it("classifies local contexts without any query/catalog calls", () => {
    expect(context("SELECT o.| FROM orders o", inputs).kind).toBe("dot");
    expect(context("SELECT * FROM cu|", inputs)).toMatchObject({ kind: "table", prefixLength: 2 });
    expect(context("SELECT cus| FROM orders", inputs)).toMatchObject({
      kind: "expression",
      prefixLength: 3,
    });
    expect(context("SELECT 'o.|' FROM orders o", inputs).kind).toBe("none");
  });
});
