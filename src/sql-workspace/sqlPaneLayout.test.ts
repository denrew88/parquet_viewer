// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  defaultSqlPanePreference,
  readSqlPanePreference,
  saveSqlPanePreference,
  SQL_PANE_LAYOUT_KEY,
  SQL_PANE_SEPARATOR,
  sqlPaneGeometry,
} from "./sqlPaneLayout";

beforeEach(() => localStorage.clear());

it("fits three usable panes and both boundaries across supported sizes and extreme preferences", () => {
  for (const width of [800, 1024, 1440]) {
    for (const dock of ["auto", "right", "bottom"] as const) {
      for (const share of [0.05, 0.2, 0.85]) {
        const layout = sqlPaneGeometry(
          width,
          600,
          { ...defaultSqlPanePreference, tables: share, source: share, dock },
          true,
        );
        const side = layout.dock === "right";
        expect(layout.tables).toBeGreaterThanOrEqual(150);
        expect(layout.query).toBeGreaterThanOrEqual(270);
        expect(
          layout.tables + layout.query + layout.source + SQL_PANE_SEPARATOR * (side ? 2 : 1),
        ).toBe(width);
        if (side) expect(layout.source).toBeGreaterThanOrEqual(270);
        else {
          expect(layout.source).toBe(0);
          expect(layout.sourceHeight).toBeGreaterThanOrEqual(180);
          expect(layout.sourceHeight + SQL_PANE_SEPARATOR).toBeLessThanOrEqual(600);
        }
      }
    }
  }
});

it("automatically docks below on small windows while retaining preferred side widths", () => {
  const preferred = { ...defaultSqlPanePreference, tables: 0.24, source: 0.36 };
  const wide = sqlPaneGeometry(1440, 900, preferred, true);
  expect(wide.dock).toBe("right");
  expect(sqlPaneGeometry(800, 900, preferred, true).dock).toBe("bottom");
  expect(sqlPaneGeometry(800, 600, preferred, true).dock).toBe("right");
  expect(sqlPaneGeometry(1440, 900, preferred, true)).toEqual(wide);
  const closed = sqlPaneGeometry(1440, 900, preferred, false);
  expect(closed.source).toBe(0);
  expect(closed.query).toBeGreaterThan(wide.query);
});

it("restores saved widths and rejects malformed storage without breaking the workspace", () => {
  const preference = { tables: 0.25, source: 0.4, sourceHeight: 0.5, dock: "bottom" as const };
  saveSqlPanePreference(preference);
  expect(readSqlPanePreference()).toEqual(preference);
  for (const raw of [
    "not JSON",
    "null",
    "[]",
    '{"tables":-1,"source":"wide","sourceHeight":99,"dock":"unknown"}',
  ]) {
    localStorage.setItem(SQL_PANE_LAYOUT_KEY, raw);
    expect(readSqlPanePreference()).toEqual(defaultSqlPanePreference);
  }
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  expect(readSqlPanePreference()).toEqual(defaultSqlPanePreference);
  read.mockRestore();
});

it("clamps unavailable container measurements to finite nonnegative geometry", () => {
  for (const size of [-1, 0, NaN, Infinity]) {
    const layout = sqlPaneGeometry(size, size, defaultSqlPanePreference, true);
    for (const value of [layout.tables, layout.query, layout.source, layout.sourceHeight]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }
});
