import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType, StockDataset } from "@intrinsic/database";
import {
  type DailyPrice,
  type DateRange,
  type FinancialStatementDraft,
  type Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import { seriesOperand } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStockDataCache, type StockManifest } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import { addDays, subtractYears } from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { referenceMovingAverage } from "./moving-average-oracle.test-helper.js";
import {
  DAILY_PRICE_FRESHNESS_VARIANT,
  DAILY_PRICE_VARIANT,
  PRICE_DATASET_VERSION,
} from "./ports.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  CanonicalStockDataService,
  FUNDAMENTALS_VARIANT_VERSION,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  type ProviderRequestEvent,
} from "./service.js";
import { referenceWilderRsi } from "./wilder-rsi-oracle.test-helper.js";
import { aggregateCompletedWeeks } from "./weekly.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The price-retention suite requires TEST_REDIS_URL or REDIS_URL. CI must not skip it " +
      "silently: it is the only coverage proving a 30-year installation widens to 34 years " +
      "without refetching or losing what it already had.",
  );
}
const describeRetention = redisUrl ? describe : describe.skip;

/** The clock the whole suite runs on, chosen so both boundaries fall on ordinary weekdays. */
const NOW = "2026-09-09T12:00:00.000Z";
const TODAY = "2026-09-09";
const PRODUCT_HISTORY_YEARS = 30;
const RETENTION_YEARS = priceRetentionYears(PRODUCT_HISTORY_YEARS);
/** 1996-09-09 — the oldest day a user may select, chart or backtest. */
const PRODUCT_START = subtractYears(TODAY, PRODUCT_HISTORY_YEARS);
/** 1992-09-09 — the oldest day the loader may hold. Internal; no surface reports it. */
const RETENTION_START = subtractYears(TODAY, RETENTION_YEARS);

/** The provider's own history begins well before the retention boundary, as AAPL's does. */
const PROVIDER_HISTORY_START = "1988-01-04";

const SLOW = 120_000;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * A deterministic Monday-Friday close series, seeded only by the trading-day index.
 *
 * Pure in the index rather than in the date, so the same date always carries the same OHLCV
 * whichever range it is generated for — which is precisely the property the overlap-integrity
 * assertions depend on. The shape is deliberately non-monotonic so RSI has both gains and losses
 * and the moving averages actually move.
 */
function closeAt(index: number): number {
  return 100 + (index % 37) * 0.8 + index * 0.01 + Math.sin(index / 11) * 4;
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Every trading day from `PROVIDER_HISTORY_START` through `TODAY`, indexed once. */
const PROVIDER_SERIES: Array<{ date: string; index: number }> = (() => {
  const rows: Array<{ date: string; index: number }> = [];
  let cursor = PROVIDER_HISTORY_START;
  while (cursor <= TODAY) {
    if (!isWeekend(cursor)) {
      rows.push({ date: cursor, index: rows.length });
    }
    cursor = addDays(cursor, 1);
  }
  return rows;
})();

function priceRows(
  securityId: string,
  range: Required<DateRange>,
): DailyPrice[] {
  return PROVIDER_SERIES.filter(
    (row) => row.date >= range.from && row.date <= range.to,
  ).map((row) => {
    const close = closeAt(row.index);
    return {
      securityId,
      date: row.date,
      open: close - 0.75,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: 1_000_000 + row.index,
    };
  });
}

class RecordingProvider implements FmpStockProviderPort {
  readonly priceRanges: Array<Required<DateRange> & { symbol: string }> = [];
  readonly statementCalls: string[] = [];
  /** Provider history begins here for this symbol; `undefined` means the full series. */
  listedFrom?: string;

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    return {
      providerSymbol: symbol,
      security: {
        symbol,
        name: "Retention Test Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      profile: { description: "Price-retention integration fixture" },
    } as MappedFmpProfile;
  }

  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    if (!range.from || !range.to) {
      throw new Error("Expected a bounded provider range");
    }
    this.priceRanges.push({ symbol, from: range.from, to: range.to });
    const from = this.listedFrom
      ? range.from > this.listedFrom
        ? range.from
        : this.listedFrom
      : range.from;
    return from > range.to ? [] : priceRows(securityId, { from, to: range.to });
  }

  async getFinancialStatements(
    _symbol: string,
    _securityId: string,
    statementType: FinancialStatementDraft["statementType"],
    cadence: "QUARTERLY" | "ANNUAL",
  ): Promise<FinancialStatementDraft[]> {
    this.statementCalls.push(`${statementType}:${cadence}`);
    return [];
  }
}

describeRetention(
  "34-year raw-price retention behind a 30-year product horizon",
  () => {
    const prisma = new PrismaClient();
    const store = new PrismaStockDataStore(prisma);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const namespace = `stock-data:v2:retention:${suffix}`;
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const createdSecurityIds: string[] = [];

    function createService(input: {
      provider: FmpStockProviderPort;
      onProviderRequest?: (event: ProviderRequestEvent) => void;
    }): CanonicalStockDataService {
      return new CanonicalStockDataService(
        store,
        input.provider,
        new RedisStockDataCache(new IoredisCacheClient(redis), 50, namespace),
        new InMemoryLoadCoordinator(),
        {
          productHistoryYears: PRODUCT_HISTORY_YEARS,
          now: () => new Date(NOW),
          ...(input.onProviderRequest
            ? { onProviderRequest: input.onProviderRequest }
            : {}),
        },
      );
    }

    async function createSecurity(
      prefix: string,
      ipoDate?: string,
    ): Promise<Security> {
      const symbol = `${prefix}${suffix}`;
      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Retention Test Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
          ...(ipoDate ? { ipoDate: new Date(`${ipoDate}T00:00:00.000Z`) } : {}),
        },
      });
      createdSecurityIds.push(row.id);
      return {
        id: row.id,
        symbol,
        name: row.name,
        exchangeCode: row.exchangeCode,
        currency: row.currency,
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
        ...(ipoDate ? { ipoDate } : {}),
      };
    }

    /** Marks fundamentals as already backfilled, so no scenario pays for a statement sync. */
    async function seedFundamentalsStates(securityId: string): Promise<void> {
      for (const operation of fundamentalsDatasetOperations(
        PRODUCT_HISTORY_YEARS,
      )) {
        await store.upsertDatasetState({
          securityId,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt: NOW,
          earliestDate: PRODUCT_START,
          latestDate: TODAY,
        });
      }
    }

    async function persistedPrices(securityId: string) {
      return prisma.dailyPrice.findMany({
        where: { securityId },
        orderBy: { date: "asc" },
      });
    }

    async function persistedCoverage(
      securityId: string,
      dataset: StockDataset,
    ) {
      const rows = await prisma.stockDatasetCoverage.findMany({
        where: { securityId, dataset },
        orderBy: { fromDate: "asc" },
      });
      return rows.map((row) => ({
        variant: row.variant,
        from: isoDate(row.fromDate),
        to: isoDate(row.toDate),
      }));
    }

    async function redisStockKeys(securityId: string): Promise<string[]> {
      return redis.smembers(`${namespace}:security:${securityId}:keys`);
    }

    async function readManifest(
      securityId: string,
    ): Promise<StockManifest | null> {
      const raw = await redis.get(
        `${namespace}:security:${securityId}:manifest`,
      );
      return raw ? (JSON.parse(raw) as StockManifest) : null;
    }

    beforeAll(async () => {
      await redis.ping();
    }, SLOW);

    afterAll(async () => {
      for (const securityId of createdSecurityIds) {
        const keys = await redisStockKeys(securityId);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
        await redis.del(`${namespace}:security:${securityId}:keys`);
      }
      await redis.del(
        `${namespace}:resident-stocks`,
        `${namespace}:access-sequence`,
      );
      if (createdSecurityIds.length > 0) {
        await prisma.security.deleteMany({
          where: { id: { in: createdSecurityIds } },
        });
      }
      await prisma.$disconnect();
      redis.disconnect();
    }, SLOW);

    describe("clean hydration of an old security", () => {
      it(
        "retains back to the 34-year boundary and still projects only the 30-year window",
        async () => {
          const security = await createSecurity("CLEAN");
          await seedFundamentalsStates(security.id);
          const provider = new RecordingProvider();
          const loader = createService({ provider });

          const visible = await loader.getDailyPrices(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          // One request, and it reaches the retention boundary rather than the product one.
          expect(
            provider.priceRanges.filter(
              (call) => call.symbol === security.symbol,
            ),
          ).toEqual([
            { symbol: security.symbol, from: RETENTION_START, to: TODAY },
          ]);

          // PostgreSQL holds the warm-up years...
          const persisted = await persistedPrices(security.id);
          const persistedDates = persisted.map((row) => isoDate(row.date));
          expect(persistedDates[0]! >= RETENTION_START).toBe(true);
          expect(persistedDates[0]! < PRODUCT_START).toBe(true);
          expect(persistedDates.at(-1)).toBe(TODAY);
          expect(
            persistedDates.filter((date) => date < PRODUCT_START).length,
          ).toBeGreaterThan(900);

          // ...and the product projection starts at the product horizon, never before it.
          expect(visible[0]!.date >= PRODUCT_START).toBe(true);
          expect(visible.every((row) => row.date >= PRODUCT_START)).toBe(true);
          expect(visible[0]!.date).toBe(
            persistedDates.find((date) => date >= PRODUCT_START),
          );

          // Derived rows exist for the warm-up years, because that is what makes the first visible
          // day valid — they are simply never projected.
          const warmUpDerived = await prisma.dailyDerivedState.count({
            where: {
              securityId: security.id,
              date: { lt: new Date(`${PRODUCT_START}T00:00:00.000Z`) },
            },
          });
          expect(warmUpDerived).toBeGreaterThan(900);
          const projectedDerived = await loader.getDailyDerivedState(
            security.symbol,
            { from: RETENTION_START, to: TODAY },
          );
          expect(
            projectedDerived.every((row) => row.date >= PRODUCT_START),
          ).toBe(true);

          // The whole point: the long weekly averages are already valid on the first visible day.
          const firstVisible = projectedDerived[0]!;
          expect(firstVisible.date).toBe(visible[0]!.date);
          expect(firstVisible.sma200w).toBeTypeOf("number");
          expect(firstVisible.ema200w).toBeTypeOf("number");
          expect(firstVisible.sma200d).toBeTypeOf("number");
          expect(firstVisible.ema200d).toBeTypeOf("number");
          expect(firstVisible.rsi14d).toBeTypeOf("number");
        },
        SLOW,
      );

      it(
        "reports the 30-year bound to Stock Details and never the retained one",
        async () => {
          const security = await createSecurity("BOUND");
          await seedFundamentalsStates(security.id);
          const loader = createService({ provider: new RecordingProvider() });

          const details = await loader.getStockDetails(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          expect(details.history).toEqual({
            start: PRODUCT_START,
            end: TODAY,
            startOrigin: "HORIZON",
          });
          expect(details.prices[0]!.date >= PRODUCT_START).toBe(true);
          expect(details.technicals[0]!.date >= PRODUCT_START).toBe(true);
        },
        SLOW,
      );
    });

    describe("an existing 30-year installation widening to 34", () => {
      let security: Security;
      let provider: RecordingProvider;
      let loader: CanonicalStockDataService;
      let before: {
        dates: string[];
        ohlcv: Map<string, string>;
        rowCount: number;
        derivedCount: number;
      };

      beforeAll(async () => {
        security = await createSecurity("WIDEN");
        provider = new RecordingProvider();
        loader = createService({ provider });
        await seedFundamentalsStates(security.id);

        // The state a real deployment is already in: exactly thirty years of prices, complete
        // coverage over them, derived state built from them, and a fresh tail watermark.
        const legacyRange = { from: PRODUCT_START, to: TODAY };
        const legacyPrices = priceRows(security.id, legacyRange);
        await store.saveDailyPriceSync({
          securityId: security.id,
          prices: legacyPrices,
          successfulCoverage: [legacyRange],
          syncedAt: NOW,
          tailDate: TODAY,
          freshThrough: TODAY,
        });
        const weeklyBars = aggregateCompletedWeeks(legacyPrices, TODAY, {
          historyStart: PRODUCT_START,
          historyStartOrigin: "HORIZON",
        });
        await store.saveDailyDerivedState({
          securityId: security.id,
          rows: buildDailyDerivedState({ prices: legacyPrices, weeklyBars }),
          weeklyPrices: weeklyBars,
          successfulCoverage: legacyRange,
          syncedAt: NOW,
        });

        const rows = await persistedPrices(security.id);
        before = {
          dates: rows.map((row) => isoDate(row.date)),
          ohlcv: new Map(
            rows.map((row) => [
              isoDate(row.date),
              [
                row.open.toString(),
                row.high.toString(),
                row.low.toString(),
                row.close.toString(),
                row.volume.toString(),
              ].join("|"),
            ]),
          ),
          rowCount: rows.length,
          derivedCount: await prisma.dailyDerivedState.count({
            where: { securityId: security.id },
          }),
        };
        expect(before.dates[0]).toBe(PRODUCT_START);
        expect(before.rowCount).toBe(before.derivedCount);
      }, SLOW);

      it(
        "requests only the missing prefix and never the covered thirty years",
        async () => {
          await loader.getDailyPrices(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          const calls = provider.priceRanges.filter(
            (call) => call.symbol === security.symbol,
          );
          expect(calls).toEqual([
            {
              symbol: security.symbol,
              from: RETENTION_START,
              to: addDays(PRODUCT_START, -1),
            },
          ]);
          // Nothing inside the interval the installation already had.
          expect(calls.every((call) => call.to < PRODUCT_START)).toBe(true);
          expect(provider.statementCalls).toEqual([]);
        },
        SLOW,
      );

      it(
        "keeps every pre-existing row and value untouched across the overlap",
        async () => {
          const rows = await persistedPrices(security.id);
          const dates = rows.map((row) => isoDate(row.date));

          // No duplicates, ascending, and strictly a superset of what was there before.
          expect(new Set(dates).size).toBe(dates.length);
          expect([...dates].sort()).toEqual(dates);
          for (const date of before.dates) {
            expect(dates).toContain(date);
          }
          expect(rows.length).toBeGreaterThan(before.rowCount);

          // Byte-identical OHLCV on the overlap: widening adds history, it does not restate it.
          for (const row of rows) {
            const date = isoDate(row.date);
            const previous = before.ohlcv.get(date);
            if (!previous) {
              expect(date < PRODUCT_START).toBe(true);
              continue;
            }
            expect(
              [
                row.open.toString(),
                row.high.toString(),
                row.low.toString(),
                row.close.toString(),
                row.volume.toString(),
              ].join("|"),
            ).toBe(previous);
          }
        },
        SLOW,
      );

      it(
        "reports coverage that agrees with the rows actually persisted",
        async () => {
          const rows = await persistedPrices(security.id);
          const dates = rows.map((row) => isoDate(row.date));
          const coverage = await persistedCoverage(
            security.id,
            StockDataset.DAILY_PRICE,
          );
          const canonical = coverage.filter(
            (row) => row.variant === DAILY_PRICE_VARIANT,
          );
          expect(canonical[0]!.from).toBe(RETENTION_START);
          expect(canonical.at(-1)!.to).toBe(TODAY);
          // The union of the recorded intervals is contiguous from the retention boundary to today.
          let cursor = RETENTION_START;
          for (const interval of canonical) {
            expect(interval.from <= cursor).toBe(true);
            cursor = addDays(interval.to, 1);
          }
          expect(cursor > TODAY).toBe(true);

          const state = await prisma.stockDatasetState.findFirst({
            where: {
              securityId: security.id,
              dataset: StockDataset.DAILY_PRICE,
              variant: DAILY_PRICE_VARIANT,
            },
          });
          expect(isoDate(state!.earliestDate!)).toBe(RETENTION_START);
          expect(isoDate(state!.latestDate!)).toBe(TODAY);
          // The state's bounds bracket the real rows, and the real rows start inside them.
          expect(dates[0]! >= RETENTION_START).toBe(true);
          expect(dates.at(-1)).toBe(TODAY);
        },
        SLOW,
      );

      it(
        "repairs the derived state across the whole history and leaves nothing stale",
        async () => {
          const priceCount = await prisma.dailyPrice.count({
            where: { securityId: security.id },
          });
          const derived = await prisma.dailyDerivedState.findMany({
            where: { securityId: security.id },
            orderBy: { date: "asc" },
          });
          // Exactly one derived row per trading day, warm-up years included.
          expect(derived).toHaveLength(priceCount);
          expect(new Set(derived.map((row) => isoDate(row.date))).size).toBe(
            derived.length,
          );

          const derivedVariants = (
            await persistedCoverage(
              security.id,
              StockDataset.DAILY_DERIVED_STATE,
            )
          ).map((row) => row.variant);
          expect([...new Set(derivedVariants)]).toEqual([
            DAILY_DERIVED_STATE_VARIANT,
          ]);

          // The recursive series were rebuilt, not patched in front of the old ones: EMA at the
          // first visible day now carries four years of prior history it did not have before.
          const firstVisible = derived.find(
            (row) => isoDate(row.date) >= PRODUCT_START,
          )!;
          expect(firstVisible.ema200d?.toNumber()).toBeTypeOf("number");
          expect(firstVisible.sma200w?.toNumber()).toBeTypeOf("number");
          expect(firstVisible.ema200w?.toNumber()).toBeTypeOf("number");
        },
        SLOW,
      );

      it(
        "publishes a manifest that is valid under the new retention policy",
        async () => {
          const manifest = await readManifest(security.id);
          expect(manifest).toMatchObject({
            status: "READY",
            productHistoryYears: PRODUCT_HISTORY_YEARS,
            priceRetentionYears: RETENTION_YEARS,
            priceDatasetVersion: PRICE_DATASET_VERSION,
            derivedStateRevision: DERIVED_STATE_REVISION,
            coverageStart: RETENTION_START,
            coverageEnd: TODAY,
          });
        },
        SLOW,
      );

      it(
        "matches Redis against PostgreSQL, and rebuilds identically after eviction",
        async () => {
          const sampleRange = { from: "2004-01-01", to: "2004-12-31" };
          const cached = await loader.getDailyDerivedState(
            security.symbol,
            sampleRange,
          );
          const durable = await store.getDailyDerivedState(
            security.id,
            sampleRange,
          );
          expect(cached.map((row) => row.date)).toEqual(
            durable.map((row) => row.date),
          );
          for (const [index, row] of cached.entries()) {
            const persisted = durable[index]!;
            expect(row.sma20d).toBeCloseTo(persisted.sma20d!, 8);
            expect(row.ema200d).toBeCloseTo(persisted.ema200d!, 8);
            expect(row.sma200w).toBeCloseTo(persisted.sma200w!, 8);
            expect(row.rsi14d).toBeCloseTo(persisted.rsi14d!, 8);
          }

          // Redis is disposable: drop every key this stock owns and read again.
          const before = provider.priceRanges.length;
          const keys = await redisStockKeys(security.id);
          expect(keys.length).toBeGreaterThan(0);
          await redis.del(...keys, `${namespace}:security:${security.id}:keys`);

          const rebuilt = await loader.getDailyDerivedState(
            security.symbol,
            sampleRange,
          );
          expect(rebuilt.map((row) => row.date)).toEqual(
            cached.map((row) => row.date),
          );
          for (const [index, row] of rebuilt.entries()) {
            expect(row.sma200w).toBeCloseTo(cached[index]!.sma200w!, 10);
            expect(row.ema200w).toBeCloseTo(cached[index]!.ema200w!, 10);
            expect(row.rsi14d).toBeCloseTo(cached[index]!.rsi14d!, 10);
          }
          // Reconstructed entirely from PostgreSQL.
          expect(provider.priceRanges).toHaveLength(before);
        },
        SLOW,
      );

      it(
        "is idempotent: a second hydration touches neither the provider nor the data",
        async () => {
          const priceCallsBefore = provider.priceRanges.length;
          const rowsBefore = await persistedPrices(security.id);
          const derivedBefore = await store.getDailyDerivedState(security.id, {
            from: RETENTION_START,
            to: TODAY,
          });

          await loader.getDailyPrices(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });
          await loader.getDailyDerivedState(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          expect(provider.priceRanges).toHaveLength(priceCallsBefore);
          const rowsAfter = await persistedPrices(security.id);
          expect(rowsAfter).toHaveLength(rowsBefore.length);
          expect(rowsAfter.map((row) => isoDate(row.date))).toEqual(
            rowsBefore.map((row) => isoDate(row.date)),
          );
          const derivedAfter = await store.getDailyDerivedState(security.id, {
            from: RETENTION_START,
            to: TODAY,
          });
          expect(derivedAfter).toEqual(derivedBefore);
        },
        SLOW,
      );
    });

    describe("a stale pre-change cache manifest", () => {
      it(
        "cannot convince the loader that the 34-year requirement is already met",
        async () => {
          const security = await createSecurity("STALE");
          await seedFundamentalsStates(security.id);
          const provider = new RecordingProvider();
          const loader = createService({ provider });

          // Thirty years in PostgreSQL, exactly as the old policy left it.
          const legacyRange = { from: PRODUCT_START, to: TODAY };
          await store.saveDailyPriceSync({
            securityId: security.id,
            prices: priceRows(security.id, legacyRange),
            successfulCoverage: [legacyRange],
            syncedAt: NOW,
            tailDate: TODAY,
            freshThrough: TODAY,
          });

          // A READY manifest written before the change: it claims coverage from the product
          // horizon and carries the old single `historyYears` field.
          const legacyManifest = {
            securityId: security.id,
            status: "READY",
            historyYears: PRODUCT_HISTORY_YEARS,
            coverageStart: PRODUCT_START,
            coverageEnd: TODAY,
            canonicalHistoryStart: PRODUCT_START,
            canonicalHistoryEnd: TODAY,
            hydratedAt: NOW,
            lastPriceRefreshAt: NOW,
            lastFundamentalsRefreshAt: NOW,
            priceDatasetVersion: PRICE_DATASET_VERSION,
            financialStatementVersion: 1,
            derivedStateRevision: DERIVED_STATE_REVISION,
          };
          const manifestKey = `${namespace}:security:${security.id}:manifest`;
          await redis.set(manifestKey, JSON.stringify(legacyManifest));
          await redis.sadd(
            `${namespace}:security:${security.id}:keys`,
            manifestKey,
          );
          await redis.zadd(
            `${namespace}:resident-stocks`,
            await redis.incr(`${namespace}:access-sequence`),
            security.id,
          );

          await loader.getDailyPrices(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          // The prefix was hydrated despite the manifest claiming readiness...
          expect(
            provider.priceRanges.filter(
              (call) => call.symbol === security.symbol,
            ),
          ).toEqual([
            {
              symbol: security.symbol,
              from: RETENTION_START,
              to: addDays(PRODUCT_START, -1),
            },
          ]);
          const rows = await persistedPrices(security.id);
          expect(isoDate(rows[0]!.date) < PRODUCT_START).toBe(true);
          // ...and the manifest is now stamped with both horizons.
          expect(await readManifest(security.id)).toMatchObject({
            status: "READY",
            productHistoryYears: PRODUCT_HISTORY_YEARS,
            priceRetentionYears: RETENTION_YEARS,
            coverageStart: RETENTION_START,
          });
        },
        SLOW,
      );
    });

    describe("a security listed inside the retention window", () => {
      it(
        "clamps to its listing date and invents no warm-up history",
        async () => {
          const listing = "2015-06-01";
          const security = await createSecurity("IPO", listing);
          await seedFundamentalsStates(security.id);
          const provider = new RecordingProvider();
          provider.listedFrom = listing;
          const loader = createService({ provider });

          const visible = await loader.getDailyPrices(security.symbol, {
            from: PRODUCT_START,
            to: TODAY,
          });

          // Clamped on both sides of the policy: no request before the listing date...
          expect(
            provider.priceRanges.filter(
              (call) => call.symbol === security.symbol,
            ),
          ).toEqual([{ symbol: security.symbol, from: listing, to: TODAY }]);
          // ...and no persisted or projected row before it either.
          const rows = await persistedPrices(security.id);
          expect(isoDate(rows[0]!.date) >= listing).toBe(true);
          expect(visible[0]!.date >= listing).toBe(true);

          // Coverage records only what actually exists; nothing claims the retention boundary.
          const coverage = (
            await persistedCoverage(security.id, StockDataset.DAILY_PRICE)
          ).filter((row) => row.variant === DAILY_PRICE_VARIANT);
          expect(coverage.every((row) => row.from >= listing)).toBe(true);

          // A young security legitimately has no 200-week average yet at its own first day.
          const derived = await store.getDailyDerivedState(security.id, {
            from: listing,
            to: addDays(listing, 30),
          });
          expect(derived[0]!.sma200w).toBeUndefined();
          expect(derived[0]!.ema200w).toBeUndefined();
        },
        SLOW,
      );
    });

    describe("derived series verified against independent oracles", () => {
      let security: Security;
      let closes: number[];
      let dates: string[];
      let derivedByDate: Map<string, Record<string, number | undefined>>;

      beforeAll(async () => {
        security = await createSecurity("ORACLE");
        await seedFundamentalsStates(security.id);
        const loader = createService({ provider: new RecordingProvider() });
        await loader.getDailyPrices(security.symbol, {
          from: PRODUCT_START,
          to: TODAY,
        });

        const rows = await persistedPrices(security.id);
        dates = rows.map((row) => isoDate(row.date));
        closes = rows.map((row) => row.close.toNumber());
        const derived = await store.getDailyDerivedState(security.id, {
          from: RETENTION_START,
          to: TODAY,
        });
        derivedByDate = new Map(
          derived.map((row) => [
            row.date,
            row as unknown as Record<string, number | undefined>,
          ]),
        );
      }, SLOW);

      /** Dates worth checking: both boundaries, a year boundary and a holiday-shortened week. */
      function probeDates(): string[] {
        const firstVisible = dates.find((date) => date >= PRODUCT_START)!;
        const lastWarmUp = [...dates]
          .reverse()
          .find((date) => date < PRODUCT_START)!;
        // The first trading day of 2015 — the week containing New Year's Day, which the fixture
        // series treats as a normal weekday but whose ISO week still starts on a Monday.
        const yearBoundary = dates.find((date) => date >= "2015-01-01")!;
        // US Independence Day 2003 fell on a Friday: the shortened week ends on Thursday.
        const holidayWeek = dates.find((date) => date >= "2003-07-03")!;
        return [
          dates[dates.length - 1]!,
          firstVisible,
          lastWarmUp,
          yearBoundary,
          holidayWeek,
        ];
      }

      it(
        "reproduces the daily moving averages and RSI from raw closes",
        () => {
          const oracles = {
            sma20d: referenceMovingAverage(closes, "SMA", 20),
            ema50d: referenceMovingAverage(closes, "EMA", 50),
            ema200d: referenceMovingAverage(closes, "EMA", 200),
            rsi14d: referenceWilderRsi(closes, 14),
          } as const;

          for (const date of probeDates()) {
            const index = dates.indexOf(date);
            const row = derivedByDate.get(date)!;
            for (const [field, values] of Object.entries(oracles)) {
              const expected = values[index];
              expect(expected).toBeTypeOf("number");
              expect(row[field]).toBeCloseTo(expected!, 6);
            }
          }
        },
        SLOW,
      );

      it(
        "reproduces the 200-week averages from completed weekly closes only",
        async () => {
          const rows = await persistedPrices(security.id);
          const prices: DailyPrice[] = rows.map((row) => ({
            securityId: security.id,
            date: isoDate(row.date),
            open: row.open.toNumber(),
            high: row.high.toNumber(),
            low: row.low.toNumber(),
            close: row.close.toNumber(),
            volume: Number(row.volume),
          }));
          const weeks = aggregateCompletedWeeks(prices, TODAY, {
            historyStart: dates[0]!,
            historyStartOrigin: "HORIZON",
          }).sort((left, right) =>
            left.weekStartDate.localeCompare(right.weekStartDate),
          );
          const weeklyCloses = weeks.map((week) => week.close);
          const sma200w = referenceMovingAverage(weeklyCloses, "SMA", 200);
          const ema200w = referenceMovingAverage(weeklyCloses, "EMA", 200);

          for (const date of probeDates()) {
            const row = derivedByDate.get(date)!;
            // The effective week is the last one whose own final trading day has already closed —
            // never the week the date sits inside while it is still running.
            const effective = weeks
              .filter((week) => week.eligibleDate <= date)
              .at(-1)!;
            const index = weeks.indexOf(effective);
            expect(effective.eligibleDate <= date).toBe(true);
            expect(row.sma200w).toBeCloseTo(sma200w[index]!, 6);
            expect(row.ema200w).toBeCloseTo(ema200w[index]!, 6);
          }
        },
        SLOW,
      );

      it(
        "never lets a weekly value appear before its own week has closed",
        () => {
          // Walk one full week: the Monday-to-Thursday rows must all carry the same weekly value,
          // and it must change only on the day a new week actually completes.
          const start = dates.findIndex((date) => date >= "2015-01-05");
          const window = dates.slice(start, start + 10);
          let previous: number | undefined;
          let changes = 0;
          for (const date of window) {
            const value = derivedByDate.get(date)!.sma200w;
            if (previous !== undefined && value !== previous) {
              changes += 1;
              // A change may only land on the trading day that closed a week: a Friday here, or the
              // last observed bar of a shortened week.
              const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
              expect(weekday).toBeGreaterThanOrEqual(4);
            }
            previous = value;
          }
          expect(changes).toBeGreaterThan(0);
          expect(changes).toBeLessThanOrEqual(2);
        },
        SLOW,
      );
    });

    describe("a maximum-length backtest at the product boundary", () => {
      it(
        "starts exactly where it asked to, with its trigger context and its long operands",
        async () => {
          const security = await createSecurity("FRAME");
          await seedFundamentalsStates(security.id);
          const loader = createService({ provider: new RecordingProvider() });

          const operands = (
            ["SMA_200W", "EMA_200W", "SMA_200D", "RSI_14D"] as const
          ).map(seriesOperand);
          const frame = await loader.getDailyEvaluationFrame(
            security,
            { from: PRODUCT_START, to: TODAY },
            operands,
          );

          // The period begins on the day it asked for. This is the assertion that changed, and it
          // changed because the old one was describing a defect: the backtest projection used to be
          // cut at `today - 30y`, so a boundary period got `periodStartIndex === 0` and **no**
          // leading context at all — while every interior period got its `t - 1` row. A Trigger
          // could therefore fire on the first simulated day of a 29-year run and not of a 30-year
          // one, for no reason a user could see. Worse, the cut moved with the clock: the same run
          // executed after UTC midnight lost its first simulated day outright.
          expect(frame.dates[frame.periodStartIndex]).toBe(
            frame.dates.find((date) => date >= PRODUCT_START),
          );
          // The boundary now behaves exactly like anywhere else: leading context exists, and it is
          // context — every row before the period start is outside the period, so the day loop,
          // which walks the execution calendar rather than the frame, can never reach one.
          expect(frame.periodStartIndex).toBeGreaterThan(0);
          expect(
            frame.dates
              .slice(0, frame.periodStartIndex)
              .every((date) => date < PRODUCT_START),
          ).toBe(true);
          // And the frame still cannot reach past what is retained.
          expect(frame.dates[0]! >= RETENTION_START).toBe(true);

          // Every long operand is already valid on that first day, which is the whole reason the
          // four warm-up years are retained.
          for (const operand of operands) {
            const column = frame.columns.get(operand)!;
            const value = column[frame.periodStartIndex]!;
            expect(Number.isNaN(value)).toBe(false);
            expect(value).toBeGreaterThan(0);
          }

          // A period that starts later behaves identically, which is now the point rather than the
          // contrast.
          const inside = await loader.getDailyEvaluationFrame(
            security,
            { from: "2005-06-01", to: TODAY },
            operands,
          );
          expect(inside.periodStartIndex).toBeGreaterThan(0);
          expect(inside.dates[0]! < "2005-06-01").toBe(true);
        },
        SLOW,
      );

      it(
        "keeps the retained warm-up years out of every product surface",
        async () => {
          // The horizon did not go away. It moved to where it belongs: the product reads, which
          // are the ones a user can reach.
          const security = await createSecurity("HIDDEN");
          await seedFundamentalsStates(security.id);
          const loader = createService({ provider: new RecordingProvider() });

          const prices = await loader.getDailyPrices(security.symbol, {
            from: RETENTION_START,
            to: TODAY,
          });
          expect(prices.length).toBeGreaterThan(0);
          expect(prices.every((row) => row.date >= PRODUCT_START)).toBe(true);

          const technicals = await loader.getDailyTechnicals(security.symbol, {
            from: RETENTION_START,
            to: TODAY,
          });
          expect(technicals.every((row) => row.date >= PRODUCT_START)).toBe(
            true,
          );

          const details = await loader.getStockDetails(security.symbol, {
            from: RETENTION_START,
            to: TODAY,
          });
          expect(details.prices.every((row) => row.date >= PRODUCT_START)).toBe(
            true,
          );
          expect(details.history.start >= PRODUCT_START).toBe(true);
        },
        SLOW,
      );
    });

    it(
      "never widens the fundamentals variant with the price-retention horizon",
      async () => {
        const security = await createSecurity("FUND");
        await seedFundamentalsStates(security.id);
        const provider = new RecordingProvider();
        const loader = createService({ provider });

        await loader.getDailyPrices(security.symbol, {
          from: PRODUCT_START,
          to: TODAY,
        });

        const variants = (
          await prisma.stockDatasetState.findMany({
            where: {
              securityId: security.id,
              dataset: {
                in: [
                  StockDataset.INCOME_STATEMENT,
                  StockDataset.BALANCE_SHEET,
                  StockDataset.CASH_FLOW,
                ],
              },
            },
          })
        ).map((row) => row.variant);
        expect(variants).toHaveLength(6);
        for (const variant of variants) {
          expect(variant).toContain(`:v${FUNDAMENTALS_VARIANT_VERSION}:h30:w7`);
          expect(variant).not.toContain(":h34:");
          expect(variant).not.toContain(":h37:");
        }
        // Already-satisfied datasets are recognised, so no statement is refetched.
        expect(provider.statementCalls).toEqual([]);
      },
      SLOW,
    );

    it(
      "keeps the recent-tail freshness watermark on its own unrevisioned variant",
      async () => {
        const security = await createSecurity("TAIL");
        await seedFundamentalsStates(security.id);
        const loader = createService({ provider: new RecordingProvider() });
        await loader.getDailyPrices(security.symbol, {
          from: PRODUCT_START,
          to: TODAY,
        });

        const variants = (
          await prisma.stockDatasetState.findMany({
            where: {
              securityId: security.id,
              dataset: StockDataset.DAILY_PRICE,
            },
          })
        )
          .map((row) => row.variant)
          .sort();
        expect(variants).toEqual(
          [DAILY_PRICE_VARIANT, DAILY_PRICE_FRESHNESS_VARIANT].sort(),
        );
      },
      SLOW,
    );
  },
);
