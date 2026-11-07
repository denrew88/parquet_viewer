import { describe, expect, it } from "vitest";
import cases from "../../fixtures/phase-22/dto-boundaries.json";
import {
  trimSqlWhitespace,
  validateSqlAlias,
  validateSqlPage,
  validateSqlRequest,
  type StartSqlRequest,
} from "./backend";

interface TextCase {
  literal?: string;
  prefix?: string;
  unit?: string;
  repeat?: number;
  suffix?: string;
  expectedValid: boolean;
}
const expand = (item: TextCase) =>
  item.literal ??
  `${item.prefix ?? ""}${(item.unit ?? "").repeat(item.repeat ?? 0)}${item.suffix ?? ""}`;
function valid(action: () => unknown) {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}
const request = (): StartSqlRequest => ({
  runId: "run",
  sql: "SELECT 1",
  action: "execute",
  tables: [{ documentId: "d", sessionId: "s", alias: "orders", columnMode: "name" }],
});
const page = () => ({ runId: "run", resultId: "result", offset: 0, limit: 1, columns: ["r0"] });
describe("shared Rust/TypeScript SQL DTO boundary fixture", () => {
  it.each(cases.blank)("blank $text", (item) =>
    expect(trimSqlWhitespace(item.text) === "").toBe(item.expectedBlank),
  );
  it.each(cases.aliases)("alias boundary %#", (item) =>
    expect(validateSqlAlias(expand(item)) === null).toBe(item.expectedValid),
  );
  it.each(cases.aliasPairs)("alias pair $values", (item) =>
    expect(
      valid(() =>
        validateSqlRequest({
          ...request(),
          tables: item.values.map((alias, i) => ({
            documentId: `d${i}`,
            sessionId: `s${i}`,
            alias,
            columnMode: "name",
          })),
        }),
      ),
    ).toBe(item.expectedValid),
  );
  it.each(cases.identities)("identity boundary %#", (item) =>
    expect(valid(() => validateSqlRequest({ ...request(), runId: expand(item) }))).toBe(
      item.expectedValid,
    ),
  );
  it.each(cases.sqlText)("SQL UTF-8 boundary %#", (item) =>
    expect(valid(() => validateSqlRequest({ ...request(), sql: expand(item) }))).toBe(
      item.expectedValid,
    ),
  );
  it.each(cases.sourceCounts)("source count $value", (item) =>
    expect(
      valid(() =>
        validateSqlRequest({
          ...request(),
          tables: Array.from({ length: item.value }, (_, i) => ({
            documentId: `d${i}`,
            sessionId: `s${i}`,
            alias: `t${i}`,
            columnMode: "name",
          })),
        }),
      ),
    ).toBe(item.expectedValid),
  );
  it.each(cases.pageOffsets)("page offset $value", (item) =>
    expect(valid(() => validateSqlPage({ ...page(), offset: item.value }))).toBe(
      item.expectedValid,
    ),
  );
  it.each(cases.pageLimits)("page limit $value", (item) =>
    expect(valid(() => validateSqlPage({ ...page(), limit: item.value }))).toBe(item.expectedValid),
  );
  it.each(cases.projections)("projection $columns", (item) =>
    expect(valid(() => validateSqlPage({ ...page(), columns: item.columns }))).toBe(
      item.expectedValid,
    ),
  );
  it.each(cases.projectionCounts)("projection count $value", (item) =>
    expect(
      valid(() =>
        validateSqlPage({
          ...page(),
          columns: Array.from({ length: item.value }, (_, i) => `r${i}`),
        }),
      ),
    ).toBe(item.expectedValid),
  );
});
