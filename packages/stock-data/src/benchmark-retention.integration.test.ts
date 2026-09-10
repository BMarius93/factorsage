import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  BenchmarkWithSeries,
  DateRange,
} from "@intrinsic/domain";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisBenchmarkDataCache } from "./benchmark-cache.js";
import { BENCHMARK_DAILY_PRICE_VARIANT } from "./benchmark-ports.js";
import { PrismaBenchmarkDataStore } from "./benchmark-prisma-store.js";
import { CanonicalBenchmarkDataService } from "./benchmark-service.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";

/**
 * An immutable backtest period is not re-measured against a later clock.
 *
 * The execution calendar is the pinned benchmark series' own bars, so whatever this read drops,
 * the run does not simulate. Clipping it at `today - retentionYears` therefore does not merely
 * hide a row: it moves the first simulated date, the return-index base and the first contribution
 * date of a run whose period was fixed and recorded months earlier.
 *
 * The retention margin only postponed that. A period accepted at the very edge of the selectable
 * horizon survives midnight and a week's retry, and then stops surviving — silently, because the
 * coverage check was applied to the range *after* clipping and therefore always agreed with it.
 */

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Benchmark retention tests require TEST_REDIS_URL or REDIS_URL: they are the only coverage " +
      "proving an immutable period is not re-clipped by a later clock.",
  );
}
const describeRetention = redisUrl ? describe : describe.skip;

/** Weekday bars from `from`, inclusive, up to and including `to`. */
function weekdayBars(
  seriesId: string,
  from: string,
  to: string,
): BenchmarkDailyPrice[] {
  const rows: BenchmarkDailyPrice[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  let close = 400;
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      rows.push({
        seriesId,
        date: cursor.toISOString().slice(0, 10),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000_000,
      });
      close += 0.5;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

/** Refuses every request: a matrix-shaped environment, where reaching FMP is itself a failure. */
class RefusingProvider implements FmpBenchmarkProviderPort {
  readonly requests: Required<DateRange>[] = [];
  async getBenchmarkDailyPrices(
    _symbol: string,
    _benchmarkId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]> {
    this.requests.push({ from: range.from as string, to: range.to as string });
    throw new Error("the provider must not be reached for retained history");
  }
}

describeRetention(
  "an immutable period is read exactly, whatever the clock says",
  () => {
    const suffix = randomUUID();
    const namespace = `benchmark:retention:${suffix}`;
    const code = `RET${suffix.slice(0, 8).toUpperCase()}`;
    const prisma = new PrismaClient();
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const store = new PrismaBenchmarkDataStore(prisma);
    const cache = new RedisBenchmarkDataCache(new IoredisCacheClient(redis), {
      namespace,
    });

    /**
     * The period a run recorded on 2026-08-26: thirty years, starting on the series' own first bar.
     *
     * Starting *on* a bar is the point. A period whose first date is a weekend can lose it to a clip
     * without changing anything the run simulates, which is exactly why the defect stayed invisible
     * until the margin expired.
     */
    const SERIES_FROM = "1996-08-26";
    const SERIES_TO = "2026-08-24";
    const PERIOD = { from: SERIES_FROM, to: SERIES_TO } as const;

    let benchmark: BenchmarkWithSeries;
    let bars: BenchmarkDailyPrice[];

    const serviceAt = (today: string) =>
      new CanonicalBenchmarkDataService(
        store,
        new RefusingProvider(),
        cache,
        new InMemoryLoadCoordinator(),
        { now: () => new Date(`${today}T12:00:00.000Z`) },
      );

    beforeAll(async () => {
      await redis.ping();
      const [persisted] = await store.reconcileBenchmarkCatalog([
        {
          code,
          name: "Retention Test Benchmark",
          providerSymbol: "RET",
          currency: "USD",
          sourceKind: "FMP_SYMBOL",
          methodologyVersion: 1,
          isActive: true,
          displayOrder: 99,
        },
      ]);
      benchmark = persisted as BenchmarkWithSeries;
      bars = weekdayBars(benchmark.series.id, SERIES_FROM, SERIES_TO);
      await store.saveDailyPriceSync({
        seriesId: benchmark.series.id,
        prices: bars,
        successfulCoverage: [{ from: SERIES_FROM, to: SERIES_TO }],
        syncedAt: new Date().toISOString(),
        tailDate: SERIES_TO,
        freshThrough: SERIES_TO,
      });
    }, 120_000);

    afterAll(async () => {
      await prisma.benchmarkDailyPrice.deleteMany({
        where: { seriesId: benchmark.series.id },
      });
      await prisma.$disconnect();
      redis.disconnect();
    });

    const firstDate = async (today: string): Promise<string | undefined> => {
      const rows = await serviceAt(today).getBenchmarkDailyPrices(
        benchmark.series,
        PERIOD,
      );
      return rows[0]?.date;
    };

    it("keeps the first date when execution crosses UTC midnight", async () => {
      expect(await firstDate("2026-08-27")).toBe(SERIES_FROM);
    }, 60_000);

    it("keeps it on a retry a week later", async () => {
      expect(await firstDate("2026-09-02")).toBe(SERIES_FROM);
    }, 60_000);

    it("keeps it one day past the benchmark retention margin", async () => {
      // 2027-08-27 minus the 31-year retained horizon is 1996-08-27 — one day after the period
      // starts. This is the case the margin only postponed: the run would have simulated one
      // session fewer, from a different first date, with nothing to say so.
      expect(await firstDate("2027-08-27")).toBe(SERIES_FROM);
    }, 60_000);

    it("keeps it years past the margin, because the rows were never deleted", async () => {
      expect(await firstDate("2030-01-02")).toBe(SERIES_FROM);
    }, 60_000);

    it("reports no missing coverage for the period the run recorded", async () => {
      for (const today of ["2026-08-27", "2027-08-27", "2030-01-02"]) {
        const missing = await serviceAt(today).missingBenchmarkCoverage(
          benchmark.series,
          PERIOD,
        );
        expect([today, missing]).toEqual([today, []]);
      }
    }, 60_000);

    it("reports the prefix as missing when durable coverage genuinely does not reach it", async () => {
      // A period reaching a year before anything this series ever covered. The check must compare
      // against the **requested** period: clipping first and then asking about the clipped range is
      // how a silently shortened run passed.
      const missing = await serviceAt("2027-08-27").missingBenchmarkCoverage(
        benchmark.series,
        { from: "1995-08-24", to: SERIES_TO },
      );
      expect(missing).toHaveLength(1);
      expect(missing[0]?.from).toBe("1995-08-24");
      expect((missing[0]?.to ?? "") < SERIES_FROM).toBe(true);
    }, 60_000);

    it("does not reach the provider for any of it", async () => {
      const provider = new RefusingProvider();
      const service = new CanonicalBenchmarkDataService(
        store,
        provider,
        cache,
        new InMemoryLoadCoordinator(),
        { now: () => new Date("2027-08-27T12:00:00.000Z") },
      );
      const rows = await service.getBenchmarkDailyPrices(
        benchmark.series,
        PERIOD,
      );
      expect(rows[0]?.date).toBe(SERIES_FROM);
      expect(provider.requests).toEqual([]);
    }, 60_000);

    it("keeps the coverage variant it was recorded under", async () => {
      const coverage = await store.getDatasetCoverage(
        benchmark.series.id,
        "DAILY_PRICE",
        BENCHMARK_DAILY_PRICE_VARIANT,
        { from: SERIES_FROM, to: SERIES_TO },
      );
      expect(coverage.length).toBeGreaterThan(0);
    }, 60_000);
  },
);
