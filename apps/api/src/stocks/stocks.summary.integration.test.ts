import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { SecurityType, StockDataset } from "@intrinsic/database";
import {
  FUNDAMENTAL_METRIC_IDS,
  STOCK_DETAILS_MAX_HISTORY_YEARS,
  STOCK_SUMMARY_TECHNICAL_IDS,
  VALUATION_RATIO_IDS,
  type StockSummaryResponse,
} from "@intrinsic/contracts";
import type { DateRange, StockSplit } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  DAILY_DERIVED_STATE_VARIANT,
  fundamentalsDatasetOperations,
  InMemoryLoadCoordinator,
  NullStockDataCache,
  PrismaStockDataStore,
  priceRetentionYears,
  subtractYears,
} from "@intrinsic/stock-data";
import { useIsolatedRateLimits, useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { eodToday } from "../eod-today";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
} from "./stock-data.tokens";

useTestDatabase();
useIsolatedRateLimits();

/** The loader's own "today": the newest date whose bar is final. */
const today = eodToday();
const retentionStart = subtractYears(
  today,
  priceRetentionYears(STOCK_DETAILS_MAX_HISTORY_YEARS),
);

function daysBeforeToday(days: number): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * The fixture's sessions, anchored to the run day so they always sit inside the summary's trailing
 * year: before the statements are public, the session they become public on, then the newest one.
 */
const BEFORE = daysBeforeToday(12);
const PUBLIC = daysBeforeToday(10);
const NEWEST = daysBeforeToday(9);
/** Filed the day before `PUBLIC`, so public from `PUBLIC` (filing plus one day). */
const FILED = daysBeforeToday(11);

/**
 * On `NEWEST` at a close of 120 and 1,111,000 diluted shares the market capitalisation is 133.32M:
 * net income TTM 12M, revenue TTM 6M, equity 4M, free cash flow TTM 3M, EBITDA TTM 4M and net debt
 * -355.52M give these five ratios, written out by hand.
 */
const RATIOS_ON_NEWEST: Record<string, number> = {
  PRICE_TO_EARNINGS_TTM: 11.11,
  PRICE_TO_SALES_TTM: 22.22,
  PRICE_TO_BOOK: 33.33,
  PRICE_TO_FCF_TTM: 44.44,
  EV_TO_EBITDA_TTM: -55.55,
};

class SummaryProvider implements FmpStockProviderPort {
  readonly splitCalls: string[] = [];
  /** Symbols whose split-list read the provider refuses. */
  readonly refuseSplitsFor = new Set<string>();

  async getStockSplits(symbol: string): Promise<StockSplit[]> {
    this.splitCalls.push(symbol);
    if (this.refuseSplitsFor.has(symbol)) {
      throw new Error("The provider refused the split list");
    }
    return [];
  }
  async getProfile() {
    return null;
  }
  async getDailyPrices(
    _symbol: string,
    _securityId: string,
    _range: DateRange,
  ) {
    return [];
  }
  async getFinancialStatements() {
    return [];
  }
}

describe("GET /stocks/:symbol/summary", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const summarySymbol = `S${suffix}`;
  const staleSplitsSymbol = `T${suffix}`;
  const unknownSymbol = `U${suffix}`;
  const provider = new SummaryProvider();

  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useValue(provider)
      .overrideProvider(STOCK_DATA_CACHE)
      .useValue(new NullStockDataCache())
      .overrideProvider(STOCK_DATA_COORDINATOR)
      .useValue(new InMemoryLoadCoordinator())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    await seedSecurity(summarySymbol, new Date().toISOString());
    // A split list read three days ago: the summary must ask the provider for it again.
    await seedSecurity(
      staleSplitsSymbol,
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    );
    provider.refuseSplitsFor.add(staleSplitsSymbol);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: [summarySymbol, staleSplitsSymbol] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  /**
   * One complete, current security: three sessions of prices and derived state, four public quarters,
   * a verified price basis and every dataset synchronized — so a read reaches no provider except for
   * a split list older than a day.
   */
  async function seedSecurity(symbol: string, splitsSyncedAt: string) {
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "Summary Test Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
        sector: "Technology",
        profile: { create: { description: "Summary fixture", employees: 42 } },
      },
    });
    const store = new PrismaStockDataStore(prisma);
    const syncedAt = new Date().toISOString();
    await store.saveDailyPriceSync({
      securityId: row.id,
      prices: (
        [
          [BEFORE, 100, 101, 95],
          [PUBLIC, 110, 140, 105],
          [NEWEST, 120, 121, 119],
        ] as const
      ).map(([date, close, high, low]) => ({
        securityId: row.id,
        date,
        open: close,
        high,
        low,
        close,
        volume: 5_000,
      })),
      successfulCoverage: [{ from: retentionStart, to: today }],
      syncedAt,
      tailDate: today,
      freshThrough: today,
    });
    await prisma.dailyDerivedState.createMany({
      data: [
        {
          securityId: row.id,
          date: new Date(`${BEFORE}T00:00:00.000Z`),
          ema50d: 99.5,
          ema200d: 90.25,
          rsi14d: 48.2,
          roicTtm: 12.5,
          currentRatio: 1.75,
        },
        {
          securityId: row.id,
          date: new Date(`${PUBLIC}T00:00:00.000Z`),
          ema50d: 101.5,
          ema200d: 91.25,
          rsi14d: 61.4,
          roicTtm: 13.5,
          currentRatio: 1.8,
          roeTtm: -5,
          dcfFcff: 150,
          dcfFcffSourceAsOf: new Date(`${PUBLIC}T00:00:00.000Z`),
          intrinsicCurrency: "USD",
        },
        {
          securityId: row.id,
          date: new Date(`${NEWEST}T00:00:00.000Z`),
          ema50d: 102.75,
          ema200d: 92.5,
          rsi14d: 64.8,
          roicTtm: 14.5,
          // Current Ratio was invalidated on the newest session; the summary keeps PUBLIC's.
          roeTtm: -6,
          netDebtToEbitdaTtm: -0.4,
          dcfFcff: 151,
          dcfFcffSourceAsOf: new Date(`${PUBLIC}T00:00:00.000Z`),
          intrinsicCurrency: "USD",
        },
      ],
    });
    await prisma.stockDatasetCoverage.create({
      data: {
        securityId: row.id,
        dataset: StockDataset.DAILY_DERIVED_STATE,
        variant: DAILY_DERIVED_STATE_VARIANT,
        fromDate: new Date(`${retentionStart}T00:00:00.000Z`),
        toDate: new Date(`${today}T00:00:00.000Z`),
        lastSuccessfulSyncAt: new Date(),
      },
    });
    await prisma.stockDatasetState.create({
      data: {
        securityId: row.id,
        dataset: StockDataset.DAILY_DERIVED_STATE,
        variant: DAILY_DERIVED_STATE_VARIANT,
        earliestDate: new Date(`${retentionStart}T00:00:00.000Z`),
        latestDate: new Date(`${today}T00:00:00.000Z`),
        lastSuccessfulSyncAt: new Date(),
      },
    });
    const periodEnd = { Q1: "03-31", Q2: "06-30", Q3: "09-30", Q4: "12-31" };
    await store.saveFinancialStatements({
      securityId: row.id,
      statements: (["Q1", "Q2", "Q3", "Q4"] as const).flatMap((period) => {
        const common = {
          securityId: row.id,
          fiscalDate: `2025-${periodEnd[period]}`,
          fiscalYear: 2025,
          period,
          reportedCurrency: "USD",
          filingDate: FILED,
        };
        return [
          {
            ...common,
            statementType: "INCOME" as const,
            values: {
              weightedAverageShsOutDil: 1_111_000,
              netIncome: 3_000_000,
              revenue: 1_500_000,
              ebitda: 1_000_000,
            },
          },
          {
            ...common,
            statementType: "CASH_FLOW" as const,
            values: {
              operatingCashFlow: 1_000_000,
              capitalExpenditure: -250_000,
            },
          },
          {
            ...common,
            statementType: "BALANCE_SHEET" as const,
            values: {
              totalStockholdersEquity: 4_000_000,
              netDebt: -355_520_000,
            },
          },
        ];
      }),
      syncedAt,
    });
    for (const operation of fundamentalsDatasetOperations(
      STOCK_DETAILS_MAX_HISTORY_YEARS,
    )) {
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: operation.dataset,
        variant: operation.variant,
        syncedAt,
      });
    }
    await store.upsertDatasetState({
      securityId: row.id,
      dataset: "SECURITY_PROFILE",
      variant: "",
      syncedAt,
    });
    await store.createPriceBasis({
      securityId: row.id,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.replaceStockSplits({
      securityId: row.id,
      splits: [],
      syncedAt: splitsSyncedAt,
    });
  }

  async function summary(symbol: string): Promise<StockSummaryResponse> {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${symbol}/summary`)
      .expect(200);
    return response.body as StockSummaryResponse;
  }

  it("answers the latest state of every section, and no history", async () => {
    const body = await summary(summarySymbol);

    expect(body.security).toMatchObject({
      symbol: summarySymbol,
      name: "Summary Test Corp",
      sector: "Technology",
    });
    expect(body.profile).toMatchObject({ employees: 42 });
    expect(body.window.to).toBe(today);
    expect(body.quote).toEqual({
      date: NEWEST,
      open: 120,
      high: 121,
      low: 119,
      close: 120,
      volume: 5_000,
      previousDate: PUBLIC,
      previousClose: 110,
      rangeHigh: 140,
      rangeLow: 95,
    });
    // The page's chart owns history: nothing here is a series, and the payload stays small.
    expect(Object.keys(body).sort()).toEqual(
      [
        "fundamentals",
        "intrinsicValueBlends",
        "intrinsicValues",
        "latestQuarter",
        "profile",
        "quote",
        "security",
        "technicals",
        "valuationRatios",
        "window",
      ].sort(),
    );
    expect(JSON.stringify(body).length).toBeLessThan(8_000);
  });

  it("states all five ratios on the newest session, hand-computed, and agrees with the ratio history read", async () => {
    const body = await summary(summarySymbol);
    expect(body.valuationRatios.status).toBe("AVAILABLE");
    if (body.valuationRatios.status !== "AVAILABLE") {
      return;
    }
    expect(body.valuationRatios.readings.map((r) => r.id)).toEqual([
      ...VALUATION_RATIO_IDS,
    ]);
    for (const reading of body.valuationRatios.readings) {
      expect(reading.date, reading.id).toBe(NEWEST);
      expect(reading.value, reading.id).toBeCloseTo(
        RATIOS_ON_NEWEST[reading.id] as number,
        10,
      );
      const history = await request(app.getHttpServer())
        .get(
          `/stocks/${summarySymbol}/valuation-ratios/daily?from=${BEFORE}&to=${NEWEST}&ratio=${reading.id}`,
        )
        .expect(200);
      expect(history.body.at(-1), reading.id).toEqual({
        date: reading.date,
        value: reading.value,
      });
    }
  });

  it("states every Fundamental Metric's newest reading with its own date, a negative as a reading and absence as none", async () => {
    const body = await summary(summarySymbol);
    expect(body.fundamentals.map((r) => r.id)).toEqual([
      ...FUNDAMENTAL_METRIC_IDS,
    ]);
    const metric = (id: string) =>
      body.fundamentals.find((reading) => reading.id === id);
    expect(metric("ROIC_TTM")).toEqual({
      id: "ROIC_TTM",
      date: NEWEST,
      value: 14.5,
    });
    expect(metric("ROE_TTM")).toEqual({
      id: "ROE_TTM",
      date: NEWEST,
      value: -6,
    });
    expect(metric("NET_DEBT_TO_EBITDA_TTM")).toEqual({
      id: "NET_DEBT_TO_EBITDA_TTM",
      date: NEWEST,
      value: -0.4,
    });
    // Not on the newest session: the newest earlier reading, never presented as the newest's.
    expect(metric("CURRENT_RATIO")).toEqual({
      id: "CURRENT_RATIO",
      date: PUBLIC,
      value: 1.8,
    });
    // Never available: no date and no value, never zero.
    expect(metric("GROSS_MARGIN_TTM")).toEqual({ id: "GROSS_MARGIN_TTM" });
    // And it is what the metric's own history read says.
    const history = await request(app.getHttpServer())
      .get(
        `/stocks/${summarySymbol}/fundamentals/daily?from=${BEFORE}&to=${NEWEST}&metric=CURRENT_RATIO`,
      )
      .expect(200);
    expect(history.body).toEqual([
      { date: BEFORE, value: 1.75 },
      { date: PUBLIC, value: 1.8 },
      { date: NEWEST },
    ]);
  });

  it("states exactly EMA 50D, EMA 200D and RSI 14D, the newest intrinsic value and the reporting period", async () => {
    const body = await summary(summarySymbol);
    expect(body.technicals).toEqual([
      { id: STOCK_SUMMARY_TECHNICAL_IDS[0], date: NEWEST, value: 102.75 },
      { id: STOCK_SUMMARY_TECHNICAL_IDS[1], date: NEWEST, value: 92.5 },
      { id: STOCK_SUMMARY_TECHNICAL_IDS[2], date: NEWEST, value: 64.8 },
    ]);
    expect(body.intrinsicValues).toEqual([
      {
        valuationDate: NEWEST,
        sourceDataAsOf: `${PUBLIC}T00:00:00.000Z`,
        model: "DCF_FCFF",
        valuePerShare: 151,
        currency: "USD",
      },
    ]);
    expect(body.intrinsicValueBlends).toEqual([]);
    expect(body.latestQuarter).toEqual({
      fiscalYear: 2025,
      period: "Q4",
      fiscalDate: "2025-12-31",
      availableFrom: PUBLIC,
    });
  });

  it("answers the rest of the summary when the split list cannot be refreshed, with the ratios FAILED", async () => {
    const before = provider.splitCalls.filter(
      (symbol) => symbol === staleSplitsSymbol,
    ).length;
    const body = await summary(staleSplitsSymbol);
    expect(
      provider.splitCalls.filter((symbol) => symbol === staleSplitsSymbol)
        .length,
    ).toBe(before + 1);
    // No ratio, no cause on the wire: a failure to retry, not a fact about the company.
    expect(body.valuationRatios).toEqual({ status: "FAILED" });
    expect(body.quote?.date).toBe(NEWEST);
    expect(body.fundamentals.find((r) => r.id === "ROIC_TTM")?.value).toBe(
      14.5,
    );
  });

  it("is a not-found for a symbol outside the catalog and a bad request for a malformed one", async () => {
    const missing = await request(app.getHttpServer())
      .get(`/stocks/${unknownSymbol}/summary`)
      .expect(404);
    expect(missing.body.message).toBe("Stock symbol was not found");
    await request(app.getHttpServer())
      .get(`/stocks/%24%24%24/summary`)
      .expect(400);
  });
});
