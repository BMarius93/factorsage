import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  MATERIALIZED_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
  type DailyDerivedState,
  type DailyPrice,
} from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import { aggregateCompletedWeeks } from "./weekly.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

const START_MONDAY = "2020-01-06";
// Long enough that every catalog period, including SMA/EMA 200W, warms up before the last row.
const WEEKS = 205;
const SYNCED_AT = "2021-03-01T21:00:00.000Z";

function closeAt(index: number): number {
  return 100 + (index % 29) * 0.75 + index * 0.05;
}

function tradingDays(securityId: string): DailyPrice[] {
  const rows: DailyPrice[] = [];
  for (let week = 0; week < WEEKS; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const close = closeAt(rows.length);
      rows.push({
        securityId,
        date: addDays(START_MONDAY, week * 7 + day),
        open: close - 1,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1_000 + rows.length,
      });
    }
  }
  return rows;
}

/**
 * PostgreSQL round trip of the unified daily derived state.
 *
 * The suite exercises the real `PrismaStockDataStore` against the migrated test database, so it
 * fails if a schema column, a Prisma mapping or the ascending range read drops one of the
 * supported daily/weekly technical or intrinsic-value fields.
 */
describe("daily derived state persistence", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const symbol = `W${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  let securityId = "";
  let rows: DailyDerivedState[] = [];
  let prices: DailyPrice[] = [];

  beforeAll(async () => {
    const security = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "Weekly Persistence Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityId = security.id;
    prices = tradingDays(securityId);
    const lastDate = prices.at(-1)!.date;
    const weeklyBars = aggregateCompletedWeeks(prices, addDays(lastDate, 3));

    // Intrinsic values are attached to the second half of the history so the same round trip also
    // proves the unavailable-versus-materialized boundary survives persistence.
    const firstValuationDate = prices[Math.floor(prices.length / 2)]!.date;
    rows = buildDailyDerivedState({ prices, weeklyBars }).map((row) =>
      row.date < firstValuationDate
        ? row
        : {
            ...row,
            intrinsicValues: {
              DCF_FCFF: 180.25,
              RESIDUAL_INCOME: 150.5,
              GRAHAM: 120.125,
            },
            intrinsicValueBlends: {
              BALANCED: 0.5 * 180.25 + 0.3 * 150.5 + 0.2 * 120.125,
              CONSERVATIVE: 0.4 * 180.25 + 0.3 * 150.5 + 0.3 * 120.125,
            },
            dcfFcffSourceAsOf: "2020-06-30T20:00:00.000Z",
            residualIncomeSourceAsOf: "2020-06-30T20:00:00.000Z",
            grahamSourceAsOf: "2020-05-15T20:00:00.000Z",
            intrinsicCurrency: "USD",
          },
    );

    await store.saveDailyDerivedState({
      securityId,
      rows,
      weeklyPrices: weeklyBars,
      successfulCoverage: { from: prices[0]!.date, to: lastDate },
      syncedAt: SYNCED_AT,
    });
  });

  afterAll(async () => {
    if (securityId) {
      await prisma.security.delete({ where: { id: securityId } });
    }
    await prisma.$disconnect();
  });

  it("writes exactly one row per trading day", async () => {
    await expect(
      prisma.dailyDerivedState.count({ where: { securityId } }),
    ).resolves.toBe(prices.length);
  });

  it("returns an ascending date range read matching what was written", async () => {
    const read = await store.getDailyDerivedState(securityId, {
      from: prices[0]!.date,
      to: prices.at(-1)!.date,
    });

    expect(read.map((row) => row.date)).toEqual(rows.map((row) => row.date));
    expect([...read].sort((a, b) => a.date.localeCompare(b.date))).toEqual(
      read,
    );

    // Values go through DECIMAL(20,8), so the round trip is compared field by field with the
    // column's own precision rather than by float identity. Which fields are present is compared
    // exactly: an unavailable value must not appear, and a materialized one must not vanish.
    read.forEach((row, index) => {
      const original = rows[index]!;
      expect(Object.keys(row).sort()).toEqual(Object.keys(original).sort());
      for (const average of MATERIALIZED_MOVING_AVERAGES) {
        if (original[average.field] === undefined) {
          expect(row[average.field]).toBeUndefined();
        } else {
          expect(row[average.field]).toBeCloseTo(original[average.field]!, 7);
        }
      }
      expect(row.weeklySourceWeekStart).toBe(original.weeklySourceWeekStart);
      expect(row.intrinsicValues).toEqual(original.intrinsicValues);
      expect(row.intrinsicValueBlends).toEqual(original.intrinsicValueBlends);
    });
  });

  it("survives the round trip for every supported daily and weekly technical field", async () => {
    const lastDate = prices.at(-1)!.date;
    const [read] = await store.getDailyDerivedState(securityId, {
      from: lastDate,
      to: lastDate,
    });
    const expected = rows.at(-1)!;

    for (const average of MATERIALIZED_MOVING_AVERAGES) {
      expect(expected[average.field]).toBeDefined();
      expect(read?.[average.field]).toBeCloseTo(expected[average.field]!, 7);
    }
    expect(read?.weeklySourceWeekStart).toBe(expected.weeklySourceWeekStart);
  });

  it("keeps unavailable technical values absent instead of turning them into zero", async () => {
    const earlyDate = prices[0]!.date;
    const [read] = await store.getDailyDerivedState(securityId, {
      from: earlyDate,
      to: earlyDate,
    });

    for (const average of WEEKLY_MOVING_AVERAGES) {
      expect(read && average.field in read).toBe(false);
      expect(read?.[average.field]).toBeUndefined();
    }
    expect(read?.sma200d).toBeUndefined();

    const stored = await prisma.dailyDerivedState.findUniqueOrThrow({
      where: {
        securityId_date: {
          securityId,
          date: new Date(`${earlyDate}T00:00:00.000Z`),
        },
      },
    });
    for (const average of WEEKLY_MOVING_AVERAGES) {
      expect(stored[average.field]).toBeNull();
    }
  });

  it("round-trips intrinsic-value models, blends and per-model provenance unchanged", async () => {
    const lastDate = prices.at(-1)!.date;
    const [read] = await store.getDailyDerivedState(securityId, {
      from: lastDate,
      to: lastDate,
    });
    const expected = rows.at(-1)!;

    expect(read?.intrinsicValues).toEqual(expected.intrinsicValues);
    expect(read?.intrinsicValueBlends).toEqual(expected.intrinsicValueBlends);
    expect(read?.dcfFcffSourceAsOf).toBe(expected.dcfFcffSourceAsOf);
    expect(read?.residualIncomeSourceAsOf).toBe(
      expected.residualIncomeSourceAsOf,
    );
    expect(read?.grahamSourceAsOf).toBe(expected.grahamSourceAsOf);
    // DDM was never eligible for this security, so it must stay absent rather than become zero.
    expect(read?.intrinsicValues?.DDM).toBeUndefined();
    expect(read?.ddmSourceAsOf).toBeUndefined();
    expect(read?.intrinsicValueBlends?.DIVIDEND).toBeUndefined();
    expect(read?.intrinsicCurrency).toBe("USD");
  });

  it("does not expose a weekly value before the trading day it became eligible on", async () => {
    // The twentieth completed week is the first that can carry SMA 20W.
    const eligibleDate = addDays(START_MONDAY, 19 * 7 + 4);
    const window = await store.getDailyDerivedState(securityId, {
      from: addDays(eligibleDate, -7),
      to: eligibleDate,
    });

    const eligible = window.at(-1);
    expect(eligible?.date).toBe(eligibleDate);
    expect(eligible?.sma20w).toBeDefined();
    for (const row of window.slice(0, -1)) {
      expect(row.sma20w).toBeUndefined();
    }
  });

  it("records the coverage watermark under the current methodology revision only", async () => {
    await expect(
      store.getDatasetState(
        securityId,
        "DAILY_DERIVED_STATE",
        DAILY_DERIVED_STATE_VARIANT,
      ),
    ).resolves.toMatchObject({
      variant: `daily-derived-state:r${DERIVED_STATE_REVISION}`,
      lastSyncedAt: SYNCED_AT,
    });

    // A superseded revision reports nothing, which is what forces a rebuild instead of letting
    // rows without weekly values pass as complete weekly coverage.
    await expect(
      store.getDatasetState(
        securityId,
        "DAILY_DERIVED_STATE",
        `daily-derived-state:r${DERIVED_STATE_REVISION - 1}`,
      ),
    ).resolves.toBeNull();
    await expect(
      store.getDatasetCoverage(
        securityId,
        "DAILY_DERIVED_STATE",
        `daily-derived-state:r${DERIVED_STATE_REVISION - 1}`,
        { from: prices[0]!.date, to: prices.at(-1)!.date },
      ),
    ).resolves.toEqual([]);
  });

  it("replaces rather than versions the rows of a rebuilt trading day", async () => {
    const rebuiltFrom = prices[prices.length - 10]!.date;
    const rebuilt = rows
      .filter((row) => row.date >= rebuiltFrom)
      .map((row) => ({ ...row, sma20w: 1.5 }));

    await store.saveDailyDerivedState({
      securityId,
      rows: rebuilt,
      weeklyPrices: [],
      successfulCoverage: { from: rebuiltFrom, to: prices.at(-1)!.date },
      syncedAt: "2021-03-02T21:00:00.000Z",
    });

    await expect(
      prisma.dailyDerivedState.count({ where: { securityId } }),
    ).resolves.toBe(prices.length);
    const read = await store.getDailyDerivedState(securityId, {
      from: rebuiltFrom,
      to: prices.at(-1)!.date,
    });
    expect(read.every((row) => row.sma20w === 1.5)).toBe(true);
  });
});
