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
  | { type: "click"; coordinate: GridCoordinate; shiftKey?: boolean; bounds: GridBounds }
  | { type: "drag"; coordinate: GridCoordinate; bounds: GridBounds }
  | { type: "row"; row: number; bounds: GridBounds }
  | { type: "column"; column: number; bounds: GridBounds }
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

function ctrlArrowTarget(
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
  const nextEmpty = isEmpty(next);
  if (!startEmpty && nextEmpty) {
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
  if (!validBounds(bounds) || command.altKey) return state;
  const primary = Boolean(command.ctrlKey || command.metaKey);
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
    target = primary
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
  if (action.type === "column") {
    if (
      !Number.isInteger(action.column) ||
      action.column < 0 ||
      action.column >= action.bounds.columnCount
    )
      return state;
    return makeState(
      state,
      { row: 0, column: action.column },
      { row: action.bounds.rowCount - 1, column: action.column },
      "column",
      true,
    );
  }
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

export function isSelected(state: SelectionState, coordinate: GridCoordinate): boolean {
  return (
    coordinate.row >= state.rect.top &&
    coordinate.row <= state.rect.bottom &&
    coordinate.column >= state.rect.left &&
    coordinate.column <= state.rect.right
  );
}
