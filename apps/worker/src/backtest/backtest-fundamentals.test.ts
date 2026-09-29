import {
  BACKTEST_SNAPSHOT_VERSION,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DailyDerivedState,
  DailyPrice,
  DateRange,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  BACKTEST_DATA_REVISIONS,
  projectEvaluationFrame,
  type DailyPriceBounds,
} from "@intrinsic/stock-data";
import {
  BACKTEST_METHODOLOGY,
  collectOperands,
  type BacktestResult,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
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
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

/**
 * A Fundamental Strategy through the worker's real execution path.
 *
 * Snapshot parsing, operand collection, the whole-period preparation, one calendar-year window at a
 * time, the canonical `projectEvaluationFrame`, the simulation and the persisted result are all the
 * production ones. Only the persistence underneath the projector is a fixture: the frame is
 * projected from `DailyDerivedState` rows exactly as `CanonicalStockDataService` projects the rows it
 * reads, so nothing between the stored metric and the trade is stubbed.
 */

const logger = createLogger({ service: "worker", level: "silent" });

const CALENDAR_SERIES = "series-calendar";
const SECURITY: Security = {
  id: "security-fundamentals",
  symbol: "FUND",
  name: "Fundamentals Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};
const START = "2019-06-03";
const END = "2021-05-28";

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

const HISTORY = weekdays("2019-05-01", END);

/**
 * The materialized history, as the derived state holds it.
 *
 * ROIC TTM: unavailable until a first statement event on 2019-11-15, 12 until the next event on
 * 2020-02-14 — across the 2019/2020 calendar-year window boundary — and 18 from then on. Debt /
 * Equity: unavailable, then 1.2 from 2019-11-15 and 0.8 from 2020-05-08.
 */
function derivedOn(date: string): DailyDerivedState {
  const row: DailyDerivedState = { securityId: SECURITY.id, date };
  if (date >= "2019-11-15") {
    row.roicTtm = date >= "2020-02-14" ? 18 : 12;
    row.debtToEquity = date >= "2020-05-08" ? 0.8 : 1.2;
  }
  return row;
}

function priceOn(date: string): DailyPrice {
  const close = 100 + HISTORY.indexOf(date) * 0.05;
  return {
    securityId: SECURITY.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/** Projects every window through the canonical projector, and records what it was asked. */
class ProjectingFrameLoader implements BacktestFrameLoader {
  readonly prepared: Required<DateRange>[] = [];
  readonly windows: Required<DateRange>[] = [];
  readonly operands: (readonly OperandKey[])[] = [];

  async prepareDailyEvaluationData(
    _security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
    this.prepared.push(range);
    const inside = HISTORY.filter(
      (date) => date >= range.from && date <= range.to,
    );
    return {
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
    this.windows.push(range);
    this.operands.push(operands);
    // The same leading context the real loader reads, so a window's first session has a `t - 1`.
    const context = new Date(`${range.from}T00:00:00.000Z`);
    context.setUTCDate(context.getUTCDate() - 10);
    const from = context.toISOString().slice(0, 10);
    const dates = HISTORY.filter((date) => date >= from && date <= range.to);
    return projectEvaluationFrame({
      security,
      prices: dates.map(priceOn),
      derived: dates.map(derivedOn),
      operands,
      periodStart: range.from,
    }).frame;
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

class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];
  readonly results: BacktestResultWrite[] = [];

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

function snapshotOf(definition: StrategyDefinition) {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-01-01T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-fundamentals",
      name: "Fundamentals",
      versionId: "version-1",
      versionNumber: 1,
      definitionHash: "hash",
      definition,
    },
    stockList: { stockListId: "list-1", name: "Fixture list" },
    securities: [
      {
        securityId: SECURITY.id,
        symbol: SECURITY.symbol,
        name: SECURITY.name,
        exchangeCode: SECURITY.exchangeCode,
        currency: SECURITY.currency,
        buyWindowMode: "FULL",
        buyWindows: [],
      },
    ],
    period: { startDate: START, endDate: END },
    capital: { initialCapital: 100_000, monthlyContribution: 0 },
    allocation: { maximumPositions: 1, fullPositionFraction: 1 },
    benchmark: {
      benchmarkId: "benchmark-1",
      seriesId: "series-comparison",
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

async function execute(definition: StrategyDefinition): Promise<{
  result: BacktestResult;
  loader: ProjectingFrameLoader;
}> {
  const loader = new ProjectingFrameLoader();
  const repository = new RecordingRepository();
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () => new Map([[SECURITY.id, SECURITY]]),
      },
      stockData: loader,
      benchmarks: new FixtureBenchmarks(),
      logger,
    },
    {
      frameConcurrency: 1,
      checkpointEveryDays: 20,
      checkpointMinIntervalMs: 0,
      leaseMs: 60_000,
      workerId: "worker-under-test",
    },
  );
  await processor.process(
    {
      jobId: "job-1",
      runId: "run-1",
      attempt: 1,
      actorUserId: "user-1",
      snapshot: snapshotOf(definition),
    },
    lease,
  );
  expect(repository.failures).toEqual([]);
  expect(repository.results).toHaveLength(1);
  return { result: repository.results[0]!.result, loader };
}

function strategy(
  buy: StrategyDefinition["buyLevels"][number]["signal"],
  extra: Partial<StrategyDefinition> = {},
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 100, signal: buy }],
    sellLevels: [],
    ...extra,
  };
}

const ROIC_ABOVE_15 = strategy({
  conditions: [
    {
      id: "roic-above-15",
      metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 15 },
    },
  ],
});

const DEBT_TO_EQUITY_BELOW_1 = strategy({
  conditions: [
    {
      id: "debt-to-equity-below-1",
      metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
      operator: "IS_BELOW",
      value: { kind: "MULTIPLE", value: 1 },
    },
  ],
});

function strategyTrades(result: BacktestResult) {
  return result.trades
    .filter((trade) => trade.source === "STRATEGY")
    .map((trade) => [trade.date, trade.action]);
}

describe("a Fundamental Strategy executed by the backtest worker", () => {
  it("buys on the first session the persisted ROIC exceeds 15%, across a calendar-year window", async () => {
    const { result, loader } = await execute(ROIC_ABOVE_15);

    // Unavailable through 2019-11-14, 12 until 2020-02-13: the first match is 2020-02-14, which is
    // read from the second calendar-year window.
    expect(strategyTrades(result)).toEqual([["2020-02-14", "BUY"]]);
    expect(loader.windows).toEqual([
      { from: START, to: "2019-12-31" },
      { from: "2020-01-01", to: "2020-12-31" },
      { from: "2021-01-01", to: END },
    ]);
    // Every window projects exactly the operands the Strategy names: the close and ROIC TTM.
    for (const operands of loader.operands) {
      expect([...operands]).toEqual(collectOperands(ROIC_ABOVE_15));
      expect([...operands]).toEqual(["fundamental:ROIC_TTM", "price"]);
    }
  });

  it("never buys on the unavailable Debt / Equity history, and buys once it is 0.8", async () => {
    const { result } = await execute(DEBT_TO_EQUITY_BELOW_1);
    // Read as zero, the unavailable months from 2019-06-03 would all be "below 1.0x".
    expect(strategyTrades(result)).toEqual([["2020-05-08", "BUY"]]);
  });

  it("sells and exits on Fundamental Conditions, with no Trigger anywhere", async () => {
    const definition = strategy(
      {
        conditions: [
          {
            id: "roic-above-15",
            metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 15 },
          },
        ],
      },
      {
        sellLevels: [
          {
            id: "s1",
            percentage: 50,
            signal: {
              conditions: [
                {
                  id: "debt-to-equity-below-1",
                  metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
                  operator: "IS_BELOW",
                  value: { kind: "MULTIPLE", value: 1 },
                },
              ],
            },
          },
        ],
        finalExit: {
          id: "x1",
          rules: [
            {
              id: "x1-rule-1",
              signal: {
                conditions: [
                  {
                    id: "debt-to-equity-below-0.9",
                    metric: {
                      kind: "FUNDAMENTAL",
                      metricId: "DEBT_TO_EQUITY",
                    },
                    operator: "IS_BELOW",
                    value: { kind: "MULTIPLE", value: 0.9 },
                  },
                  {
                    id: "roic-above-17",
                    metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                    operator: "IS_ABOVE",
                    value: { kind: "PERCENT", value: 17 },
                  },
                ],
              },
            },
          ],
        },
      },
    );
    const { result } = await execute(definition);
    // BUY when ROIC first exceeds 15; on 2020-05-08 Debt / Equity drops to 0.8, which matches both
    // the SELL level and the FINAL EXIT rule — FINAL EXIT outranks the partial SELL on one date.
    expect(strategyTrades(result).slice(0, 2)).toEqual([
      ["2020-02-14", "BUY"],
      ["2020-05-08", "FINAL_EXIT"],
    ]);
  });

  it("gives an identical result on every run", async () => {
    const first = await execute(ROIC_ABOVE_15);
    const second = await execute(ROIC_ABOVE_15);
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
    const multipleFirst = await execute(DEBT_TO_EQUITY_BELOW_1);
    const multipleSecond = await execute(DEBT_TO_EQUITY_BELOW_1);
    expect(JSON.stringify(multipleSecond.result)).toBe(
      JSON.stringify(multipleFirst.result),
    );
  });
});
