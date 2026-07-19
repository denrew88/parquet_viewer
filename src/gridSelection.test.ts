import { describe, expect, it } from "vitest";
import {
  applyGridKey,
  createSelection,
  normalizeRect,
  selectionReducer,
  ctrlArrowTarget,
  type GridBounds,
  type GridKeyCommand,
} from "./gridSelection";

const bounds: GridBounds = { rowCount: 12, columnCount: 8, pageStep: 4 };

describe("grid selection reducer", () => {
  it("normalizes reverse coordinates", () => {
    expect(normalizeRect({ row: 7, column: 6 }, { row: 2, column: 1 })).toEqual({
      top: 2,
      left: 1,
      bottom: 7,
      right: 6,
    });
  });

  it("supports click, shift click, drag, row, column, all, and escape", () => {
    let state = createSelection("session", bounds);
    state = selectionReducer(state, {
      type: "click",
      coordinate: { row: 3, column: 4 },
      bounds,
    });
    expect(state.anchor).toEqual({ row: 3, column: 4 });
    state = selectionReducer(state, {
      type: "click",
      coordinate: { row: 9, column: 0 },
      shiftKey: true,
      bounds,
    });
    expect(state.rect).toEqual({ top: 3, left: 0, bottom: 9, right: 4 });
    state = selectionReducer(state, {
      type: "drag",
      coordinate: { row: 1, column: 2 },
      bounds,
    });
    expect(state.anchor).toEqual({ row: 3, column: 4 });
    state = selectionReducer(state, { type: "row", row: 4, bounds });
    expect([state.kind, state.rect]).toEqual(["row", { top: 4, left: 0, bottom: 4, right: 7 }]);
    state = selectionReducer(state, { type: "column", column: 3, bounds });
    expect(state.includeColumnHeaders).toBe(true);
    expect(state.rect).toEqual({ top: 0, left: 3, bottom: 11, right: 3 });
    state = selectionReducer(state, { type: "all", bounds });
    expect(state.kind).toBe("all");
    expect(state.includeColumnHeaders).toBe(false);
    state = selectionReducer(state, {
      type: "key",
      command: { key: "Escape" },
      bounds,
    });
    expect(state.rect).toEqual({ top: 11, left: 7, bottom: 11, right: 7 });
  });

  it("rejects invalid coordinates and resets on a new session only", () => {
    const state = createSelection("a", bounds);
    expect(
      selectionReducer(state, {
        type: "click",
        coordinate: { row: -1, column: 1 },
        bounds,
      }),
    ).toBe(state);
    expect(selectionReducer(state, { type: "reset", sessionId: "a", bounds })).toBe(state);
    const reset = selectionReducer(state, { type: "reset", sessionId: "b", bounds });
    expect(reset.sessionId).toBe("b");
    expect(reset.generation).toBeGreaterThan(state.generation);
  });
});

describe("keyboard matrix", () => {
  const cases: [string, GridKeyCommand, [number, number], [number, number, number, number]][] = [
    ["up", { key: "ArrowUp" }, [4, 3], [4, 3, 4, 3]],
    ["down", { key: "ArrowDown" }, [6, 3], [6, 3, 6, 3]],
    ["left", { key: "ArrowLeft" }, [5, 2], [5, 2, 5, 2]],
    ["right", { key: "ArrowRight" }, [5, 4], [5, 4, 5, 4]],
    ["shift down", { key: "ArrowDown", shiftKey: true }, [6, 3], [5, 3, 6, 3]],
    ["ctrl up", { key: "ArrowUp", ctrlKey: true }, [0, 3], [0, 3, 0, 3]],
    ["ctrl down", { key: "ArrowDown", ctrlKey: true }, [11, 3], [11, 3, 11, 3]],
    ["ctrl left", { key: "ArrowLeft", ctrlKey: true }, [5, 0], [5, 0, 5, 0]],
    ["ctrl right", { key: "ArrowRight", ctrlKey: true }, [5, 7], [5, 7, 5, 7]],
    ["ctrl shift up", { key: "ArrowUp", ctrlKey: true, shiftKey: true }, [0, 3], [0, 3, 5, 3]],
    [
      "ctrl shift down",
      { key: "ArrowDown", ctrlKey: true, shiftKey: true },
      [11, 3],
      [5, 3, 11, 3],
    ],
    ["ctrl shift left", { key: "ArrowLeft", ctrlKey: true, shiftKey: true }, [5, 0], [5, 0, 5, 3]],
    [
      "ctrl shift right",
      { key: "ArrowRight", ctrlKey: true, shiftKey: true },
      [5, 7],
      [5, 3, 5, 7],
    ],
    ["home", { key: "Home" }, [5, 0], [5, 0, 5, 0]],
    ["end", { key: "End" }, [5, 7], [5, 7, 5, 7]],
    ["ctrl home", { key: "Home", ctrlKey: true }, [0, 0], [0, 0, 0, 0]],
    ["meta end", { key: "End", metaKey: true }, [11, 7], [11, 7, 11, 7]],
    ["page up", { key: "PageUp" }, [1, 3], [1, 3, 1, 3]],
    ["page down", { key: "PageDown" }, [9, 3], [9, 3, 9, 3]],
    ["shift page down", { key: "PageDown", shiftKey: true }, [9, 3], [5, 3, 9, 3]],
    ["top clamp", { key: "ArrowUp" }, [4, 3], [4, 3, 4, 3]],
  ];

  it.each(cases)("handles %s", (_name, command, active, rect) => {
    let state = createSelection("session", bounds);
    state = selectionReducer(state, {
      type: "click",
      coordinate: { row: 5, column: 3 },
      bounds,
    });
    state = applyGridKey(state, command, bounds);
    expect([state.active.row, state.active.column]).toEqual(active);
    expect([state.rect.top, state.rect.left, state.rect.bottom, state.rect.right]).toEqual(rect);
  });

  it("maps Ctrl and Meta to the same commands and ignores Alt combinations", () => {
    const state = createSelection("session", bounds);
    expect(applyGridKey(state, { key: "End", ctrlKey: true }, bounds).active).toEqual(
      applyGridKey(state, { key: "End", metaKey: true }, bounds).active,
    );
    expect(applyGridKey(state, { key: "ArrowDown", altKey: true }, bounds)).toBe(state);
  });

  it("GRID-NAV-001 restores Excel Ctrl+Arrow occupied and empty-region semantics", () => {
    const occupied = new Set(["5:3", "5:4", "5:5", "5:7"]);
    const isEmpty = ({ row, column }: { row: number; column: number }) =>
      !occupied.has(`${row}:${column}`);
    expect(ctrlArrowTarget({ row: 5, column: 3 }, 0, 1, bounds, isEmpty)).toEqual({
      row: 5,
      column: 5,
    });
    expect(ctrlArrowTarget({ row: 5, column: 5 }, 0, 1, bounds, isEmpty)).toEqual({
      row: 5,
      column: 7,
    });
    expect(ctrlArrowTarget({ row: 5, column: 6 }, 0, -1, bounds, isEmpty)).toEqual({
      row: 5,
      column: 5,
    });
  });

  it("GRID-NAV-002 uses Ctrl+Alt+Arrow for absolute boundaries and Shift to extend", () => {
    let state = createSelection("session", bounds);
    state = selectionReducer(state, {
      type: "click",
      coordinate: { row: 5, column: 3 },
      bounds,
    });
    const moved = applyGridKey(
      state,
      { key: "ArrowDown", ctrlKey: true, altKey: true },
      bounds,
      () => true,
    );
    expect(moved.active).toEqual({ row: 11, column: 3 });
    const extended = applyGridKey(
      state,
      { key: "ArrowLeft", ctrlKey: true, altKey: true, shiftKey: true },
      bounds,
      () => true,
    );
    expect(extended.anchor).toEqual({ row: 5, column: 3 });
    expect(extended.active).toEqual({ row: 5, column: 0 });
  });
});
