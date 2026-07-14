import { describe, expect, it } from "vitest";
import {
  applyGridKey,
  createSelection,
  normalizeRect,
  selectionReducer,
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

  it("implements Excel-style Ctrl boundary movement over sparse values", () => {
    const occupied = new Set(["5:3", "5:4", "5:5", "5:7"]);
    const isEmpty = ({ row, column }: { row: number; column: number }) =>
      !occupied.has(`${row}:${column}`);
    let state = createSelection("session", bounds);
    state = selectionReducer(state, {
      type: "click",
      coordinate: { row: 5, column: 3 },
      bounds,
    });
    state = applyGridKey(state, { key: "ArrowRight", ctrlKey: true }, bounds, isEmpty);
    expect(state.active).toEqual({ row: 5, column: 5 });
    state = applyGridKey(state, { key: "ArrowRight", ctrlKey: true }, bounds, isEmpty);
    expect(state.active).toEqual({ row: 5, column: 7 });
  });

  it("maps Ctrl and Meta to the same commands and ignores Alt combinations", () => {
    const state = createSelection("session", bounds);
    expect(applyGridKey(state, { key: "End", ctrlKey: true }, bounds).active).toEqual(
      applyGridKey(state, { key: "End", metaKey: true }, bounds).active,
    );
    expect(applyGridKey(state, { key: "ArrowDown", altKey: true }, bounds)).toBe(state);
  });
});
