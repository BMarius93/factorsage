import {
  BACKTEST_SNAPSHOT_VERSION,
  STRATEGY_SCHEMA_VERSION,
  type BacktestLiveSnapshotResponse,
} from "@intrinsic/contracts";
import {
  BACKTEST_DATA_REVISIONS,
  type DailyPriceBounds,
} from "@intrinsic/stock-data";
import {
  BACKTEST_METHODOLOGY,
  createEvaluationFrame,
  PRICE_OPERAND,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
  type BacktestFrameLoader,
} from "./backtest-processor.js";
import type { BacktestJobLease } from "./job-lease.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  BacktestMilestoneWrite,
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";
import { parseRunSnapshot } from "./run-snapshot.js";

/**
 * A `BacktestRun` snapshot written **before** FINAL EXIT gained Exit Rules, executed by the current
 * worker.
 *
 * A `StrategyVersion` row is read through `normalizeStrategyDefinition` on every path, so it was
 * upgraded for free. A run snapshot is not: it is an immutable frozen copy taken at submission, and
 * `BacktestRun.snapshot` is the reproducibility authority (`AGENTS.md` invariant 12), so a run
 * queued before the release — or recovered, or retried after it — still carries
 * `schemaVersion: 1` with a flat `finalExit.signal`.
 *
 * This suite drives the **real** `BacktestProcessor.process` over such a snapshot, not
 * `normalizeStrategyDefinition` in isolation, because the defect it guards against was precisely
 * that the parse boundary between them did not upgrade anything.
 */

const logger = createLogger({ service: "worker", level: "silent" });

const COMPARISON_SERIES = "series-comparison";
const CALENDAR_SERIES = "series-calendar";
const SYMBOL = "AAA";
const SECURITY_ID = "security-1";
const START = "2020-01-02";
const END = "2020-06-30";

const lease: BacktestJobLease = {
  interruption: () => null,
  markLost: () => {},
} as unknown as BacktestJobLease;

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const HISTORY = weekdays("2019-06-03", END);

/**
 * A price that rises for the first half of the run and then falls through the comparison series.
 *
 * The BUY fires while price is above the series and FINAL EXIT fires once it drops below, so the
 * fixture proves the exit logic actually *executed* rather than merely parsed.
 */
const SERIES_LEVEL = 100;
function closeOn(date: string): number {
  const index = HISTORY.indexOf(date);
  const turn = HISTORY.indexOf("2020-04-01");
  return index <= turn ? SERIES_LEVEL + 10 : SERIES_LEVEL - 10;
}

/** `Price is below <series>` — the whole logic of the legacy FINAL EXIT under test. */
const LEGACY_EXIT_SIGNAL = {
  conditions: [
    {
      id: "exit-condition-1",
      metric: { kind: "PRICE" },
      operator: "IS_BELOW",
      value: { kind: "SERIES", seriesId: "SMA_200D" },
    },
  ],
};

/**
 * Exactly the document the previous release wrote: `schemaVersion: 1`, and a FINAL EXIT that is one
 * flat `signal` with no `rules` anywhere.
 */
function legacySnapshotDocument() {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-01-01T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-1",
      name: "Legacy fixture",
      versionId: "version-1",
      versionNumber: 1,
      definitionHash: "hash",
      definition: {
        schemaVersion: 1,
        buyLevels: [
          {
            id: "b100",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "buy-condition-1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
        ],
        sellLevels: [],
        finalExit: { id: "exit-1", signal: LEGACY_EXIT_SIGNAL },
      },
    },
    stockList: { stockListId: "list-1", name: "Fixture list" },
    securities: [
      {
        securityId: SECURITY_ID,
        symbol: SYMBOL,
        name: "AAA Inc.",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: "FULL",
        buyWindows: [],
      },
    ],
    period: { startDate: START, endDate: END },
    capital: { initialCapital: 100_000, monthlyContribution: 0 },
    allocation: { maximumPositions: 1, fullPositionFraction: 1 },
    benchmark: {
      benchmarkId: "benchmark-1",
      seriesId: COMPARISON_SERIES,
      seriesVersion: 1,
      code: "SP500",
      name: "S&P 500",
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
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
  };
}

function claimOf(snapshot: unknown): ClaimedBacktestJob {
  return {
    jobId: "job-1",
    runId: "run-1",
    attempt: 1,
    actorUserId: "user-1",
    snapshot,
  };
}

class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];
  readonly results: BacktestResultWrite[] = [];
  readonly progress: {
    percent: number;
    snapshot?: BacktestLiveSnapshotResponse;
    milestone?: BacktestMilestoneWrite;
  }[] = [];

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return null;
  }
  async heartbeat(): Promise<boolean> {
    return true;
  }
  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0 };
  }
  async updateProgress(write: {
    percent: number;
    snapshot?: BacktestLiveSnapshotResponse;
    milestone?: BacktestMilestoneWrite;
  }): Promise<boolean> {
    this.progress.push({
      percent: write.percent,
      ...(write.snapshot ? { snapshot: write.snapshot } : {}),
      ...(write.milestone ? { milestone: write.milestone } : {}),
    });
    return true;
  }
  async persistResult(write: BacktestResultWrite): Promise<boolean> {
    this.results.push(write);
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

class FixtureFrameLoader implements BacktestFrameLoader {
  async prepareDailyEvaluationData(
    _security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
    const inside = HISTORY.filter(
      (date) => date >= range.from && date <= range.to,
    );
    return inside.length === 0
      ? null
      : {
          firstDate: inside[0] as string,
          lastDate: inside[inside.length - 1] as string,
          tradingDays: inside.length,
        };
  }

  async readDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame> {
    const context = new Date(`${range.from}T00:00:00.000Z`);
    context.setUTCDate(context.getUTCDate() - 10);
    const from = context.toISOString().slice(0, 10);
    const dates = HISTORY.filter((date) => date >= from && date <= range.to);
    const closes = Float64Array.from(dates.map(closeOn));
    const columns = new Map<OperandKey, Float64Array>();
    for (const operand of operands) {
      if (operand !== PRICE_OPERAND) {
        // A flat comparison series the price crosses exactly once, mid-run.
        columns.set(operand, Float64Array.from(dates.map(() => SERIES_LEVEL)));
      }
    }
    let periodStartIndex = dates.length;
    for (let index = 0; index < dates.length; index += 1) {
      if ((dates[index] as string) >= range.from) {
        periodStartIndex = index;
        break;
      }
    }
    return createEvaluationFrame({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      dates,
      closes,
      columns,
      periodStartIndex,
    });
  }
}

class FixtureBenchmarks implements BacktestBenchmarkLoader {
  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    return {
      id: seriesId,
      benchmarkId: "benchmark-1",
      version: 1,
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: "SPY",
      currency: "USD",
      methodologyVersion: 1,
    };
  }
  async getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    return weekdays(range.from, range.to).map((date, index) => ({
      seriesId: series.id,
      date,
      open: 400 + index * 0.2,
      high: 401 + index * 0.2,
      low: 399 + index * 0.2,
      close: 400 + index * 0.2,
      volume: 5_000,
    }));
  }
  async missingBenchmarkCoverage(): Promise<Required<DateRange>[]> {
    return [];
  }
}

function processorWith() {
  const repository = new RecordingRepository();
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () =>
          new Map<string, Security>([
            [
              SECURITY_ID,
              {
                id: SECURITY_ID,
                symbol: SYMBOL,
                name: "AAA Inc.",
                exchangeCode: "NASDAQ",
                currency: "USD",
                type: "STOCK",
                isAdr: false,
                isActivelyTrading: true,
              },
            ],
          ]),
      },
      stockData: new FixtureFrameLoader(),
      benchmarks: new FixtureBenchmarks(),
      logger,
    },
    {
      frameConcurrency: 2,
      checkpointEveryDays: 5,
      checkpointMinIntervalMs: 0,
      leaseMs: 60_000,
      workerId: "worker-under-test",
    },
  );
  return { processor, repository };
}

describe("a schema version 1 run snapshot under the current worker", () => {
  it("parses, upgrades FINAL EXIT to one Exit Rule, and leaves the stored document untouched", () => {
    const stored = legacySnapshotDocument();
    const frozen = structuredClone(stored);

    const parsed = parseRunSnapshot(stored);

    // The executable projection is canonical.
    expect(parsed.strategy.definition.schemaVersion).toBe(
      STRATEGY_SCHEMA_VERSION,
    );
    expect(parsed.strategy.definition.finalExit).toEqual({
      id: "exit-1",
      // Deterministic: the single rule reuses FINAL EXIT's own id rather than inventing one.
      rules: [{ id: "exit-1", signal: LEGACY_EXIT_SIGNAL }],
    });

    // The stored document is the reproducibility authority and is never rewritten in place.
    expect(stored).toEqual(frozen);
    expect(stored.strategy.definition.schemaVersion).toBe(1);
    expect(stored.strategy.definition.finalExit).toEqual({
      id: "exit-1",
      signal: LEGACY_EXIT_SIGNAL,
    });
    expect(stored.strategy.definition.finalExit).not.toHaveProperty("rules");
  });

  it("executes the run to completion, firing the legacy FINAL EXIT", async () => {
    const stored = legacySnapshotDocument();
    const frozen = structuredClone(stored);
    const { processor, repository } = processorWith();

    await processor.process(claimOf(stored), lease);

    // No TypeError, no missing-rules failure: the run completed.
    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);
    const { result } = repository.results[0] as BacktestResultWrite;

    // The FINAL EXIT logic actually executed rather than merely parsing.
    const exits = result.trades.filter((trade) => trade.action === "FINAL_EXIT");
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((trade) => trade.levelId === "exit-1")).toBe(true);
    expect(result.summary.finalExitTrades).toBe(exits.length);
    // One exit per (security, date): the level is one action however it was written.
    expect(new Set(exits.map((trade) => `${trade.securityId}|${trade.date}`)).size).toBe(
      exits.length,
    );

    // Executing a run never mutates the document it was claimed with.
    expect(stored).toEqual(frozen);
  });

  /**
   * The upcast is a document conversion, not a revalidation.
   *
   * A snapshot already written in the current schema must come back as the very same object, so
   * every run submitted after this release costs nothing and cannot be perturbed by a projection
   * step that has no work to do.
   */
  it("passes a current-schema snapshot through untouched", () => {
    const current = legacySnapshotDocument();
    current.strategy.definition = {
      ...current.strategy.definition,
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      finalExit: { id: "exit-1", rules: [{ id: "exit-1", signal: LEGACY_EXIT_SIGNAL }] },
    } as never;

    const parsed = parseRunSnapshot(current);

    expect(parsed).toBe(current as never);
    expect(parsed.strategy.definition).toBe(current.strategy.definition as never);
  });

  /** The boundary still refuses what it always refused: a document it cannot read at all. */
  it("still refuses a structurally unreadable snapshot", async () => {
    const broken = legacySnapshotDocument() as Record<string, unknown>;
    delete (broken.strategy as Record<string, unknown>).definition;
    const { processor, repository } = processorWith();

    await processor.process(claimOf(broken), lease);

    expect(repository.results).toEqual([]);
    expect(repository.failures).toHaveLength(1);
    // A deterministic refusal carrying a product-safe reason, rather than a partial run. The
    // classification is the processor's existing one; only the fact of the refusal is asserted here.
    expect(repository.failures[0]?.code).toBeTruthy();
    expect(repository.failures[0]?.message).toBeTruthy();
  });
});
