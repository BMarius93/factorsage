import { BACKTEST_SNAPSHOT_VERSION } from "@intrinsic/contracts";
import type { BenchmarkSeries, Security } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
} from "./backtest-processor.js";
import type { BacktestJobLease } from "./job-lease.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

const logger = createLogger({ service: "worker", level: "silent" });

const COMPARISON_SERIES = "series-comparison";
const CALENDAR_SERIES = "series-calendar";

function snapshotDocument(overrides: Record<string, unknown> = {}) {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-01-01T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-1",
      name: "Fixture",
      versionId: "version-1",
      versionNumber: 1,
      definitionHash: "hash",
      definition: { schemaVersion: 1, buyLevels: [], sellLevels: [] },
    },
    stockList: { stockListId: "list-1", name: "Fixture list" },
    securities: [
      {
        securityId: "security-1",
        symbol: "AAA",
        name: "AAA Inc.",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: "FULL",
        buyWindows: [],
      },
    ],
    period: { startDate: "2020-01-01", endDate: "2020-12-31" },
    capital: { initialCapital: 10_000, monthlyContribution: 0 },
    allocation: { maximumPositions: 5, fullPositionFraction: 0.2 },
    benchmark: {
      benchmarkId: "benchmark-1",
      seriesId: COMPARISON_SERIES,
      seriesVersion: 1,
      code: "SP500",
      name: "S&P 500",
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      methodologyVersion: 1,
      currency: "USD",
    },
    executionCalendar: {
      referenceCode: "SP500",
      seriesId: CALENDAR_SERIES,
      seriesVersion: 1,
    },
    methodology: {},
    dataRevisions: { priceDatasetVersion: 1, derivedStateRevision: 1 },
    ...overrides,
  };
}

function claimOf(snapshot: unknown, attempt = 1): ClaimedBacktestJob {
  return {
    jobId: "job-1",
    runId: "run-1",
    attempt,
    actorUserId: "user-1",
    snapshot,
  };
}

/** Accepts every write and remembers only the failure, which is what these cases are about. */
class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return null;
  }
  async heartbeat(): Promise<boolean> {
    return true;
  }
  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0 };
  }
  async updateProgress(): Promise<boolean> {
    return true;
  }
  async persistResult(): Promise<boolean> {
    return true;
  }
  async failJob(write: BacktestFailureWrite): Promise<boolean> {
    this.failures.push(write);
    return true;
  }
  async releaseJob(): Promise<boolean> {
    return true;
  }
}

const lease: BacktestJobLease = {
  interruption: () => null,
  markLost: () => {},
} as unknown as BacktestJobLease;

/** Records which series ids execution asked for, and can refuse any of them. */
class RecordingBenchmarks implements BacktestBenchmarkLoader {
  readonly requested: string[] = [];

  constructor(private readonly unavailable: ReadonlySet<string> = new Set()) {}

  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    this.requested.push(seriesId);
    if (this.unavailable.has(seriesId)) {
      throw new Error(`series ${seriesId} is unavailable`);
    }
    return {
      id: seriesId,
      benchmarkId: "benchmark-1",
      version: 1,
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      currency: "USD",
      methodologyVersion: 1,
    };
  }

  async getBenchmarkDailyPrices() {
    return [];
  }
}

function processorWith(benchmarks: BacktestBenchmarkLoader) {
  const repository = new RecordingRepository();
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () => new Map<string, Security>(),
      },
      stockData: {
        getDailyEvaluationFrame: async () => {
          throw new Error("no frame should be needed in these cases");
        },
      },
      benchmarks,
      logger,
    },
    {
      frameConcurrency: 1,
      checkpointEveryDays: 5,
      checkpointMinIntervalMs: 0,
      leaseMs: 60_000,
      workerId: "worker-under-test",
    },
  );
  return { processor, repository };
}

/**
 * The execution calendar is methodology, so it is never inferred.
 *
 * The failure these guard against is not a crash — it is a run that quietly succeeds having
 * simulated a different set of dates than the one it recorded, because an auxiliary series
 * happened to be unreadable on that attempt. Two attempts of the same run would then disagree
 * about the same portfolio, and nothing on screen would say why.
 */
describe("the pinned execution calendar", () => {
  it("fails the run deterministically when its series cannot be read", async () => {
    const benchmarks = new RecordingBenchmarks(new Set([CALENDAR_SERIES]));
    const { processor, repository } = processorWith(benchmarks);

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.failures).toHaveLength(1);
    expect(repository.failures[0]?.code).toBe("EXECUTION_CALENDAR_UNAVAILABLE");
    expect(repository.failures[0]?.phase).toBe("PREPARING_DATA");
    // No securities-union fallback: it never reached the frame loader, which would have thrown.
    expect(benchmarks.requested).toContain(CALENDAR_SERIES);
  });

  it("refuses a snapshot that pins no calendar rather than choosing one", async () => {
    const benchmarks = new RecordingBenchmarks();
    const { processor, repository } = processorWith(benchmarks);
    const withoutCalendar = snapshotDocument();
    delete (withoutCalendar as Record<string, unknown>).executionCalendar;

    await processor.process(claimOf(withoutCalendar), lease);

    expect(repository.failures).toHaveLength(1);
    // Caught at the snapshot parse, before any phase is entered, so the user is told the run could
    // not start rather than being handed numbers from a methodology it never recorded.
    expect(repository.failures[0]?.code).toBe("EXECUTION_FAILED");
    expect(repository.failures[0]?.phase).toBeNull();
    expect(benchmarks.requested).toEqual([]);
  });

  it("asks for the same series on every attempt, whatever the catalog has done since", async () => {
    const seen: string[][] = [];
    for (const attempt of [1, 2, 3]) {
      const benchmarks = new RecordingBenchmarks(new Set([CALENDAR_SERIES]));
      const { processor } = processorWith(benchmarks);
      await processor.process(claimOf(snapshotDocument(), attempt), lease);
      seen.push(benchmarks.requested);
    }

    // A retry re-reads the snapshot, and the snapshot is immutable, so the calendar cannot drift
    // between attempts even while the catalog appends new versions around it.
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0]).toContain(CALENDAR_SERIES);
  });
});
