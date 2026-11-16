// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartBackend, ChartData, ChartDetailRequest } from "./contract";
import { useChartDetail, type ChartDetailCache } from "./useChartDetail";
import { ChartScheduler, type RenderedChart } from "./useChartJob";

const data = (count: number): ChartData => ({
  validRows: count,
  totalRows: count,
  excludedRows: 0,
  filteredRows: 0,
  sampled: false,
  groupsTruncated: false,
});

const overview: RenderedChart = {
  key: "original-session",
  request: { source: { kind: "block", blockId: "block" }, kind: "scatter", x: "x", y: "y" },
  kind: "scatter",
  data: data(100_000),
  x: "X",
  y: "Y",
  xScale: "linear",
  yScale: "linear",
};

const first: ChartDetailRequest = { kind: "range", x: [1, 2], y: [5, 7] };
const second: ChartDetailRequest = { kind: "range", x: [3, 4], y: [8, 9] };

function setup() {
  const compute = vi.fn<ChartBackend["compute"]>();
  const cancel = vi.fn<ChartBackend["cancel"]>().mockResolvedValue(undefined);
  const backend: ChartBackend = {
    compute,
    cancel,
    retainResult: vi.fn(),
    releaseResult: vi.fn(),
    releaseBlock: vi.fn(),
    copyImage: vi.fn(),
    saveImage: vi.fn(),
  };
  const scheduler = new ChartScheduler();
  const cache: ChartDetailCache = new Map();
  const initialProps: { detail: ChartDetailRequest | null; chart: RenderedChart } = {
    detail: first,
    chart: overview,
  };
  const hook = renderHook(
    ({ detail, chart }) =>
      useChartDetail({ detail, overview: chart, active: true, backend, scheduler, cache }),
    { initialProps },
  );
  return { ...hook, compute, cancel };
}

afterEach(() => vi.useRealTimers());

describe("chart detail requests", () => {
  it("debounces range changes and reuses an already resolved range after Reset", async () => {
    vi.useFakeTimers();
    const { result, compute, rerender } = setup();
    compute.mockResolvedValue(data(5));
    expect(compute).not.toHaveBeenCalled();
    rerender({ detail: second, chart: overview });
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(compute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: second }));
    expect(result.current.data?.validRows).toBe(5);
    rerender({ detail: null, chart: overview });
    expect(result.current.status).toBeNull();
    rerender({ detail: second, chart: overview });
    expect(result.current.data?.validRows).toBe(5);
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight old view and ignores its result across a new source generation", async () => {
    vi.useFakeTimers();
    const { result, compute, cancel, rerender } = setup();
    let resolveOld!: (value: ChartData) => void;
    compute
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce(data(2));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    const chart = { ...overview, key: "next-session" };
    rerender({ detail: first, chart });
    expect(cancel).toHaveBeenCalledWith(compute.mock.calls[0][0].requestId);
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(result.current.data?.validRows).toBe(2);
    await act(async () => resolveOld(data(100)));
    expect(result.current.data?.validRows).toBe(2);
  });

  it("keeps the first index preparation running across viewports, then cancels superseded warm queries", async () => {
    vi.useFakeTimers();
    const { result, compute, cancel, rerender } = setup();
    let finishPreparation!: (value: ChartData) => void;
    let finishSuperseded!: (value: ChartData) => void;
    compute
      .mockImplementationOnce(() => new Promise((resolve) => (finishPreparation = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (finishSuperseded = resolve)))
      .mockResolvedValueOnce(data(3));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    rerender({ detail: second, chart: overview });
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(cancel).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(1);

    await act(async () => finishPreparation(data(10)));
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1][0].detail).toEqual(second);
    expect(result.current.data).toBeUndefined();

    const third: ChartDetailRequest = { kind: "range", x: [7, 8] };
    rerender({ detail: third, chart: overview });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(compute.mock.calls[1][0].requestId);
    await act(async () => vi.advanceTimersByTimeAsync(160));
    await act(async () => finishSuperseded(data(20)));
    expect(result.current.data?.validRows).toBe(3);
    rerender({ detail: first, chart: overview });
    expect(result.current.data?.validRows).toBe(10);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("cancels detached index preparation when the current viewport is cancelled", async () => {
    vi.useFakeTimers();
    const { result, compute, cancel, rerender } = setup();
    let finishPreparation!: (value: ChartData) => void;
    compute.mockImplementationOnce(() => new Promise((resolve) => (finishPreparation = resolve)));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    rerender({ detail: second, chart: overview });
    await act(async () => vi.advanceTimersByTimeAsync(160));
    act(() => result.current.cancel());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(compute.mock.calls[0][0].requestId);
    await act(async () => finishPreparation(data(10)));
    expect(result.current.status).toBe("cancelled");
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
