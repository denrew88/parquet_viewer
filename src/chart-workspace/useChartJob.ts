import { useEffect, useRef, useState } from "react";
import type { ChartBackend, ChartData, ChartRequest, ChartScale } from "./contract";
import type { ChartPlan } from "./chartModel";

let requestSequence = 0;

interface ScheduledWork {
  run: () => Promise<void>;
  cancelled: boolean;
}

export class ChartScheduler {
  private running = 0;
  private queue: ScheduledWork[] = [];

  submit(run: ScheduledWork["run"]): () => void {
    const job = { run, cancelled: false };
    this.queue.push(job);
    this.next();
    return () => {
      job.cancelled = true;
      this.queue = this.queue.filter((queued) => queued !== job);
    };
  }

  private next(): void {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      this.running++;
      void job.run().finally(() => {
        this.running--;
        this.next();
      });
    }
  }
}

export interface RenderedChart {
  key: string;
  request: Omit<ChartRequest, "requestId">;
  data: ChartData;
  kind: ChartRequest["kind"];
  x: string;
  y: string | null;
  xScale: ChartScale;
  yScale: ChartScale;
  scatterLabel?: string;
  barAggregate?: NonNullable<ChartRequest["bar"]>["aggregate"];
  whiskers?: ChartRequest["whiskers"];
  resultId?: string;
}

interface JobState {
  key: string;
  status: "loading" | "ready" | "error" | "cancelled";
  error?: string;
}

function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String(cause.message);
  return typeof cause === "string" ? cause : "Could not compute this chart.";
}

export function useChartJob({
  id,
  plan,
  active,
  backend,
  scheduler,
  cache,
}: {
  id: string;
  plan: ChartPlan;
  active: boolean;
  backend: ChartBackend;
  scheduler: ChartScheduler;
  cache: Map<string, RenderedChart>;
}) {
  const key = "request" in plan ? JSON.stringify(plan) : "";
  const [job, setJob] = useState<JobState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [display, setDisplay] = useState<RenderedChart | undefined>(() => cache.get(id));
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active || !key) return;
    const cached = cache.get(id);
    if (cached?.key === key) {
      setDisplay(cached);
      setJob({ key, status: "ready" });
      return;
    }
    const ready = JSON.parse(key) as Extract<ChartPlan, { request: unknown }>;
    const requestId = `chart-${Date.now()}-${++requestSequence}`;
    let stopped = false;
    let inFlight = false;
    setJob({ key, status: "loading" });

    const unschedule = scheduler.submit(async () => {
      inFlight = true;
      try {
        const data = await backend.compute({ ...ready.request, requestId });
        if (stopped) return;
        const rendered: RenderedChart = {
          key,
          request: ready.request,
          data,
          kind: ready.request.kind,
          x: ready.x.name,
          y: ready.y?.name ?? null,
          xScale: ready.request.xScale ?? "linear",
          yScale: ready.request.yScale ?? "linear",
          scatterLabel: ready.scatterLabel?.name,
          barAggregate: ready.request.bar?.aggregate,
          whiskers: ready.request.whiskers,
          resultId: ready.request.source.kind === "sql" ? ready.request.source.resultId : undefined,
        };
        cache.delete(id);
        cache.set(id, rendered);
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
        setDisplay(rendered);
        setJob({ key, status: "ready" });
      } catch (cause) {
        if (!stopped) setJob({ key, status: "error", error: message(cause) });
      } finally {
        inFlight = false;
      }
    });
    function stop() {
      if (stopped) return;
      stopped = true;
      unschedule();
      if (inFlight) void backend.cancel(requestId).catch(() => {});
    }
    cancelRef.current = () => {
      stop();
      setJob({ key, status: "cancelled" });
    };
    return () => {
      stop();
      cancelRef.current = null;
    };
  }, [active, attempt, backend, cache, id, key, scheduler]);

  return {
    display,
    current: job?.key === key ? job : null,
    cancel: () => cancelRef.current?.(),
    retry: () => {
      cache.delete(id);
      setAttempt((value) => value + 1);
    },
  };
}
