import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadRootEnv } from "@intrinsic/config";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategyLevelKind,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DailyPrice,
  DateRange,
  FinancialStatementDraft,
  LocalDate,
  Security,
  SecurityId,
} from "@intrinsic/domain";
import {
  FmpProviderError,
  FmpRateLimitError,
  type FmpCurrentQuote,
  type FmpCurrentQuoteProviderPort,
  type FmpExchangeCalendarPort,
  type FmpExchangeHoliday,
  type FmpStockProviderPort,
  type MappedFmpProfile,
} from "@intrinsic/fmp";
import { createLogger, type LogLevel } from "@intrinsic/observability";
import {
  CachedTradingCalendar,
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  monitorWindowObservations,
  requiredDailySeries,
  type CurrentObservation,
  type ProviderRequestEvent,
} from "@intrinsic/stock-data";
import type { OperandKey } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { MonitorCycle, type MonitorDataLoader } from "./monitor-cycle.js";
import {
  PrismaMonitorRepository,
  type MonitorRepository,
} from "./monitor-repository.js";

/**
 * Developer-only capacity benchmark for the Monitor cycle.
 *
 * It drives the **production path** — `MonitorCycle`, `PrismaMonitorRepository`,
 * `CanonicalStockDataService` over a real PostgreSQL and a real Redis cache and Redlock — and
 * replaces exactly one boundary, the provider, with a synthetic counting stub. Nothing here is a
 * test double of the code under measurement, so the numbers describe what a deployment would do.
 *
 * It writes only to the dedicated test database (`useTestDatabase`) and to a namespaced Redis key
 * space it removes afterwards. It never touches the development database and never calls FMP.
 *
 * ```bash
 * pnpm --filter @intrinsic/worker bench:monitor -- --scenario=small
 * pnpm --filter @intrinsic/worker bench:monitor -- --scenario=boundary --sizes=50,100,101,200,500
 * pnpm --filter @intrinsic/worker bench:monitor -- --scenario=growing --resident=100 --cycles=3
 * ```
 *
 * Findings and the environment the published numbers were taken in are recorded in
 * `ai/architecture/production-capacity.md`. Do not treat local values as universal.
 */

loadRootEnv();
useTestDatabase();

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Args = {
  scenario: string;
  resident: number;
  cycles: number;
  sizes: number[];
  pool: number | undefined;
  users: number | undefined;
  out: string | undefined;
  logLevel: LogLevel;
  quoteFailure: "" | "429" | "500" | "timeout";
  flushBetweenCycles: boolean;
  keep: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  return {
    scenario: get("scenario") ?? "small",
    resident: Number(get("resident") ?? "100"),
    cycles: Number(get("cycles") ?? "3"),
    sizes: (get("sizes") ?? "50,100,101,200,500").split(",").map(Number),
    pool: get("pool") === undefined ? undefined : Number(get("pool")),
    users: get("users") === undefined ? undefined : Number(get("users")),
    out: get("out"),
    logLevel: (get("log") ?? "warn") as LogLevel,
    quoteFailure: (get("quote-failure") ?? "") as Args["quoteFailure"],
    flushBetweenCycles: has("flush-between-cycles"),
    keep: has("keep"),
  };
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Clock and calendar
// ---------------------------------------------------------------------------

/** 11:00 New York on Tuesday 2025-06-10: a regular session, one bar after the synthetic history. */
const NOW = new Date("2025-06-10T15:00:00.000Z");
const HISTORY_FROM: LocalDate = "2013-01-02";
const HISTORY_TO: LocalDate = "2025-06-09";

/** Full closures NYSE/NASDAQ observed 2013–2025 (fixed dates plus the movable ones), for realism. */
const FULL_CLOSURES = new Set<LocalDate>([
  ...[
    2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
    2025,
  ].flatMap((year) => [`${year}-01-01`, `${year}-07-04`, `${year}-12-25`]),
  "2013-01-21",
  "2013-02-18",
  "2013-03-29",
  "2013-05-27",
  "2013-09-02",
  "2013-11-28",
  "2014-01-20",
  "2014-02-17",
  "2014-04-18",
  "2014-05-26",
  "2014-09-01",
  "2014-11-27",
  "2015-01-19",
  "2015-02-16",
  "2015-04-03",
  "2015-05-25",
  "2015-09-07",
  "2015-11-26",
  "2016-01-18",
  "2016-02-15",
  "2016-03-25",
  "2016-05-30",
  "2016-09-05",
  "2016-11-24",
  "2017-01-16",
  "2017-02-20",
  "2017-04-14",
  "2017-05-29",
  "2017-09-04",
  "2017-11-23",
  "2018-01-15",
  "2018-02-19",
  "2018-03-30",
  "2018-05-28",
  "2018-09-03",
  "2018-11-22",
  "2018-12-05",
  "2019-01-21",
  "2019-02-18",
  "2019-04-19",
  "2019-05-27",
  "2019-09-02",
  "2019-11-28",
  "2020-01-20",
  "2020-02-17",
  "2020-04-10",
  "2020-05-25",
  "2020-09-07",
  "2020-11-26",
  "2021-01-18",
  "2021-02-15",
  "2021-04-02",
  "2021-05-31",
  "2021-09-06",
  "2021-11-25",
  "2022-01-17",
  "2022-02-21",
  "2022-04-15",
  "2022-05-30",
  "2022-06-20",
  "2022-09-05",
  "2022-11-24",
  "2023-01-16",
  "2023-02-20",
  "2023-04-07",
  "2023-05-29",
  "2023-06-19",
  "2023-09-04",
  "2023-11-23",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-09-02",
  "2024-11-28",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-09-01",
  "2025-11-27",
]);

function tradingDays(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    const date = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !FULL_CLOSURES.has(date)) {
      out.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const TRADING_DAYS = tradingDays(HISTORY_FROM, HISTORY_TO);

// ---------------------------------------------------------------------------
// Synthetic provider
// ---------------------------------------------------------------------------

/** Deterministic per-symbol pseudo-random walk, so a re-run reproduces the same history. */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(
    createHash("sha256").update(seed).digest("hex").slice(0, 8),
    16,
  );
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function synthesizeHistory(symbol: string): DailyPrice[] {
  const random = seededRandom(symbol);
  let price = 20 + random() * 200;
  return TRADING_DAYS.map((date) => {
    const drift = (random() - 0.5) * 0.03;
    const open = price;
    price = Math.max(1, price * (1 + drift));
    const high = Math.max(open, price) * (1 + random() * 0.01);
    const low = Math.min(open, price) * (1 - random() * 0.01);
    return {
      securityId: "",
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(price),
      volume: Math.floor(1_000_000 + random() * 5_000_000),
    };
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type ProviderCounters = {
  dailyPrices: number;
  dailyPriceRows: number;
  profiles: number;
  statements: number;
  quoteBatches: number;
  quoteSymbols: number;
  holidays: number;
};

class SyntheticProvider
  implements
    FmpStockProviderPort,
    FmpCurrentQuoteProviderPort,
    FmpExchangeCalendarPort
{
  readonly counters: ProviderCounters = {
    dailyPrices: 0,
    dailyPriceRows: 0,
    profiles: 0,
    statements: 0,
    quoteBatches: 0,
    quoteSymbols: 0,
    holidays: 0,
  };
  /** Advances per cycle so quotes move and some evaluations transition. */
  cycleIndex = 0;
  private readonly histories = new Map<string, DailyPrice[]>();

  constructor(private readonly failure: Args["quoteFailure"]) {}

  private history(symbol: string): DailyPrice[] {
    let rows = this.histories.get(symbol);
    if (!rows) {
      rows = synthesizeHistory(symbol);
      this.histories.set(symbol, rows);
    }
    return rows;
  }

  /**
   * A profile is returned, not `null`: the loader records a profile sync only when it saved one,
   * and a security the provider cannot profile is re-asked on every hydration. Real listings have
   * a profile, so a benchmark that returned `null` would count a provider request per re-hydration
   * that production would not make.
   */
  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    this.counters.profiles += 1;
    return {
      providerSymbol: symbol,
      security: {
        symbol,
        name: `Bench ${symbol}`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      profile: { description: "Synthetic benchmark security" },
    };
  }

  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    this.counters.dailyPrices += 1;
    const rows = this.history(symbol).filter(
      (row) =>
        (!range.from || row.date >= range.from) &&
        (!range.to || row.date <= range.to),
    );
    this.counters.dailyPriceRows += rows.length;
    return rows.map((row) => ({ ...row, securityId }));
  }

  async getFinancialStatements(): Promise<FinancialStatementDraft[]> {
    this.counters.statements += 1;
    return [];
  }

  async getCurrentQuotes(
    providerSymbols: readonly string[],
  ): Promise<FmpCurrentQuote[]> {
    const batches = Math.ceil(providerSymbols.length / 50);
    this.counters.quoteBatches += batches;
    this.counters.quoteSymbols += providerSymbols.length;
    if (this.failure === "429") {
      throw new FmpRateLimitError(30_000);
    }
    if (this.failure === "500") {
      throw new FmpProviderError("Stock data provider request failed", 500);
    }
    if (this.failure === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      throw new FmpProviderError("Stock data provider request timed out", 504);
    }
    return providerSymbols.map((symbol) => {
      const rows = this.history(symbol);
      const last = rows[rows.length - 1] as DailyPrice;
      const swing = Math.sin(this.cycleIndex * 0.9 + last.close) * 0.02;
      const price = round(last.close * (1 + swing));
      return {
        providerSymbol: symbol,
        price,
        open: last.close,
        dayHigh: Math.max(price, last.close),
        dayLow: Math.min(price, last.close),
        volume: 500_000,
        quotedAt: NOW.toISOString(),
      };
    });
  }

  async getExchangeHolidays(
    _exchangeCode: string,
    from: string,
    to: string,
  ): Promise<FmpExchangeHoliday[]> {
    this.counters.holidays += 1;
    return [...FULL_CLOSURES]
      .filter((date) => date > from && date <= to)
      .map((date) => ({ date, fullClose: true }));
  }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

type StrategyKind =
  | "simple"
  | "two-indicator"
  | "trigger"
  | "long-window"
  | "intrinsic"
  | "multi-level";

let rowCounter = 0;
function rowId(prefix: string): string {
  rowCounter += 1;
  return `${prefix}-${rowCounter}`;
}

/** A raw level row; the canonical normalizer validates the shape, so the bench stays untyped here. */
function level(
  kind: StrategyLevelKind,
  signal: Record<string, unknown>,
  percentage = 25,
): Record<string, unknown> {
  return kind === "FINAL_EXIT"
    ? { id: rowId("exit"), signal }
    : { id: rowId(kind.toLowerCase()), percentage, signal };
}

function definitionOf(kind: StrategyKind): StrategyDefinition {
  const priceAbove = (seriesId: string) => ({
    id: rowId("condition"),
    metric: { kind: "PRICE" as const },
    operator: "IS_ABOVE" as const,
    value: { kind: "SERIES" as const, seriesId: seriesId as never },
  });
  const rsi = (operator: "IS_ABOVE" | "IS_BELOW", value: number) => ({
    id: rowId("condition"),
    metric: { kind: "OSCILLATOR" as const, seriesId: "RSI_14D" as never },
    operator,
    value: { kind: "NUMBER" as const, value },
  });
  const raw: Record<StrategyKind, Record<string, unknown>> = {
    simple: {
      buyLevels: [level("BUY", { conditions: [priceAbove("SMA_50D")] })],
      sellLevels: [],
    },
    "two-indicator": {
      buyLevels: [
        level("BUY", {
          conditions: [priceAbove("SMA_50D"), rsi("IS_BELOW", 70)],
        }),
      ],
      sellLevels: [level("SELL", { conditions: [rsi("IS_ABOVE", 80)] }, 50)],
    },
    trigger: {
      buyLevels: [
        level("BUY", {
          conditions: [],
          trigger: {
            id: rowId("trigger"),
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: { kind: "SERIES", seriesId: "EMA_50D" as never },
          },
        }),
      ],
      sellLevels: [],
    },
    "long-window": {
      buyLevels: [level("BUY", { conditions: [priceAbove("EMA_200D")] })],
      sellLevels: [],
    },
    intrinsic: {
      buyLevels: [
        level("BUY", {
          conditions: [
            {
              id: rowId("condition"),
              metric: {
                kind: "MARGIN_OF_SAFETY",
                sourceId: "DCF_FCFF" as never,
              },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 20 },
            },
          ],
        }),
      ],
      sellLevels: [],
    },
    "multi-level": {
      buyLevels: [
        level("BUY", {
          conditions: [priceAbove("SMA_50D"), rsi("IS_BELOW", 60)],
        }),
        level("BUY", {
          conditions: [priceAbove("SMA_200D"), rsi("IS_BELOW", 40)],
        }),
        level("BUY", {
          conditions: [priceAbove("EMA_200D")],
          trigger: {
            id: rowId("trigger"),
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_20D" as never },
          },
        }),
      ],
      sellLevels: [
        level("SELL", { conditions: [rsi("IS_ABOVE", 75)] }, 50),
        level(
          "SELL",
          {
            conditions: [],
            trigger: {
              id: rowId("trigger"),
              metric: { kind: "PRICE" },
              operator: "CROSSES_BELOW",
              value: { kind: "SERIES", seriesId: "EMA_50D" as never },
            },
          },
          50,
        ),
      ],
      finalExit: level("FINAL_EXIT", {
        conditions: [],
        trigger: {
          id: rowId("trigger"),
          metric: { kind: "PRICE" },
          operator: "CROSSES_BELOW",
          value: { kind: "SERIES", seriesId: "SMA_200D" as never },
        },
      }),
    },
  };
  return normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    ...raw[kind],
  });
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

type PgStats = {
  xact_commit: number;
  tup_returned: number;
  tup_fetched: number;
  tup_inserted: number;
  tup_updated: number;
  tup_deleted: number;
  blks_read: number;
  blks_hit: number;
};

type RedisStats = {
  calls: Record<string, number>;
  inBytes: number;
  outBytes: number;
};

type PhaseTimer = { calls: number; ms: number };

function timer(): PhaseTimer {
  return { calls: 0, ms: 0 };
}

async function timed<T>(phase: PhaseTimer, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    phase.calls += 1;
    phase.ms += performance.now() - started;
  }
}

/** The loader `MonitorCycle` sees, with every method timed. Mirrors the production composition. */
class TimedLoader implements MonitorDataLoader {
  readonly phases = {
    findSecurities: timer(),
    getCurrentObservations: timer(),
    prepare: timer(),
    readFrame: timer(),
  };

  constructor(private readonly stockData: CanonicalStockDataService) {}

  findSecurities(securityIds: readonly SecurityId[]): Promise<Security[]> {
    return timed(this.phases.findSecurities, () =>
      this.stockData.findSecuritiesByIds(securityIds),
    );
  }

  getCurrentObservations(
    securities: readonly Security[],
  ): Promise<Map<SecurityId, CurrentObservation>> {
    return timed(this.phases.getCurrentObservations, () =>
      this.stockData.getCurrentObservations(securities),
    );
  }

  prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    asOf: LocalDate,
  ): Promise<void> {
    return timed(this.phases.prepare, () =>
      this.stockData.prepareMonitorEvaluationData(security, observations, asOf),
    );
  }

  readMonitorEvaluationFrame(
    input: Parameters<MonitorDataLoader["readMonitorEvaluationFrame"]>[0],
  ) {
    return timed(this.phases.readFrame, () =>
      this.stockData.readMonitorEvaluationFrame(input),
    );
  }

  monitorWindowObservations(operands: readonly OperandKey[]): number {
    return monitorWindowObservations(requiredDailySeries(operands));
  }
}

class TimedRepository implements MonitorRepository {
  readonly phases = {
    listActiveMonitors: timer(),
    loadSignalStates: timer(),
    applyTransition: timer(),
    resolveUnvisitedSignals: timer(),
    markScanned: timer(),
  };

  constructor(private readonly inner: MonitorRepository) {}

  listActiveMonitors() {
    return timed(this.phases.listActiveMonitors, () =>
      this.inner.listActiveMonitors(),
    );
  }

  loadSignalStates(monitorId: string) {
    return timed(this.phases.loadSignalStates, () =>
      this.inner.loadSignalStates(monitorId),
    );
  }

  applyTransition(write: Parameters<MonitorRepository["applyTransition"]>[0]) {
    return timed(this.phases.applyTransition, () =>
      this.inner.applyTransition(write),
    );
  }

  resolveUnvisitedSignals(
    input: Parameters<MonitorRepository["resolveUnvisitedSignals"]>[0],
  ) {
    return timed(this.phases.resolveUnvisitedSignals, () =>
      this.inner.resolveUnvisitedSignals(input),
    );
  }

  markScanned(monitorIds: readonly string[], now: Date) {
    return timed(this.phases.markScanned, () =>
      this.inner.markScanned(monitorIds, now),
    );
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
let queryCount = 0;
let queryMs = 0;
prisma.$on("query", (event) => {
  queryCount += 1;
  queryMs += event.duration;
});

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl) {
  throw new Error(
    "REDIS_URL (or TEST_REDIS_URL) is required for the capacity benchmark",
  );
}
const redis = createStockDataRedisClient(redisUrl);
const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const stem = suffix.slice(0, 4).toUpperCase();
const namespace = `stock-data:v2:bench:${suffix}`;
const logger = createLogger({
  service: "worker",
  level: args.logLevel,
  base: { component: "bench" },
});

const provider = new SyntheticProvider(args.quoteFailure);
const providerRequestsByReason: Record<string, number> = {};
const onProviderRequest = (event: ProviderRequestEvent): void => {
  const key = `${event.dataset}:${event.reason}`;
  providerRequestsByReason[key] = (providerRequestsByReason[key] ?? 0) + 1;
};

const store = new PrismaStockDataStore(prisma);
const cache = new RedisStockDataCache(
  new IoredisCacheClient(redis),
  args.resident,
  namespace,
);
const coordinator = new RedlockLoadCoordinator(redis, {
  lockDurationMs: 30_000,
  lockWaitMs: 120_000,
});
const stockData = new CanonicalStockDataService(
  store,
  provider,
  cache,
  coordinator,
  {
    // Eight visible years: long enough for an EMA 200D window plus its warm-up, short enough that
    // a thousand synthetic securities hydrate in minutes rather than hours.
    productHistoryYears: 8,
    now: () => NOW,
    onProviderRequest,
  },
);
const loader = new TimedLoader(stockData);
const repository = new TimedRepository(new PrismaMonitorRepository(prisma));
const calendar = new CachedTradingCalendar(provider, { now: () => NOW });

const createdUserIds: string[] = [];
const createdSecurityIds: string[] = [];

/**
 * PostgreSQL 15+ backends flush their pending statistics at most once a second and only at the end
 * of a transaction, so a 50 ms cycle's counters are invisible until every pooled connection has run
 * another statement. Forcing a flush on as many pooled connections as the pool holds, then waiting
 * for the collector, makes the before/after difference describe the cycle rather than its
 * predecessor.
 */
async function settlePgStats(): Promise<void> {
  await Promise.all(
    Array.from(
      { length: 16 },
      () => prisma.$queryRaw`SELECT pg_stat_force_next_flush()::text`,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function pgStats(): Promise<PgStats> {
  await settlePgStats();
  const rows = await prisma.$queryRaw<Record<keyof PgStats, bigint>[]>`
    SELECT xact_commit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
           blks_read, blks_hit
    FROM pg_stat_database WHERE datname = current_database()
  `;
  const row = rows[0] as Record<keyof PgStats, bigint>;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as PgStats;
}

async function redisStats(): Promise<RedisStats> {
  const calls: Record<string, number> = {};
  for (const line of (await redis.info("commandstats")).split("\n")) {
    const match = /^cmdstat_(\w+):calls=(\d+)/.exec(line.trim());
    if (match) {
      calls[match[1] as string] = Number(match[2]);
    }
  }
  const stats = await redis.info("stats");
  const read = (name: string): number =>
    Number(new RegExp(`(?:^|\\n)${name}:(\\d+)`).exec(stats)?.[1] ?? "0");
  return {
    calls,
    inBytes: read("total_net_input_bytes"),
    outBytes: read("total_net_output_bytes"),
  };
}

function diff(before: PgStats, after: PgStats): PgStats {
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      after[key as keyof PgStats] - before[key as keyof PgStats],
    ]),
  ) as PgStats;
}

function diffRedis(before: RedisStats, after: RedisStats) {
  const calls: Record<string, number> = {};
  for (const [command, count] of Object.entries(after.calls)) {
    const delta = count - (before.calls[command] ?? 0);
    if (delta > 0) {
      calls[command] = delta;
    }
  }
  return {
    calls,
    total: Object.values(calls).reduce((sum, value) => sum + value, 0),
    inBytes: after.inBytes - before.inBytes,
    outBytes: after.outBytes - before.outBytes,
  };
}

function resetPhases(): void {
  for (const phases of [loader.phases, repository.phases]) {
    for (const phase of Object.values(phases)) {
      phase.calls = 0;
      phase.ms = 0;
    }
  }
}

type CycleMeasurement = {
  label: string;
  cycle: number;
  durationMs: number;
  cpuMs: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  heapPeakMb: number;
  summary: Awaited<ReturnType<MonitorCycle["run"]>>;
  pg: PgStats & { queries: number; queryMs: number };
  redis: ReturnType<typeof diffRedis>;
  provider: ProviderCounters;
  providerByReason: Record<string, number>;
  phases: Record<string, PhaseTimer>;
  cacheResident: number;
};

async function measureCycle(
  label: string,
  cycle: number,
): Promise<CycleMeasurement> {
  resetPhases();
  for (const key of Object.keys(providerRequestsByReason)) {
    delete providerRequestsByReason[key];
  }
  const providerBefore = { ...provider.counters };
  const pgBefore = await pgStats();
  const redisBefore = await redisStats();
  const queriesBefore = queryCount;
  const queryMsBefore = queryMs;
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  let heapPeak = process.memoryUsage().heapUsed;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    rssPeak = Math.max(rssPeak, usage.rss);
    heapPeak = Math.max(heapPeak, usage.heapUsed);
  }, 20);

  provider.cycleIndex = cycle;
  const monitorCycle = new MonitorCycle(repository, loader, calendar, logger, {
    symbolConcurrency: 4,
    quoteMaxAgeMs: 4 * 24 * 60 * 60_000,
    now: () => NOW,
  });
  const started = performance.now();
  let summary: Awaited<ReturnType<MonitorCycle["run"]>>;
  try {
    summary = await monitorCycle.run(cycle);
  } finally {
    clearInterval(sampler);
  }
  const durationMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const pgAfter = await pgStats();
  const redisAfter = await redisStats();
  const providerAfter = provider.counters;
  const resident = await redis.zcard(`${namespace}:resident-stocks`);

  const providerDelta = Object.fromEntries(
    Object.keys(providerAfter).map((key) => [
      key,
      providerAfter[key as keyof ProviderCounters] -
        providerBefore[key as keyof ProviderCounters],
    ]),
  ) as ProviderCounters;

  return {
    label,
    cycle,
    durationMs: Math.round(durationMs),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssBeforeMb: Math.round(rssBefore / 1_048_576),
    rssPeakMb: Math.round(rssPeak / 1_048_576),
    heapPeakMb: Math.round(heapPeak / 1_048_576),
    summary,
    pg: {
      ...diff(pgBefore, pgAfter),
      queries: queryCount - queriesBefore,
      queryMs: Math.round(queryMs - queryMsBefore),
    },
    redis: diffRedis(redisBefore, redisAfter),
    provider: providerDelta,
    providerByReason: { ...providerRequestsByReason },
    phases: {
      ...Object.fromEntries(
        Object.entries(loader.phases).map(([key, value]) => [
          key,
          { ...value, ms: Math.round(value.ms) },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(repository.phases).map(([key, value]) => [
          key,
          { ...value, ms: Math.round(value.ms) },
        ]),
      ),
    },
    cacheResident: resident,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createUser(index: number): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `bench-${suffix}-${index}@example.test`,
      emailVerifiedAt: NOW,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function createSecurities(count: number): Promise<Security[]> {
  const rows: Security[] = [];
  const data = Array.from({ length: count }, (_, index) => ({
    providerSymbol: `BENCH${suffix}.${index}`,
    symbol: `B${stem}${index}`,
    name: `Bench ${index}`,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: SecurityType.STOCK,
    isAdr: false,
    isActivelyTrading: true,
  }));
  await prisma.security.createMany({ data });
  const created = await prisma.security.findMany({
    where: { providerSymbol: { startsWith: `BENCH${suffix}.` } },
    orderBy: { symbol: "asc" },
  });
  for (const row of created) {
    createdSecurityIds.push(row.id);
    rows.push({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchangeCode: row.exchangeCode,
      currency: row.currency,
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
    });
  }
  return rows;
}

async function createStrategy(
  userId: string,
  kind: StrategyKind,
): Promise<string> {
  const definition = definitionOf(kind);
  const row = await prisma.strategy.create({
    data: {
      userId,
      name: `${kind} ${suffix}`,
      versions: {
        create: {
          versionNumber: 1,
          definition: definition as never,
          definitionHash: createHash("sha256")
            .update(strategyDefinitionFingerprint(definition))
            .digest("hex"),
        },
      },
    },
  });
  return row.id;
}

async function createMonitor(input: {
  userId: string;
  strategyId: string;
  securities: readonly Security[];
  name: string;
  enabled?: boolean;
}): Promise<string> {
  const list = await prisma.stockList.create({
    data: {
      userId: input.userId,
      name: input.name,
      items: {
        create: input.securities.map((security) => ({
          securityId: security.id,
        })),
      },
    },
  });
  const monitor = await prisma.monitor.create({
    data: {
      userId: input.userId,
      name: input.name,
      strategyId: input.strategyId,
      stockListId: list.id,
      enabled: input.enabled ?? true,
    },
  });
  return monitor.id;
}

async function disableAllBenchMonitors(): Promise<void> {
  await prisma.monitor.updateMany({
    where: { userId: { in: createdUserIds } },
    data: { enabled: false },
  });
}

async function cleanup(): Promise<void> {
  if (args.keep) {
    process.stdout.write(
      `kept fixtures: users ${createdUserIds.length}, securities ${createdSecurityIds.length}, namespace ${namespace}\n`,
    );
    return;
  }
  await disableAllBenchMonitors();
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.security.deleteMany({
    where: { id: { in: createdSecurityIds } },
  });
  const keys = await redis.keys(`${namespace}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type ScenarioSpec = {
  users: number;
  pool: number;
  monitorsPerUser: number;
  listSize: number;
  strategies: StrategyKind[];
  /** How a Monitor's list is drawn from the pool. */
  draw: "shared" | "partial" | "distinct";
};

const SCENARIOS: Record<string, ScenarioSpec> = {
  small: {
    users: 1,
    pool: 10,
    monitorsPerUser: 1,
    listSize: 10,
    strategies: ["simple"],
    draw: "shared",
  },
  normal: {
    users: 10,
    pool: 100,
    monitorsPerUser: 2,
    listSize: 20,
    strategies: ["two-indicator", "trigger"],
    draw: "partial",
  },
  growing: {
    users: 100,
    pool: 500,
    monitorsPerUser: 3,
    listSize: 30,
    strategies: ["simple", "two-indicator", "trigger"],
    draw: "partial",
  },
  stress: {
    users: 50,
    pool: 1_000,
    monitorsPerUser: 4,
    listSize: 40,
    strategies: ["simple", "two-indicator", "trigger", "long-window"],
    draw: "distinct",
  },
  "shared-50": {
    users: 100,
    pool: 50,
    monitorsPerUser: 1,
    listSize: 50,
    strategies: ["two-indicator"],
    draw: "shared",
  },
};

function drawList(
  spec: ScenarioSpec,
  pool: readonly Security[],
  user: number,
  monitor: number,
): Security[] {
  const random = seededRandom(`${suffix}:${user}:${monitor}`);
  if (spec.draw === "shared") {
    return pool.slice(0, spec.listSize);
  }
  if (spec.draw === "distinct") {
    const start =
      ((user * spec.monitorsPerUser + monitor) * spec.listSize) % pool.length;
    return Array.from(
      { length: spec.listSize },
      (_, index) => pool[(start + index) % pool.length] as Security,
    );
  }
  const chosen = new Set<number>();
  while (chosen.size < Math.min(spec.listSize, pool.length)) {
    chosen.add(Math.floor(random() * pool.length));
  }
  return [...chosen].map((index) => pool[index] as Security);
}

async function buildScenario(
  spec: ScenarioSpec,
): Promise<{ securities: Security[]; monitors: number }> {
  const securities = await createSecurities(spec.pool);
  let monitors = 0;
  for (let user = 0; user < spec.users; user += 1) {
    const userId = await createUser(user);
    const strategyIds = new Map<StrategyKind, string>();
    for (let monitor = 0; monitor < spec.monitorsPerUser; monitor += 1) {
      const kind = spec.strategies[
        monitor % spec.strategies.length
      ] as StrategyKind;
      let strategyId = strategyIds.get(kind);
      if (!strategyId) {
        strategyId = await createStrategy(userId, kind);
        strategyIds.set(kind, strategyId);
      }
      await createMonitor({
        userId,
        strategyId,
        securities: drawList(spec, securities, user, monitor),
        name: `u${user} m${monitor} ${kind}`,
      });
      monitors += 1;
    }
  }
  return { securities, monitors };
}

function report(measurement: CycleMeasurement): void {
  const s = measurement.summary;
  const p = measurement.phases;
  const line = [
    `${measurement.label} c${measurement.cycle}`,
    `${measurement.durationMs}ms wall`,
    `${measurement.cpuMs}ms cpu`,
    `mon=${s.monitors} sym=${s.symbols} eval=${s.evaluations} emit=${s.signalsEmitted} res=${s.signalsResolved} ne=${s.notEvaluable} noSnap=${s.symbolsWithoutSnapshot} unch=${s.transitionsUnchanged}`,
    `pg q=${measurement.pg.queries} (${measurement.pg.queryMs}ms) fetched=${measurement.pg.tup_fetched} returned=${measurement.pg.tup_returned} ins=${measurement.pg.tup_inserted} upd=${measurement.pg.tup_updated} del=${measurement.pg.tup_deleted}`,
    `redis cmds=${measurement.redis.total} in=${Math.round(measurement.redis.inBytes / 1024)}KB out=${Math.round(measurement.redis.outBytes / 1024)}KB resident=${measurement.cacheResident}`,
    `provider prices=${measurement.provider.dailyPrices}req/${measurement.provider.dailyPriceRows}rows profiles=${measurement.provider.profiles} stmts=${measurement.provider.statements} quotes=${measurement.provider.quoteBatches}b/${measurement.provider.quoteSymbols}s holidays=${measurement.provider.holidays}`,
    `redis top ${Object.entries(measurement.redis.calls)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([command, count]) => `${command}=${count}`)
      .join(",")}`,
    `phases prep=${p.prepare?.ms}ms frame=${p.readFrame?.ms}ms quotes=${p.getCurrentObservations?.ms}ms states=${p.loadSignalStates?.ms}ms trans=${p.applyTransition?.ms}ms/${p.applyTransition?.calls} sweep=${p.resolveUnvisitedSignals?.ms}ms`,
    `rss ${measurement.rssBeforeMb}->${measurement.rssPeakMb}MB heapPeak=${measurement.heapPeakMb}MB`,
  ].join(" | ");
  process.stdout.write(`${line}\n`);
}

const results: CycleMeasurement[] = [];

async function runCycles(label: string, count = args.cycles): Promise<void> {
  for (let cycle = 1; cycle <= count; cycle += 1) {
    if (args.flushBetweenCycles && cycle > 1) {
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
    const measurement = await measureCycle(label, cycle);
    results.push(measurement);
    report(measurement);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write(
    `capacity bench: scenario=${args.scenario} resident=${args.resident} cycles=${args.cycles} namespace=${namespace}\n`,
  );
  try {
    if (args.scenario === "boundary") {
      const pool = await createSecurities(args.pool ?? Math.max(...args.sizes));
      const userId = await createUser(0);
      const strategyId = await createStrategy(userId, "simple");
      // Warm PostgreSQL coverage for the whole pool once, so every size measures residency alone.
      const warmMonitor = await createMonitor({
        userId,
        strategyId,
        securities: pool,
        name: "warm",
      });
      await runCycles(`warm(${pool.length})`, 1);
      await prisma.monitor.update({
        where: { id: warmMonitor },
        data: { enabled: false },
      });
      for (const size of args.sizes) {
        const monitorId = await createMonitor({
          userId,
          strategyId,
          securities: pool.slice(0, size),
          name: `boundary ${size}`,
        });
        await runCycles(`U=${size}`, args.cycles);
        await prisma.monitor.update({
          where: { id: monitorId },
          data: { enabled: false },
        });
      }
    } else if (args.scenario === "complexity") {
      const pool = await createSecurities(args.pool ?? 100);
      const userId = await createUser(0);
      const kinds: StrategyKind[] = [
        "simple",
        "two-indicator",
        "trigger",
        "long-window",
        "intrinsic",
        "multi-level",
      ];
      const monitorIds = new Map<StrategyKind, string>();
      for (const kind of kinds) {
        monitorIds.set(
          kind,
          await createMonitor({
            userId,
            strategyId: await createStrategy(userId, kind),
            securities: pool,
            name: kind,
            enabled: false,
          }),
        );
      }
      // Warm coverage with the widest window first, so each kind measures its own cost only.
      await prisma.monitor.update({
        where: { id: monitorIds.get("multi-level") as string },
        data: { enabled: true },
      });
      await runCycles("warm(multi-level)", 1);
      await disableAllBenchMonitors();
      for (const kind of kinds) {
        await prisma.monitor.update({
          where: { id: monitorIds.get(kind) as string },
          data: { enabled: true },
        });
        await runCycles(kind, args.cycles);
        await prisma.monitor.update({
          where: { id: monitorIds.get(kind) as string },
          data: { enabled: false },
        });
      }
      await prisma.monitor.updateMany({
        where: { id: { in: [...monitorIds.values()] } },
        data: { enabled: true },
      });
      await runCycles("all-six-together", args.cycles);
    } else {
      const spec = SCENARIOS[args.scenario];
      if (!spec) {
        throw new Error(
          `Unknown scenario ${args.scenario}; known: ${Object.keys(SCENARIOS).join(", ")}, boundary, complexity`,
        );
      }
      const effective = {
        ...spec,
        pool: args.pool ?? spec.pool,
        users: args.users ?? spec.users,
      };
      const built = await buildScenario(effective);
      process.stdout.write(
        `built: users=${effective.users} monitors=${built.monitors} pool=${built.securities.length} listSize=${effective.listSize} draw=${effective.draw}\n`,
      );
      await runCycles(args.scenario, args.cycles);
    }
  } finally {
    await cleanup();
    if (args.out) {
      writeFileSync(
        args.out,
        JSON.stringify(
          {
            args,
            environment: {
              node: process.version,
              platform: process.platform,
              arch: process.arch,
              now: NOW.toISOString(),
            },
            results,
          },
          null,
          2,
        ),
      );
    }
    process.stdout.write(
      `done in ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
    );
    redis.disconnect();
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  logger.fatal({ event: "bench.failed", err });
  process.exitCode = 1;
});
