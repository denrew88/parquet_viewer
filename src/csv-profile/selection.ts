export interface CsvColumnSelectionState {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
  activeId: string | null;
}

export type CsvColumnSelectionAction =
  | {
      type: "click";
      columnId: string;
      visibleIds: readonly string[];
      ctrl: boolean;
      shift: boolean;
    }
  | { type: "select-visible"; visibleIds: readonly string[] }
  | { type: "toggle-visible"; visibleIds: readonly string[] }
  | { type: "clear" };

export const EMPTY_CSV_COLUMN_SELECTION: CsvColumnSelectionState = {
  selectedIds: new Set<string>(),
  anchorId: null,
  activeId: null,
};

function visibleRange(
  visibleIds: readonly string[],
  anchorId: string | null,
  columnId: string,
): string[] {
  const targetIndex = visibleIds.indexOf(columnId);
  const anchorIndex = anchorId === null ? -1 : visibleIds.indexOf(anchorId);
  if (targetIndex < 0) return [];
  if (anchorIndex < 0) return [columnId];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleIds.slice(start, end + 1);
}

export function csvColumnSelectionReducer(
  state: CsvColumnSelectionState,
  action: CsvColumnSelectionAction,
): CsvColumnSelectionState {
  if (action.type === "clear") return EMPTY_CSV_COLUMN_SELECTION;
  if (action.type === "select-visible") {
    return {
      selectedIds: new Set(action.visibleIds),
      anchorId: action.visibleIds[0] ?? null,
      activeId: action.visibleIds[action.visibleIds.length - 1] ?? null,
    };
  }
  if (action.type === "toggle-visible") {
    const selectedIds = new Set(state.selectedIds);
    const allVisibleSelected =
      action.visibleIds.length > 0 && action.visibleIds.every((id) => selectedIds.has(id));
    for (const id of action.visibleIds) {
      if (allVisibleSelected) selectedIds.delete(id);
      else selectedIds.add(id);
    }
    return {
      selectedIds,
      anchorId: action.visibleIds[0] ?? state.anchorId,
      activeId: action.visibleIds[action.visibleIds.length - 1] ?? state.activeId,
    };
  }

  if (action.shift) {
    const range = visibleRange(action.visibleIds, state.anchorId, action.columnId);
    const selectedIds = action.ctrl ? new Set(state.selectedIds) : new Set<string>();
    for (const id of range) selectedIds.add(id);
    return {
      selectedIds,
      anchorId: state.anchorId ?? action.columnId,
      activeId: action.columnId,
    };
  }

  if (action.ctrl) {
    const selectedIds = new Set(state.selectedIds);
    if (selectedIds.has(action.columnId)) selectedIds.delete(action.columnId);
    else selectedIds.add(action.columnId);
    return { selectedIds, anchorId: action.columnId, activeId: action.columnId };
  }

  return {
    selectedIds: new Set([action.columnId]),
    anchorId: action.columnId,
    activeId: action.columnId,
  };
}
