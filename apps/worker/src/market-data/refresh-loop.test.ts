import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  MarketDataRefreshLoop,
  type MarketDataRefreshWork,
} from "./refresh-loop.js";
import type {
  ClaimedMarketDataRefresh,
  MarketDataRefreshScheduleRepository,
} from "./schedule-repository.js";

const logger = createLogger({ service: "worker", level: "silent" });
const NOW = new Date("2026-10-09T22:00:00.000Z");
const INTERVAL = 600_000;

class RecordingSchedule implements MarketDataRefreshScheduleRepository {
  readonly completed: Date[] = [];
  readonly released: Date[] = [];
  readonly failed: {
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }[] = [];
  constructor(private readonly claims: ClaimedMarketDataRefresh[]) {}
  async ensureSchedule() {}
  async claimDueRun() {
    return this.claims.shift() ?? null;
  }
  async heartbeat() {
    return true;
  }
  async completeRun(input: { nextDueAt: Date }) {
    this.completed.push(input.nextDueAt);
    return true;
  }
  async releaseRun(input: { nextDueAt: Date }) {
    this.released.push(input.nextDueAt);
    return true;
  }
  async failRun(input: {
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }) {
    this.failed.push({
      backoffMs: input.backoffMs,
      maxBackoffMs: input.maxBackoffMs,
      error: input.error,
    });
    return true;
  }
  async recoverExpiredRun() {
    return false;
  }
  async requestImmediateRun() {}
}

function loopWith(schedule: RecordingSchedule, work: MarketDataRefreshWork) {
  return new MarketDataRefreshLoop(schedule, work, logger, {
    workerId: "market-data-under-test",
    refreshIntervalMs: INTERVAL,
    pollIntervalMs: 10,
    leaseMs: 60_000,
    heartbeatIntervalMs: 1_000,
    retryBackoffMs: 5_000,
    now: () => NOW,
  });
}

const summary = { outcomes: [], providerReads: 0, failed: 0, durationMs: 1 };

describe("market-data refresh loop", () => {
  it("schedules the next run one interval after the end of this one", async () => {
    const schedule = new RecordingSchedule([
      { runSequence: 1, claimedAt: NOW },
    ]);
    const ran = await loopWith(schedule, {
      run: async (runSequence) => ({ ...summary, runSequence }),
    }).runOnce();

    expect(ran).toBe(true);
    expect(schedule.completed).toEqual([new Date(NOW.getTime() + INTERVAL)]);
  });

  it("records a failed run with a backoff capped at the interval", async () => {
    const schedule = new RecordingSchedule([
      { runSequence: 2, claimedAt: NOW },
    ]);
    await loopWith(schedule, {
      run: async () => {
        throw new Error("provider unavailable");
      },
    }).runOnce();

    expect(schedule.failed).toEqual([
      {
        backoffMs: 5_000,
        maxBackoffMs: INTERVAL,
        error: "provider unavailable",
      },
    ]);
    expect(schedule.completed).toEqual([]);
  });

  it("hands an unfinished run straight back when it is asked to stop", async () => {
    const schedule = new RecordingSchedule([
      { runSequence: 3, claimedAt: NOW },
    ]);
    const loop = loopWith(schedule, {
      run: async (runSequence, aborted) => {
        loop.stop();
        expect(aborted()).toBe(true);
        return { ...summary, runSequence };
      },
    });
    await loop.runOnce();

    expect(schedule.released).toEqual([NOW]);
    expect(schedule.completed).toEqual([]);
  });

  it("claims nothing when no run is due", async () => {
    const schedule = new RecordingSchedule([]);
    await expect(
      loopWith(schedule, {
        run: async () => ({ ...summary, runSequence: 0 }),
      }).runOnce(),
    ).resolves.toBe(false);
  });
});
