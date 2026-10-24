import {
  BACKTEST_SNAPSHOT_VERSION,
  collectStrategyEtfSources,
  STRATEGY_SCHEMA_VERSION,
  type BacktestRunSnapshot,
  type BacktestSnapshotEtfSeries,
  type BacktestSnapshotSecuritySector,
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
  LeaseRenewal,
} from "./job-repository.js";
import { weekdaySessions } from "../shared/etf-context.test-helper.js";

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

/** The stock's own RSI on one session; the security lets several stocks differ in one run. */
type StockRsi = (date: LocalDate, securityId: string) => number;

function derivedOn(
  date: LocalDate,
  stockRsi?: StockRsi,
  securityId = SECURITY.id,
): DailyDerivedState {
  const row: DailyDerivedState = { securityId, date };
  row.rsi14d = stockRsi
    ? stockRsi(date, securityId)
    : date >= STOCK_RSI_RISES
      ? 60
      : 40;
  return row;
}

function priceOn(date: LocalDate, securityId = SECURITY.id): DailyPrice {
  const close = 100 + HISTORY.indexOf(date) * 0.05;
  return {
    securityId,
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

  constructor(private readonly stockRsi?: StockRsi) {}

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
      prices: dates.map((date) => priceOn(date, security.id)),
      derived: dates.map((date) =>
        derivedOn(date, this.stockRsi, security.id),
      ),
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

/**
 * XLE: rises by one a session, then drops a hundred on the step date and stays flat. Its Price is
 * therefore strictly below its own SMA 20D on the step session and the eighteen after it — while
 * the twenty-session window still holds a close from before the drop — and never before.
 */
const XLE_STEP_DOWN: LocalDate = "2024-05-06";
const XLE_SESSIONS = weekdays("2024-01-02", END);
const XLE_STEP_INDEX = XLE_SESSIONS.indexOf(XLE_STEP_DOWN);
const XLE_BARS: BenchmarkDailyPrice[] = XLE_SESSIONS.map((date, index) => {
  const close =
    index < XLE_STEP_INDEX ? 300 + index : 300 + XLE_STEP_INDEX - 100;
  return {
    seriesId: "series-xle",
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 2_000_000,
  };
});

/** XLF: strictly falling all year, so Price sits strictly below its own SMA 20D once warm. */
const XLF_SESSIONS = weekdays("2024-01-02", END);
const XLF_BARS: BenchmarkDailyPrice[] = XLF_SESSIONS.map((date, index) => ({
  seriesId: "series-xlf",
  date,
  open: 500 - index,
  high: 501 - index,
  low: 499 - index,
  close: 500 - index,
  volume: 2_500_000,
}));

/** XLC: lists inside the run's period, strictly rising from its first session. */
const XLC_LISTING: LocalDate = "2024-03-18";
const XLC_SESSIONS = weekdays(XLC_LISTING, END);
const XLC_BARS: BenchmarkDailyPrice[] = XLC_SESSIONS.map((date, index) => ({
  seriesId: "series-xlc",
  date,
  open: 80 + index,
  high: 81 + index,
  low: 79 + index,
  close: 80 + index,
  volume: 4_000_000,
}));

type EtfFixture = {
  bars: BenchmarkDailyPrice[];
  /** The history read fails, as a Redis or PostgreSQL outage makes it fail. */
  unreadable?: boolean;
  /** The price basis the store holds now; the pins below record 3. */
  basisGeneration?: number;
  /** Coverage the floor gate reports as missing; empty = anchored. */
  missingFromFloor?: Required<DateRange>[];
};

class FixtureEtfContexts implements EtfContextLoader {
  /** Every read made of the loader, as `<method>:<seriesId>`, in order. */
  readonly calls: string[] = [];

  constructor(private readonly bySeriesId: ReadonlyMap<string, EtfFixture>) {}

  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    this.calls.push(`getSeries:${seriesId}`);
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
    this.calls.push(`readFullBenchmarkHistory:${series.id}`);
    const fixture = this.bySeriesId.get(series.id);
    if (fixture?.unreadable) {
      throw new Error(`Timed out reading benchmark:v1:${series.id}`);
    }
    return {
      seriesId: series.id,
      basisGeneration: fixture?.basisGeneration ?? 3,
      rows: fixture ? [...fixture.bars] : [],
      missing: [],
      source: "POSTGRESQL",
    };
  }

  async benchmarkRefreshState(
    series: BenchmarkSeries,
  ): Promise<BenchmarkRefreshState> {
    this.calls.push(`benchmarkRefreshState:${series.id}`);
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
    this.calls.push(`missingBenchmarkCoverage:${series.id}`);
    return [...(this.bySeriesId.get(series.id)?.missingFromFloor ?? [])];
  }
}

const READY_ETF_FIXTURES = new Map<string, EtfFixture>([
  ["series-xlk", { bars: XLK_BARS }],
  ["series-spy", { bars: SPY_BARS }],
  ["series-gld", { bars: GLD_BARS }],
  ["series-xle", { bars: XLE_BARS }],
  ["series-xlc", { bars: XLC_BARS }],
  ["series-xlf", { bars: XLF_BARS }],
]);

const ETF_SERIES_PINS: BacktestSnapshotEtfSeries[] = [
  { code: "ETF_GLD", ticker: "GLD", seriesId: "series-gld", seriesVersion: 1, basisGeneration: 3 },
  { code: "ETF_XLC", ticker: "XLC", seriesId: "series-xlc", seriesVersion: 1, basisGeneration: 3 },
  { code: "ETF_XLE", ticker: "XLE", seriesId: "series-xle", seriesVersion: 1, basisGeneration: 3 },
  { code: "ETF_XLF", ticker: "XLF", seriesId: "series-xlf", seriesVersion: 1, basisGeneration: 3 },
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

const XLE_PRICE_BELOW_SMA20: StrategyCondition = {
  id: "c-xle-price",
  metric: { kind: "PRICE", source: { kind: "ETF", code: "ETF_XLE" } },
  operator: "IS_BELOW",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

const XLC_RSI_ABOVE_50: StrategyCondition = {
  id: "c-xlc-rsi",
  metric: {
    kind: "OSCILLATOR",
    seriesId: "RSI_14D",
    source: { kind: "ETF", code: "ETF_XLC" },
  },
  operator: "IS_ABOVE",
  value: { kind: "NUMBER", value: 50 },
};

const XLK_PRICE_ABOVE_SMA20: StrategyCondition = {
  id: "c-xlk-price",
  metric: { kind: "PRICE", source: { kind: "ETF", code: "ETF_XLK" } },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

function strategyOf(conditions: StrategyCondition[]): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 100, signal: { conditions } }],
    sellLevels: [],
  };
}

/** A BUY level, and optionally a 50% SELL level and a one-rule FINAL EXIT. */
function leveledStrategy(levels: {
  buy: StrategyCondition[];
  sell?: StrategyCondition[];
  finalExit?: StrategyCondition[];
}): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      { id: "b1", percentage: 100, signal: { conditions: levels.buy } },
    ],
    sellLevels: levels.sell
      ? [{ id: "s1", percentage: 50, signal: { conditions: levels.sell } }]
      : [],
    ...(levels.finalExit
      ? {
          finalExit: {
            id: "x1",
            rules: [{ id: "r1", signal: { conditions: levels.finalExit } }],
          },
        }
      : {}),
  };
}

function securitiesOf(
  count: number,
  catalogSectors: readonly (string | undefined)[] = [],
): Security[] {
  return Array.from({ length: count }, (_, index) => {
    const security =
      index === 0
        ? SECURITY
        : {
            ...SECURITY,
            id: `${SECURITY.id}-${index}`,
            symbol: `ALF${index}`,
            name: `Alfa Corp ${index}`,
          };
    // The catalog's *current* sector: what a run must never consult once its snapshot froze one.
    const sector = catalogSectors[index];
    return sector === undefined ? security : { ...security, sector };
  });
}

function snapshotOf(
  definition: StrategyDefinition,
  etfSeries: BacktestSnapshotEtfSeries[],
  securities: readonly Security[] = [SECURITY],
  frozenSectors?: readonly BacktestSnapshotSecuritySector[],
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
    securities: securities.map((security, index) => ({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      exchangeCode: security.exchangeCode,
      currency: security.currency,
      buyWindowMode: "FULL" as const,
      buyWindows: [],
      ...(frozenSectors ? { sector: frozenSectors[index]! } : {}),
    })),
    ...(etfSeries.length > 0 ? { etfSeries } : {}),
    period: { startDate: START, endDate: END },
    capital: { initialCapital: 100_000, monthlyContribution: 0 },
    allocation: {
      maximumPositions: securities.length,
      fullPositionFraction: 1 / securities.length,
    },
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
    stockRsi?: StockRsi;
    securities?: number;
    /** One frozen sector per security, as the API froze it at submission. */
    frozenSectors?: readonly BacktestSnapshotSecuritySector[];
    /** One current catalog sector per security, which execution must ignore. */
    catalogSectors?: readonly (string | undefined)[];
    /** The run is expected to fail: its failure write is returned instead of a result. */
    expectFailure?: boolean;
  } = {},
): Promise<{
  result: BacktestResult;
  write: BacktestResultWrite;
  loader: ProjectingFrameLoader;
  etfLoader: FixtureEtfContexts;
  failures: BacktestFailureWrite[];
}> {
  const loader = new ProjectingFrameLoader(options.stockRsi);
  const repository = new RecordingRepository();
  const securities = securitiesOf(
    options.securities ?? options.frozenSectors?.length ?? 1,
    options.catalogSectors,
  );
  const frozenCodes = (options.frozenSectors ?? []).flatMap((frozen) =>
    frozen.etfCode ? [frozen.etfCode] : [],
  );
  const etfLoader = new FixtureEtfContexts(
    options.etfFixtures ?? READY_ETF_FIXTURES,
  );
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () =>
          new Map(securities.map((security) => [security.id, security])),
      },
      stockData: loader,
      benchmarks: new FixtureBenchmarks(),
      etfContexts: {
        loader: etfLoader,
        publicationDelayMs: 30 * 60 * 1000,
        isScheduledSession: weekdaySessions,
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
          ETF_SERIES_PINS.filter(
            (pin) =>
              (collectStrategyEtfSources(definition) as readonly string[]).includes(
                pin.code,
              ) || frozenCodes.includes(pin.code),
          ),
        securities,
        options.frozenSectors,
      ),
    },
    lease,
  );
  if (options.expectFailure) {
    expect(repository.results).toEqual([]);
    return {
      result: undefined as never,
      write: undefined as never,
      loader,
      etfLoader,
      failures: repository.failures,
    };
  }
  expect(repository.failures).toEqual([]);
  expect(repository.results).toHaveLength(1);
  return {
    result: repository.results[0]!.result,
    write: repository.results[0]!,
    loader,
    etfLoader,
    failures: repository.failures,
  };
}

class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];
  readonly results: BacktestResultWrite[] = [];

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return null;
  }
  async heartbeat(): Promise<LeaseRenewal> {
    return "HELD";
  }
  async isCancelRequested(): Promise<boolean> {
    return false;
  }
  async cancelJob(): Promise<boolean> {
    return true;
  }
  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0, cancelled: 0 };
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

  it("decides each stock on its own rule and all of them on the one shared ETF context", async () => {
    // Three stocks under the decision's own four-source BUY signal. The three ETF rules are the
    // same market context for every stock; only the stock's own RSI differs: the first clears 50
    // from April, the second only from May, the third never.
    const definition = strategyOf([
      STOCK_RSI_ABOVE_50,
      SPY_PRICE_ABOVE_SMA20,
      XLK_RSI_ABOVE_50,
      GLD_RVOL_ABOVE_1_5,
    ]);
    const [first, second, third] = securitiesOf(3);
    const { result, etfLoader } = await execute(definition, {
      securities: 3,
      stockRsi: (date, securityId) =>
        securityId === first!.id
          ? date >= "2024-04-01"
            ? 60
            : 40
          : securityId === second!.id
            ? date >= "2024-05-01"
              ? 60
              : 40
            : 10,
    });

    // Hand-derived per stock: GLD's RVOL rule holds on its two spike sessions only, so each stock
    // buys on the first spike at or after its own rule starts holding — and the third never does.
    const buys = result.trades
      .filter((trade) => trade.source === "STRATEGY" && trade.action === "BUY")
      .map((trade) => [trade.symbol, trade.date]);
    expect(buys).toEqual([
      [first!.symbol, GLD_SPIKES[0]],
      [second!.symbol, GLD_SPIKES[1]],
    ]);
    expect(result.trades.some((trade) => trade.symbol === third!.symbol)).toBe(
      false,
    );
    // Three stocks, one read of each of the three funds.
    expect(
      etfLoader.calls.filter((call) => call.startsWith("readFullBenchmarkHistory:")),
    ).toHaveLength(3);
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
      { etfFixtures: fixtures },
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

  it("stops the run, rather than completing it on undecidable rules, when an ETF cannot be read", async () => {
    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-xlk", { ...READY_ETF_FIXTURES.get("series-xlk")!, unreadable: true });
    const { failures } = await execute(strategyOf([XLK_RSI_ABOVE_50]), {
      etfFixtures: fixtures,
      expectFailure: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "EXECUTION_FAILED" });
    expect(JSON.stringify(failures[0])).toContain("XLK could not be read");
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

/** April only: the stock's own BUY rule holds for one month, so nothing re-enters after an exit. */
const STOCK_RSI_APRIL_ONLY = (date: LocalDate): number =>
  date >= "2024-04-01" && date < "2024-05-01" ? 60 : 40;

describe("ETF-sourced Conditions in SELL and FINAL EXIT", () => {
  it("sells and exits on the sessions the ETF rules first hold, and on no other", async () => {
    // Hand-derived: the stock's own rule buys on the first April session. GLD's RVOL is exactly
    // 2.0 on its spike sessions, so the SELL level fires on the first spike after the buy. XLE's
    // Price drops below its SMA 20D on its step-down session, so FINAL EXIT fires there.
    const { result, write } = await execute(
      leveledStrategy({
        buy: [STOCK_RSI_ABOVE_50],
        sell: [GLD_RVOL_ABOVE_1_5],
        finalExit: [XLE_PRICE_BELOW_SMA20],
      }),
      { stockRsi: STOCK_RSI_APRIL_ONLY },
    );
    expect(strategyTrades(result)).toEqual([
      ["2024-04-01", "BUY"],
      ["2024-04-10", "SELL"],
      [XLE_STEP_DOWN, "FINAL_EXIT"],
    ]);
    // The position was closed by the strategy, so nothing was left for the terminal liquidation.
    expect(
      result.trades.filter((trade) => trade.source === "END_OF_BACKTEST"),
    ).toEqual([]);
    expect(write.etfConditions?.map((row) => [row.ticker, row.status])).toEqual(
      [
        ["GLD", "READY"],
        ["XLE", "READY"],
      ],
    );
  });

  it("neither sells nor exits on a rule whose ETF is unavailable, and still honours the other", async () => {
    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-xle", {
      bars: XLE_BARS,
      missingFromFloor: [{ from: "1993-01-01", to: "2023-12-29" }],
    });
    const { result, write } = await execute(
      leveledStrategy({
        buy: [STOCK_RSI_ABOVE_50],
        sell: [GLD_RVOL_ABOVE_1_5],
        finalExit: [XLE_PRICE_BELOW_SMA20],
      }),
      { stockRsi: STOCK_RSI_APRIL_ONLY, etfFixtures: fixtures },
    );
    // XLE's rule is NOT_EVALUABLE on every session: the exit never fires, the step-down included.
    // GLD is untouched, so the SELL level still fires on its first spike.
    expect(strategyTrades(result)).toEqual([
      ["2024-04-01", "BUY"],
      ["2024-04-10", "SELL"],
    ]);
    expect(
      result.trades.filter((trade) => trade.action === "FINAL_EXIT"),
    ).toEqual([]);
    // What the strategy never closed is what the end of the run liquidated: the position was
    // still open on the step-down session and every session after it.
    expect(
      result.trades
        .filter((trade) => trade.source === "END_OF_BACKTEST")
        .map((trade) => trade.date),
    ).toEqual([END]);
    expect(write.etfConditions?.map((row) => [row.ticker, row.status])).toEqual(
      [
        ["GLD", "READY"],
        ["XLE", "NOT_BOOTSTRAPPED"],
      ],
    );
  });

  it("leaves stock-only SELL and FINAL EXIT rules exactly as they were beside an ETF rule in BUY", async () => {
    // A stock-only strategy with all three level kinds, and the same strategy with an ETF rule
    // that holds on every session added to its BUY level. The ETF rule can change nothing, so the
    // two runs must trade identically — to the share and the cent.
    const stockSell: StrategyCondition = {
      id: "c-stock-sell",
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 65 },
    };
    const stockExit: StrategyCondition = {
      id: "c-stock-exit",
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "IS_BELOW",
      value: { kind: "NUMBER", value: 30 },
    };
    // 60 from April (BUY), 70 on one session (SELL), 20 from the 20th of May (FINAL EXIT).
    const stockRsi = (date: LocalDate): number =>
      date >= "2024-05-20"
        ? 20
        : date === "2024-04-22"
          ? 70
          : date >= "2024-04-01"
            ? 60
            : 40;
    const stockOnly = await execute(
      leveledStrategy({
        buy: [STOCK_RSI_ABOVE_50],
        sell: [stockSell],
        finalExit: [stockExit],
      }),
      { stockRsi, etfSeries: [] },
    );
    const withEtf = await execute(
      leveledStrategy({
        buy: [STOCK_RSI_ABOVE_50, XLK_RSI_ABOVE_50],
        sell: [stockSell],
        finalExit: [stockExit],
      }),
      { stockRsi },
    );
    expect(strategyTrades(stockOnly.result)).toEqual([
      ["2024-04-01", "BUY"],
      ["2024-04-22", "SELL"],
      ["2024-05-20", "FINAL_EXIT"],
    ]);
    const facts = (result: BacktestResult) =>
      result.trades.map(({ date, action, source, shares, price }) => ({
        date,
        action,
        source,
        shares,
        price,
      }));
    expect(facts(withEtf.result)).toEqual(facts(stockOnly.result));
    // The stock-only run never touched the ETF loader at all.
    expect(stockOnly.etfLoader.calls).toEqual([]);
    expect(stockOnly.write.etfConditions).toBeUndefined();
  });
});

describe("an ETF's price basis restated between submission and execution", () => {
  it("computes on the one basis the run reads, records it, and is not refused", async () => {
    // Submitted when XLK was on generation 3 (the pin); by the time the worker reads it the
    // provider has re-based it to generation 4, and the bars below are the restated ones. As for
    // a stock (`historical-price-basis-v1.md` §9), the basis is the one in force when the run
    // reads it: the pin records what was in force at submission and binds nothing.
    const restated = new Map(READY_ETF_FIXTURES);
    restated.set("series-xlk", { bars: XLK_BARS, basisGeneration: 4 });
    const { result, write, etfLoader } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5]),
      { etfFixtures: restated, stockRsi: () => 10 },
    );
    // The same hand-derived trades as on any basis: every XLK value comes from the bars read.
    expect(strategyTrades(result)).toEqual([["2024-04-10", "BUY"]]);
    // The generation actually read is what the result records, beside the unchanged GLD.
    expect(
      write.etfConditions?.map((row) => [row.ticker, row.basisGeneration]),
    ).toEqual([
      ["GLD", 3],
      ["XLK", 4],
    ]);
    // Read exactly once: a run cannot meet two bases of one fund, whatever happens after the read.
    expect(
      etfLoader.calls.filter((call) => call === "readFullBenchmarkHistory:series-xlk"),
    ).toHaveLength(1);
  });
});

describe("point-in-time boundaries of an ETF's own history", () => {
  it("cannot evaluate before a fund that lists inside the period has warmed up", async () => {
    // XLC's first session is inside the run. Its RSI 14D needs fifteen closes, so the first
    // session the rule can hold is its fifteenth — counted from its own listing, not the period.
    const { result } = await execute(strategyOf([XLC_RSI_ABOVE_50]), {
      stockRsi: () => 10,
    });
    expect(XLC_LISTING > START).toBe(true);
    expect(XLC_SESSIONS[14]).toBe("2024-04-05");
    expect(strategyTrades(result)[0]).toEqual(["2024-04-05", "BUY"]);
  });

  it("never substitutes a neighbouring session for one the ETF has no bar for", async () => {
    // XLK is missing exactly the session GLD first spikes on. Its RSI is 100 the session before
    // and the session after, so any carry-forward or nearest-session read would buy on the spike.
    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-xlk", {
      bars: XLK_BARS.filter((bar) => bar.date !== GLD_SPIKES[0]),
    });
    const { result } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5]),
      { etfFixtures: fixtures, stockRsi: () => 10 },
    );
    // The signal is undecidable on the first spike and fires on the second.
    expect(strategyTrades(result)).toEqual([[GLD_SPIKES[1], "BUY"]]);
  });
});

describe("how much is read for ETF conditions", () => {
  it("reads each distinct ETF once per run, however many securities and rules read it", async () => {
    // Three securities; seven ETF rules across BUY, SELL and FINAL EXIT naming two funds.
    const definition = leveledStrategy({
      buy: [
        STOCK_RSI_ABOVE_50,
        XLK_RSI_ABOVE_50,
        XLK_PRICE_ABOVE_SMA20,
        GLD_RVOL_ABOVE_1_5,
      ],
      sell: [
        { ...XLK_RSI_ABOVE_50, id: "c-xlk-rsi-sell" },
        { ...GLD_RVOL_ABOVE_1_5, id: "c-gld-rvol-sell" },
      ],
      finalExit: [
        { ...XLK_PRICE_ABOVE_SMA20, id: "c-xlk-price-exit", operator: "IS_BELOW" },
        { ...GLD_RVOL_ABOVE_1_5, id: "c-gld-rvol-exit" },
      ],
    });
    const { result, loader, etfLoader } = await execute(definition, {
      securities: 3,
    });

    // Exactly one of each read per distinct fund: 2 funds x 4 reads, for 3 securities x 7 rules.
    expect([...etfLoader.calls].sort()).toEqual(
      [
        "benchmarkRefreshState:series-gld",
        "benchmarkRefreshState:series-xlk",
        "getSeries:series-gld",
        "getSeries:series-xlk",
        "missingBenchmarkCoverage:series-gld",
        "missingBenchmarkCoverage:series-xlk",
        "readFullBenchmarkHistory:series-gld",
        "readFullBenchmarkHistory:series-xlk",
      ].sort(),
    );
    // Every security was loaded, and each for its own stock operands alone.
    expect(loader.operands.length).toBeGreaterThanOrEqual(3);
    for (const operands of loader.operands) {
      expect([...operands]).toEqual(["price", "series:RSI_14D"]);
    }
    // And the one context decided all three: each security buys on the first GLD spike.
    const buys = result.trades.filter(
      (trade) => trade.source === "STRATEGY" && trade.action === "BUY",
    );
    expect(buys.map((trade) => trade.date)).toEqual([
      "2024-04-10",
      "2024-04-10",
      "2024-04-10",
    ]);
    expect(new Set(buys.map((trade) => trade.symbol)).size).toBe(3);
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

// ---------------------------------------------------------------------------
// Stock's Sector: one rule, each stock's own sector ETF
// ---------------------------------------------------------------------------

const STOCK_SECTOR = { kind: "STOCK_SECTOR" } as const;

const SECTOR_PRICE_ABOVE_SMA20: StrategyCondition = {
  id: "c-sector-price-above",
  metric: { kind: "PRICE", source: STOCK_SECTOR },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

const SECTOR_PRICE_BELOW_SMA20: StrategyCondition = {
  id: "c-sector-price-below",
  metric: { kind: "PRICE", source: STOCK_SECTOR },
  operator: "IS_BELOW",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

const SECTOR_RSI_ABOVE_50: StrategyCondition = {
  id: "c-sector-rsi-above",
  metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: STOCK_SECTOR },
  operator: "IS_ABOVE",
  value: { kind: "NUMBER", value: 50 },
};

const SECTOR_RSI_BELOW_50: StrategyCondition = {
  ...SECTOR_RSI_ABOVE_50,
  id: "c-sector-rsi-below",
  operator: "IS_BELOW",
};

/**
 * The frozen sectors, written out by hand rather than through the mapping under test: what the API
 * stores on each snapshot security for a strategy that reads Stock's Sector.
 */
const TECHNOLOGY: BacktestSnapshotSecuritySector = { name: "Technology", etfCode: "ETF_XLK" };
const FINANCIALS: BacktestSnapshotSecuritySector = {
  name: "Financial Services",
  etfCode: "ETF_XLF",
};
const ENERGY: BacktestSnapshotSecuritySector = { name: "Energy", etfCode: "ETF_XLE" };
const COMMUNICATION: BacktestSnapshotSecuritySector = {
  name: "Communication Services",
  etfCode: "ETF_XLC",
};
const NO_SECTOR: BacktestSnapshotSecuritySector = { name: null, etfCode: null };
const UNSUPPORTED: BacktestSnapshotSecuritySector = {
  name: "Conglomerates",
  etfCode: null,
};

/**
 * `[symbol, date, action]`, ordered, for comparing whole multi-stock trade lists; the terminal
 * liquidation (a SELL whose source is the end of the run) reads `END_OF_BACKTEST`.
 */
function tradesBySymbol(result: BacktestResult): [string, string, string][] {
  return result.trades
    .map((trade): [string, string, string] => [
      trade.symbol,
      trade.date,
      trade.source === "END_OF_BACKTEST" ? "END_OF_BACKTEST" : trade.action,
    ])
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

function historyReads(etfLoader: FixtureEtfContexts): string[] {
  return etfLoader.calls
    .filter((call) => call.startsWith("readFullBenchmarkHistory:"))
    .sort();
}

describe("Stock's Sector conditions executed by the backtest worker", () => {
  it("reads each stock's own sector ETF in BUY and FINAL EXIT beside a stock rule and a named-ETF SELL", async () => {
    // Six stocks of one list: two Technology (XLK, rising), one Financial Services (XLF, falling),
    // one Energy (XLE, rising until its step-down on 2024-05-06), one with no sector, one whose
    // sector is not one of the eleven. The second stock's own RSI clears 50 only from May.
    const [, second] = securitiesOf(6);
    const { result, write, etfLoader, loader } = await execute(
      leveledStrategy({
        buy: [STOCK_RSI_ABOVE_50, SECTOR_PRICE_ABOVE_SMA20],
        sell: [GLD_RVOL_ABOVE_1_5],
        finalExit: [SECTOR_PRICE_BELOW_SMA20],
      }),
      {
        frozenSectors: [TECHNOLOGY, TECHNOLOGY, FINANCIALS, ENERGY, NO_SECTOR, UNSUPPORTED],
        stockRsi: (date, securityId) =>
          date >= (securityId === second!.id ? "2024-05-01" : "2024-04-01") ? 60 : 40,
      },
    );

    // Hand-derived per stock, from the funds' constructions alone:
    // - ALFA (XLK): buys on the stock rule's first session — a rising close is above its SMA 20D —
    //   sells half on the first GLD spike after, never exits (XLK is never below), and is
    //   liquidated at the end.
    // - ALF1 (XLK): the same fund, its own stock rule: buys on 1 May, sells on the 15 May spike.
    // - ALF2 (XLF): a falling close is never above its SMA 20D, so on the very sessions ALFA buys
    //   under the same rule, it does not — never.
    // - ALF3 (XLE): buys and sells like ALFA, then exits on XLE's step-down session.
    // - ALF4 (no sector) and ALF5 (unsupported): their Stock's Sector rule is never evaluable.
    expect(tradesBySymbol(result)).toEqual(
      [
        ["ALFA", "2024-04-01", "BUY"],
        ["ALFA", "2024-04-10", "SELL"],
        ["ALFA", END, "END_OF_BACKTEST"],
        ["ALF1", "2024-05-01", "BUY"],
        ["ALF1", "2024-05-15", "SELL"],
        ["ALF1", END, "END_OF_BACKTEST"],
        ["ALF3", "2024-04-01", "BUY"],
        ["ALF3", "2024-04-10", "SELL"],
        ["ALF3", XLE_STEP_DOWN, "FINAL_EXIT"],
      ].sort((left, right) => left.join("|").localeCompare(right.join("|"))),
    );

    // Four funds read, each once: XLK for two stocks, XLF and XLE for one each, GLD for the SELL
    // rule. Nothing for the two stocks without a sector ETF, and never a substitute such as SPY.
    expect(historyReads(etfLoader)).toEqual([
      "readFullBenchmarkHistory:series-gld",
      "readFullBenchmarkHistory:series-xle",
      "readFullBenchmarkHistory:series-xlf",
      "readFullBenchmarkHistory:series-xlk",
    ]);
    expect(write.etfConditions?.map((row) => [row.ticker, row.status])).toEqual([
      ["GLD", "READY"],
      ["XLE", "READY"],
      ["XLF", "READY"],
      ["XLK", "READY"],
    ]);
    // The per-security loads stayed the stock's own operands: no sector column is loaded per stock.
    for (const operands of loader.operands) {
      expect([...operands]).toEqual(["price", "series:RSI_14D"]);
    }
  });

  it("trades exactly as the explicit fund does: Stock's Sector of a Technology stock is XLK", async () => {
    // The equivalence oracle: for a stock of each sector, a strategy whose BUY, SELL and FINAL EXIT
    // read Stock's Sector must trade identically, to the share and the cent, to the same strategy
    // naming that stock's sector ETF outright.
    const facts = (result: BacktestResult) =>
      result.trades.map(({ date, action, source, shares, price }) => ({
        date,
        action,
        source,
        shares,
        price,
      }));
    for (const [frozen, code] of [
      [TECHNOLOGY, "ETF_XLK"],
      [FINANCIALS, "ETF_XLF"],
      [ENERGY, "ETF_XLE"],
      [COMMUNICATION, "ETF_XLC"],
    ] as const) {
      const named = { kind: "ETF", code } as const;
      const withSource = (
        condition: StrategyCondition,
        source: typeof STOCK_SECTOR | typeof named,
      ): StrategyCondition =>
        ({
          ...condition,
          metric: { ...condition.metric, source },
        }) as StrategyCondition;
      const shape = (source: typeof STOCK_SECTOR | typeof named) =>
        leveledStrategy({
          buy: [STOCK_RSI_ABOVE_50, withSource(SECTOR_PRICE_ABOVE_SMA20, source)],
          sell: [withSource(SECTOR_RSI_BELOW_50, source)],
          finalExit: [withSource(SECTOR_PRICE_BELOW_SMA20, source)],
        });
      const bySector = await execute(shape(STOCK_SECTOR), {
        frozenSectors: [frozen],
        stockRsi: STOCK_RSI_APRIL_ONLY,
      });
      const byName = await execute(shape(named), { stockRsi: STOCK_RSI_APRIL_ONLY });
      expect(facts(bySector.result), code).toEqual(facts(byName.result));
      expect(bySector.write.etfConditions).toEqual(byName.write.etfConditions);
    }
  });

  it("degrades only the stocks whose sector ETF cannot be read, and records why", async () => {
    // XLF is falling, so its RSI is 0 and a Financial Services stock's "below 50" rule holds on
    // every period session; XLK is rising, so a Technology stock's never does.
    const control = await execute(strategyOf([SECTOR_RSI_BELOW_50]), {
      frozenSectors: [TECHNOLOGY, FINANCIALS],
      stockRsi: () => 10,
    });
    expect(tradesBySymbol(control.result).filter(([, , action]) => action === "BUY")).toEqual([
      ["ALF1", START, "BUY"],
    ]);

    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-xlf", {
      bars: XLF_BARS,
      missingFromFloor: [{ from: "1993-01-01", to: "2023-12-29" }],
    });
    const { result, write } = await execute(strategyOf([SECTOR_RSI_BELOW_50]), {
      frozenSectors: [TECHNOLOGY, FINANCIALS],
      stockRsi: () => 10,
      etfFixtures: fixtures,
    });
    expect(result.trades).toEqual([]);
    expect(write.etfConditions).toEqual([
      { code: "ETF_XLF", ticker: "XLF", status: "NOT_BOOTSTRAPPED" },
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

  it("cannot evaluate a stock whose sector ETF lists inside the period before the fund has warmed up", async () => {
    const { result } = await execute(strategyOf([SECTOR_RSI_ABOVE_50]), {
      frozenSectors: [COMMUNICATION],
      stockRsi: () => 10,
    });
    expect(XLC_SESSIONS[14]).toBe("2024-04-05");
    expect(strategyTrades(result)[0]).toEqual(["2024-04-05", "BUY"]);
  });

  it("never carries a sector ETF's reading onto a session the fund has no bar for", async () => {
    const fixtures = new Map(READY_ETF_FIXTURES);
    fixtures.set("series-xlk", {
      bars: XLK_BARS.filter((bar) => bar.date !== GLD_SPIKES[0]),
    });
    const { result } = await execute(
      strategyOf([SECTOR_RSI_ABOVE_50, GLD_RVOL_ABOVE_1_5]),
      { frozenSectors: [TECHNOLOGY], etfFixtures: fixtures, stockRsi: () => 10 },
    );
    expect(strategyTrades(result)).toEqual([[GLD_SPIKES[1], "BUY"]]);
  });

  it("reads the sector the snapshot froze, never the catalog's current one", async () => {
    // Submitted when the stock was Financial Services; reclassified as Technology before the worker
    // ran. XLF's falling close is never above its SMA 20D; XLK's rising one always is — so a run
    // that consulted the catalog would buy on the first session.
    const frozenRun = await execute(strategyOf([SECTOR_PRICE_ABOVE_SMA20]), {
      frozenSectors: [FINANCIALS],
      catalogSectors: ["Technology"],
      stockRsi: () => 10,
    });
    expect(frozenRun.result.trades).toEqual([]);
    expect(historyReads(frozenRun.etfLoader)).toEqual([
      "readFullBenchmarkHistory:series-xlf",
    ]);

    // The next submission freezes the new classification, and that run reads the new fund.
    const resubmitted = await execute(strategyOf([SECTOR_PRICE_ABOVE_SMA20]), {
      frozenSectors: [TECHNOLOGY],
      catalogSectors: ["Technology"],
      stockRsi: () => 10,
    });
    expect(strategyTrades(resubmitted.result)[0]).toEqual([START, "BUY"]);
    expect(historyReads(resubmitted.etfLoader)).toEqual([
      "readFullBenchmarkHistory:series-xlk",
    ]);
  });

  it("never lets a stock without a sector ETF trade on another fund's reading", async () => {
    // XLK is the only fund this run reads, and its rule holds on every session — so a stock whose
    // sector resolved to no fund would buy at once if its rule were read from any fund at all.
    const { result, etfLoader } = await execute(strategyOf([SECTOR_PRICE_ABOVE_SMA20]), {
      frozenSectors: [NO_SECTOR, UNSUPPORTED, TECHNOLOGY],
      stockRsi: () => 10,
    });
    expect(tradesBySymbol(result).filter(([, , action]) => action === "BUY")).toEqual([
      ["ALF2", START, "BUY"],
    ]);
    expect(historyReads(etfLoader)).toEqual(["readFullBenchmarkHistory:series-xlk"]);
  });

  it("is deterministic: the same snapshot executed twice persists the same result", async () => {
    const run = () =>
      execute(
        leveledStrategy({
          buy: [STOCK_RSI_ABOVE_50, SECTOR_PRICE_ABOVE_SMA20],
          sell: [GLD_RVOL_ABOVE_1_5],
          finalExit: [SECTOR_PRICE_BELOW_SMA20],
        }),
        {
          frozenSectors: [TECHNOLOGY, FINANCIALS, ENERGY, NO_SECTOR],
          stockRsi: STOCK_RSI_APRIL_ONLY,
        },
      );
    const first = await run();
    const second = await run();
    expect(second.result.trades).toEqual(first.result.trades);
    expect(second.write.etfConditions).toEqual(first.write.etfConditions);
  });

  it("shares one read between a named XLK rule and the Technology stocks' Stock's Sector rules", async () => {
    const { result, etfLoader } = await execute(
      strategyOf([XLK_RSI_ABOVE_50, SECTOR_PRICE_ABOVE_SMA20]),
      { frozenSectors: [TECHNOLOGY, FINANCIALS, TECHNOLOGY], stockRsi: () => 10 },
    );
    // The named XLK rule holds for everyone; the sector rule only for the Technology stocks.
    expect(
      tradesBySymbol(result).filter(([, , action]) => action === "BUY"),
    ).toEqual([
      ["ALF2", START, "BUY"],
      ["ALFA", START, "BUY"],
    ]);
    expect(historyReads(etfLoader)).toEqual([
      "readFullBenchmarkHistory:series-xlf",
      "readFullBenchmarkHistory:series-xlk",
    ]);
  });
});

describe("the snapshot parse fails closed on Stock's Sector freezes it cannot honour", () => {
  const definition = strategyOf([SECTOR_RSI_ABOVE_50]);
  const [alfa, alf1] = securitiesOf(2);
  const pins = (...codes: string[]) =>
    ETF_SERIES_PINS.filter((pin) => codes.includes(pin.code));

  it("accepts a whole, consistent freeze with exactly the resolved funds pinned", () => {
    expect(() =>
      parseRunSnapshot(
        snapshotOf(definition, pins("ETF_XLK", "ETF_XLF"), [alfa!, alf1!], [
          TECHNOLOGY,
          FINANCIALS,
        ]),
      ),
    ).not.toThrow();
    // No resolved fund at all is still a whole freeze: nothing to pin, every rule not evaluable.
    expect(() =>
      parseRunSnapshot(
        snapshotOf(definition, [], [alfa!, alf1!], [NO_SECTOR, UNSUPPORTED]),
      ),
    ).not.toThrow();
  });

  it("refuses a security with no frozen sector when the definition reads Stock's Sector", () => {
    const snapshot = snapshotOf(definition, pins("ETF_XLK"), [alfa!, alf1!], [TECHNOLOGY, TECHNOLOGY]);
    delete (snapshot.securities[1] as { sector?: unknown }).sector;
    expect(() => parseRunSnapshot(snapshot)).toThrow(
      /securities\[1\]\.sector does not say which sector ETF/,
    );
  });

  it("refuses a frozen sector on a definition that reads none", () => {
    expect(() =>
      parseRunSnapshot(
        snapshotOf(strategyOf([STOCK_RSI_ABOVE_50]), [], [alfa!], [TECHNOLOGY]),
      ),
    ).toThrow(/reads no Stock's Sector rule/);
  });

  it("refuses a freeze that contradicts the mapping, or names a fund no sector maps to", () => {
    expect(() =>
      parseRunSnapshot(
        snapshotOf(definition, pins("ETF_XLF"), [alfa!], [
          { name: "Technology", etfCode: "ETF_XLF" },
        ]),
      ),
    ).toThrow(/maps to ETF_XLK/);
    expect(() =>
      parseRunSnapshot(
        snapshotOf(definition, pins("SP500"), [alfa!], [
          { name: "Conglomerates", etfCode: "SP500" },
        ]),
      ),
    ).toThrow(/maps to null/);
    expect(() =>
      parseRunSnapshot(
        snapshotOf(definition, [], [alfa!], [
          { name: 7, etfCode: null } as unknown as BacktestSnapshotSecuritySector,
        ]),
      ),
    ).toThrow(/does not say which sector ETF/);
  });

  it("refuses a resolved sector fund the snapshot pins no series for, and a pin nothing reads", () => {
    expect(() =>
      parseRunSnapshot(snapshotOf(definition, pins("ETF_XLK"), [alfa!, alf1!], [TECHNOLOGY, FINANCIALS])),
    ).toThrow(/reads ETF_XLF but snapshot.etfSeries pins no series/);
    expect(() =>
      parseRunSnapshot(snapshotOf(definition, pins("ETF_XLK", "ETF_XLE"), [alfa!], [TECHNOLOGY])),
    ).toThrow(/pins ETF_XLE, which the definition does not read/);
  });

  it("refuses a forged Stock's Sector source and a Stock's Sector trigger", () => {
    const forged = strategyOf([
      {
        ...SECTOR_RSI_ABOVE_50,
        metric: {
          kind: "OSCILLATOR",
          seriesId: "RSI_14D",
          source: { kind: "STOCK_SECTOR", code: "ETF_XLK" },
        } as unknown as StrategyCondition["metric"],
      },
    ]);
    expect(() =>
      parseRunSnapshot(snapshotOf(forged, pins("ETF_XLK"), [alfa!], [TECHNOLOGY])),
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
              metric: { kind: "PRICE", source: STOCK_SECTOR },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
          },
        },
      ],
      sellLevels: [],
    };
    expect(() =>
      parseRunSnapshot(snapshotOf(triggered, pins("ETF_XLK"), [alfa!], [TECHNOLOGY])),
    ).toThrow(/Stock's Sector trigger is not part of V1/);
  });
});
