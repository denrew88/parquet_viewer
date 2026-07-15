import { EMPTY_QUERY_PLAN, type QueryPlan } from "./model";

export type QueryRunStatus = "idle" | "queued" | "running" | "cancelling" | "failed";

export interface QueryProgress {
  rowsScanned: number;
  totalRows: number | null;
  resultRows: number;
}

export interface DocumentQueryState {
  documentId: string;
  sessionId: string;
  draftPlan: QueryPlan;
  committedPlan: QueryPlan;
  queryId: string | null;
  taskId: string | null;
  status: QueryRunStatus;
  progress: QueryProgress | null;
  error: string | null;
}

export type QueryAction =
  | { type: "edit"; plan: QueryPlan }
  | { type: "start"; documentId: string; sessionId: string; taskId: string; plan: QueryPlan }
  | {
      type: "progress";
      documentId: string;
      sessionId: string;
      taskId: string;
      progress: QueryProgress;
    }
  | {
      type: "commit";
      documentId: string;
      sessionId: string;
      taskId: string;
      queryId: string;
      plan: QueryPlan;
    }
  | { type: "cancel"; documentId: string; sessionId: string; taskId: string }
  | { type: "cancelled"; documentId: string; sessionId: string; taskId: string }
  | {
      type: "fail";
      documentId: string;
      sessionId: string;
      taskId: string;
      message: string;
    }
  | { type: "replaceSession"; sessionId: string; compatiblePlan?: QueryPlan };

export function createDocumentQueryState(
  documentId: string,
  sessionId: string,
): DocumentQueryState {
  return {
    documentId,
    sessionId,
    draftPlan: EMPTY_QUERY_PLAN,
    committedPlan: EMPTY_QUERY_PLAN,
    queryId: null,
    taskId: null,
    status: "idle",
    progress: null,
    error: null,
  };
}

function matchesTask(
  state: DocumentQueryState,
  action: { documentId: string; sessionId: string; taskId: string },
): boolean {
  return (
    state.documentId === action.documentId &&
    state.sessionId === action.sessionId &&
    state.taskId === action.taskId
  );
}

export function documentQueryReducer(
  state: DocumentQueryState,
  action: QueryAction,
): DocumentQueryState {
  switch (action.type) {
    case "edit":
      return { ...state, draftPlan: action.plan, error: null };
    case "start":
      if (state.documentId !== action.documentId || state.sessionId !== action.sessionId) {
        return state;
      }
      return {
        ...state,
        draftPlan: action.plan,
        taskId: action.taskId,
        status: "queued",
        progress: null,
        error: null,
      };
    case "progress":
      if (!matchesTask(state, action)) return state;
      return { ...state, status: "running", progress: action.progress };
    case "commit":
      if (!matchesTask(state, action)) return state;
      return {
        ...state,
        draftPlan: action.plan,
        committedPlan: action.plan,
        queryId: action.queryId,
        taskId: null,
        status: "idle",
        progress: null,
        error: null,
      };
    case "cancel":
      if (!matchesTask(state, action)) return state;
      return { ...state, status: "cancelling" };
    case "cancelled":
      if (!matchesTask(state, action)) return state;
      return { ...state, taskId: null, status: "idle", progress: null, error: null };
    case "fail":
      if (!matchesTask(state, action)) return state;
      return {
        ...state,
        taskId: null,
        status: "failed",
        progress: null,
        error: action.message,
      };
    case "replaceSession": {
      const plan = action.compatiblePlan ?? EMPTY_QUERY_PLAN;
      return {
        ...createDocumentQueryState(state.documentId, action.sessionId),
        draftPlan: plan,
        committedPlan: plan,
      };
    }
  }
}
