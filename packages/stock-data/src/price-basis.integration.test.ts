import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType, StockDataset } from "@intrinsic/database";
import type { DailyPrice, DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStockDataCache } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import { DAILY_DERIVED_STATE_VARIANT } from "./derived-state.js";
import { DAILY_PRICE_VARIANT } from "./ports.js";
import type { PriceBasisEvent } from "./price-basis.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  CanonicalStockDataService,
  PriceBasisChangedError,
  priceRetentionYears,
  type PriceBasisObservation,
} from "./service.js";

/**
 * Re-base-safe price loading against PostgreSQL and Redis
 * (`docs/decisions/historical-price-basis-v1.md`, §7–§9).
 *
 * The pure rules are pinned by `price-basis.test.ts` and the loader's decisions by `service.test.ts`.
 * These cases prove what only the real stores can: that a replacement is one transaction which
 * either lands whole or not at all, that its generation is compare-and-set, and that an evaluation
 * read refuses a basis that moved under it.
 */

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Price-basis integration tests require TEST_REDIS_URL or REDIS_URL.",
  );
}
const describeWithRedis = redisUrl ? describe : describe.skip;

const TODAY = "2026-08-24";
const NOW = `${TODAY}T12:00:00.000Z`;

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

function bar(securityId: string, date: string, close: number): DailyPrice {
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

/** A provider that answers every range from one history, as FMP does. */
class HistoryProvider implements FmpStockProviderPort {
  readonly ranges: Required<DateRange>[] = [];
  constructor(public history: DailyPrice[]) {}
  async getProfile() {
    return null;
  }
  async getDailyPrices(_symbol: string, securityId: string, range: DateRange) {
    if (!range.from || !range.to) throw new Error("Expected bounded range");
    this.ranges.push({ from: range.from, to: range.to });
    return this.history
      .filter((row) => row.date >= range.from! && row.date <= range.to!)
      .map((row) => ({ ...row, securityId }));
  }
  async getFinancialStatements() {
    return [];
  }
}

describeWithRedis("re-base-safe price loading on PostgreSQL and Redis", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const namespace = `stock-data:v2:test:price-basis:${randomUUID()}`;
  const securityIds: string[] = [];

  async function createSecurity(symbol: string) {
    const created = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `${symbol} Corp`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(created.id);
    return created;
  }

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await prisma.$disconnect();
    await redis.quit();
  });

  describe("replaceDailyPriceHistory", () => {
    let securityId: string;
    const dates = weekdays("2026-06-01", "2026-06-30");
    const event: PriceBasisEvent = {
      securityId: "",
      generation: 0,
      kind: "MEASURED",
      effectiveDate: "2026-06-15",
      priceRatio: 4,
      detectedAt: NOW,
      evidence: {
        runs: [],
        comparedSessions: dates.length,
        changedSessions: 10,
        unfittedSessions: 0,
      },
    };

    beforeAll(async () => {
      securityId = (
        await createSecurity(`PB${randomUUID().slice(0, 8).toUpperCase()}`)
      ).id;
      await store.saveDailyPriceSync({
        securityId,
        prices: dates.map((date) => bar(securityId, date, 400)),
        successfulCoverage: [{ from: "2026-06-01", to: "2026-06-30" }],
        syncedAt: NOW,
        tailDate: "2026-06-30",
      });
      await store.saveDailyDerivedState({
        securityId,
        rows: dates.map((date) => ({ securityId, date, sma20d: 400 })),
        weeklyPrices: [],
        successfulCoverage: { from: "2026-06-01", to: "2026-06-30" },
        syncedAt: NOW,
      });
    });

    it("writes prices, derived rows, the event and the next generation together", async () => {
      const replaced = await store.replaceDailyPriceHistory({
        securityId,
        expectedGeneration: null,
        prices: dates.map((date) =>
          bar(securityId, date, date < "2026-06-15" ? 100 : 101),
        ),
        derivedRows: dates.map((date) => ({ securityId, date, sma20d: 100 })),
        weeklyPrices: [],
        events: [{ ...event, securityId }],
        priceCoverage: { from: "2026-06-01", to: "2026-06-30" },
        derivedCoverage: { from: "2026-06-01", to: "2026-06-30" },
        syncedAt: NOW,
        tailDate: "2026-06-30",
        freshThrough: "2026-06-30",
        verifiedAt: NOW,
      });

      expect(replaced).toEqual({ securityId, generation: 1, verifiedAt: NOW });
      const prices = await store.getDailyPrices(securityId, {
        from: "2026-06-01",
        to: "2026-06-30",
      });
      expect(prices.map((row) => row.close)).toEqual(
        dates.map((date) => (date < "2026-06-15" ? 100 : 101)),
      );
      const derived = await store.getDailyDerivedState(securityId, {
        from: "2026-06-01",
        to: "2026-06-30",
      });
      expect(derived.map((row) => row.sma20d)).toEqual(dates.map(() => 100));
      expect(await store.getPriceBasisEvents(securityId)).toEqual([
        { ...event, securityId, generation: 1 },
      ]);
      expect(
        await store.getDatasetCoverage(
          securityId,
          "DAILY_DERIVED_STATE",
          DAILY_DERIVED_STATE_VARIANT,
          { from: "2026-01-01", to: "2026-12-31" },
        ),
      ).toEqual([{ from: "2026-06-01", to: "2026-06-30" }]);
    });

    it("writes nothing when another writer replaced the history first", async () => {
      await expect(
        store.replaceDailyPriceHistory({
          securityId,
          // Stale: the previous case already moved the generation to 1.
          expectedGeneration: null,
          prices: dates.map((date) => bar(securityId, date, 7)),
          derivedRows: [],
          weeklyPrices: [],
          events: [],
          priceCoverage: { from: "2026-06-01", to: "2026-06-30" },
          derivedCoverage: { from: "2026-06-01", to: "2026-06-30" },
          syncedAt: NOW,
          tailDate: "2026-06-30",
          verifiedAt: NOW,
        }),
      ).rejects.toThrow("Stock price basis changed");
      const prices = await store.getDailyPrices(securityId, {
        from: "2026-06-01",
        to: "2026-06-30",
      });
      expect(
        prices.every((row) => row.close === 100 || row.close === 101),
      ).toBe(true);
      expect((await store.getPriceBasis(securityId))?.generation).toBe(1);
    });

    it("rolls the whole replacement back when its last step fails", async () => {
      await expect(
        store.replaceDailyPriceHistory({
          securityId,
          expectedGeneration: 1,
          prices: dates.map((date) => bar(securityId, date, 9)),
          derivedRows: dates.map((date) => ({ securityId, date, sma20d: 9 })),
          weeklyPrices: [],
          events: [{ ...event, securityId }],
          priceCoverage: { from: "2026-06-01", to: "2026-06-30" },
          derivedCoverage: { from: "2026-06-01", to: "2026-06-30" },
          syncedAt: NOW,
          tailDate: "2026-06-30",
          verifiedAt: NOW,
          assertOwned: () => {
            throw new Error("lease lost before commit");
          },
        }),
      ).rejects.toThrow("lease lost before commit");
      const prices = await store.getDailyPrices(securityId, {
        from: "2026-06-01",
        to: "2026-06-30",
      });
      expect(prices.some((row) => row.close === 9)).toBe(false);
      expect((await store.getPriceBasis(securityId))?.generation).toBe(1);
      expect(await store.getPriceBasisEvents(securityId)).toHaveLength(1);
    });

    it("creates a first verification once and never rewrites it", async () => {
      const other = (
        await createSecurity(`PV${randomUUID().slice(0, 8).toUpperCase()}`)
      ).id;
      const first = await store.createPriceBasis({
        securityId: other,
        verifiedAt: NOW,
      });
      const again = await store.createPriceBasis({
        securityId: other,
        verifiedAt: "2027-01-01T00:00:00.000Z",
      });
      expect(first).toEqual({
        securityId: other,
        generation: 1,
        verifiedAt: NOW,
      });
      expect(again).toEqual(first);
    });
  });

  describe("the loader end to end", () => {
    it("replaces a re-based history, records the split, and refuses a read pinned to the old basis", async () => {
      const created = await createSecurity(
        `PL${randomUUID().slice(0, 8).toUpperCase()}`,
      );
      const [security] = await store.findSecuritiesByIds([created.id]);
      if (!security) throw new Error("security not created");
      const sessions = weekdays("2026-07-01", TODAY);
      const exDate = "2026-08-17";
      const stored = sessions
        .filter((date) => date < "2026-08-20")
        .map((date) =>
          bar(
            security.id,
            date,
            date < exDate ? 400 + sessions.indexOf(date) : 100,
          ),
        );
      await store.saveDailyPriceSync({
        securityId: security.id,
        prices: stored,
        successfulCoverage: [
          {
            from: `${Number(TODAY.slice(0, 4)) - priceRetentionYears(30)}${TODAY.slice(4)}`,
            to: TODAY,
          },
        ],
        syncedAt: "2026-08-19T23:00:00.000Z",
        tailDate: "2026-08-19",
        freshThrough: "2026-08-19",
      });
      await store.createPriceBasis({
        securityId: security.id,
        verifiedAt: "2026-07-01T00:00:00.000Z",
      });
      // The provider's history after it re-based for a 4:1 split on 2026-08-17.
      const rebased = sessions.map((date) =>
        bar(
          security.id,
          date,
          date < exDate ? (400 + sessions.indexOf(date)) / 4 : 100,
        ),
      );
      const provider = new HistoryProvider(rebased);
      const observations: PriceBasisObservation[] = [];
      const service = new CanonicalStockDataService(
        store,
        provider,
        new RedisStockDataCache(new IoredisCacheClient(redis), 10, namespace),
        new InMemoryLoadCoordinator(),
        {
          productHistoryYears: 30,
          now: () => new Date(NOW),
          onPriceBasisEvent: (event) => observations.push(event),
        },
      );

      const before = await store.getPriceBasis(security.id);
      const prices = await service.getDailyPrices(security.symbol, {
        from: "2026-07-01",
        to: TODAY,
      });

      expect(prices.map((row) => row.close)).toEqual(
        rebased.map((row) => row.close),
      );
      const after = await store.getPriceBasis(security.id);
      expect(after?.generation).toBe((before?.generation ?? 0) + 1);
      const events = await store.getPriceBasisEvents(security.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "MEASURED",
        effectiveDate: exDate,
      });
      expect(events[0]!.priceRatio).toBeCloseTo(4, 9);
      expect(observations).toEqual([
        expect.objectContaining({ outcome: "REPLACED" }),
      ]);
      expect(
        await prisma.stockDatasetState.findUnique({
          where: {
            securityId_dataset_variant: {
              securityId: security.id,
              dataset: StockDataset.DAILY_PRICE,
              variant: DAILY_PRICE_VARIANT,
            },
          },
        }),
      ).not.toBeNull();

      // A run prepared before the replacement is refused on its next window read.
      await expect(
        service.readDailyEvaluationFrame(
          security,
          { from: "2026-07-01", to: TODAY },
          [],
          { priceBasisGeneration: before?.generation ?? null },
        ),
      ).rejects.toBeInstanceOf(PriceBasisChangedError);
      // One prepared after it reads on.
      await expect(
        service.readDailyEvaluationFrame(
          security,
          { from: "2026-07-01", to: TODAY },
          [],
          { priceBasisGeneration: after?.generation ?? null },
        ),
      ).resolves.toMatchObject({ securityId: security.id });
    });
  });
});
