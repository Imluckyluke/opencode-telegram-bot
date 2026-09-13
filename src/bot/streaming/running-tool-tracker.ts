import { bucketElapsedMs } from "../../app/formatters/duration-formatter.js";
import { logger } from "../../utils/logger.js";

export interface RunningToolTick {
  sessionId: string;
  callId: string;
  elapsedMs: number;
  isFinal: boolean;
}

export interface RunningToolTrackerOptions {
  thresholdMs: number;
  tickIntervalMs: number;
  maxTrackingMs: number;
  onTick: (tick: RunningToolTick) => void;
  onHeartbeat: (sessionId: string) => void;
}

interface TrackedCall {
  sessionId: string;
  startedAt: number;
  lastBucketMs?: number;
  stopped: boolean;
}

/**
 * Drives elapsed-time updates for tool calls.
 *
 * OpenCode emits `running` tool events when the tool output changes, not on a
 * schedule: a tool that blocks without printing anything produces no events at
 * all. Elapsed time therefore has to come from an own interval, never from
 * incoming events.
 */
export class RunningToolTracker {
  private readonly thresholdMs: number;
  private readonly tickIntervalMs: number;
  private readonly maxTrackingMs: number;
  private readonly onTick: RunningToolTrackerOptions["onTick"];
  private readonly onHeartbeat: RunningToolTrackerOptions["onHeartbeat"];
  private readonly calls: Map<string, TrackedCall> = new Map();
  private readonly heartbeatSessions: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RunningToolTrackerOptions) {
    this.thresholdMs = options.thresholdMs;
    this.tickIntervalMs = options.tickIntervalMs;
    this.maxTrackingMs = options.maxTrackingMs;
    this.onTick = options.onTick;
    this.onHeartbeat = options.onHeartbeat;
  }

  track(sessionId: string, callId: string): void {
    if (!sessionId || !callId || this.calls.has(callId)) {
      return;
    }

    this.calls.set(callId, { sessionId, startedAt: Date.now(), stopped: false });
    this.ensureTimer();
  }

  /**
   * Forgets the call and returns how long it ran, but only if it lived past the
   * threshold. Fast calls return undefined so their output stays as it was.
   */
  release(callId: string): number | undefined {
    const call = this.calls.get(callId);
    if (!call) {
      return undefined;
    }

    this.calls.delete(callId);
    this.stopTimerWhenIdle();

    if (call.lastBucketMs === undefined) {
      return undefined;
    }

    return Date.now() - call.startedAt;
  }

  setHeartbeatActive(sessionId: string, active: boolean): void {
    if (!sessionId) {
      return;
    }

    if (active) {
      this.heartbeatSessions.add(sessionId);
      this.ensureTimer();
      return;
    }

    this.heartbeatSessions.delete(sessionId);
    this.stopTimerWhenIdle();
  }

  clearSession(sessionId: string, reason: string): void {
    let clearedAny = this.heartbeatSessions.delete(sessionId);

    for (const [callId, call] of Array.from(this.calls.entries())) {
      if (call.sessionId !== sessionId) {
        continue;
      }

      this.calls.delete(callId);
      clearedAny = true;
    }

    this.stopTimerWhenIdle();

    if (clearedAny) {
      logger.debug(`[RunningToolTracker] Cleared session: session=${sessionId}, reason=${reason}`);
    }
  }

  clearAll(reason: string): void {
    const count = this.calls.size;
    this.calls.clear();
    this.heartbeatSessions.clear();
    this.stopTimerWhenIdle();

    if (count > 0) {
      logger.debug(`[RunningToolTracker] Cleared all calls: count=${count}, reason=${reason}`);
    }
  }

  trackedCallIds(sessionId: string): string[] {
    const matches: { callId: string; startedAt: number }[] = [];

    for (const [callId, call] of this.calls) {
      if (call.sessionId === sessionId) {
        matches.push({ callId, startedAt: call.startedAt });
      }
    }

    matches.reverse();
    matches.sort((left, right) => right.startedAt - left.startedAt);
    return matches.map((entry) => entry.callId);
  }

  newestCallId(sessionId: string): string | undefined {
    return this.trackedCallIds(sessionId)[0];
  }

  displayTick(callId: string, now: number = Date.now()): RunningToolTick | undefined {
    const call = this.calls.get(callId);
    if (!call) {
      return undefined;
    }

    const elapsedMs = now - call.startedAt;
    if (elapsedMs < this.thresholdMs) {
      return undefined;
    }

    const isFinal = elapsedMs >= this.maxTrackingMs || call.stopped;
    const bucketMs = isFinal ? this.maxTrackingMs : bucketElapsedMs(elapsedMs);
    return { sessionId: call.sessionId, callId, elapsedMs: bucketMs, isFinal };
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  private stopTimerWhenIdle(): void {
    if (!this.timer || this.calls.size > 0 || this.heartbeatSessions.size > 0) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();

    for (const [callId, call] of this.calls) {
      if (call.stopped) {
        continue;
      }

      const elapsedMs = now - call.startedAt;
      if (elapsedMs < this.thresholdMs) {
        continue;
      }

      const isFinal = elapsedMs >= this.maxTrackingMs;
      const bucketMs = isFinal ? this.maxTrackingMs : bucketElapsedMs(elapsedMs);
      if (!isFinal && call.lastBucketMs === bucketMs) {
        continue;
      }

      call.lastBucketMs = bucketMs;
      call.stopped = isFinal;
      this.onTick({ sessionId: call.sessionId, callId, elapsedMs: bucketMs, isFinal });
    }

    for (const sessionId of this.heartbeatSessions) {
      this.onHeartbeat(sessionId);
    }
  }
}
