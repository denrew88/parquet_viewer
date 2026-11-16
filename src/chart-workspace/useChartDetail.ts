import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChartBackend, ChartData, ChartDetailRequest } from "./contract";
import type { ChartScheduler, RenderedChart } from "./useChartJob";

export type ChartDetailCache = Map<string, ChartData>;

const maxCachedDetails = 8;
let requestSequence = 0;

type DetailState =
  | { key: string; status: "loading" | "cancelled" }
  | { key: string; status: "ready"; data: ChartData }
  | { key: string; status: "error"; error: string };

interface RangePreparation {
  key: string;
  overviewKey: string;
  wait: Promise<void>;
  stop(): void;
}

export function useChartDetail({
  detail,
  overview,
  active,
  backend,
  scheduler,
  cache,
}: {
  detail: ChartDetailRequest | null;
  overview?: RenderedChart;
  active: boolean;
  backend: ChartBackend;
  scheduler: ChartScheduler;
  cache: ChartDetailCache;
}) {
  const encoded = detail ? JSON.stringify(detail) : "";
  const key = overview && encoded ? JSON.stringify([overview.key, encoded]) : "";
  const [state, setState] = useState<DetailState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  const preparation = useRef<RangePreparation | null>(null);
  const warmedOverview = useRef<string | null>(null);
  const overviewKey = overview?.key;
  const kind = detail?.kind;
  const wanted = useRef({ active, key, overviewKey, kind });
  useLayoutEffect(() => {
    wanted.current = { active, key, overviewKey, kind };
  }, [active, key, overviewKey, kind]);

  useEffect(() => {
    if (!active || !key || !overview) return;
    function displayCached() {
      const cached = cache.get(key);
      if (!cached) return false;
      cache.delete(key);
      cache.set(key, cached);
      setState({ key, status: "ready", data: cached });
      return true;
    }
    function viewportOnlyChange() {
      const next = wanted.current;
      return (
        next.active && next.kind === "range" && next.overviewKey === overviewKey && next.key !== key
      );
    }
    function stopPreparation() {
      const pending = preparation.current;
      if (pending && pending.overviewKey === overviewKey) pending.stop();
    }
    if (displayCached())
      return () => {
        if (!viewportOnlyChange()) stopPreparation();
      };

    const detail = JSON.parse(encoded) as ChartDetailRequest;
    const requestId = `chart-detail-${Date.now()}-${++requestSequence}`;
    let stopped = false;
    let running = false;
    let detached = false;
    let unschedule: (() => void) | undefined;
    setState({ key, status: "loading" });

    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      unschedule?.();
      if (running) void backend.cancel(requestId).catch(() => {});
    };
    const schedule = () => {
      if (stopped || displayCached()) return;
      unschedule = scheduler.submit(async () => {
        running = true;
        let cold: RangePreparation | undefined;
        let finishCold: (() => void) | undefined;
        if (detail.kind === "range" && warmedOverview.current !== overview.key) {
          const wait = new Promise<void>((finish) => {
            finishCold = finish;
          });
          cold = { key, overviewKey: overview.key, wait, stop };
          preparation.current = cold;
        }
        try {
          const data = await backend.compute({ ...overview.request, requestId, detail });
          if (stopped) return;
          if (cold) warmedOverview.current = overview.key;
          cache.set(key, data);
          if (cache.size > maxCachedDetails) cache.delete(cache.keys().next().value!);
          if (!detached) setState({ key, status: "ready", data });
        } catch (cause) {
          if (!stopped && !detached) {
            setState({
              key,
              status: "error",
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        } finally {
          running = false;
          if (cold && preparation.current === cold) preparation.current = null;
          finishCold?.();
        }
      });
    };
    const timer = window.setTimeout(
      () => {
        const pending = preparation.current;
        if (detail.kind === "range" && pending?.overviewKey === overview.key) {
          void pending.wait.then(schedule);
        } else {
          schedule();
        }
      },
      detail.kind === "group" ? 0 : 160,
    );
    stopRef.current = () => {
      stop();
      stopPreparation();
      setState({ key, status: "cancelled" });
    };
    return () => {
      const sameOverview = viewportOnlyChange();
      if (sameOverview && running && preparation.current?.key === key) {
        // Let the first native index build finish for the latest viewport.
        detached = true;
      } else {
        stop();
      }
      if (!sameOverview) stopPreparation();
      stopRef.current = null;
    };
  }, [active, attempt, backend, cache, encoded, key, overview, overviewKey, scheduler]);

  const cached = key ? cache.get(key) : undefined;
  const current = state?.key === key ? state : null;
  return {
    data: cached ?? (current?.status === "ready" ? current.data : undefined),
    status: !key || !active ? null : cached ? "ready" : (current?.status ?? "loading"),
    error: current?.status === "error" ? current.error : undefined,
    cancel: () => stopRef.current?.(),
    retry: () => setAttempt((value) => value + 1),
  };
}
