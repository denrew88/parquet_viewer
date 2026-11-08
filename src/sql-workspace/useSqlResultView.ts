import { useCallback, useEffect, useRef, useState } from "react";
import type { DataPage, QueryStatusResponse } from "../backend";
import { EMPTY_QUERY_PLAN, type QueryPlan } from "../query/model";
import type { QueryToolbarStatus } from "../query/QueryToolbar";
import type { SqlWorkspaceBackend } from "./backend";

const IDLE: QueryToolbarStatus = { state: "idle", message: "", matchCount: null };
const DOCUMENT_ID = "sql-workspace";
let viewSequence = 0;

interface ViewTask {
  id: string;
  started: boolean;
  start: Promise<QueryStatusResponse | null>;
  disposal?: Promise<void>;
}

interface AppliedView {
  task: ViewTask;
  plan: QueryPlan;
  page: DataPage;
  matchCount: number | null;
}

interface FindTarget {
  row: number;
  columnId: string;
  matchIndex: number;
  key: string;
}

function hasView(plan: QueryPlan) {
  return plan.filters.length > 0 || plan.sort.length > 0 || Boolean(plan.search);
}

function statusMessage(status: QueryStatusResponse): string {
  const { rowsScanned, totalRows } = status.progress;
  if (status.state === "queued") return "Query queued";
  if (status.state === "cancelling") return "Cancelling query";
  return totalRows === null
    ? `Scanning ${rowsScanned.toLocaleString()} rows`
    : `Scanning ${rowsScanned.toLocaleString()} / ${totalRows.toLocaleString()} rows`;
}

export function useSqlResultView(
  api: Pick<SqlWorkspaceBackend, "resultView" | "readPage">,
  runId: string,
  resultId: string,
  basePage: DataPage,
) {
  const viewApi = api.resultView;
  const [plan, setPlan] = useState<QueryPlan>(EMPTY_QUERY_PLAN);
  const [applied, setApplied] = useState<AppliedView | null>(null);
  const [baseVisiblePage, setBaseVisiblePage] = useState(basePage);
  const [toolbar, setToolbar] = useState<QueryToolbarStatus>(IDLE);
  const [findTarget, setFindTarget] = useState<FindTarget | null>(null);
  const appliedRef = useRef<AppliedView | null>(null);
  const targetRef = useRef<FindTarget | null>(null);
  const pending = useRef<ViewTask | null>(null);
  const serial = useRef(0);
  const visibleOffset = useRef(0);
  const findRevision = useRef(0);
  const mounted = useRef(false);
  const releaseBarrier = useRef(Promise.resolve());

  const retire = useCallback(
    (task: ViewTask | null, cancel = false) => {
      if (!task || !viewApi) return releaseBarrier.current;
      if (!task.disposal) {
        task.disposal = task.start
          .catch(() => null)
          .then(async () => {
            if (!task.started) return;
            if (cancel) await viewApi.cancel(runId, resultId, task.id).catch(() => {});
            await viewApi.release(runId, resultId, task.id).catch(() => {});
          });
        releaseBarrier.current = Promise.all([releaseBarrier.current, task.disposal]).then(
          () => {},
        );
      }
      return releaseBarrier.current;
    },
    [resultId, runId, viewApi],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const running = pending.current;
      const committed = appliedRef.current;
      pending.current = null;
      appliedRef.current = null;
      void retire(running, true);
      void retire(committed?.task ?? null);
    };
  }, [retire]);

  function clearFind() {
    ++findRevision.current;
    targetRef.current = null;
    setFindTarget(null);
  }

  async function apply(next: QueryPlan) {
    if (!viewApi) return;
    setPlan(next);
    clearFind();
    const previous = pending.current;
    pending.current = null;
    ++serial.current;
    const ready = retire(previous, true);
    if (!hasView(next)) {
      const committed = appliedRef.current;
      appliedRef.current = null;
      visibleOffset.current = 0;
      setBaseVisiblePage(basePage);
      setApplied(null);
      setToolbar(IDLE);
      void retire(committed?.task ?? null);
      return;
    }

    const task: ViewTask = {
      id: `sql-view-${Date.now()}-${++viewSequence}`,
      started: false,
      start: Promise.resolve(null),
    };
    pending.current = task;
    const current = () => mounted.current && pending.current === task;
    task.start = ready.then(() => {
      if (!current()) return null;
      task.started = true;
      return viewApi.start(runId, resultId, task.id, next);
    });
    setToolbar({ ...IDLE, state: "queued", message: "Query queued" });
    try {
      let status = await task.start;
      while (
        current() &&
        status &&
        (status.state === "queued" || status.state === "running" || status.state === "cancelling")
      ) {
        setToolbar({ ...IDLE, state: status.state, message: statusMessage(status) });
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (!current()) return;
        status = await viewApi.status(runId, resultId, task.id);
      }
      if (!current() || !status) return;
      if (status.state === "failed")
        throw new Error(status.error?.message ?? "Result view failed.");
      if (status.state === "complete") {
        const page = await api.readPage({
          runId,
          resultId,
          viewId: task.id,
          offset: 0,
          limit: basePage.limit,
          columns: basePage.columns,
        });
        if (!current()) return;
        const committed = appliedRef.current;
        const value = { task, plan: next, page, matchCount: status.findMatchCount };
        appliedRef.current = value;
        visibleOffset.current = 0;
        setApplied(value);
        setToolbar({ ...IDLE, matchCount: value.matchCount });
        void retire(committed?.task ?? null);
      } else {
        setToolbar({ ...IDLE, matchCount: appliedRef.current?.matchCount ?? null });
      }
    } catch (error) {
      if (current())
        setToolbar({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
          matchCount: appliedRef.current?.matchCount ?? null,
        });
    } finally {
      if (pending.current === task) pending.current = null;
      if (appliedRef.current?.task !== task) void retire(task);
    }
  }

  function cancel() {
    const task = pending.current;
    if (!task) return;
    const generation = ++serial.current;
    pending.current = null;
    setToolbar({ ...IDLE, state: "cancelling", message: "Cancelling query" });
    void retire(task, true).then(() => {
      if (mounted.current && serial.current === generation)
        setToolbar({ ...IDLE, matchCount: appliedRef.current?.matchCount ?? null });
    });
  }

  async function find(direction: "next" | "previous") {
    const view = appliedRef.current;
    if (!viewApi || !view || view.plan.search?.mode !== "find" || pending.current) return;
    const revision = ++findRevision.current;
    const current = () =>
      mounted.current &&
      appliedRef.current?.task === view.task &&
      findRevision.current === revision;
    const viewId = view.task.id;
    try {
      const response = await viewApi.find(runId, resultId, viewId, {
        documentId: DOCUMENT_ID,
        sessionId: resultId,
        queryId: viewId,
        fromResultOffset: targetRef.current?.row ?? visibleOffset.current,
        fromMatchIndex: targetRef.current?.matchIndex ?? null,
        direction,
        wrap: true,
      });
      const match = response.match;
      if (!current() || !match) return;
      const page = await api.readPage({
        runId,
        resultId,
        viewId,
        offset: Math.floor(match.rowOffset / basePage.limit) * basePage.limit,
        limit: basePage.limit,
        columns: [...new Set([match.columnId, ...basePage.columns])].slice(0, 64),
      });
      if (!current()) return;
      const value = { ...view, page, matchCount: match.totalMatches };
      appliedRef.current = value;
      setApplied(value);
      setToolbar({ ...IDLE, matchCount: value.matchCount });
      visibleOffset.current = match.rowOffset;
      const target = {
        row: match.rowOffset,
        columnId: match.columnId,
        matchIndex: match.matchIndex,
        key: `${viewId}:${revision}`,
      };
      targetRef.current = target;
      setFindTarget(target);
    } catch (error) {
      if (current())
        setToolbar({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
          matchCount: view.matchCount,
        });
    }
  }

  async function goToPage(offset: number, onError: (cause: unknown) => void) {
    const view = appliedRef.current;
    const revision = ++findRevision.current;
    const current = () =>
      mounted.current &&
      appliedRef.current?.task === view?.task &&
      findRevision.current === revision;
    try {
      const page = await api.readPage({
        runId,
        resultId,
        ...(view ? { viewId: view.task.id } : {}),
        offset,
        limit: basePage.limit,
        columns: basePage.columns,
      });
      if (!current()) return;
      if (view) {
        const value = { ...view, page };
        appliedRef.current = value;
        setApplied(value);
      } else setBaseVisiblePage(page);
      visibleOffset.current = page.offset;
      targetRef.current = null;
      setFindTarget(null);
    } catch (error) {
      if (current()) onError(error);
    }
  }

  return {
    plan,
    toolbar,
    draftDiffers: hasView(plan) && plan !== applied?.plan,
    applying:
      toolbar.state === "queued" || toolbar.state === "running" || toolbar.state === "cancelling",
    viewId: applied?.task.id,
    page: applied?.page ?? baseVisiblePage,
    findTarget,
    apply,
    cancel,
    find,
    goToPage,
  };
}
