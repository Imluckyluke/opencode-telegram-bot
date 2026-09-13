import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunningToolTracker,
  type RunningToolTick,
} from "../../../src/bot/streaming/running-tool-tracker.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function createTracker(overrides: { maxTrackingMs?: number } = {}) {
  const ticks: RunningToolTick[] = [];
  const heartbeats: string[] = [];
  const tracker = new RunningToolTracker({
    thresholdMs: 20 * SECOND,
    tickIntervalMs: 5 * SECOND,
    maxTrackingMs: overrides.maxTrackingMs ?? 24 * 60 * MINUTE,
    onTick: (tick) => ticks.push(tick),
    onHeartbeat: (sessionId) => heartbeats.push(sessionId),
  });

  return { tracker, ticks, heartbeats };
}

describe("bot/streaming/running-tool-tracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays silent until the threshold is reached", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(15 * SECOND);

    expect(ticks).toEqual([]);
  });

  it("emits a tick once the threshold is crossed", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(20 * SECOND);

    expect(ticks).toEqual([
      { sessionId: "s1", callId: "call-1", elapsedMs: 20 * SECOND, isFinal: false },
    ]);
  });

  it("does not emit again while the displayed bucket is unchanged", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(ticks).toHaveLength(1);
  });

  it("emits exactly one tick per bucket change", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(60 * SECOND);

    expect(ticks.map((tick) => tick.elapsedMs)).toEqual([
      20 * SECOND,
      30 * SECOND,
      40 * SECOND,
      50 * SECOND,
      MINUTE,
    ]);
  });

  it("returns the duration on release once the call passed the threshold", async () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(25 * SECOND);

    expect(tracker.release("call-1")).toBe(25 * SECOND);
  });

  it("returns undefined for a call that never reached the threshold", async () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(10 * SECOND);

    expect(tracker.release("call-1")).toBeUndefined();
  });

  it("returns undefined for an untracked call", () => {
    const { tracker } = createTracker();

    expect(tracker.release("missing")).toBeUndefined();
  });

  it("stops ticking after releasing the last call", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    tracker.release("call-1");
    await vi.advanceTimersByTimeAsync(60 * SECOND);

    expect(ticks).toHaveLength(1);
  });

  it("emits a final tick at the tracking limit and then stops", async () => {
    vi.useFakeTimers();
    const { tracker, ticks } = createTracker({ maxTrackingMs: MINUTE });

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(MINUTE);
    const ticksAtLimit = ticks.length;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(ticks[ticks.length - 1]).toEqual({
      sessionId: "s1",
      callId: "call-1",
      elapsedMs: MINUTE,
      isFinal: true,
    });
    expect(ticks).toHaveLength(ticksAtLimit);
  });

  it("keeps the duration available after the final tick", async () => {
    vi.useFakeTimers();
    const { tracker } = createTracker({ maxTrackingMs: MINUTE });

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(tracker.release("call-1")).toBe(2 * MINUTE);
  });

  it("fires the heartbeat on every tick regardless of buckets", async () => {
    vi.useFakeTimers();
    const { tracker, heartbeats } = createTracker();

    tracker.setHeartbeatActive("s1", true);
    await vi.advanceTimersByTimeAsync(15 * SECOND);

    expect(heartbeats).toEqual(["s1", "s1", "s1"]);
  });

  it("keeps the interval alive for a heartbeat without tracked calls", async () => {
    vi.useFakeTimers();
    const { tracker, heartbeats } = createTracker();

    tracker.setHeartbeatActive("s1", true);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(heartbeats).toHaveLength(1);

    tracker.setHeartbeatActive("s1", false);
    await vi.advanceTimersByTimeAsync(30 * SECOND);

    expect(heartbeats).toHaveLength(1);
  });

  it("clears only the requested session", async () => {
    vi.useFakeTimers();
    const { tracker, ticks, heartbeats } = createTracker();

    tracker.track("s1", "call-1");
    tracker.track("s2", "call-2");
    tracker.setHeartbeatActive("s1", true);
    tracker.clearSession("s1", "test");

    await vi.advanceTimersByTimeAsync(20 * SECOND);

    expect(heartbeats).toEqual([]);
    expect(ticks.map((tick) => tick.callId)).toEqual(["call-2"]);
  });

  it("returns undefined from newestCallId when the session has no calls", () => {
    const { tracker } = createTracker();

    tracker.track("s2", "call-2");

    expect(tracker.newestCallId("s1")).toBeUndefined();
  });

  it("returns the only tracked call for the session", () => {
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");

    expect(tracker.newestCallId("s1")).toBe("call-1");
  });

  it("picks the later start when two calls belong to one session", () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    vi.advanceTimersByTime(1000);
    tracker.track("s1", "call-2");

    expect(tracker.newestCallId("s1")).toBe("call-2");
  });

  it("does not let a released call win newestCallId", () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    vi.advanceTimersByTime(1000);
    tracker.track("s1", "call-2");
    tracker.release("call-2");

    expect(tracker.newestCallId("s1")).toBe("call-1");
  });

  it("lists tracked calls newest first", () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    vi.advanceTimersByTime(1000);
    tracker.track("s1", "call-2");
    tracker.track("s2", "call-other");

    expect(tracker.trackedCallIds("s1")).toEqual(["call-2", "call-1"]);
  });

  it("ignores a call from another session when picking newestCallId", () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    vi.advanceTimersByTime(1000);
    tracker.track("s2", "call-2");

    expect(tracker.newestCallId("s1")).toBe("call-1");
  });

  it("returns no display tick until the threshold", async () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(15 * SECOND);

    expect(tracker.displayTick("call-1")).toBeUndefined();
  });

  it("returns the bucketed display tick, not raw elapsed", async () => {
    vi.useFakeTimers();
    const { tracker } = createTracker();

    tracker.track("s1", "call-1");
    await vi.advanceTimersByTimeAsync(12 * MINUTE);

    expect(tracker.displayTick("call-1")).toEqual({
      sessionId: "s1",
      callId: "call-1",
      elapsedMs: 10 * MINUTE,
      isFinal: false,
    });
  });
});
