import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  CALCULATED_SERIES_DECIMAL,
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  FUNDAMENTAL_METRIC_FIELDS,
  FUNDAMENTAL_METRICS,
  isRepresentableCalculatedSeriesValue,
  MATERIALIZED_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
  type DailyDerivedState,
  type DailyPrice,
  type FundamentalMetricField,
  type FundamentalMetricSnapshot,
} from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { materializeDailyFundamentals } from "./fundamental-metrics-materializer.js";
import {
  GOLDEN_EXPECTED,
  goldenStatements,
  SECURITY_ID as FIXTURE_SECURITY_ID,
} from "./fundamental-metrics.test-helper.js";
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
      for (const oscillator of DAILY_OSCILLATORS) {
        if (original[oscillator.field] === undefined) {
          expect(row[oscillator.field]).toBeUndefined();
        } else {
          expect(row[oscillator.field]).toBeCloseTo(
            original[oscillator.field]!,
            7,
          );
        }
      }
      for (const entry of DAILY_RELATIVE_VOLUMES) {
        if (original[entry.field] === undefined) {
          expect(row[entry.field]).toBeUndefined();
        } else {
          expect(row[entry.field]).toBeCloseTo(original[entry.field]!, 7);
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
    // The registry-driven loop above and below would pass vacuously over an emptied registry.
    expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
    for (const oscillator of DAILY_OSCILLATORS) {
      expect(expected[oscillator.field]).toBeDefined();
      expect(read?.[oscillator.field]).toBeCloseTo(
        expected[oscillator.field]!,
        7,
      );
    }
    expect(DAILY_RELATIVE_VOLUMES.length).toBeGreaterThan(0);
    for (const entry of DAILY_RELATIVE_VOLUMES) {
      expect(expected[entry.field]).toBeDefined();
      expect(read?.[entry.field]).toBeCloseTo(expected[entry.field]!, 7);
    }
    expect(read?.weeklySourceWeekStart).toBe(expected.weeklySourceWeekStart);
  });

  it("has a PostgreSQL column for every registered moving average", async () => {
    // The wide-column model means a registry entry is only real once a migration adds its column.
    // Without this guard, adding a period and forgetting the migration persists nothing at all:
    // the mapper writes a key Prisma silently ignores and every read returns absent, which is
    // indistinguishable from a warm-up gap. Asserted against the live schema, not the Prisma
    // client's types, so a drifted migration is caught too.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'DailyDerivedState'
    `;
    const columnNames = new Set(columns.map((column) => column.column_name));

    expect(columnNames.size).toBeGreaterThan(0);
    for (const average of MATERIALIZED_MOVING_AVERAGES) {
      expect(columnNames).toContain(average.field);
    }
    for (const oscillator of DAILY_OSCILLATORS) {
      expect(columnNames).toContain(oscillator.field);
    }
    for (const entry of DAILY_RELATIVE_VOLUMES) {
      expect(columnNames).toContain(entry.field);
    }
  });

  it("stores every calculated series in exactly the range the calculations guard", async () => {
    // A calculation refuses a value its column cannot hold (`isRepresentableCalculatedSeriesValue`)
    // instead of letting PostgreSQL fail the rebuild. That guard is only right while it states the
    // same range as the live columns, so both the declared type and its boundary are asserted here.
    const columns = await prisma.$queryRaw<
      {
        column_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }[]
    >`
      SELECT column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name = 'DailyDerivedState' AND data_type = 'numeric'
    `;

    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(
        { precision: column.numeric_precision, scale: column.numeric_scale },
        column.column_name,
      ).toEqual(CALCULATED_SERIES_DECIMAL);
    }

    // The boundary as PostgreSQL applies it to that type, given the decimal text Prisma sends for a
    // number: the largest double below 10^12 is stored, 10^12 itself is refused.
    const { precision, scale } = CALCULATED_SERIES_DECIMAL;
    const store = (value: number) =>
      prisma.$queryRawUnsafe<{ stored: string }[]>(
        `SELECT CAST($1::text AS NUMERIC(${precision}, ${scale}))::text AS stored`,
        String(value),
      );
    const largestBelow = 1e12 - 2 ** -13;
    for (const value of [largestBelow, -largestBelow]) {
      expect(isRepresentableCalculatedSeriesValue(value)).toBe(true);
      const [row] = await store(value);
      expect(Math.abs(Number(row?.stored))).toBeLessThan(1e12);
    }
    for (const value of [1e12, -1e12]) {
      expect(isRepresentableCalculatedSeriesValue(value)).toBe(false);
      await expect(store(value)).rejects.toThrow(/overflow/i);
    }
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
    // The first trading day has no oscillator warm-up either: absent, not zero.
    for (const oscillator of DAILY_OSCILLATORS) {
      expect(read && oscillator.field in read).toBe(false);
      expect(read?.[oscillator.field]).toBeUndefined();
    }
    // Nor any Relative Volume: the first session has no previous sessions to average.
    for (const entry of DAILY_RELATIVE_VOLUMES) {
      expect(read && entry.field in read).toBe(false);
      expect(read?.[entry.field]).toBeUndefined();
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
    for (const oscillator of DAILY_OSCILLATORS) {
      expect(stored[oscillator.field]).toBeNull();
    }
    for (const entry of DAILY_RELATIVE_VOLUMES) {
      expect(stored[entry.field]).toBeNull();
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

/**
 * PostgreSQL round trip of the fifteen Fundamental Metrics columns.
 *
 * Values cross `DECIMAL(20,8)`, so expectations are the stored quantum written as literals (rounded
 * half away from zero at the eighth decimal), never the pre-quantization double.
 */
describe("fundamental metrics persistence", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const symbol = `F${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  let securityId = "";

  /** Full-precision golden values and their stored quanta. */
  const POSITIVE: Record<FundamentalMetricField, [number, number]> = {
    revenueGrowthTtmYoy: [GOLDEN_EXPECTED.revenueGrowthTtmYoy, 17.39130435],
    epsGrowthTtmYoy: [GOLDEN_EXPECTED.epsGrowthTtmYoy, 27.27272727],
    fcfGrowthTtmYoy: [GOLDEN_EXPECTED.fcfGrowthTtmYoy, 25],
    grossMarginTtm: [GOLDEN_EXPECTED.grossMarginTtm, 44.81481481],
    operatingMarginTtm: [GOLDEN_EXPECTED.operatingMarginTtm, 18.14814815],
    netMarginTtm: [GOLDEN_EXPECTED.netMarginTtm, 11.66666667],
    fcfMarginTtm: [GOLDEN_EXPECTED.fcfMarginTtm, 18.51851852],
    roicTtm: [GOLDEN_EXPECTED.roicTtm, 14.07636364],
    roeTtm: [GOLDEN_EXPECTED.roeTtm, 14],
    roaTtm: [GOLDEN_EXPECTED.roaTtm, 5.72727273],
    debtToEquity: [GOLDEN_EXPECTED.debtToEquity, 0.44],
    currentRatio: [GOLDEN_EXPECTED.currentRatio, 1.6],
    netDebtToEbitdaTtm: [GOLDEN_EXPECTED.netDebtToEbitdaTtm, 0.76923077],
    interestCoverageTtm: [GOLDEN_EXPECTED.interestCoverageTtm, 10.6],
    assetTurnoverTtm: [GOLDEN_EXPECTED.assetTurnoverTtm, 0.49090909],
  };

  /** The metrics whose methodology allows a negative reading, with their stored quanta. */
  const NEGATIVE: Partial<Record<FundamentalMetricField, [number, number]>> = {
    revenueGrowthTtmYoy: [-10.370370370370372, -10.37037037],
    grossMarginTtm: [-7.181818181818182, -7.18181818],
    operatingMarginTtm: [-4.090909090909091, -4.09090909],
    netMarginTtm: [-0.123456789, -0.12345679],
    fcfMarginTtm: [-2.5, -2.5],
    roicTtm: [-7.181818181818182, -7.18181818],
    roeTtm: [-10, -10],
    roaTtm: [-4.090909090909091, -4.09090909],
    netDebtToEbitdaTtm: [-2, -2],
    interestCoverageTtm: [-2.5, -2.5],
  };

  function row(
    date: string,
    values: Partial<Record<FundamentalMetricField, number>>,
  ): DailyDerivedState {
    return { securityId, date, sma20d: 100, ...values };
  }

  function valuesOf(
    table: Partial<Record<FundamentalMetricField, [number, number]>>,
    index: 0 | 1,
  ): FundamentalMetricSnapshot {
    return Object.fromEntries(
      Object.entries(table).map(([field, pair]) => [field, pair![index]]),
    );
  }

  beforeAll(async () => {
    const security = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "Fundamental Persistence Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityId = security.id;
  });

  afterAll(async () => {
    if (securityId) {
      await prisma.security.delete({ where: { id: securityId } });
    }
    await prisma.$disconnect();
  });

  it("has a nullable DECIMAL(20,8) column for every registered metric", async () => {
    const columns = await prisma.$queryRaw<
      {
        column_name: string;
        data_type: string;
        numeric_precision: number;
        numeric_scale: number;
        is_nullable: string;
      }[]
    >`
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'DailyDerivedState'
    `;
    const byName = new Map(
      columns.map((column) => [column.column_name, column]),
    );

    expect(FUNDAMENTAL_METRICS).toHaveLength(15);
    for (const metric of FUNDAMENTAL_METRICS) {
      expect(byName.get(metric.field), metric.field).toMatchObject({
        data_type: "numeric",
        numeric_precision: 20,
        numeric_scale: 8,
        is_nullable: "YES",
      });
    }
    // Still one row per (securityId, date): no calculation revision joined the identity.
    const key = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'DailyDerivedState' AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `;
    expect(key.map((column) => column.column_name)).toEqual([
      "securityId",
      "date",
    ]);
    // The metrics live on the unified row only: no snapshot, EAV or per-family table exists.
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name ILIKE '%fundamental%' OR table_name ILIKE '%metric%')
    `;
    expect(tables).toEqual([]);
  });

  it("round-trips positive, negative, zero and absent values at storage precision", async () => {
    const zero = Object.fromEntries(
      FUNDAMENTAL_METRIC_FIELDS.map((field) => [field, 0]),
    );
    const written = [
      row("2026-03-02", valuesOf(POSITIVE, 0)),
      row("2026-03-03", valuesOf(NEGATIVE, 0)),
      row("2026-03-04", zero),
      row("2026-03-05", {}),
    ];
    await store.saveDailyDerivedState({
      securityId,
      rows: written,
      weeklyPrices: [],
      successfulCoverage: { from: "2026-03-02", to: "2026-03-05" },
      syncedAt: "2026-03-05T21:00:00.000Z",
    });

    const [positive, negative, zeros, absent] =
      await store.getDailyDerivedState(securityId, {
        from: "2026-03-02",
        to: "2026-03-05",
      });

    expect(positive).toEqual(row("2026-03-02", valuesOf(POSITIVE, 1)));
    expect(negative).toEqual(row("2026-03-03", valuesOf(NEGATIVE, 1)));
    // A real zero stays a present zero.
    expect(zeros).toEqual(row("2026-03-04", zero));
    // Absence stays absence: no key at all, not null and not zero.
    expect(absent).toEqual(row("2026-03-05", {}));
    for (const field of FUNDAMENTAL_METRIC_FIELDS) {
      expect(absent && field in absent, field).toBe(false);
    }

    const stored = await prisma.dailyDerivedState.findMany({
      where: { securityId },
      orderBy: { date: "asc" },
    });
    for (const field of FUNDAMENTAL_METRIC_FIELDS) {
      expect(stored[3]?.[field], field).toBeNull();
      expect(stored[2]?.[field]?.toString(), field).toBe("0");
    }
    // Metrics that cannot be negative were left out of the negative row, and stay NULL.
    expect(stored[1]?.debtToEquity).toBeNull();
    expect(stored[1]?.currentRatio).toBeNull();
  });

  it("round-trips very large finite values inside the column's bounds exactly", async () => {
    const written = [
      row("2026-04-01", {
        revenueGrowthTtmYoy: 999_999_999_999.9999,
        interestCoverageTtm: 987_654_321_098.5,
        netDebtToEbitdaTtm: -987_654_321_098.5,
      }),
    ];
    await store.saveDailyDerivedState({
      securityId,
      rows: written,
      weeklyPrices: [],
      successfulCoverage: { from: "2026-04-01", to: "2026-04-01" },
      syncedAt: "2026-04-01T21:00:00.000Z",
    });

    await expect(
      store.getDailyDerivedState(securityId, {
        from: "2026-04-01",
        to: "2026-04-01",
      }),
    ).resolves.toEqual(written);
  });

  it("rejects a value outside DECIMAL(20,8) instead of storing a clamped or infinite number", async () => {
    const date = "2026-04-02";
    const good = row(date, { roicTtm: 12.5 });
    await store.saveDailyDerivedState({
      securityId,
      rows: [good],
      weeklyPrices: [],
      successfulCoverage: { from: date, to: date },
      syncedAt: "2026-04-02T21:00:00.000Z",
    });

    // 1e12 needs thirteen integer digits: PostgreSQL refuses it. Non-finite values are refused by
    // the store before Prisma could write them as NULL.
    for (const value of [
      1e12,
      -1e12,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]) {
      await expect(
        store.saveDailyDerivedState({
          securityId,
          rows: [row(date, { roicTtm: value })],
          weeklyPrices: [],
          successfulCoverage: { from: date, to: date },
          syncedAt: "2026-04-02T22:00:00.000Z",
        }),
      ).rejects.toThrow();
    }
    // The replacement ran in one transaction: the previously stored row is untouched.
    await expect(
      store.getDailyDerivedState(securityId, { from: date, to: date }),
    ).resolves.toEqual([good]);
  });

  it("stores the materialized snapshot on the same daily row as technical and intrinsic state", async () => {
    const prices: DailyPrice[] = [];
    for (let day = 0; prices.length < 30; day += 1) {
      const date = addDays("2026-05-04", day);
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        prices.push({
          securityId,
          date,
          open: 100,
          high: 101,
          low: 99,
          close: 100 + prices.length,
          volume: 1_000,
        });
      }
    }
    const statements = goldenStatements({ available: "2026-05-01" }).map(
      (each) => ({ ...each, securityId }),
    );
    expect(statements[0]?.securityId).not.toBe(FIXTURE_SECURITY_ID);
    const fundamentalStates = materializeDailyFundamentals({
      securityId,
      tradingDates: prices.map((price) => price.date),
      statements,
    });
    const rows = buildDailyDerivedState({
      prices,
      fundamentalStates,
      intrinsicStates: [
        {
          date: prices.at(-1)!.date,
          intrinsicValues: { GRAHAM: 148 },
          grahamSourceAsOf: "2026-05-01T00:00:00.000Z",
          intrinsicCurrency: "USD",
        },
      ],
    });
    await store.saveDailyDerivedState({
      securityId,
      rows,
      weeklyPrices: [],
      successfulCoverage: { from: prices[0]!.date, to: prices.at(-1)!.date },
      syncedAt: "2026-06-12T21:00:00.000Z",
    });

    const [last] = await store.getDailyDerivedState(securityId, {
      from: prices.at(-1)!.date,
      to: prices.at(-1)!.date,
    });
    expect(last?.sma20d).toBeCloseTo(
      prices.slice(-20).reduce((sum, price) => sum + price.close, 0) / 20,
      7,
    );
    expect(last?.rsi14d).toBeDefined();
    expect(last?.intrinsicValues).toEqual({ GRAHAM: 148 });
    for (const [field, quanta] of Object.entries(POSITIVE)) {
      expect(last?.[field as FundamentalMetricField], field).toBe(quanta[1]);
    }
  });
});
