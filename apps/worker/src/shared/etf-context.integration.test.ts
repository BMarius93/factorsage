import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import type { StrategyEtfSourceCode } from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  LocalDate,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  addDays,
  BENCHMARK_TECHNICAL_FIELDS,
  buildBenchmarkTechnicalContext,
  CanonicalBenchmarkDataService,
  createStockDataRedisClient,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  MARKET_OVERVIEW_HISTORY_FLOOR,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
  withEtfOperandColumns,
  type BenchmarkTechnicalSnapshot,
  type LoadCoordinator,
  type RedisCacheClient,
} from "@intrinsic/stock-data";
import {
  createEvaluationFrame,
  etfOperand,
  type OperandKey,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadEtfTechnicalSnapshots,
  type EtfContextLoader,
} from "./etf-context.js";
import { weekdaySessions } from "./etf-context.test-helper.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "ETF context infrastructure tests require TEST_REDIS_URL or REDIS_URL and TEST_DATABASE_URL.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * ETF technical contexts through the real benchmark infrastructure: `loadEtfTechnicalSnapshots`
 * over `CanonicalBenchmarkDataService` on PostgreSQL and Redis, wired exactly as the worker
 * composition wires it (`backtest/composition.ts`) — the four provider-free reads and nothing else.
 *
 * The benchmark reader's own guarantees are proven in `packages/stock-data`
 * (`benchmark-residency.integration.test.ts`). What is proven here is what a Strategy Condition
 * adds on top of it: that the context a run or a Monitor cycle evaluates is the **same numbers**
 * whether Redis is warm, was just lost or cannot be republished; that it follows a price re-base as
 * one generation; that a series without floor-anchored coverage, or a bar the tail watermark has not
 * confirmed, is refused; that nothing on this path ever asks the provider; and that what is read
 * grows with the distinct ETFs named, never with the securities and rules reading them.
 */

const publicationDelayMs = 30 * 60 * 1000;
const logger = createLogger({ service: "worker", level: "silent" });

/** A Friday. 21:00Z is past the 16:00 New York close plus the publication delay. */
const TODAY: LocalDate = "2026-10-09";
const NOW = new Date(`${TODAY}T21:00:00.000Z`);
/** Twenty-one years of sessions: enough for every weekly average, and twenty-two year chunks. */
const FIRST: LocalDate = "2005-01-03";

function weekdays(from: string, to: string): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(date);
    }
  }
  return dates;
}

/** The Monday after `TODAY`: the one session the watermark test adds. */
const NEXT_SESSION: LocalDate = "2026-10-12";
const EVERY_DATE = weekdays(FIRST, NEXT_SESSION);
const INDEX = new Map(EVERY_DATE.map((date, index) => [date, index]));
/** The sessions the fund has traded by `TODAY`: what every test but one bootstraps. */
const DATES = EVERY_DATE.filter((date) => date <= TODAY);

/**
 * A provider holding one deterministic history from `FIRST`, answering exactly the window asked.
 *
 * Only the bootstrap and the refresh may use one. `rebaseAt` is a split the provider has folded
 * in: every close before that date is divided by the ratio, as a split-adjusted series is.
 */
class HistoryProvider implements FmpBenchmarkProviderPort {
  readonly requests: Required<DateRange>[] = [];
  rebaseAt: { date: string; ratio: number } | null = null;
  publishedThrough = TODAY;
  /** A bar the provider lists at another close for now: a mid-session, provisional reading. */
  provisional: { date: string; close: number } | null = null;

  /** `scale` separates one fund's history from another's, so no context can pass for the next. */
  constructor(private readonly scale = 1) {}

  close(date: string): number {
    if (this.provisional?.date === date) {
      return this.provisional.close;
    }
    const index = INDEX.get(date) ?? 0;
    const base =
      this.scale *
      (50 + index * 0.01 + 5 * Math.sin(index / 9) + (index % 7) * 0.3);
    return this.rebaseAt && date < this.rebaseAt.date
      ? Math.round((base / this.rebaseAt.ratio) * 1e6) / 1e6
      : Math.round(base * 1e6) / 1e6;
  }

  bar(seriesId: string, date: string): BenchmarkDailyPrice {
    const close = this.close(date);
    return {
      seriesId,
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000_000 + ((INDEX.get(date) ?? 0) % 13) * 50_000,
    };
  }

  bars(seriesId: string, through = this.publishedThrough): BenchmarkDailyPrice[] {
    return EVERY_DATE.filter((date) => date <= through).map((date) =>
      this.bar(seriesId, date),
    );
  }

  async getBenchmarkDailyPrices(
    _symbol: string,
    seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    const requested = { from: range.from as string, to: range.to as string };
    this.requests.push(requested);
    return this.bars(seriesId).filter(
      (bar) => bar.date >= requested.from && bar.date <= requested.to,
    );
  }
}

/** The provider the evaluation path is given: any request at all is the defect under test. */
class RefusingProvider implements FmpBenchmarkProviderPort {
  readonly requests: string[] = [];

  async getBenchmarkDailyPrices(
    symbol: string,
    _seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests.push(`${symbol} ${range.from}..${range.to}`);
    throw new Error("Strategy evaluation must never ask the market-data provider");
  }
}

/** Counts the year chunks reads ask Redis for. */
class CountingClient extends IoredisCacheClient {
  chunkReads = 0;
  override async mget(...keys: string[]) {
    this.chunkReads += keys.length;
    return super.mget(...keys);
  }
}

describeInfrastructure("ETF technical contexts over PostgreSQL and Redis", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const namespace = `benchmark:test:etfctx:${suffix}`;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
  const client = new CountingClient(redis);
  const store = new PrismaBenchmarkDataStore(prisma);
  const cache = new RedisBenchmarkDataCache(client as RedisCacheClient, {
    namespace,
  });
  /** Throwaway series, each standing in for one catalog ETF by code. */
  const FUNDS = [
    { code: "ETF_XLK", scale: 1 },
    { code: "ETF_XLF", scale: 2 },
    { code: "ETF_GLD", scale: 3 },
  ] as const satisfies readonly { code: StrategyEtfSourceCode; scale: number }[];
  const catalogCodes = FUNDS.map((fund) => `CTX${fund.code}${suffix}`);
  const seriesByCode = new Map<StrategyEtfSourceCode, BenchmarkSeries>();
  const refusing = new RefusingProvider();

  function service(
    provider: FmpBenchmarkProviderPort,
    now = NOW,
    coordinator: LoadCoordinator = new InMemoryLoadCoordinator(),
  ): CanonicalBenchmarkDataService {
    return new CanonicalBenchmarkDataService(store, provider, cache, coordinator, {
      now: () => now,
    });
  }

  /** The worker composition's own slice of the service: four reads, and no hydration method. */
  function loaderOver(
    benchmarks: CanonicalBenchmarkDataService,
    calls: string[] = [],
  ): EtfContextLoader {
    return {
      getSeries: (seriesId) => {
        calls.push(`getSeries:${seriesId}`);
        return benchmarks.getSeries(seriesId);
      },
      readFullBenchmarkHistory: (series, through) => {
        calls.push(`readFullBenchmarkHistory:${series.id}`);
        return benchmarks.readFullBenchmarkHistory(series, through);
      },
      benchmarkRefreshState: (series) => {
        calls.push(`benchmarkRefreshState:${series.id}`);
        return benchmarks.benchmarkRefreshState(series);
      },
      missingBenchmarkCoverage: (series, period) => {
        calls.push(`missingBenchmarkCoverage:${series.id}`);
        return benchmarks.missingBenchmarkCoverage(series, period);
      },
    };
  }

  function seriesOf(code: StrategyEtfSourceCode): BenchmarkSeries {
    return seriesByCode.get(code)!;
  }

  /** Loads the contexts of the given funds the way a run does, on the evaluation path only. */
  async function load(
    codes: readonly StrategyEtfSourceCode[],
    options: {
      now?: Date;
      coordinator?: LoadCoordinator;
      calls?: string[];
    } = {},
  ) {
    return loadEtfTechnicalSnapshots({
      series: codes.map((code) => ({ code, seriesId: seriesOf(code).id })),
      loader: loaderOver(
        service(refusing, options.now ?? NOW, options.coordinator),
        options.calls,
      ),
      now: options.now ?? NOW,
      publicationDelayMs,
      isScheduledSession: weekdaySessions,
      logger,
    });
  }

  /**
   * The bootstrap: every bar from the history floor to today, as
   * `pnpm benchmarks:prewarm --group market-overview` loads it.
   */
  async function bootstrap(
    code: StrategyEtfSourceCode,
    provider = new HistoryProvider(
      FUNDS.find((fund) => fund.code === code)?.scale,
    ),
    now = NOW,
  ): Promise<HistoryProvider> {
    // Asked through today whatever the provider has published: a read that reaches today is what
    // records the tail watermark, exactly as the bootstrap and every refresh after it do.
    await service(provider, now).ensureBenchmarkHydrated(seriesOf(code), {
      from: MARKET_OVERVIEW_HISTORY_FLOOR,
      to: now.toISOString().slice(0, 10),
    });
    return provider;
  }

  /** The context the product's own builder computes from bars held in memory: no storage at all. */
  function contextFromBars(
    seriesId: string,
    rows: BenchmarkDailyPrice[],
    basisGeneration = 0,
  ): BenchmarkTechnicalSnapshot {
    const context = buildBenchmarkTechnicalContext({
      seriesId,
      history: { seriesId, basisGeneration, rows, missing: [], source: "POSTGRESQL" },
      refreshState: { lastTailSyncAt: NOW.toISOString() },
      missingFromFloor: [],
      now: NOW,
      publicationDelayMs,
    });
    if (context.status !== "READY") {
      throw new Error(`Expected a READY context, got ${context.status}`);
    }
    return context.snapshot;
  }

  /** Bit-for-bit: the same sessions, the same close and the same twenty columns. */
  function expectSameSnapshot(
    actual: BenchmarkTechnicalSnapshot | undefined,
    expected: BenchmarkTechnicalSnapshot,
  ): void {
    expect(actual).toBeDefined();
    if (!actual) {
      return;
    }
    expect(actual.dates).toEqual(expected.dates);
    expect(actual.basisGeneration).toBe(expected.basisGeneration);
    expect(actual.latestSession).toBe(expected.latestSession);
    expect(Buffer.from(actual.closes.buffer)).toEqual(
      Buffer.from(expected.closes.buffer),
    );
    expect(BENCHMARK_TECHNICAL_FIELDS).toHaveLength(20);
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      const column = actual.columns.get(field);
      const wanted = expected.columns.get(field);
      expect(column, field).toBeDefined();
      // Compared as bytes, so NaN warm-up positions must match as exactly as the values do.
      expect(Buffer.from(column!.buffer), field).toEqual(
        Buffer.from(wanted!.buffer),
      );
    }
  }

  async function clearRedis(): Promise<void> {
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async function resetSeries(target: BenchmarkSeries): Promise<void> {
    const where = { seriesId: target.id };
    await prisma.benchmarkDailyPrice.deleteMany({ where });
    await prisma.benchmarkDatasetCoverage.deleteMany({ where });
    await prisma.benchmarkDatasetState.deleteMany({ where });
    await prisma.benchmarkSeriesPriceBasis.deleteMany({ where });
    await prisma.benchmarkPriceBasisEvent.deleteMany({ where });
  }

  beforeAll(async () => {
    await redis.ping();
    const reconciled = await store.reconcileBenchmarkCatalog(
      catalogCodes.map((code, index) => ({
        code,
        name: code,
        sourceKind: "FMP_SYMBOL" as const,
        seriesType: "ETF_PROXY" as const,
        providerSymbol: `C${index}${suffix}`,
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        isBacktestSelectable: false,
        displayOrder: 99,
      })),
    );
    FUNDS.forEach((fund, index) => {
      seriesByCode.set(
        fund.code,
        reconciled.find((row) => row.code === catalogCodes[index])!.series,
      );
    });
  });

  beforeEach(async () => {
    await clearRedis();
    for (const series of seriesByCode.values()) {
      await resetSeries(series);
    }
    client.chunkReads = 0;
    refusing.requests.length = 0;
  });

  afterAll(async () => {
    await clearRedis();
    redis.disconnect();
    await prisma.benchmark.deleteMany({ where: { code: { in: catalogCodes } } });
    await prisma.$disconnect();
  });

  it("computes a context from the resident projection with no provider request, equal to one computed from the provider's own bars", async () => {
    const provider = await bootstrap("ETF_XLK");
    const series = seriesOf("ETF_XLK");

    const { snapshots, diagnostics } = await load(["ETF_XLK"]);

    expect(refusing.requests).toEqual([]);
    expect(diagnostics).toEqual([
      {
        code: "ETF_XLK",
        ticker: "XLK",
        status: "READY",
        firstSession: FIRST,
        latestSession: TODAY,
        basisGeneration: 0,
      },
    ]);
    // Served by Redis: the projection the bootstrap published is what was read.
    expect(client.chunkReads).toBeGreaterThan(0);
    // The stored and projected history is the provider's history, to the last bit: what was
    // computed from PostgreSQL and Redis equals what is computed from the same bars in memory.
    const expected = contextFromBars(series.id, provider.bars(series.id));
    expectSameSnapshot(snapshots.get("ETF_XLK"), expected);
    // Every one of the twenty series exists by the end of twenty-one years, the 200-week pair
    // included, and none of them before its own warm-up.
    const snapshot = snapshots.get("ETF_XLK")!;
    const last = snapshot.dates.length - 1;
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      expect(Number.isFinite(snapshot.columns.get(field)![last]), field).toBe(
        true,
      );
      expect(Number.isNaN(snapshot.columns.get(field)![0]), field).toBe(true);
    }
  });

  it("returns the identical context after Redis loses everything, rebuilt from PostgreSQL alone", async () => {
    await bootstrap("ETF_XLK");
    const warm = await load(["ETF_XLK"]);
    const residentBars = (await cache.getHead(seriesOf("ETF_XLK").id))?.head
      .bars;
    expect(residentBars).toBe(DATES.length);

    await clearRedis();
    expect(await cache.getHead(seriesOf("ETF_XLK").id)).toBeNull();

    const cold = await load(["ETF_XLK"]);

    expect(refusing.requests).toEqual([]);
    expect(cold.diagnostics).toEqual(warm.diagnostics);
    expectSameSnapshot(
      cold.snapshots.get("ETF_XLK"),
      warm.snapshots.get("ETF_XLK")!,
    );
    // The read repaired the projection under the hydration lock: the next reader is resident.
    expect((await cache.getHead(seriesOf("ETF_XLK").id))?.head.bars).toBe(
      DATES.length,
    );
  });

  it("returns the identical context from PostgreSQL when the projection cannot be republished", async () => {
    await bootstrap("ETF_XLK");
    const warm = await load(["ETF_XLK"]);
    await clearRedis();
    const busy: LoadCoordinator = {
      run: async () => {
        throw new Error(
          "The operation was unable to achieve a quorum during its retry window.",
        );
      },
    };

    const fallback = await load(["ETF_XLK"], { coordinator: busy });

    expect(refusing.requests).toEqual([]);
    expect(fallback.diagnostics).toEqual(warm.diagnostics);
    expectSameSnapshot(
      fallback.snapshots.get("ETF_XLK"),
      warm.snapshots.get("ETF_XLK")!,
    );
    // Nothing was republished, so this answer really did come from PostgreSQL.
    expect(await cache.getHead(seriesOf("ETF_XLK").id)).toBeNull();
  });

  it("follows a price re-base as one generation: the whole context on the new basis, never a mixture", async () => {
    const EX_DATE = "2026-10-06";
    await bootstrap(
      "ETF_XLK",
      Object.assign(new HistoryProvider(1), { publishedThrough: "2026-10-05" }),
    );
    const series = seriesOf("ETF_XLK");
    const before = await load(["ETF_XLK"]);
    expect(before.diagnostics[0]).toMatchObject({
      status: "READY",
      basisGeneration: 0,
      latestSession: "2026-10-05",
    });
    // What a backtest submitted now would pin: the API reads the same row (`freezeEtfSeries`),
    // and no row means generation 0.
    const pinnedAtSubmission =
      (
        await prisma.benchmarkSeriesPriceBasis.findUnique({
          where: { seriesId: series.id },
        })
      )?.generation ?? 0;
    expect(pinnedAtSubmission).toBe(0);

    // The scheduled refresh — a provider user by design — meets a 4:1 split the provider folded
    // into every earlier bar, and replaces the stored history in one generation.
    const rebased = new HistoryProvider(1);
    rebased.rebaseAt = { date: EX_DATE, ratio: 4 };
    const refresh = await service(rebased).refreshBenchmarkSeries(series, {
      expectedSession: TODAY,
    });
    expect(refresh).toMatchObject({ status: "REBASED", basisGeneration: 1 });

    const after = await load(["ETF_XLK"]);
    // The run reads the basis in force now and reports it, so its result can say it differs from
    // what its submission pinned: the pin's source and the reader agree on the new generation.
    expect(
      (
        await prisma.benchmarkSeriesPriceBasis.findUniqueOrThrow({
          where: { seriesId: series.id },
        })
      ).generation,
    ).toBe(1);
    expect(after.diagnostics[0]?.basisGeneration).not.toBe(pinnedAtSubmission);

    expect(refusing.requests).toEqual([]);
    expect(after.diagnostics).toEqual([
      {
        code: "ETF_XLK",
        ticker: "XLK",
        status: "READY",
        firstSession: FIRST,
        latestSession: TODAY,
        basisGeneration: 1,
      },
    ]);
    // Equal, bit for bit, to a context computed from the re-based history alone.
    expectSameSnapshot(
      after.snapshots.get("ETF_XLK"),
      contextFromBars(series.id, rebased.bars(series.id), 1),
    );
    // And visibly not the old basis: a pre-split close and its moving average are a quarter of
    // what the first context held, while RSI — a ratio of the series to itself — is unchanged.
    const old = before.snapshots.get("ETF_XLK")!;
    const current = after.snapshots.get("ETF_XLK")!;
    const position = old.index.get("2026-09-30")!;
    expect(current.index.get("2026-09-30")).toBe(position);
    expect(current.closes[position]! * 4).toBeCloseTo(old.closes[position]!, 4);
    expect(current.columns.get("sma200d")![position]! * 4).toBeCloseTo(
      old.columns.get("sma200d")![position]!,
      4,
    );
    expect(current.columns.get("rsi14d")![position]).toBeCloseTo(
      old.columns.get("rsi14d")![position]!,
      4,
    );
  });

  it("refuses a series loaded for a recent window only, and does not ask the provider for the rest", async () => {
    // What an on-demand read leaves behind: three years of bars and coverage from their start,
    // not from the history floor. The first stored bar is not provably the fund's first session.
    await service(new HistoryProvider(2)).ensureBenchmarkHydrated(
      seriesOf("ETF_XLF"),
      { from: "2023-10-09", to: TODAY },
    );
    await bootstrap("ETF_XLK");

    const { snapshots, diagnostics } = await load(["ETF_XLF", "ETF_XLK"]);

    expect(refusing.requests).toEqual([]);
    expect(diagnostics.map((row) => [row.ticker, row.status])).toEqual([
      ["XLF", "NOT_BOOTSTRAPPED"],
      ["XLK", "READY"],
    ]);
    // Refused whole — no partial context whose anchor a later, deeper load would move — while the
    // bootstrapped fund beside it is untouched.
    expect(snapshots.has("ETF_XLF")).toBe(false);
    expect(snapshots.has("ETF_XLK")).toBe(true);
    // Still exactly as it was stored: the evaluation path wrote nothing.
    expect(
      await service(refusing).missingBenchmarkCoverage(seriesOf("ETF_XLF"), {
        from: MARKET_OVERVIEW_HISTORY_FLOOR,
        to: TODAY,
      }),
    ).toEqual([{ from: MARKET_OVERVIEW_HISTORY_FLOOR, to: "2023-10-08" }]);
  });

  it("holds back a stored session until the tail watermark proves it was read after it finalized", async () => {
    await bootstrap("ETF_XLK");
    const series = seriesOf("ETF_XLK");
    const intraday = new Date(`${NEXT_SESSION}T15:00:00.000Z`);
    const evening = new Date(`${NEXT_SESSION}T22:00:00.000Z`);
    const published = Object.assign(new HistoryProvider(1), {
      publishedThrough: NEXT_SESSION,
    });
    const finalClose = published.close(NEXT_SESSION);

    // A refresh during Monday's session: the provider already lists a bar for the day, at a
    // price the session has not settled on — read at 11:00 New York. The loader asks only through
    // the EOD cutoff, so that bar is neither requested nor stored
    // (`docs/decisions/eod-finality-v1.md`).
    const midSession = Object.assign(new HistoryProvider(1), {
      publishedThrough: NEXT_SESSION,
      provisional: { date: NEXT_SESSION, close: finalClose * 0.97 },
    });
    await service(midSession, intraday).refreshBenchmarkSeries(series, {
      expectedSession: TODAY,
    });
    expect(await store.getLatestDailyPriceDate(series.id)).toBe(TODAY);
    expect(
      midSession.requests.every((request) => request.to < NEXT_SESSION),
    ).toBe(true);

    // A loader from before that rule did store it, read mid-session: the row is in storage, but
    // its watermark predates the session's finalization.
    await prisma.benchmarkDailyPrice.create({
      data: {
        seriesId: series.id,
        date: new Date(`${NEXT_SESSION}T00:00:00.000Z`),
        open: finalClose * 0.97,
        high: finalClose * 0.97,
        low: finalClose * 0.97,
        close: finalClose * 0.97,
        volume: 1_000_000n,
      },
    });
    expect(await store.getLatestDailyPriceDate(series.id)).toBe(NEXT_SESSION);

    // Monday evening: the session has closed, the delay has passed and a Monday bar is stored —
    // but nothing has read the tail since it finalized. The clock is not evidence: Friday is
    // still the newest session a condition may read, and the provisional price is in no context.
    const unconfirmed = await load(["ETF_XLK"], { now: evening });
    expect(unconfirmed.diagnostics[0]).toMatchObject({
      status: "READY",
      latestSession: TODAY,
    });
    expect(unconfirmed.snapshots.get("ETF_XLK")!.index.has(NEXT_SESSION)).toBe(
      false,
    );

    // The evening refresh reads the tail after the session finalized, corrects the bar to its
    // final close and records when it read it.
    await service(published, evening).refreshBenchmarkSeries(series, {
      expectedSession: NEXT_SESSION,
    });

    const confirmed = await load(["ETF_XLK"], { now: evening });
    expect(confirmed.diagnostics[0]).toMatchObject({
      status: "READY",
      latestSession: NEXT_SESSION,
    });
    const snapshot = confirmed.snapshots.get("ETF_XLK")!;
    expect(snapshot.closes[snapshot.index.get(NEXT_SESSION)!]).toBe(finalClose);
    // Coverage is still one unbroken interval from the floor, so the anchor gate holds.
    expect(
      await service(refusing, evening).missingBenchmarkCoverage(series, {
        from: MARKET_OVERVIEW_HISTORY_FLOOR,
        to: NEXT_SESSION,
      }),
    ).toEqual([]);
    expect(refusing.requests).toEqual([]);
  });

  it("reads once per distinct ETF: what is read grows with the funds named, never with who reads them", async () => {
    for (const fund of FUNDS) {
      await bootstrap(fund.code);
    }
    const years = new Set(DATES.map((date) => date.slice(0, 4))).size;
    expect(years).toBe(22);

    // One fund.
    client.chunkReads = 0;
    const oneCalls: string[] = [];
    await load(["ETF_XLK"], { calls: oneCalls });
    const chunksForOne = client.chunkReads;
    expect(oneCalls).toHaveLength(4);
    expect(chunksForOne).toBe(years);

    // Three funds: three times the reads of one, exactly.
    client.chunkReads = 0;
    const calls: string[] = [];
    const { snapshots } = await load(
      FUNDS.map((fund) => fund.code),
      { calls },
    );
    expect(client.chunkReads).toBe(3 * chunksForOne);
    expect(calls).toHaveLength(3 * 4);
    for (const fund of FUNDS) {
      const id = seriesOf(fund.code).id;
      expect(calls.filter((call) => call.endsWith(`:${id}`))).toEqual([
        `getSeries:${id}`,
        `readFullBenchmarkHistory:${id}`,
        `benchmarkRefreshState:${id}`,
        `missingBenchmarkCoverage:${id}`,
      ]);
    }
    // The three contexts are three different funds' numbers, not one read three times.
    const closes = FUNDS.map(
      (fund) => snapshots.get(fund.code)!.closes[DATES.length - 1],
    );
    expect(new Set(closes).size).toBe(3);

    // Two hundred securities, each read by twenty-one rules of each of the three funds: every
    // column is joined from the three contexts already in memory. Not one more read of anything.
    client.chunkReads = 0;
    const sessions = DATES.slice(-252);
    const operandsOf = (code: StrategyEtfSourceCode): OperandKey[] => [
      etfOperand(code, "price"),
      ...[
        "SMA_20D",
        "SMA_50D",
        "SMA_100D",
        "SMA_200D",
        "EMA_20D",
        "EMA_50D",
        "EMA_200D",
        "SMA_20W",
        "SMA_50W",
        "SMA_100W",
        "SMA_200W",
        "EMA_20W",
        "EMA_50W",
        "EMA_200W",
        "RSI_7D",
        "RSI_14D",
        "RSI_21D",
      ].map((id) => etfOperand(code, `series:${id}` as OperandKey)),
      ...[10, 20, 50].map((period) =>
        etfOperand(code, `relative-volume:${period}` as OperandKey),
      ),
    ];
    const operands = FUNDS.flatMap((fund) => operandsOf(fund.code));
    expect(operands).toHaveLength(3 * 21);
    let joinedColumns = 0;
    for (let security = 0; security < 200; security += 1) {
      const frame = withEtfOperandColumns(
        createEvaluationFrame({
          securityId: `security-${security}`,
          symbol: `S${security}`,
          name: `Security ${security}`,
          dates: sessions,
          closes: new Float64Array(sessions.length).fill(100),
          columns: new Map(),
          periodStartIndex: 0,
        }),
        operands,
        snapshots,
      );
      joinedColumns += frame.columns.size;
      // Joined by exact date: the last session's XLK close is the context's own.
      expect(
        frame.columns.get(etfOperand("ETF_XLK", "price"))![sessions.length - 1],
      ).toBe(snapshots.get("ETF_XLK")!.closes[DATES.length - 1]);
    }
    expect(joinedColumns).toBe(200 * 63);
    expect(client.chunkReads).toBe(0);
    expect(refusing.requests).toEqual([]);
  });
});
