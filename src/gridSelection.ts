export interface GridCoordinate {
  row: number;
  column: number;
}

export interface GridRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type SelectionKind = "cell" | "row" | "column" | "all";

export interface SelectionState {
  sessionId: string;
  anchor: GridCoordinate;
  active: GridCoordinate;
  rect: GridRect;
  kind: SelectionKind;
  wholeColumns: ReadonlySet<number> | null;
  includeColumnHeaders: boolean;
  generation: number;
}

export interface GridBounds {
  rowCount: number;
  columnCount: number;
  pageStep: number;
}

export interface GridKeyCommand {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export type SelectionAction =
  | { type: "reset"; sessionId: string; bounds: GridBounds }
  | {
      type: "remapColumns";
      previousColumnIds: readonly string[];
      nextColumnIds: readonly string[];
      bounds: GridBounds;
    }
  | { type: "click"; coordinate: GridCoordinate; shiftKey?: boolean; bounds: GridBounds }
  | { type: "drag"; coordinate: GridCoordinate; bounds: GridBounds }
  | { type: "row"; row: number; bounds: GridBounds }
  | {
      type: "column";
      column: number;
      visibleColumns: readonly number[];
      mode: "replace" | "extend" | "toggle";
      bounds: GridBounds;
    }
  | { type: "all"; bounds: GridBounds }
  | {
      type: "key";
      command: GridKeyCommand;
      bounds: GridBounds;
      isEmpty?: (coordinate: GridCoordinate) => boolean;
    };

export function normalizeRect(anchor: GridCoordinate, active: GridCoordinate): GridRect {
  return {
    top: Math.min(anchor.row, active.row),
    left: Math.min(anchor.column, active.column),
    bottom: Math.max(anchor.row, active.row),
    right: Math.max(anchor.column, active.column),
  };
}

function validBounds(bounds: GridBounds): boolean {
  return bounds.rowCount > 0 && bounds.columnCount > 0;
}

function isValidCoordinate(coordinate: GridCoordinate, bounds: GridBounds): boolean {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.column) &&
    coordinate.row >= 0 &&
    coordinate.row < bounds.rowCount &&
    coordinate.column >= 0 &&
    coordinate.column < bounds.columnCount
  );
}

function makeState(
  previous: SelectionState,
  anchor: GridCoordinate,
  active: GridCoordinate,
  kind: SelectionKind = "cell",
  includeColumnHeaders = false,
): SelectionState {
  return {
    ...previous,
    anchor,
    active,
    rect: normalizeRect(anchor, active),
    kind,
    wholeColumns: null,
    includeColumnHeaders,
    generation: previous.generation + 1,
  };
}

export function createSelection(sessionId: string, bounds: GridBounds): SelectionState {
  void bounds;
  const coordinate = { row: 0, column: 0 };
  return {
    sessionId,
    anchor: coordinate,
    active: coordinate,
    rect: normalizeRect(coordinate, coordinate),
    kind: "cell",
    wholeColumns: null,
    includeColumnHeaders: false,
    generation: 0,
  };
}

function moveTo(
  state: SelectionState,
  coordinate: GridCoordinate,
  extend: boolean,
): SelectionState {
  return makeState(state, extend ? state.anchor : coordinate, coordinate);
}

function makeColumnState(
  state: SelectionState,
  bounds: GridBounds,
  wholeColumns: ReadonlySet<number>,
  anchor: number,
  active: number,
): SelectionState {
  const next = makeState(
    state,
    { row: 0, column: anchor },
    { row: bounds.rowCount - 1, column: active },
    "column",
    true,
  );
  for (const column of wholeColumns) {
    next.rect.left = Math.min(next.rect.left, column);
    next.rect.right = Math.max(next.rect.right, column);
  }
  return { ...next, wholeColumns };
}

function selectColumn(
  state: SelectionState,
  { column, visibleColumns, mode, bounds }: Extract<SelectionAction, { type: "column" }>,
): SelectionState {
  const clicked = visibleColumns.indexOf(column);
  if (!isValidCoordinate({ row: 0, column }, bounds) || clicked < 0) return state;
  if (mode === "extend" && state.wholeColumns) {
    const anchor = visibleColumns.indexOf(state.anchor.column);
    if (anchor >= 0) {
      const span = visibleColumns.slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1);
      return makeColumnState(state, bounds, new Set(span), state.anchor.column, column);
    }
  }
  if (mode === "toggle") {
    const columns = new Set(state.wholeColumns);
    if (!columns.delete(column)) {
      columns.add(column);
      return makeColumnState(state, bounds, columns, column, column);
    }
    const remaining = visibleColumns.find((index) => columns.has(index));
    if (remaining === undefined) return moveTo(state, { row: 0, column }, false);
    const anchor = columns.has(state.anchor.column) ? state.anchor.column : remaining;
    const active = columns.has(state.active.column) ? state.active.column : remaining;
    return makeColumnState(state, bounds, columns, anchor, active);
  }
  return makeColumnState(state, bounds, new Set([column]), column, column);
}

function stepCoordinate(
  coordinate: GridCoordinate,
  rowDelta: number,
  columnDelta: number,
  bounds: GridBounds,
): GridCoordinate {
  return {
    row: Math.max(0, Math.min(bounds.rowCount - 1, coordinate.row + rowDelta)),
    column: Math.max(0, Math.min(bounds.columnCount - 1, coordinate.column + columnDelta)),
  };
}

export function ctrlArrowTarget(
  start: GridCoordinate,
  rowDelta: number,
  columnDelta: number,
  bounds: GridBounds,
  isEmpty: (coordinate: GridCoordinate) => boolean,
): GridCoordinate {
  const boundary = {
    row: rowDelta < 0 ? 0 : rowDelta > 0 ? bounds.rowCount - 1 : start.row,
    column: columnDelta < 0 ? 0 : columnDelta > 0 ? bounds.columnCount - 1 : start.column,
  };
  const next = stepCoordinate(start, rowDelta, columnDelta, bounds);
  if (next.row === start.row && next.column === start.column) return start;

  const startEmpty = isEmpty(start);
  if (!startEmpty && isEmpty(next)) {
    let cursor = next;
    while (cursor.row !== boundary.row || cursor.column !== boundary.column) {
      if (!isEmpty(cursor)) return cursor;
      cursor = stepCoordinate(cursor, rowDelta, columnDelta, bounds);
    }
    return cursor;
  }

  let cursor = next;
  if (startEmpty) {
    while (isEmpty(cursor) && (cursor.row !== boundary.row || cursor.column !== boundary.column)) {
      cursor = stepCoordinate(cursor, rowDelta, columnDelta, bounds);
    }
    return cursor;
  }

  while (!isEmpty(cursor) && (cursor.row !== boundary.row || cursor.column !== boundary.column)) {
    const candidate = stepCoordinate(cursor, rowDelta, columnDelta, bounds);
    if (isEmpty(candidate)) return cursor;
    cursor = candidate;
  }
  return cursor;
}

export function applyGridKey(
  state: SelectionState,
  command: GridKeyCommand,
  bounds: GridBounds,
  isEmpty: (coordinate: GridCoordinate) => boolean = () => false,
): SelectionState {
  if (!validBounds(bounds)) return state;
  const primary = Boolean(command.ctrlKey || command.metaKey);
  const absoluteArrow = Boolean(primary && command.altKey && command.key.startsWith("Arrow"));
  if (command.altKey && !absoluteArrow) return state;
  if (primary && command.key.toLocaleLowerCase() === "a") {
    return makeState(
      state,
      { row: 0, column: 0 },
      { row: bounds.rowCount - 1, column: bounds.columnCount - 1 },
      "all",
      false,
    );
  }
  if (command.key === "Escape") return moveTo(state, state.active, false);

  let target: GridCoordinate | null = null;
  const direction =
    command.key === "ArrowUp"
      ? ([-1, 0] as const)
      : command.key === "ArrowDown"
        ? ([1, 0] as const)
        : command.key === "ArrowLeft"
          ? ([0, -1] as const)
          : command.key === "ArrowRight"
            ? ([0, 1] as const)
            : null;
  if (direction) {
    target = absoluteArrow
      ? {
          row: direction[0] < 0 ? 0 : direction[0] > 0 ? bounds.rowCount - 1 : state.active.row,
          column:
            direction[1] < 0 ? 0 : direction[1] > 0 ? bounds.columnCount - 1 : state.active.column,
        }
      : primary
        ? ctrlArrowTarget(state.active, direction[0], direction[1], bounds, isEmpty)
        : stepCoordinate(state.active, direction[0], direction[1], bounds);
  } else if (command.key === "Home") {
    target = primary ? { row: 0, column: 0 } : { row: state.active.row, column: 0 };
  } else if (command.key === "End") {
    target = primary
      ? { row: bounds.rowCount - 1, column: bounds.columnCount - 1 }
      : { row: state.active.row, column: bounds.columnCount - 1 };
  } else if (command.key === "PageUp") {
    target = stepCoordinate(state.active, -Math.max(1, bounds.pageStep), 0, bounds);
  } else if (command.key === "PageDown") {
    target = stepCoordinate(state.active, Math.max(1, bounds.pageStep), 0, bounds);
  }
  return target ? moveTo(state, target, Boolean(command.shiftKey)) : state;
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  if (action.type === "reset") {
    if (state.sessionId === action.sessionId) return state;
    const next = createSelection(action.sessionId, action.bounds);
    return { ...next, generation: state.generation + 1 };
  }
  if (action.type === "remapColumns") {
    if (!validBounds(action.bounds)) return state;
    const positions = new Map(action.nextColumnIds.map((id, index) => [id, index]));
    const remapColumn = (column: number) => positions.get(action.previousColumnIds[column]);
    const remap = (coordinate: GridCoordinate): GridCoordinate => {
      const nextColumn = remapColumn(coordinate.column) ?? 0;
      return {
        row: Math.max(0, Math.min(action.bounds.rowCount - 1, coordinate.row)),
        column: Math.max(0, Math.min(action.bounds.columnCount - 1, nextColumn)),
      };
    };
    if (state.wholeColumns) {
      const columns = new Set<number>();
      for (const column of state.wholeColumns) {
        const remapped = remapColumn(column);
        if (remapped !== undefined) columns.add(remapped);
      }
      const first = columns.values().next().value;
      if (first === undefined) return moveTo(state, remap(state.active), false);
      return makeColumnState(
        state,
        action.bounds,
        columns,
        remapColumn(state.anchor.column) ?? first,
        remapColumn(state.active.column) ?? first,
      );
    }
    return makeState(
      state,
      remap(state.anchor),
      remap(state.active),
      state.kind,
      state.includeColumnHeaders,
    );
  }
  if (!validBounds(action.bounds)) return state;
  if (action.type === "click" || action.type === "drag") {
    if (!isValidCoordinate(action.coordinate, action.bounds)) return state;
    const extend = action.type === "drag" || Boolean(action.shiftKey);
    return moveTo(state, action.coordinate, extend);
  }
  if (action.type === "row") {
    if (!Number.isInteger(action.row) || action.row < 0 || action.row >= action.bounds.rowCount)
      return state;
    return makeState(
      state,
      { row: action.row, column: 0 },
      { row: action.row, column: action.bounds.columnCount - 1 },
      "row",
    );
  }
  if (action.type === "column") return selectColumn(state, action);
  if (action.type === "all") {
    return makeState(
      state,
      { row: 0, column: 0 },
      { row: action.bounds.rowCount - 1, column: action.bounds.columnCount - 1 },
      "all",
    );
  }
  return applyGridKey(state, action.command, action.bounds, action.isEmpty);
}

export function isSelectedColumn(state: SelectionState, column: number): boolean {
  return (
    state.wholeColumns?.has(column) ?? (column >= state.rect.left && column <= state.rect.right)
  );
}

export function isSelected(
  state: SelectionState,
  coordinate: GridCoordinate,
  rowCount = state.rect.bottom + 1,
): boolean {
  return (
    coordinate.row >= state.rect.top &&
    coordinate.row < (state.wholeColumns ? rowCount : state.rect.bottom + 1) &&
    isSelectedColumn(state, coordinate.column)
  );
}
