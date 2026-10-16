import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  BenchmarkDailyPrice,
  DailyDerivedState,
  DailyPrice,
} from "@intrinsic/domain";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  BENCHMARK_TECHNICAL_FIELDS,
  benchmarkSessionFinalizedAt,
  buildBenchmarkTechnicalContext,
} from "./benchmark-technicals.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import { quantizeToStoredDecimal } from "./stored-decimal.js";
import { aggregateCompletedWeeks } from "./weekly.js";

loadRootEnv();
useTestDatabase();

/**
 * `quantizeToStoredDecimal` against the real thing: values written through the stock path's own
 * store into `DailyDerivedState`'s `numeric(20, 8)` columns and read back. The ETF technicals apply
 * this function so that a stock and an ETF decide identical bars identically (FIN-12); this is the
 * proof that it reproduces the write-and-read exactly, half-way cases and binary residues included.
 */
describe("the stored-decimal rounding against PostgreSQL numeric(20, 8)", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const securityIds: string[] = [];

  async function createStock(): Promise<string> {
    const symbol = `SD${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const { id } = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "Stored Decimal Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(id);
    return id;
  }

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    await prisma.$disconnect();
  });

  it("matches a write and read of the stock path on every value, bit for bit", async () => {
    const securityId = await createStock();

    // Running means of cents (the FIN-12 residues), exact half-way points at the ninth place in
    // both directions, long fractions, large and tiny magnitudes, and seeded noise.
    let state = 20_261_016;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    const values: number[] = [
      14.690000000000033,
      14.680000000000001,
      0.1 + 0.2,
      1.234567885,
      1.234567884999,
      98.765432105,
      0.000000005,
      0.000000015,
      Number("123456789.123456785"),
      99.99999999500001,
      49.999999995,
      100,
      0.5,
    ];
    for (let index = 0; index < 600; index += 1) {
      const cents = Math.floor(random() * 5_000_000) / 100;
      const window = 2 + Math.floor(random() * 200);
      values.push((cents * window + random() * 1e-6) / window);
      values.push(Math.floor(random() * 1e11) / 1e9 + 5e-9);
      values.push(random() * 1_000);
    }
    const dates = weekdays("2000-01-03", "2030-12-31").slice(0, values.length);
    const rows: DailyDerivedState[] = values.map((value, index) => ({
      securityId,
      date: dates[index]!,
      sma20d: value,
    }));
    await store.saveDailyDerivedState({
      securityId,
      rows,
      weeklyPrices: [],
      successfulCoverage: { from: dates[0]!, to: dates[dates.length - 1]! },
      syncedAt: new Date().toISOString(),
    });
    const stored = await store.getDailyDerivedState(securityId, {
      from: dates[0]!,
      to: dates[dates.length - 1]!,
    });

    expect(stored).toHaveLength(values.length);
    const mismatches = stored
      .map((row, index) => ({
        written: values[index]!,
        read: row.sma20d,
        quantized: quantizeToStoredDecimal(values[index]!),
      }))
      .filter((entry) => !Object.is(entry.read, entry.quantized));
    expect(mismatches).toEqual([]);
  });

  it("gives a stock read from PostgreSQL and an ETF identical values and identical tie decisions", async () => {
    const securityId = await createStock();
    // One tie-dense cent history (closes on three cent levels), fed to both paths.
    let state = 1_216;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    const dates = weekdays("2016-01-04", "2030-12-31").slice(0, 1_200);
    const cents = dates.map(() => 1_467 + Math.floor(random() * 3));
    const prices: DailyPrice[] = dates.map((date, index) => {
      const close = cents[index]! / 100;
      const volume = 900_000 + Math.floor(random() * 200_000);
      return {
        securityId,
        date,
        open: close,
        high: close + 0.05,
        low: close - 0.05,
        close,
        volume,
      };
    });
    const last = dates[dates.length - 1]!;

    // The stock: calculated, written to `DailyDerivedState`, read back.
    await store.saveDailyDerivedState({
      securityId,
      rows: buildDailyDerivedState({
        prices,
        weeklyBars: aggregateCompletedWeeks(prices, last, {
          historyStart: dates[0]!,
          historyStartOrigin: "LISTING",
        }),
      }),
      weeklyPrices: [],
      successfulCoverage: { from: dates[0]!, to: last },
      syncedAt: new Date().toISOString(),
    });
    const stock = await store.getDailyDerivedState(securityId, {
      from: dates[0]!,
      to: last,
    });

    // The ETF: the same bars through the benchmark adapter, in memory.
    const seriesId = "series-stored-decimal";
    const bars: BenchmarkDailyPrice[] = prices.map(
      ({ securityId: _securityId, ...bar }) => ({
        ...bar,
        seriesId,
      }),
    );
    const finalized = benchmarkSessionFinalizedAt(last, 0).getTime();
    const context = buildBenchmarkTechnicalContext({
      seriesId,
      history: {
        seriesId,
        basisGeneration: 1,
        rows: bars,
        missing: [],
        source: "REDIS",
      },
      refreshState: {
        lastTailSyncAt: new Date(finalized + 60_000).toISOString(),
      },
      missingFromFloor: [],
      now: new Date(finalized + 120_000),
      publicationDelayMs: 0,
    });
    if (context.status !== "READY") {
      throw new Error(`Expected READY, got ${context.status}`);
    }
    const etf = context.snapshot;

    expect(stock.map((row) => row.date)).toEqual(etf.dates);
    const differences: Array<{
      date: string;
      field: string;
      stock: number | null;
      etf: number;
    }> = [];
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      const column = etf.columns.get(field)!;
      stock.forEach((row, index) => {
        const stockValue = row[field] ?? Number.NaN;
        if (!Object.is(stockValue, column[index])) {
          differences.push({
            date: row.date,
            field,
            stock: row[field] ?? null,
            etf: column[index]!,
          });
        }
      });
    }
    expect(differences).toEqual([]);

    // Every exact tie against a daily SMA (found in integer cents) reads as a tie on both paths.
    let ties = 0;
    for (const period of [20, 50, 100, 200] as const) {
      const field = `sma${period}d` as const;
      let windowSum = 0;
      cents.forEach((close, index) => {
        windowSum += close;
        if (index >= period) {
          windowSum -= cents[index - period]!;
        }
        if (index + 1 >= period && windowSum === close * period) {
          ties += 1;
          expect([
            stock[index]![field],
            etf.columns.get(field)![index],
          ]).toEqual([prices[index]!.close, prices[index]!.close]);
        }
      });
    }
    expect(ties).toBeGreaterThan(50);
  });
});
