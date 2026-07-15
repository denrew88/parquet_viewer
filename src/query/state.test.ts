import { describe, expect, it } from "vitest";
import { toggleSort } from "./model";
import { createDocumentQueryState, documentQueryReducer } from "./state";

describe("document query state", () => {
  it("commits only the current document, session, and task tuple", () => {
    const initial = createDocumentQueryState("document-1", "session-1");
    const plan = toggleSort(initial.draftPlan, "amount", false);
    const running = documentQueryReducer(initial, {
      type: "start",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
      plan,
    });
    const stale = documentQueryReducer(running, {
      type: "commit",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-old",
      queryId: "query-old",
      plan,
    });
    expect(stale).toBe(running);
    const committed = documentQueryReducer(running, {
      type: "commit",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
      queryId: "query-1",
      plan,
    });
    expect(committed.queryId).toBe("query-1");
    expect(committed.committedPlan).toEqual(plan);
    expect(committed.taskId).toBeNull();
  });

  it("keeps the committed result while cancellation or failure affects a replacement", () => {
    const initial = createDocumentQueryState("document-1", "session-1");
    const plan = toggleSort(initial.draftPlan, "amount", false);
    const running = documentQueryReducer(initial, {
      type: "start",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
      plan,
    });
    const cancelling = documentQueryReducer(running, {
      type: "cancel",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
    });
    expect(cancelling.status).toBe("cancelling");
    const cancelled = documentQueryReducer(cancelling, {
      type: "cancelled",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
    });
    expect(cancelled.queryId).toBeNull();
    expect(cancelled.committedPlan).toEqual(initial.committedPlan);
  });

  it("atomically replaces the source session and rejects late task updates", () => {
    const initial = createDocumentQueryState("document-1", "session-1");
    const running = documentQueryReducer(initial, {
      type: "start",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
      plan: initial.draftPlan,
    });
    const replacement = documentQueryReducer(running, {
      type: "replaceSession",
      sessionId: "session-2",
    });
    expect(replacement.sessionId).toBe("session-2");
    expect(replacement.taskId).toBeNull();
    const late = documentQueryReducer(replacement, {
      type: "progress",
      documentId: "document-1",
      sessionId: "session-1",
      taskId: "task-1",
      progress: { rowsScanned: 100, totalRows: 1_000, resultRows: 10 },
    });
    expect(late).toBe(replacement);
  });
});
