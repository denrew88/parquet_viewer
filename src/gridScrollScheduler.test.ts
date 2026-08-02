import { describe, expect, it } from "vitest";
import {
  GRID_SCROLL_QUIET_MS,
  createGridScrollSchedulerState,
  reduceGridScrollScheduler,
} from "./gridScrollScheduler";

const sample = (row: number, timestamp: number, synthetic = false) =>
  ({ type: "sample", row, timestamp, pageSize: 200, synthetic }) as const;

describe("Phase 17 grid scroll scheduler", () => {
  it("T-P17-001 keeps a slow jump below two pages out of scrub mode", () => {
    let state = reduceGridScrollScheduler(createGridScrollSchedulerState(), sample(0, 0));
    state = reduceGridScrollScheduler(state, sample(399, 121));
    expect(state.mode).toBe("idle");
  });

  it("T-P17-002 enters scrub at a two-page jump in either direction", () => {
    const forward = reduceGridScrollScheduler(
      createGridScrollSchedulerState(0, 0),
      sample(400, 1_000),
    );
    const backward = reduceGridScrollScheduler(
      createGridScrollSchedulerState(400, 0),
      sample(0, 1_000),
    );
    expect(forward.mode).toBe("scrub");
    expect(backward.mode).toBe("scrub");
  });

  it("T-P17-003 honors the one-page and 120ms inclusive boundaries", () => {
    expect(
      reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(199, 120)).mode,
    ).toBe("idle");
    expect(
      reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(200, 120)).mode,
    ).toBe("scrub");
    expect(
      reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(200, 121)).mode,
    ).toBe("idle");
    expect(
      reduceGridScrollScheduler(createGridScrollSchedulerState(200, 0), sample(0, 120)).mode,
    ).toBe("scrub");
  });

  it("T-P17-003 accumulates sub-page movement inside one velocity window", () => {
    let fast = createGridScrollSchedulerState(0, 0);
    fast = reduceGridScrollScheduler(fast, sample(100, 40));
    expect(fast.mode).toBe("idle");
    fast = reduceGridScrollScheduler(fast, sample(200, 80));
    expect(fast.mode).toBe("scrub");

    let slow = createGridScrollSchedulerState(0, 0);
    slow = reduceGridScrollScheduler(slow, sample(100, 80));
    slow = reduceGridScrollScheduler(slow, sample(200, 160));
    expect(slow.mode).toBe("idle");
    expect(slow).toMatchObject({ windowAnchorRow: 100, windowAnchorTimestamp: 80 });

    slow = reduceGridScrollScheduler(slow, sample(300, 240));
    expect(slow.mode).toBe("idle");
  });

  it("keeps the newest valid anchor when an older velocity window expires", () => {
    let state = createGridScrollSchedulerState(0, 0);
    state = reduceGridScrollScheduler(state, sample(100, 80));
    state = reduceGridScrollScheduler(state, sample(200, 121));
    expect(state.mode).toBe("idle");
    state = reduceGridScrollScheduler(state, sample(300, 160));
    expect(state.mode).toBe("scrub");
  });

  it("T-P17-004 safely re-baselines invalid and non-monotonic samples", () => {
    const initial = createGridScrollSchedulerState();
    expect(reduceGridScrollScheduler(initial, sample(Number.NaN, 1))).toBe(initial);
    expect(reduceGridScrollScheduler(initial, sample(0, Number.POSITIVE_INFINITY))).toBe(initial);

    let state = reduceGridScrollScheduler(initial, sample(0, 100));
    state = reduceGridScrollScheduler(state, sample(400, 100));
    expect(state).toMatchObject({ lastRow: 400, lastTimestamp: 100, mode: "idle" });
    state = reduceGridScrollScheduler(state, sample(0, 99));
    expect(state).toMatchObject({ lastRow: 0, lastTimestamp: 99, mode: "idle" });
    state = reduceGridScrollScheduler(state, sample(0, 100));
    expect(state.mode).toBe("idle");
  });

  it("T-P17-005 keeps scrub latched through slow intermediate samples", () => {
    let state = reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(400, 1));
    for (let index = 1; index <= 10; index += 1) {
      state = reduceGridScrollScheduler(state, sample(400 + index, index * 200));
      expect(state.mode).toBe("scrub");
    }
    expect(reduceGridScrollScheduler(state, { type: "scrollend" }).mode).toBe("idle");
  });

  it("extends the scrub quiet deadline for a same-row scroll sample", () => {
    let state = reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(400, 10));
    expect(state.quietDeadline).toBe(130);
    state = reduceGridScrollScheduler(state, sample(400, 100));
    expect(state).toMatchObject({ mode: "scrub", quietDeadline: 220, lastTimestamp: 100 });
  });

  it("T-P17-006 settles once at the quiet boundary and deduplicates scrollend", () => {
    let state = reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(400, 1));
    state = reduceGridScrollScheduler(state, { type: "quiet", timestamp: 120 });
    expect(state).toMatchObject({ mode: "scrub", settleCount: 0 });
    state = reduceGridScrollScheduler(state, sample(600, 100));
    state = reduceGridScrollScheduler(state, {
      type: "quiet",
      timestamp: 100 + GRID_SCROLL_QUIET_MS - 1,
    });
    expect(state.settleCount).toBe(0);
    state = reduceGridScrollScheduler(state, {
      type: "quiet",
      timestamp: 100 + GRID_SCROLL_QUIET_MS,
    });
    expect(state).toMatchObject({ mode: "idle", settleCount: 1 });
    state = reduceGridScrollScheduler(state, { type: "scrollend" });
    expect(state.settleCount).toBe(1);
  });

  it("re-baselines the velocity window at settle before the next slow input", () => {
    let state = reduceGridScrollScheduler(createGridScrollSchedulerState(0, 0), sample(400, 10));
    expect(state.mode).toBe("scrub");
    state = reduceGridScrollScheduler(state, { type: "scrollend" });
    expect(state).toMatchObject({
      mode: "idle",
      windowAnchorRow: 400,
      windowAnchorTimestamp: 10,
    });
    state = reduceGridScrollScheduler(state, sample(401, 20));
    expect(state.mode).toBe("idle");
  });

  it("T-P17-007 ignores synthetic recenter samples completely", () => {
    const state = reduceGridScrollScheduler(
      createGridScrollSchedulerState(10, 100),
      sample(10_000, 101, true),
    );
    expect(state).toEqual(createGridScrollSchedulerState(10, 100));
  });
});
