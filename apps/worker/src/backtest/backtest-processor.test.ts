import { BACKTEST_SNAPSHOT_VERSION } from "@intrinsic/contracts";
import { BACKTEST_DATA_REVISIONS } from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY } from "@intrinsic/strategy";
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
    methodology: { ...BACKTEST_METHODOLOGY },
    dataRevisions: { ...BACKTEST_DATA_REVISIONS },
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
  readonly released: string[] = [];
  readonly results: string[] = [];

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
  async persistResult(write: { runId: string }): Promise<boolean> {
    this.results.push(write.runId);
    return true;
  }
  async failJob(write: BacktestFailureWrite): Promise<boolean> {
    this.failures.push(write);
    return true;
  }
  async releaseJob(_jobId: string, runId: string): Promise<boolean> {
    this.released.push(runId);
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

/**
 * A queued run may not cross an engine deploy.
 *
 * The failure this guards against leaves no trace: a run submitted under `execution@2` and claimed
 * by a worker that implements `execution@3` would execute the new rules and persist the result
 * beside the old version stamps. Nothing would look wrong — the numbers would simply not be the
 * ones the snapshot says were produced, and the record that exists to make a run reproducible
 * would be the thing that lied.
 */
describe("engine methodology compatibility", () => {
  /** Every field is execution-affecting, so every field is checked. */
  const FIELDS = Object.keys(
    BACKTEST_METHODOLOGY,
  ) as (keyof typeof BACKTEST_METHODOLOGY)[];

  it("executes normally when the snapshot names exactly this build's methodology", async () => {
    const benchmarks = new RecordingBenchmarks(new Set([CALENDAR_SERIES]));
    const { processor, repository } = processorWith(benchmarks);

    await processor.process(claimOf(snapshotDocument()), lease);

    // It got past the guard and failed on the calendar instead, which is the next thing it does.
    expect(repository.failures[0]?.code).toBe("EXECUTION_CALENDAR_UNAVAILABLE");
    expect(benchmarks.requested).toContain(CALENDAR_SERIES);
  });

  it.each(FIELDS)(
    "refuses a run whose %s methodology this build does not implement",
    async (field) => {
      const benchmarks = new RecordingBenchmarks();
      const { processor, repository } = processorWith(benchmarks);
      const stale = snapshotDocument({
        methodology: {
          ...BACKTEST_METHODOLOGY,
          [field]: "queued-under-something-else@0",
        },
      });

      await processor.process(claimOf(stale), lease);

      expect(repository.failures).toHaveLength(1);
      expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
      // Before anything is loaded: not the calendar, not a security. The answer cannot change
      // with effort spent, so no effort is spent.
      expect(benchmarks.requested).toEqual([]);
    },
  );

  const DATA_FIELDS = Object.keys(
    BACKTEST_DATA_REVISIONS,
  ) as (keyof typeof BACKTEST_DATA_REVISIONS)[];

  it.each(DATA_FIELDS)(
    "refuses a run whose %s data revision this build does not implement",
    async (field) => {
      const benchmarks = new RecordingBenchmarks();
      const { processor, repository } = processorWith(benchmarks);
      const stale = snapshotDocument({
        dataRevisions: { ...BACKTEST_DATA_REVISIONS, [field]: 999 },
      });

      await processor.process(claimOf(stale), lease);

      expect(repository.failures).toHaveLength(1);
      expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
      // Before the execution calendar, before any security, before any provider or cache read.
      expect(benchmarks.requested).toEqual([]);
    },
  );

  it("refuses a run that recorded no data revisions at all", async () => {
    const benchmarks = new RecordingBenchmarks();
    const { processor, repository } = processorWith(benchmarks);
    const withoutRevisions = snapshotDocument();
    delete (withoutRevisions as Record<string, unknown>).dataRevisions;

    await processor.process(claimOf(withoutRevisions), lease);

    expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
    expect(benchmarks.requested).toEqual([]);
  });

  it("keeps refusing a data-revision mismatch on every retry", async () => {
    const stale = snapshotDocument({
      dataRevisions: { ...BACKTEST_DATA_REVISIONS, derivedStateRevision: 99 },
    });
    for (const attempt of [1, 2, 3]) {
      const benchmarks = new RecordingBenchmarks();
      const { processor, repository } = processorWith(benchmarks);
      await processor.process(claimOf(stale, attempt), lease);
      expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
      expect(benchmarks.requested).toEqual([]);
    }
  });

  it("names the field that disagreed, server-side only", async () => {
    const { processor, repository } = processorWith(new RecordingBenchmarks());
    const stale = snapshotDocument({
      dataRevisions: { ...BACKTEST_DATA_REVISIONS, priceDatasetVersion: 42 },
    });

    await processor.process(claimOf(stale), lease);

    const detail = JSON.stringify(repository.failures[0]?.detail);
    expect(detail).toContain("dataRevisions.priceDatasetVersion");
    expect(detail).toContain("42");
    expect(repository.failures[0]?.message).not.toContain("priceDataset");
  });

  it("refuses a run that recorded no methodology at all", async () => {
    const benchmarks = new RecordingBenchmarks();
    const { processor, repository } = processorWith(benchmarks);
    const withoutMethodology = snapshotDocument();
    delete (withoutMethodology as Record<string, unknown>).methodology;

    await processor.process(claimOf(withoutMethodology), lease);

    expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
  });

  it("neither rewrites the snapshot nor re-submits the run", async () => {
    const benchmarks = new RecordingBenchmarks();
    const { processor, repository } = processorWith(benchmarks);
    const stale = snapshotDocument({
      methodology: { ...BACKTEST_METHODOLOGY, execution: "older@1" },
    });
    const before = JSON.stringify(stale);
    const claim = claimOf(stale);

    await processor.process(claim, lease);

    // The document the worker was handed is untouched, so nothing can have been written back to
    // the row it came from — a run's recorded methodology is what it was submitted under, forever.
    expect(JSON.stringify(claim.snapshot)).toBe(before);
    expect(repository.released).toEqual([]);
    expect(repository.results).toEqual([]);
  });

  it("fails terminally and sanitizes: the user is told to re-run, versions stay server-side", async () => {
    const { processor, repository } = processorWith(new RecordingBenchmarks());
    const stale = snapshotDocument({
      methodology: { ...BACKTEST_METHODOLOGY, returns: "internal-revision@9" },
    });

    await processor.process(claimOf(stale), lease);

    const failure = repository.failures[0];
    expect(failure?.message).toContain("Run it again");
    expect(failure?.message).not.toContain("internal-revision@9");
    expect(failure?.message).not.toContain("time-weighted");
    // Developer detail travels in `detail`, which no API contract projects.
    expect(JSON.stringify(failure?.detail)).toContain(
      "ENGINE_VERSION_MISMATCH",
    );
  });

  it("keeps refusing on every retry rather than drifting into the new methodology", async () => {
    const stale = snapshotDocument({
      methodology: { ...BACKTEST_METHODOLOGY, calendar: "older-axis@0" },
    });
    for (const attempt of [1, 2, 3]) {
      const benchmarks = new RecordingBenchmarks();
      const { processor, repository } = processorWith(benchmarks);
      await processor.process(claimOf(stale, attempt), lease);
      expect(repository.failures[0]?.code).toBe("ENGINE_VERSION_MISMATCH");
      expect(benchmarks.requested).toEqual([]);
    }
  });
});
