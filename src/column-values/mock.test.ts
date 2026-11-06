import { describe, expect, it, vi } from "vitest";
import { createColumnValuesMock } from "./mock";
import type { ColumnValue, ColumnValuesOrder, ColumnValuesPageRequest } from "./backend";

const identity = { operationId: "cursor-operation", documentId: "doc", sessionId: "session" };
const source = { ...identity, queryId: null, columnId: "label" };
const values: ColumnValue[] = Array.from({ length: 237 }, (_, index) => ({
  value: `value-${index.toString().padStart(3, "0")}`,
  isNull: false,
  isEmpty: false,
  isInvalid: false,
  count: 237 - index,
  truncated: false,
}));
function mock() {
  return createColumnValuesMock(
    async () => values,
    async () => {
      throw new Error("Copy is not part of cursor mock tests");
    },
    () => {},
  );
}
const request = (order: ColumnValuesOrder = "valueAscending"): ColumnValuesPageRequest => ({
  ...identity,
  search: null,
  order,
  offset: 0,
  limit: 100,
  cursor: null,
});

describe("column values mock cursor contract", () => {
  it.each<ColumnValuesOrder>([
    "valueAscending",
    "valueDescending",
    "countAscending",
    "countDescending",
  ])("round trips three pages without duplicates in %s order", async (order) => {
    const api = mock();
    await api.startColumnValues(source);
    const first = await api.readColumnValuesPage(request(order));
    const second = await api.readColumnValuesPage({
      ...request(order),
      offset: 100,
      cursor: first.nextCursor,
    });
    const last = await api.readColumnValuesPage({
      ...request(order),
      offset: 200,
      cursor: second.nextCursor,
    });
    const actual = [...first.values, ...second.values, ...last.values];
    const expected =
      order === "valueAscending" || order === "countDescending" ? values : [...values].reverse();
    expect(actual).toEqual(expected);
    expect(new Set(actual.map((value) => value.value)).size).toBe(237);
    expect(first.previousCursor).toBeNull();
    expect(last.nextCursor).toBeNull();
    expect(last.values).toHaveLength(37);
    const back = await api.readColumnValuesPage({
      ...request(order),
      offset: 100,
      cursor: last.previousCursor,
    });
    expect(back.values).toEqual(second.values);
    const start = await api.readColumnValuesPage({
      ...request(order),
      cursor: back.previousCursor,
    });
    expect(start.values).toEqual(first.values);
  });
  it("binds cursor tokens to the snapshot and exact request context", async () => {
    const api = mock();
    await api.startColumnValues(source);
    const first = await api.readColumnValuesPage(request());
    const next = { ...request(), offset: 100, cursor: first.nextCursor };
    for (const changed of [
      { order: "countDescending" as const },
      { search: "value" },
      { offset: 200 },
      { limit: 50 },
    ])
      await expect(api.readColumnValuesPage({ ...next, ...changed })).rejects.toThrow(/cursor/);
    await expect(api.readColumnValuesPage({ ...next, cursor: "unissued-token" })).rejects.toThrow(
      /cursor/,
    );
    await api.startColumnValues({ ...source, operationId: "other-operation" });
    await expect(
      api.readColumnValuesPage({ ...next, operationId: "other-operation" }),
    ).rejects.toThrow(/cursor/);
    expect((await api.readColumnValuesPage({ ...next, search: "" })).values).toEqual(
      values.slice(100, 200),
    );
    await api.releaseColumnValues(identity);
    await expect(api.readColumnValuesPage(next)).rejects.toThrow(/unavailable/);
  });
  it("expires cursor tokens and bounds the retained token registry", async () => {
    const api = mock();
    await api.startColumnValues(source);
    const first = await api.readColumnValuesPage(request());
    const next = { ...request(), offset: 100, cursor: first.nextCursor };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60 * 1000 + 1);
    try {
      await expect(api.readColumnValuesPage(next)).rejects.toThrow(/cursor/);
    } finally {
      clock.mockRestore();
    }
    for (let index = 0; index < 257; index++) await api.readColumnValuesPage(request());
    await expect(api.readColumnValuesPage(next)).rejects.toThrow(/cursor/);
    const fresh = await api.readColumnValuesPage(request());
    expect(
      (await api.readColumnValuesPage({ ...next, cursor: fresh.nextCursor })).values,
    ).toHaveLength(100);
    await api.cancelColumnValues(identity);
    await expect(api.readColumnValuesPage({ ...next, cursor: fresh.nextCursor })).rejects.toThrow(
      /unavailable/,
    );
  });
});
