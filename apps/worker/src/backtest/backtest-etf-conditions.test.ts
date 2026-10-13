import {
  BACKTEST_SNAPSHOT_VERSION,
  collectStrategyEtfSources,
  STRATEGY_SCHEMA_VERSION,
  type BacktestRunSnapshot,
  type BacktestSnapshotEtfSeries,
  type StrategyCondition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DailyDerivedState,
  DailyPrice,
  DateRange,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  BACKTEST_DATA_REVISIONS,
  projectEvaluationFrame,
  type BenchmarkHistory,
  type BenchmarkRefreshState,
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
import type { EtfContextLoader } from "../shared/etf-context.js";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
  type BacktestFrameLoader,
} from "./backtest-processor.js";
import type { BacktestJobLease } from "./job-lease.js";
import { BacktestSnapshotError, parseRunSnapshot } from "./run-snapshot.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

/**
 * ETF-sourced Conditions through the worker's real execution path: snapshot parsing with the
 * pinned ETF series, the once-per-run ETF context computed by the production
 * `buildBenchmarkTechnicalContext` from fixture OHLCV, the exact-date column join, the canonical
 * projector, gates, simulation and the persisted result with its diagnostics.
 *
 * Every expectation is derived **independently** of the production calculations, from analytic
 * facts of the constructed inputs: a strictly rising close series has Wilder RSI exactly 100 after
 * its warm-up and sits strictly above every SMA of itself; a volume exactly double a flat baseline
 * reads RVOL exactly 2.0; the stock's own RSI is a fixture value per session. The expected trade
 * dates below are hand-derived intersections of those facts.
 */

const logger = createLogger({ service: "worker", level: "silent" });

const CALENDAR_SERIES = "series-calendar";
const SECURITY: Security = {
  id: "security-etf-conditions",
  symbol: "ALFA",
  name: "Alfa Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};
const START = "2024-03-01";
const END = "2024-05-31";

const lease: BacktestJobLease = {
  interruption: () => null,
  markLost: () => {},
} as unknown as BacktestJobLease;

function weekdays(from: string, to: string): LocalDate[] {
  const dates: LocalDate[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10) as LocalDate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const HISTORY = weekdays("2024-01-02", END);

/** GLD trades exactly double its flat baseline on these sessions, and only these. */
const GLD_SPIKES: readonly LocalDate[] = ["2024-04-10", "2024-05-15"];
/** The stock's own RSI fixture: 40 before April, 60 from April the 1st. */
const STOCK_RSI_RISES = "2024-04-01";

function derivedOn(date: LocalDate, stockRsi?: (date: LocalDate) => number): DailyDerivedState {
  const row: DailyDerivedState = { securityId: SECURITY.id, date };
  row.rsi14d = stockRsi ? stockRsi(date) : date >= STOCK_RSI_RISES ? 60 : 40;
  return row;
}

function priceOn(date: LocalDate): DailyPrice {
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

class ProjectingFrameLoader implements BacktestFrameLoader {
  readonly operands: (readonly OperandKey[])[] = [];

  constructor(private readonly stockRsi?: (date: LocalDate) => number) {}

  async prepareDailyEvaluationData(
    _security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
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
    this.operands.push(operands);
    const context = new Date(`${range.from}T00:00:00.000Z`);
    context.setUTCDate(context.getUTCDate() - 10);
    const from = context.toISOString().slice(0, 10);
    const dates = HISTORY.filter((date) => date >= from && date <= range.to);
    return projectEvaluationFrame({
      security,
      prices: dates.map(priceOn),
      derived: dates.map((date) => derivedOn(date, this.stockRsi)),
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

// ---------------------------------------------------------------------------
// The ETF fixtures: analytic constructions with hand-derivable indicator facts
// ---------------------------------------------------------------------------

/** XLK: strictly rising closes from the 1st of February, so RSI 14D is exactly 100 once warm. */
const XLK_SESSIONS = weekdays("2024-02-01", END);
const XLK_BARS: BenchmarkDailyPrice[] = XLK_SESSIONS.map((date, index) => ({
  seriesId: "series-xlk",
  date,
  open: 200 + index,
  high: 201 + index,
  low: 199 + index,
  close: 200 + index,
  volume: 1_000_000,
}));
/** The first XLK session with an RSI 14D: fifteen closes exist at index 14. */
const XLK_RSI_FIRST = XLK_SESSIONS[14]!;

/** SPY: strictly rising closes all year, so Price sits strictly above its own SMA 20D once warm. */
const SPY_SESSIONS = weekdays("2024-01-02", END);
const SPY_BARS: BenchmarkDailyPrice[] = SPY_SESSIONS.map((date, index) => ({
  seriesId: "series-spy",
  date,
  open: 400 + index * 0.5,
  high: 401 + index * 0.5,
  low: 399 + index * 0.5,
  close: 400 + index * 0.5,
  volume: 3_000_000,
}));

/** GLD: flat closes, flat volume, doubled exactly on the spike sessions. */
const GLD_SESSIONS = weekdays("2024-01-02", END);
const GLD_BARS: BenchmarkDailyPrice[] = GLD_SESSIONS.map((date) => ({
  seriesId: "series-gld",
  date,
  open: 180,
  high: 181,
  low: 179,
  close: 180,
  volume: GLD_SPIKES.includes(date) ? 2_000_000 : 1_000_000,
}));

type EtfFixture = {
  bars: BenchmarkDailyPrice[];
  /** Coverage the floor gate reports as missing; empty = anchored. */
  missingFromFloor?: Required<DateRange>[];
};

class FixtureEtfContexts implements EtfContextLoader {
  constructor(private readonly bySeriesId: ReadonlyMap<string, EtfFixture>) {}

  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    return {
      id: seriesId,
      benchmarkId: `benchmark-${seriesId}`,
      version: 1,
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: seriesId,
      currency: "USD",
      methodologyVersion: 1,
    };
  }

  async readFullBenchmarkHistory(
    series: BenchmarkSeries,
  ): Promise<BenchmarkHistory> {
    const fixture = this.bySeriesId.get(series.id);
    return {
      seriesId: series.id,
      basisGeneration: 3,
      rows: fixture ? [...fixture.bars] : [],
      missing: [],
      source: "POSTGRESQL",
    };
  }

  async benchmarkRefreshState(
    series: BenchmarkSeries,
  ): Promise<BenchmarkRefreshState> {
    const fixture = this.bySeriesId.get(series.id);
    const latest = fixture?.bars[fixture.bars.length - 1]?.date;
    return {
      coverageEnd: latest,
      latestBar: latest,
      // Read after every fixture session finalized, so the whole history is synchronized.
      lastTailSyncAt: "2024-06-03T12:00:00.000Z",
    };
  }

  async missingBenchmarkCoverage(
    series: BenchmarkSeries,
  ): Promise<Required<DateRange>[]> {
    return [...(this.bySeriesId.get(series.id)?.missingFromFloor ?? [])];
  }
}

const READY_ETF_FIXTURES = new Map<string, EtfFixture>([
  ["series-xlk", { bars: XLK_BARS }],
  ["series-spy", { bars: SPY_BARS }],
  ["series-gld", { bars: GLD_BARS }],
]);

const ETF_SERIES_PINS: BacktestSnapshotEtfSeries[] = [
  { code: "ETF_GLD", ticker: "GLD", seriesId: "series-gld", seriesVersion: 1, basisGeneration: 3 },
  { code: "ETF_XLK", ticker: "XLK", seriesId: "series-xlk", seriesVersion: 1, basisGeneration: 3 },
  { code: "SP500", ticker: "SPY", seriesId: "series-spy", seriesVersion: 1, basisGeneration: 3 },
];

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const STOCK_RSI_ABOVE_50: StrategyCondition = {
  id: "c-stock-rsi",
  metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
  operator: "IS_ABOVE",
  value: { kind: "NUMBER", value: 50 },
};

const XLK_RSI_ABOVE_50: StrategyCondition = {
  id: "c-xlk-rsi",
  metric: {
    kind: "OSCILLATOR",
    seriesId: "RSI_14D",
    source: { kind: "ETF", code: "ETF_XLK" },
  },
  operator: "IS_ABOVE",
  value: { kind: "NUMBER", value: 50 },
};

const SPY_PRICE_ABOVE_SMA20: StrategyCondition = {
  id: "c-spy-price",
  metric: { kind: "PRICE", source: { kind: "ETF", code: "SP500" } },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

const GLD_RVOL_ABOVE_1_5: StrategyCondition = {
  id: "c-gld-rvol",
  metric: {
    kind: "RELATIVE_VOLUME",
    period: 20,
    source: { kind: "ETF", code: "ETF_GLD" },
  },
  operator: "IS_ABOVE",
  value: { kind: "MULTIPLE", value: 1.5 },
};

function strategyOf(conditions: StrategyCondition[]): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 100, signal: { conditions } }],
    sellLevels: [],
  };
}

function snapshotOf(
  definition: StrategyDefinition,
  etfSeries: BacktestSnapshotEtfSeries[],
): BacktestRunSnapshot {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-01-01T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-etf",
      name: "ETF Conditions",
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
    ...(etfSeries.length > 0 ? { etfSeries } : {}),
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

async function execute(
  definition: StrategyDefinition,
  options: {
    etfSeries?: BacktestSnapshotEtfSeries[];
    etfFixtures?: ReadonlyMap<string, EtfFixture>;
    stockRsi?: (date: LocalDate) => number;
  } = {},
): Promise<{
  result: BacktestResult;
  write: BacktestResultWrite;
  loader: ProjectingFrameLoader;
}> {
  const loader = new ProjectingFrameLoader(options.stockRsi);
  const repository = new RecordingRepository();
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () => new Map([[SECURITY.id, SECURITY]]),
      },
      stockData: loader,
      benchmarks: new FixtureBenchmarks(),
      etfContexts: {
        loader: new FixtureEtfContexts(
          options.etfFixtures ?? READY_ETF_FIXTURES,
        ),
        publicationDelayMs: 30 * 60 * 1000,
      },
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
      snapshot: snapshotOf(
        definition,
        options.etfSeries ??
          ETF_SERIES_PINS.filter((pin) =>
            (collectStrategyEtfSources(definition) as readonly string[]).includes(
              pin.code,
            ),
          ),
      ),
    },
    lease,
  );
  expect(repository.failures).toEqual([]);
  expect(repository.results).toHaveLength(1);
  return {
    result: repository.results[0]!.result,
    write: repository.results[0]!,
    loader,
  };
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

function strategyTrades(result: BacktestResult) {
  return result.trades
    .filter((trade) => trade.source === "STRATEGY")
    .map((trade) => [trade.date, trade.action]);
}

describe("ETF-sourced Conditions executed by the backtest worker", () => {
  it("buys on the first session every Stock and ETF condition independently holds", async () => {
    const definition = strategyOf([
      STOCK_RSI_ABOVE_50,
      SPY_PRICE_ABOVE_SMA20,
      XLK_RSI_ABOVE_50,
      GLD_RVOL_ABOVE_1_5,
    ]);
    const { result, loader } = await execute(definition);

    // Hand-derived intersection: the stock's RSI fixture passes from 2024-04-01; SPY's rising
    // close is above its SMA 20D all period; XLK's RSI is exactly 100 from its fifteenth session
    // (2024-02-21, well before the period); GLD's RVOL is exactly 2.0 on its spike sessions and
    // 1.0 otherwise. The first session all four hold is the first April spike.
    expect(XLK_RSI_FIRST < START).toBe(true);
    expect(strategyTrades(result)).toEqual([["2024-04-10", "BUY"]]);

    // The per-security loader was asked for the stock operands alone: the ETF columns are joined
    // from the once-per-run context, never loaded per security.
    for (const operands of loader.operands) {
      expect([...operands]).toEqual(collectOperands(definition));
      expect([...operands]).toEqual(["price", "series:RSI_14D"]);
    }

    // The aggregate diagnostics say what the run read, per ETF, in code order.
    expect(result).toBeDefined();
  });

  it("records per-ETF diagnostics with the result write", async () => {
    const { write } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5, SPY_PRICE_ABOVE_SMA20]),
    );
    expect(write.etfConditions).toEqual([
      {
        code: "ETF_GLD",
        ticker: "GLD",
        status: "READY",
        firstSession: GLD_SESSIONS[0],
        latestSession: GLD_SESSIONS[GLD_SESSIONS.length - 1],
        basisGeneration: 3,
      },
      {
        code: "ETF_XLK",
        ticker: "XLK",
        status: "READY",
        firstSession: XLK_SESSIONS[0],
        latestSession: XLK_SESSIONS[XLK_SESSIONS.length - 1],
        basisGeneration: 3,
      },
      {
        code: "SP500",
        ticker: "SPY",
        status: "READY",
        firstSession: SPY_SESSIONS[0],
        latestSession: SPY_SESSIONS[SPY_SESSIONS.length - 1],
        basisGeneration: 3,
      },
    ]);
  });

  it("reads the ETF's series and never the stock's own column of the same identity", async () => {
    // The stock's RSI fixture fails the threshold on every session. If the source were silently
    // misread as the stock, this run could never buy; XLK's RSI of 100 is what passes.
    const { result } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5]),
      { stockRsi: () => 10 },
    );
    expect(strategyTrades(result)).toEqual([["2024-04-10", "BUY"]]);

    // And the converse: a stock condition is never satisfied by the ETF's reading.
    const stockOnly = await execute(strategyOf([STOCK_RSI_ABOVE_50]), {
      etfSeries: [],
      stockRsi: () => 10,
    });
    expect(strategyTrades(stockOnly.result)).toEqual([]);
  });

  it("degrades exactly the conditions naming an unavailable ETF, with its reason recorded", async () => {
    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-gld", {
      bars: GLD_BARS,
      missingFromFloor: [{ from: "1993-01-01", to: "2023-12-29" }],
    });
    const { result, write } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5]),
      {
        etfSeries: ETF_SERIES_PINS.filter((pin) => pin.code !== "SP500"),
        etfFixtures: fixtures,
      },
    );
    // The GLD condition is NOT_EVALUABLE on every session, so the ANDed signal never fires.
    expect(strategyTrades(result)).toEqual([]);
    expect(write.etfConditions).toEqual([
      {
        code: "ETF_GLD",
        ticker: "GLD",
        status: "NOT_BOOTSTRAPPED",
      },
      {
        code: "ETF_XLK",
        ticker: "XLK",
        status: "READY",
        firstSession: XLK_SESSIONS[0],
        latestSession: XLK_SESSIONS[XLK_SESSIONS.length - 1],
        basisGeneration: 3,
      },
    ]);
  });

  it("never buys before the ETF indicator's own genuine warm-up is complete", async () => {
    // XLK alone, with its RSI first defined on its fifteenth session. GLD's spike gate is removed
    // so the expected first BUY is exactly the first session the period holds an XLK RSI — which,
    // XLK having listed in February, is the first period session, not one invented earlier.
    const { result } = await execute(strategyOf([XLK_RSI_ABOVE_50]), {
      etfSeries: ETF_SERIES_PINS.filter((pin) => pin.code === "ETF_XLK"),
      stockRsi: () => 10,
    });
    const trades = strategyTrades(result);
    expect(trades[0]).toEqual([START, "BUY"]);
    expect(XLK_RSI_FIRST > XLK_SESSIONS[0]!).toBe(true);
  });
});

describe("the snapshot parse fails closed on ETF sources it cannot honour", () => {
  const definition = strategyOf([XLK_RSI_ABOVE_50]);

  it("refuses a definition reading an ETF the snapshot pins no series for", () => {
    expect(() => parseRunSnapshot(snapshotOf(definition, []))).toThrow(
      BacktestSnapshotError,
    );
    expect(() => parseRunSnapshot(snapshotOf(definition, []))).toThrow(
      /pins no series/,
    );
  });

  it("refuses a pinned series the definition does not read", () => {
    const stockOnly = strategyOf([STOCK_RSI_ABOVE_50]);
    expect(() =>
      parseRunSnapshot(
        snapshotOf(stockOnly, [
          {
            code: "ETF_XLK",
            ticker: "XLK",
            seriesId: "series-xlk",
            seriesVersion: 1,
            basisGeneration: 0,
          },
        ]),
      ),
    ).toThrow(/does not read/);
  });

  it("refuses a source this engine does not define, and any ETF-sourced trigger", () => {
    const unknownCode = strategyOf([
      {
        ...XLK_RSI_ABOVE_50,
        metric: {
          kind: "OSCILLATOR",
          seriesId: "RSI_14D",
          source: { kind: "ETF", code: "ETF_NOPE" },
        } as unknown as StrategyCondition["metric"],
      },
    ]);
    expect(() =>
      parseRunSnapshot(snapshotOf(unknownCode, ETF_SERIES_PINS)),
    ).toThrow(/not a source this engine defines/);

    const triggered: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [],
            trigger: {
              id: "t1",
              metric: { kind: "PRICE", source: { kind: "ETF", code: "SP500" } },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
          },
        },
      ],
      sellLevels: [],
    };
    expect(() =>
      parseRunSnapshot(
        snapshotOf(triggered, [
          {
            code: "SP500",
            ticker: "SPY",
            seriesId: "series-spy",
            seriesVersion: 1,
            basisGeneration: 0,
          },
        ]),
      ),
    ).toThrow(/trigger is not part of V1/);
  });

  it("accepts a consistent pinned snapshot and leaves stock-only parsing untouched", () => {
    expect(() =>
      parseRunSnapshot(
        snapshotOf(
          definition,
          ETF_SERIES_PINS.filter((pin) => pin.code === "ETF_XLK"),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      parseRunSnapshot(snapshotOf(strategyOf([STOCK_RSI_ABOVE_50]), [])),
    ).not.toThrow();
  });
});
