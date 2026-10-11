import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { BenchmarkSeries, MarketOverviewEtf } from "@intrinsic/domain";
import { FmpClient } from "@intrinsic/fmp";
import {
  CanonicalBenchmarkDataService,
  createStockDataRedisClient,
  InMemoryLoadCoordinator,
  IoredisCacheClient,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapMarketOverview,
  countingFetch,
} from "./market-overview-bootstrap";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The bootstrap integration test requires TEST_REDIS_URL or REDIS_URL and TEST_DATABASE_URL.",
  );
}
const describeBootstrap = redisUrl ? describe : describe.skip;

/** The provider's page cap: one response holds at most this many rows and drops the oldest. */
const PAGE_CAP = 5_000;
const FLOOR = "1993-01-01";
/** Historical, so a rerun is answered from durable coverage whatever the wall clock says. */
const TO = "2024-12-31";

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += 86_400_000
  ) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(new Date(time).toISOString().slice(0, 10));
    }
  }
  return dates;
}

/**
 * The bootstrap end to end, with only the provider's HTTP endpoint faked.
 *
 * The real `FmpClient` pages the history (the fake honours the provider's 5,000-row cap and drops
 * the oldest rows, as the provider does), the real Prisma store persists it, and the real Redis
 * projection — under an isolated namespace — is published and verified. The fixture benchmarks are
 * test-only catalog rows, never the product's, and are removed afterwards.
 */
describeBootstrap("market-overview bootstrap", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const namespace = `benchmark:test-bootstrap:${suffix}`;
  const prisma = new PrismaClient();
  const store = new PrismaBenchmarkDataStore(prisma);
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );

  const calendarSymbol = `CAL${suffix}`;
  const lateSymbol = `NEW${suffix}`;
  const histories = new Map<string, string[]>([
    // Longer than one page: the walk has to ask twice.
    [calendarSymbol, weekdays("1995-01-02", TO)],
    // Lists in 2018: one page, and a long pre-inception period the provider has nothing for.
    [lateSymbol, weekdays("2018-06-19", TO)],
  ]);
  const etfs: MarketOverviewEtf[] = [
    {
      ticker: lateSymbol,
      label: "Late listing",
      benchmarkCode: `BOOTNEW${suffix}`,
      listedIn: "2018-06",
    },
    {
      ticker: calendarSymbol,
      label: "Calendar",
      benchmarkCode: `BOOTCAL${suffix}`,
      listedIn: "1995-01",
    },
  ];
  const failing = new Set<string>();
  /** Every row the provider sent, by symbol: what a duplicate would show up in. */
  const sent = new Map<string, number>();

  const providerFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const symbol = url.searchParams.get("symbol") ?? "";
    if (failing.has(symbol)) {
      return new Response("upstream unavailable", { status: 503 });
    }
    const from = url.searchParams.get("from") ?? "0000-01-01";
    const to = url.searchParams.get("to") ?? "9999-12-31";
    const inside = (histories.get(symbol) ?? []).filter(
      (date) => date >= from && date <= to,
    );
    // Newest first and capped, as the provider answers.
    const page = inside.slice(-PAGE_CAP).reverse();
    sent.set(symbol, (sent.get(symbol) ?? 0) + page.length);
    return new Response(
      JSON.stringify(
        page.map((date, index) => ({
          date,
          open: 100 + index * 0.01,
          high: 101 + index * 0.01,
          low: 99 + index * 0.01,
          close: 100 + index * 0.01,
          volume: 1_000,
        })),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  function loader(http: ReturnType<typeof countingFetch>) {
    return new CanonicalBenchmarkDataService(
      store,
      new FmpClient(
        () => ({
          apiKey: "test-only",
          timeoutMs: 5_000,
          baseUrl: "https://provider.test/stable/",
          maxRetries: 0,
        }),
        http.fetch,
      ),
      new RedisBenchmarkDataCache(new IoredisCacheClient(redis), { namespace }),
      new InMemoryLoadCoordinator(),
    );
  }

  async function seriesOf(code: string): Promise<BenchmarkSeries> {
    const benchmark = await store.findBenchmarkByCode(code);
    if (!benchmark) {
      throw new Error(`fixture ${code} is missing`);
    }
    return benchmark.series;
  }

  beforeAll(async () => {
    await store.reconcileBenchmarkCatalog(
      etfs.map((etf, index) => ({
        code: etf.benchmarkCode,
        name: `Bootstrap fixture ${etf.ticker}`,
        sourceKind: "FMP_SYMBOL" as const,
        seriesType: "ETF_PROXY" as const,
        providerSymbol: etf.ticker,
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        // Never selectable: a fixture must not appear in `GET /benchmarks`.
        isBacktestSelectable: false,
        displayOrder: 900 + index,
      })),
    );
  });

  afterAll(async () => {
    await prisma.benchmark.deleteMany({
      where: { code: { in: etfs.map((etf) => etf.benchmarkCode) } },
    });
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();
    await prisma.$disconnect();
  });

  it("loads every history to inception, pages the provider, isolates a failure, and resumes without re-asking", async () => {
    // First run: the late listing's provider is down.
    failing.add(lateSymbol);
    const firstHttp = countingFetch(providerFetch);
    const first = await bootstrapMarketOverview({
      benchmarks: loader(firstHttp),
      from: FLOOR,
      to: TO,
      etfs,
      calendarCode: `BOOTCAL${suffix}`,
      providerRequestsFor: (symbol) => firstHttp.requestsFor(symbol),
    });

    const calendarBars = histories.get(calendarSymbol)?.length ?? 0;
    expect(calendarBars).toBeGreaterThan(PAGE_CAP);
    // The calendar loads first even though it is listed second.
    expect(first.reports.map((report) => report.ticker)).toEqual([
      calendarSymbol,
      lateSymbol,
    ]);
    expect(first.reports[0]).toMatchObject({
      status: "OK",
      firstBar: "1995-01-02",
      lastBar: TO,
      bars: calendarBars,
      preInception: { from: FLOOR, to: "1995-01-01" },
      missingCoverage: [],
      // Two pages: the provider's cap is real, and the walk reaches inception.
      providerHttpRequests: 2,
      residency: "RESIDENT",
    });
    expect(first.reports[1]).toMatchObject({ status: "FAILED", bars: 0 });
    expect(first.failed).toBe(1);

    // PostgreSQL holds exactly one row per session.
    const calendar = await seriesOf(`BOOTCAL${suffix}`);
    expect(
      await prisma.benchmarkDailyPrice.count({
        where: { seriesId: calendar.id },
      }),
    ).toBe(calendarBars);

    // Second run, provider recovered: only the series that failed is asked for.
    failing.delete(lateSymbol);
    const secondHttp = countingFetch(providerFetch);
    const second = await bootstrapMarketOverview({
      benchmarks: loader(secondHttp),
      from: FLOOR,
      to: TO,
      etfs,
      calendarCode: `BOOTCAL${suffix}`,
      providerRequestsFor: (symbol) => secondHttp.requestsFor(symbol),
    });

    expect(secondHttp.requestsFor(calendarSymbol)).toBe(0);
    expect(second.reports[0]).toMatchObject({
      status: "OK",
      bars: calendarBars,
      providerHttpRequests: 0,
    });
    const lateBars = histories.get(lateSymbol)?.length ?? 0;
    expect(second.reports[1]).toMatchObject({
      status: "OK",
      firstBar: "2018-06-19",
      lastBar: TO,
      bars: lateBars,
      preInception: { from: FLOOR, to: "2018-06-18" },
      // Checked against the calendar series' sessions, and complete.
      calendarGaps: { count: 0 },
      offCalendarBars: { count: 0 },
      providerHttpRequests: 1,
    });
    expect(second.failed).toBe(0);

    // Third run: nothing is missing and nothing is asked — the pre-inception years included, since
    // durable coverage records that they were asked and came back empty.
    const thirdHttp = countingFetch(providerFetch);
    const third = await bootstrapMarketOverview({
      benchmarks: loader(thirdHttp),
      from: FLOOR,
      to: TO,
      etfs,
      calendarCode: `BOOTCAL${suffix}`,
      providerRequestsFor: (symbol) => thirdHttp.requestsFor(symbol),
    });
    expect(thirdHttp.total()).toBe(0);
    expect(third.reports.map((report) => report.bars)).toEqual([
      calendarBars,
      lateBars,
    ]);

    const late = await seriesOf(`BOOTNEW${suffix}`);
    expect(
      await prisma.benchmarkDailyPrice.count({ where: { seriesId: late.id } }),
    ).toBe(lateBars);
  }, 120_000);

  it("rebuilds the projection from PostgreSQL alone after Redis loses it", async () => {
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    const http = countingFetch(providerFetch);
    const result = await bootstrapMarketOverview({
      benchmarks: loader(http),
      from: FLOOR,
      to: TO,
      etfs,
      calendarCode: `BOOTCAL${suffix}`,
      providerRequestsFor: (symbol) => http.requestsFor(symbol),
    });

    // Rebuilt by the hydration step from PostgreSQL — never the provider — so the residency proof
    // that follows finds it already complete.
    expect(http.total()).toBe(0);
    expect(result.reports.map((report) => report.residency)).toEqual([
      "RESIDENT",
      "RESIDENT",
    ]);
    expect(result.failed).toBe(0);
    const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      namespace,
    });
    for (const etf of etfs) {
      const series = await seriesOf(etf.benchmarkCode);
      const head = await cache.getHead(series.id);
      expect(head?.head.bars).toBe(histories.get(etf.ticker)?.length);
    }
  }, 60_000);
});
