export const GRID_SCROLL_QUIET_MS = 120;

export type GridScrollMode = "idle" | "scrub";

export interface GridScrollSchedulerState {
  lastRow: number | null;
  lastTimestamp: number | null;
  mode: GridScrollMode;
  quietDeadline: number | null;
  settleCount: number;
  windowAnchorRow: number | null;
  windowAnchorTimestamp: number | null;
}

export type GridScrollSchedulerAction =
  | {
      type: "sample";
      row: number;
      timestamp: number;
      pageSize: number;
      synthetic?: boolean;
    }
  | { type: "quiet"; timestamp: number }
  | { type: "scrollend" }
  | { type: "rebase"; row: number; timestamp: number };

export function createGridScrollSchedulerState(
  row: number | null = null,
  timestamp: number | null = null,
): GridScrollSchedulerState {
  return {
    lastRow: Number.isFinite(row) ? row : null,
    lastTimestamp: Number.isFinite(timestamp) ? timestamp : null,
    mode: "idle",
    quietDeadline: null,
    settleCount: 0,
    windowAnchorRow: Number.isFinite(row) ? row : null,
    windowAnchorTimestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

function settle(state: GridScrollSchedulerState): GridScrollSchedulerState {
  if (state.mode !== "scrub") return state;
  return {
    ...state,
    mode: "idle",
    quietDeadline: null,
    settleCount: state.settleCount + 1,
    windowAnchorRow: state.lastRow,
    windowAnchorTimestamp: state.lastTimestamp,
  };
}

export function reduceGridScrollScheduler(
  state: GridScrollSchedulerState,
  action: GridScrollSchedulerAction,
): GridScrollSchedulerState {
  if (action.type === "scrollend") return settle(state);
  if (action.type === "quiet") {
    if (
      state.mode !== "scrub" ||
      state.quietDeadline === null ||
      !Number.isFinite(action.timestamp) ||
      action.timestamp < state.quietDeadline
    )
      return state;
    return settle(state);
  }
  if (action.type === "rebase") {
    if (!Number.isFinite(action.row) || !Number.isFinite(action.timestamp)) return state;
    return {
      ...state,
      lastRow: action.row,
      lastTimestamp: action.timestamp,
      mode: "idle",
      quietDeadline: null,
      windowAnchorRow: action.row,
      windowAnchorTimestamp: action.timestamp,
    };
  }
  if (action.synthetic) return state;
  if (
    !Number.isFinite(action.row) ||
    !Number.isFinite(action.timestamp) ||
    !Number.isFinite(action.pageSize) ||
    action.pageSize <= 0
  )
    return state;

  const monotonic = state.lastTimestamp !== null && action.timestamp > state.lastTimestamp;
  const hasBaseline = state.lastRow !== null && monotonic;
  const delta = hasBaseline ? Math.abs(action.row - state.lastRow!) : 0;
  const anchorElapsed =
    state.windowAnchorTimestamp === null
      ? Number.POSITIVE_INFINITY
      : action.timestamp - state.windowAnchorTimestamp;
  const lastElapsed = hasBaseline
    ? action.timestamp - state.lastTimestamp!
    : Number.POSITIVE_INFINITY;
  const useExistingAnchor =
    monotonic &&
    state.windowAnchorRow !== null &&
    state.windowAnchorTimestamp !== null &&
    anchorElapsed <= GRID_SCROLL_QUIET_MS;
  const useLastSampleAsAnchor =
    !useExistingAnchor && hasBaseline && lastElapsed <= GRID_SCROLL_QUIET_MS;
  const windowAnchorRow = useExistingAnchor
    ? state.windowAnchorRow
    : useLastSampleAsAnchor
      ? state.lastRow
      : action.row;
  const windowAnchorTimestamp = useExistingAnchor
    ? state.windowAnchorTimestamp
    : useLastSampleAsAnchor
      ? state.lastTimestamp
      : action.timestamp;
  const windowDelta = Math.abs(action.row - windowAnchorRow!);
  const windowHasDuration = windowAnchorTimestamp !== action.timestamp;
  const entersScrub =
    hasBaseline &&
    (delta >= action.pageSize * 2 || (windowHasDuration && windowDelta >= action.pageSize));
  const mode = state.mode === "scrub" || entersScrub ? "scrub" : "idle";

  return {
    ...state,
    lastRow: action.row,
    lastTimestamp: action.timestamp,
    mode,
    quietDeadline: mode === "scrub" ? action.timestamp + GRID_SCROLL_QUIET_MS : null,
    windowAnchorRow,
    windowAnchorTimestamp,
  };
}
