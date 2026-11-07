import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalogue from "./identifierKeywords.json";
import { quoteSqlIdentifier, sqlIdentifier, sqlColumnName, sqlTableName } from "./model";
import { sqlCompletions } from "./completionModel";
import type { SqlTable } from "./model";

describe("optional SQL identifier quoting", () => {
  it.each(["o", "orders", "customer_id", "CustomerID", "_x2", "c1", "c4096"])(
    "keeps safe spelling %s",
    (name) => {
      expect(sqlIdentifier(name)).toBe(name);
      expect(sqlTableName(name)).toBe(name);
    },
  );
  it.each(["select", "SELECT", "Order", "Qualify", "asof", "join", "from", "null", "true"])(
    "quotes parser keyword %s in every context",
    (name) => {
      expect(sqlIdentifier(name)).toBe(`"${name}"`);
    },
  );
  it.each([
    ["", '""'],
    ["1id", '"1id"'],
    ["customer id", '"customer id"'],
    ["a.b", '"a.b"'],
    ["고객번호", '"고객번호"'],
    ['x"y', '"x""y"'],
    ['x"; SELECT 99; --', '"x""; SELECT 99; --"'],
    ["a\nb", '"a\nb"'],
    ["a-b", '"a-b"'],
    ["a$", '"a$"'],
  ])("retains escaping for %s", (name, expected) => expect(sqlIdentifier(name)).toBe(expected));
  it("retains the explicitly always-quoted helper and exclusive ordinal spelling", () => {
    expect(quoteSqlIdentifier("orders")).toBe('"orders"');
    const column = {
      id: "s3",
      sourceIndex: 3,
      originalName: "select",
      sqlType: "BIGINT",
      nullable: false,
    };
    expect(sqlColumnName(column, "name")).toBe('"select"');
    expect(sqlColumnName(column, "ordinal")).toBe("c4");
  });
  it("pins the catalogue to the bundled crate version and quotes every keyword", () => {
    const lock = readFileSync(
      "artifacts/experiments/csv-native-parquet/size-variant/Cargo.lock",
      "utf8",
    );
    expect(lock.match(/name = "libduckdb-sys"\r?\nversion = "([^"]+)"/)?.[1]).toBe(
      catalogue.engineCrateVersion,
    );
    expect(catalogue.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.keywords.length).toBeGreaterThan(400);
    expect(new Set(catalogue.keywords).size).toBe(catalogue.keywords.length);
    for (const word of catalogue.keywords) expect(sqlIdentifier(word)).toBe(`"${word}"`);
  });
  it("replaces an entire quoted token with a simple identifier without leaving quotes", () => {
    const table = {
      documentId: "d",
      sessionId: "s",
      fileName: "orders.csv",
      path: "orders.csv",
      alias: "orders",
      columnMode: "name",
      defaultColumnMode: "name",
      nameModeAllowed: true,
      nameModeReason: null,
      columns: [],
    } as SqlTable;
    const marked = 'SELECT * FROM "ord|ers"',
      pos = marked.indexOf("|"),
      doc = marked.replace("|", "");
    const result = sqlCompletions(doc, pos, [table])!;
    expect(doc.slice(0, result.from) + result.options[0].insertText + doc.slice(result.to)).toBe(
      "SELECT * FROM orders",
    );
  });
});
