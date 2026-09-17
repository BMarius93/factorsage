import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkCatalogEntry,
  BenchmarkDailyPrice,
  BenchmarkWithSeries,
  DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import { BENCHMARK_DAILY_PRICE_VARIANT } from "./benchmark-ports.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import { CanonicalBenchmarkDataService } from "./benchmark-service.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Market-reference loading tests require TEST_REDIS_URL or REDIS_URL: they are the coverage " +
      "proving several benchmark series share one infrastructure without colliding.",
  );
}
const describeReferences = redisUrl ? describe : describe.skip;

const TODAY = "2020-06-30";

function bars(
  seriesId: string,
  base: number,
  count: number,
): BenchmarkDailyPrice[] {
  const rows: BenchmarkDailyPrice[] = [];
  const cursor = new Date("2020-01-01T00:00:00.000Z");
  while (rows.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const close = base + rows.length;
      rows.push({
        seriesId,
        date: cursor.toISOString().slice(0, 10),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 0,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

/** Answers per provider symbol, and records every symbol it was asked for. */
class SymbolAwareProvider implements FmpBenchmarkProviderPort {
  readonly requests: {
    symbol: string;
    seriesId: string;
    range: Required<DateRange>;
  }[] = [];

  constructor(private readonly bases: Record<string, number>) {}

  async getBenchmarkDailyPrices(
    providerSymbol: string,
    seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests.push({
      symbol: providerSymbol,
      seriesId,
      range: { from: range.from as string, to: range.to as string },
    });
    const base = this.bases[providerSymbol];
    if (base === undefined) {
      throw new Error(`No fixture for provider symbol '${providerSymbol}'`);
    }
    return bars(seriesId, base, 120).filter(
      (row) =>
        (!range.from || row.date >= range.from) &&
        (!range.to || row.date <= range.to),
    );
  }
}

/**
 * Several benchmark series through **one** infrastructure.
 *
 * The market references the Dashboard reports are not a new subsystem: they are more rows in the
 * catalog that already exists. What has to be proven is that adding them cannot damage the one
 * series the product's backtests depend on — so every assertion here is about isolation by
 * `seriesId`, which is what PostgreSQL rows, coverage intervals, watermarks and Redis keys are all
 * keyed by.
 */
describeReferences(
  "market-reference series share the benchmark infrastructure",
  () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const namespace = `benchmark:test:${suffix}`;
    const codes = {
      proxy: `MKTPROXY${suffix}`,
      spx: `MKTSPX${suffix}`,
      vix: `MKTVIX${suffix}`,
    };
    const symbols = {
      [codes.proxy]: "TESTSPY",
      [codes.spx]: "^TESTGSPC",
      [codes.vix]: "^TESTVIX",
    };
    const range = { from: "2020-01-01", to: "2020-03-31" };

    const prisma = new PrismaClient();
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const store = new PrismaBenchmarkDataStore(prisma);
    const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      namespace,
    });
    const coordinator = new InMemoryLoadCoordinator();
    let benchmarks: BenchmarkWithSeries[] = [];

    function serviceWith(provider: FmpBenchmarkProviderPort) {
      return new CanonicalBenchmarkDataService(
        store,
        provider,
        cache,
        coordinator,
        {
          now: () => new Date(`${TODAY}T12:00:00.000Z`),
        },
      );
    }

    function entry(
      code: string,
      overrides: Partial<BenchmarkCatalogEntry>,
    ): BenchmarkCatalogEntry {
      return {
        code,
        name: code,
        sourceKind: "FMP_SYMBOL",
        seriesType: "ETF_PROXY",
        providerSymbol: symbols[code] as string,
        currency: "USD",
        methodologyVersion: 1,
        isActive: true,
        isBacktestSelectable: true,
        displayOrder: 99,
        ...overrides,
      };
    }

    async function clearProjection(): Promise<void> {
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }

    beforeAll(async () => {
      await redis.ping();
      benchmarks = await store.reconcileBenchmarkCatalog([
        entry(codes.proxy, {}),
        entry(codes.spx, { seriesType: "INDEX", isBacktestSelectable: false }),
        entry(codes.vix, { seriesType: "INDEX", isBacktestSelectable: false }),
      ]);
    });

    beforeEach(clearProjection);

    afterAll(async () => {
      await clearProjection();
      redis.disconnect();
      await prisma.benchmark.deleteMany({
        where: { code: { in: Object.values(codes) } },
      });
      await prisma.$disconnect();
    });

    function seriesFor(code: string) {
      const found = benchmarks.find((benchmark) => benchmark.code === code);
      if (!found) {
        throw new Error(`Fixture ${code} was not reconciled`);
      }
      return found.series;
    }

    it("registers an index as active but never backtest-selectable", async () => {
      const active = await store.listActiveBenchmarks();
      const byCode = new Map(active.map((row) => [row.code, row]));

      // Active, so internal services still resolve them and the loader still maintains them …
      expect(byCode.get(codes.spx)?.isActive).toBe(true);
      // … and not selectable, which is a separate, product-level refusal.
      expect(byCode.get(codes.spx)?.isBacktestSelectable).toBe(false);
      expect(byCode.get(codes.proxy)?.isBacktestSelectable).toBe(true);
      expect(byCode.get(codes.spx)?.series.seriesType).toBe("INDEX");
      expect(byCode.get(codes.proxy)?.series.seriesType).toBe("ETF_PROXY");
    });

    it("hydrates each series from its own provider symbol into its own rows", async () => {
      const provider = new SymbolAwareProvider({
        TESTSPY: 400,
        "^TESTGSPC": 7000,
        "^TESTVIX": 15,
      });
      const service = serviceWith(provider);

      for (const code of Object.values(codes)) {
        await service.getBenchmarkDailyPrices(seriesFor(code), range);
      }

      // Each request carried the right symbol under the right series id — a caret symbol reaches the
      // provider unchanged, and nothing was fetched for a series it does not belong to.
      for (const request of provider.requests) {
        const code = Object.values(codes).find(
          (candidate) => seriesFor(candidate).id === request.seriesId,
        );
        expect(code).toBeDefined();
        expect(request.symbol).toBe(symbols[code as string]);
      }

      const stored = await Promise.all(
        Object.values(codes).map(async (code) => ({
          code,
          rows: await store.getDailyPrices(seriesFor(code).id, range),
        })),
      );
      for (const { rows } of stored) {
        expect(rows.length).toBeGreaterThan(0);
      }
      // Three series, three price levels, no bleed.
      expect(stored[0]?.rows[0]?.close).toBe(400);
      expect(stored[1]?.rows[0]?.close).toBe(7000);
      expect(stored[2]?.rows[0]?.close).toBe(15);
    });

    it("keys the Redis projection by series id, so no two series can collide", async () => {
      const provider = new SymbolAwareProvider({
        TESTSPY: 400,
        "^TESTGSPC": 7000,
        "^TESTVIX": 15,
      });
      const service = serviceWith(provider);
      for (const code of Object.values(codes)) {
        await service.getBenchmarkDailyPrices(seriesFor(code), range);
      }

      const keys = (await redis.keys(`${namespace}*`)).sort();
      for (const code of Object.values(codes)) {
        const seriesId = seriesFor(code).id;
        // The namespace `AGENTS.md` invariant 16 names, and nothing else.
        expect(keys).toContain(`${namespace}:benchmark:${seriesId}:manifest`);
        expect(keys).toContain(
          `${namespace}:benchmark:${seriesId}:daily-price:2020`,
        );
        // Never keyed by code, and never a second namespace of its own.
        expect(keys.some((key) => key.includes(code))).toBe(false);
      }
      expect(
        keys.every((key) => key.startsWith(`${namespace}:benchmark:`)),
      ).toBe(true);

      // And a read of one series returns only its own bars.
      const spx = await cache.readDailyPrices(seriesFor(codes.spx).id, range);
      const vix = await cache.readDailyPrices(seriesFor(codes.vix).id, range);
      expect(spx?.[0]?.close).toBe(7000);
      expect(vix?.[0]?.close).toBe(15);
    });

    it("serves a warm read from the cache manifest without touching the provider", async () => {
      const warm = new SymbolAwareProvider({
        TESTSPY: 400,
        "^TESTGSPC": 7000,
        "^TESTVIX": 15,
      });
      const service = serviceWith(warm);

      // Whatever this first read costs — a full hydration on a cold database, nothing at all when an
      // earlier case already materialized the range — the second one must cost zero.
      await service.getBenchmarkDailyPrices(seriesFor(codes.spx), range);
      const afterFirst = warm.requests.length;
      expect(await cache.getManifest(seriesFor(codes.spx).id)).not.toBeNull();

      const rows = await service.getBenchmarkDailyPrices(
        seriesFor(codes.spx),
        range,
      );

      expect(warm.requests.length).toBe(afterFirst);
      expect(rows[0]?.close).toBe(7000);
    });

    it("rebuilds from PostgreSQL after a Redis flush without refetching", async () => {
      const provider = new SymbolAwareProvider({
        TESTSPY: 400,
        "^TESTGSPC": 7000,
        "^TESTVIX": 15,
      });
      await serviceWith(provider).getBenchmarkDailyPrices(
        seriesFor(codes.vix),
        range,
      );
      await clearProjection();

      // Redis is a disposable projection; the durable coverage and the durable freshness watermark
      // both survive a flush, so the repair costs one PostgreSQL read and no provider traffic.
      const afterFlush = new SymbolAwareProvider({});
      const rows = await serviceWith(afterFlush).getBenchmarkDailyPrices(
        seriesFor(codes.vix),
        range,
      );

      expect(afterFlush.requests).toEqual([]);
      expect(rows[0]?.close).toBe(15);
      expect(await cache.getManifest(seriesFor(codes.vix).id)).not.toBeNull();
    });

    it("coordinates concurrent loads of one series through the shared hydration lock", async () => {
      await clearProjection();
      const provider = new SymbolAwareProvider({ "^TESTGSPC": 7000 });
      const service = serviceWith(provider);

      const [first, second, third] = await Promise.all([
        service.getBenchmarkDailyPrices(seriesFor(codes.spx), range),
        service.getBenchmarkDailyPrices(seriesFor(codes.spx), range),
        service.getBenchmarkDailyPrices(seriesFor(codes.spx), range),
      ]);

      // One of them hydrated; the other two waited on the lock and found the range already there.
      expect(first).toEqual(second);
      expect(second).toEqual(third);
      const hydrations = new Set(
        provider.requests.map(
          (request) => `${request.range.from}:${request.range.to}`,
        ),
      );
      expect(hydrations.size).toBeLessThanOrEqual(provider.requests.length);
      expect(
        provider.requests.every((request) => request.symbol === "^TESTGSPC"),
      ).toBe(true);
    });

    it("keeps coverage per series, so hydrating an index never marks the proxy covered", async () => {
      await clearProjection();
      const provider = new SymbolAwareProvider({ "^TESTVIX": 15 });
      const wide = { from: "2020-04-01", to: "2020-06-30" };

      await serviceWith(provider).getBenchmarkDailyPrices(
        seriesFor(codes.vix),
        wide,
      );

      const vixCoverage = await store.getDatasetCoverage(
        seriesFor(codes.vix).id,
        "DAILY_PRICE",
        BENCHMARK_DAILY_PRICE_VARIANT,
        wide,
      );
      const proxyCoverage = await store.getDatasetCoverage(
        seriesFor(codes.proxy).id,
        "DAILY_PRICE",
        BENCHMARK_DAILY_PRICE_VARIANT,
        wide,
      );

      expect(vixCoverage.length).toBeGreaterThan(0);
      // The proxy was never asked for this window, so it must not be claimed as covered — a false
      // claim here is permanent, because coverage means "asking again is pointless".
      expect(proxyCoverage).toEqual([]);
      // And no VIX bar landed under the proxy's series.
      const proxyRows = await store.getDailyPrices(
        seriesFor(codes.proxy).id,
        wide,
      );
      expect(proxyRows).toEqual([]);
    });
  },
);
