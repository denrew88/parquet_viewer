import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sqlCompletions, sqlFunctionHint, MAX_COMPLETION_OPTIONS } from "./completionModel";
import { SQL_FUNCTIONS } from "./functionCatalog";
import type { SqlTable } from "./model";

const table = (alias = "orders", mode: "name" | "ordinal" = "name"): SqlTable => ({
  documentId: alias,
  sessionId: alias,
  alias,
  columnMode: mode,
  fileName: alias + ".csv",
  path: alias + ".csv",
  defaultColumnMode: "name",
  nameModeAllowed: true,
  nameModeReason: null,
  columns: [
    { id: "s0", sourceIndex: 0, originalName: "id", sqlType: "BIGINT", nullable: false },
    {
      id: "s2",
      sourceIndex: 2,
      originalName: '결제 "금액"',
      sqlType: "DECIMAL(18,2)",
      nullable: true,
    },
  ],
});
function complete(text: string, tables = [table()]) {
  const pos = text.indexOf("|");
  return sqlCompletions(text.replace("|", ""), pos, tables);
}
function hint(text: string) {
  return sqlFunctionHint(text.replace("|", ""), text.indexOf("|"));
}

describe("bounded SQL completion model", () => {
  it("keeps the browser function names equal to the authoritative Rust allow-list", () => {
    const source = readFileSync("src-tauri/src/query/sql_workspace/security.rs", "utf8");
    const block = source.match(/let functions = \[([\s\S]*?)\n\s*\];/);
    expect(block).not.toBeNull();
    const names = [...block![1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1].toUpperCase());
    expect(SQL_FUNCTIONS.map((f) => f.name)).toEqual(names);
    expect(complete("SELECT read_| ")?.options.some((o) => o.type === "function")).not.toBe(true);
    expect(complete("| ")?.options.map((o) => o.label)).not.toEqual(
      expect.arrayContaining(["DROP", "INSERT", "read_parquet"]),
    );
  });
  it.each(["SELECT * FROM |", "SELECT * FROM orders o JOIN |", "SELECT * FROM orders o, |"])(
    "offers registered tables only at %s",
    (sql) => {
      const result = complete(sql, [table("sales file"), table("customers")])!;
      expect(result.options.map((o) => o.type)).toEqual(["table", "table"]);
      expect(result.options[0].insertText).toBe('"sales file"');
    },
  );
  it.each([
    "SELECT EXTRACT(YEAR FROM |) FROM orders",
    "SELECT * FROM orders WHERE id IS DISTINCT FROM |",
    "SELECT id IS DISTINCT FROM 1, | FROM orders",
  ])("does not suggest tables for expression FROM at %s", (sql) => {
    expect(complete(sql)?.options.some((option) => option.type === "table")).not.toBe(true);
  });
  it.each([
    "SELECT id, | FROM orders o",
    "SELECT COALESCE(o.id, |) FROM orders o",
    "SELECT * FROM orders o ORDER BY id, |",
  ])("keeps expression commas in column context: %s", (sql) => {
    expect(complete(sql)?.options.some((o) => o.type === "property" && o.label === "id")).toBe(
      true,
    );
  });
  it.each([
    "SELECT o.| FROM orders AS o",
    "SELECT o.| FROM orders o WHERE o.id > 0",
    "SELECT SUM(o.|) FROM orders o",
  ])("resolves forward FROM aliases in %s", (sql) => {
    expect(complete(sql)?.options.map((o) => o.insertText)).toEqual(["id", '"결제 ""금액"""']);
  });
  it("quotes SQL names, preserves original ordinals/gaps, and never mixes modes", () => {
    expect(complete('SELECT * FROM orders o WHERE o."결|')?.options[0]).toMatchObject({
      insertText: '"결제 ""금액"""',
      detail: expect.stringContaining("DECIMAL"),
    });
    const ordinal = complete("SELECT o.c| FROM orders o", [table("orders", "ordinal")])!;
    expect(ordinal.options.map((o) => o.insertText)).toEqual(["c1", "c3"]);
    expect(ordinal.options[1].detail).toContain('결제 "금액"');
    expect(
      complete("SELECT o.| FROM orders o", [table("orders", "ordinal")])?.options.some((o) =>
        o.insertText.includes('"'),
      ),
    ).toBe(false);
  });
  it("keeps name-mode rows concise and retains the original name once for ordinal rows", () => {
    const named = complete("SELECT o.| FROM orders o")!.options;
    expect(named[0]).toMatchObject({ label: "id", detail: "BIGINT", insertText: "id" });
    const ordinal = complete("SELECT o.| FROM orders o", [table("orders", "ordinal")])!.options;
    expect(ordinal[0]).toMatchObject({ label: "c1", detail: "BIGINT · id", insertText: "c1" });
    expect(ordinal[1].detail).toBe('DECIMAL(18,2) · 결제 "금액"');
  });
  it("replaces a whole existing quoted token without leaving its closing quote behind", () => {
    const doc = 'SELECT o."결|junk" FROM orders o';
    const result = complete(doc)!;
    const source = doc.replace("|", "");
    expect(
      source.slice(0, result.from) + result.options[0].insertText + source.slice(result.to),
    ).toBe('SELECT o."결제 ""금액""" FROM orders o');
  });
  it("qualifies ambiguous unqualified columns across a JOIN", () => {
    const result = complete("SELECT id| FROM orders o JOIN customers c ON o.id=c.id", [
      table(),
      table("customers"),
    ])!;
    expect(result.options.filter((o) => o.type === "property").map((o) => o.insertText)).toEqual([
      "o.id",
      "c.id",
    ]);
  });
  it.each([
    "SELECT o.| FROM missing o",
    "SELECT orders.| FROM orders o",
    "SELECT o.| FROM orders o JOIN orders o ON true",
    "WITH orders AS (SELECT 1 AS fake) SELECT orders.| FROM orders",
    "WITH orders(x) AS (SELECT 1) SELECT o.| FROM orders o",
    "WITH RECURSIVE orders AS (SELECT 1) SELECT o.| FROM orders o",
    "WITH /* note */ orders AS (SELECT 1 AS private_col) SELECT orders.| FROM orders",
    "WITH orders /* note */ AS (SELECT 1) SELECT o.| FROM orders o",
    "WITH orders AS /* note */ (SELECT 1), /* next */ customers AS (SELECT 2) SELECT o.| FROM orders o",
    "SELECT o.| FROM (SELECT id FROM orders) o",
    "SELECT (SELECT o.| FROM missing o) FROM orders o",
    "SELECT (SELECT o.|) FROM orders o",
    "SELECT catalog.orders.| FROM orders",
  ])("suppresses unknown, shadowed, derived or ambiguous scope: %s", (sql) =>
    expect(complete(sql)).toBeNull(),
  );
  it("can complete a known table before a FROM clause exists, without leaking it into a nested scope", () => {
    expect(complete("SELECT orders.| ")?.options).toHaveLength(2);
    expect(complete("SELECT (SELECT orders.|)")).toBeNull();
  });
  it("resolves a local table inside a nested SELECT without borrowing the outer alias", () => {
    expect(
      complete("SELECT (SELECT c.| FROM customers c) FROM orders o", [
        table(),
        table("customers", "ordinal"),
      ])?.options.map((o) => o.insertText),
    ).toEqual(["c1", "c3"]);
  });
  it.each([
    "SELECT 'abc|def' FROM orders",
    "SELECT $$abc|def$$ FROM orders",
    "SELECT $tag$abc|def$tag$ FROM orders",
    "SELECT -- alias o.|",
    "SELECT /* outer /* inner */ o.| */ 1",
    "SELECT 'unterminated|",
  ])("does not complete inside literals/comments: %s", (sql) => expect(complete(sql)).toBeNull());
  it("does not resolve fake FROM text hidden inside a string or comment", () => {
    expect(complete("SELECT o.|, 'FROM orders o' FROM missing m")).toBeNull();
    expect(complete("SELECT o.| /* FROM orders o */ FROM missing m")).toBeNull();
  });
  it("refreshes alias, mode and schema solely from current metadata", () => {
    expect(complete("SELECT o.| FROM orders o")?.options[0].insertText).toBe("id");
    expect(
      complete("SELECT o.| FROM orders o", [table("orders", "ordinal")])?.options[0].insertText,
    ).toBe("c1");
    expect(complete("SELECT o.| FROM orders o", [table("renamed")])).toBeNull();
    expect(complete("SELECT o.| FROM orders o", [])).toBeNull();
  });
  it("caps candidate allocation for wide inputs and refuses excessive UTF-8 text", () => {
    const wide = table();
    wide.columns = Array.from({ length: 4096 }, (_, i) => ({
      id: `s${i}`,
      sourceIndex: i,
      originalName: `field_${i}`,
      sqlType: "VARCHAR",
      nullable: true,
    }));
    expect(complete("SELECT o.| FROM orders o", [wide])?.options).toHaveLength(
      MAX_COMPLETION_OPTIONS,
    );
    expect(complete("SELECT o.field_4095| FROM orders o", [wide])?.options[0].insertText).toBe(
      "field_4095",
    );
    expect(complete("SELECT |" + "x".repeat(65536))).toBeNull();
    expect(complete("SELECT |" + "한".repeat(22000))).toBeNull();
    expect(complete("SELECT |" + "x ".repeat(8200))).toBeNull();
    expect(complete("SELECT " + "(".repeat(65) + "|")).toBeNull();
    expect(
      complete(
        "SELECT o.| FROM " + Array.from({ length: 65 }, (_, i) => `orders o${i}`).join(", "),
      ),
    ).toBeNull();
  });
});
describe("SQL function argument help", () => {
  it.each([
    ["SELECT COALESCE(|", "COALESCE", 1],
    ["SELECT COALESCE(1, |", "COALESCE", 2],
    ["SELECT COALESCE(SUM(|", "SUM", 1],
    ["SELECT COALESCE(SUM(x), |", "COALESCE", 2],
    ["SELECT COALESCE('a,b', /* , */ |", "COALESCE", 2],
    ["SELECT COALESCE((1+2), |", "COALESCE", 2],
  ])("tracks lexical commas and innermost allowed call in %s", (sql, name, argumentIndex) =>
    expect(hint(sql as string)).toMatchObject({ name, argumentIndex }),
  );
  it.each([
    "SELECT SUM(x)|",
    "SELECT read_parquet(|",
    "SELECT SUM(read_parquet(|",
    "SELECT o.sum(|",
    "SELECT 'COALESCE(|",
    "SELECT /* COALESCE(|",
    "SELECT $$COALESCE(|",
  ])("does not fabricate function help at %s", (sql) => expect(hint(sql)).toBeNull());
});
