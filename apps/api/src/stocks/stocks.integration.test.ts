import { randomUUID } from "node:crypto";
import { getFmpConfig, loadRootEnv } from "@intrinsic/config";
import {
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import type { DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import {
  DAILY_DERIVED_STATE_VARIANT,
  InMemoryLoadCoordinator,
  NullStockDataCache,
} from "@intrinsic/stock-data";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
} from "./stock-data.tokens";

const runtimeToday = new Date().toISOString().slice(0, 10);
const runtimeHistoryStart = (() => {
  const date = new Date(`${runtimeToday}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
})();

class FakeFmpProvider implements FmpStockProviderPort {
  allowedSymbol = "";
  readonly dailyCalls: DateRange[] = [];

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    if (symbol !== this.allowedSymbol) {
      return null;
    }
    return {
      providerSymbol: symbol,
      security: {
        symbol,
        name: "Persisted Test Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      profile: { description: "Deterministic provider fixture" },
    };
  }

  async getDailyPrices(_symbol: string, securityId: string, range: DateRange) {
    this.dailyCalls.push(range);
    return [
      {
        securityId,
        date: "2019-12-31",
        open: 90,
        high: 91,
        low: 89,
        close: 90.5,
        volume: 900,
      },
      {
        securityId,
        date: "2020-01-03",
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1_000,
      },
    ];
  }

  async getFinancialStatements(
    _symbol: string,
    _securityId: string,
    _statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW",
    _cadence: "QUARTERLY" | "ANNUAL",
    _limit: number,
  ) {
    return [];
  }
}

describe("Stock Details API", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const baseSymbol = `B${suffix}`;
  const loadedSymbol = `L${suffix}`;
  const unknownSymbol = `U${suffix}`;
  const provider = new FakeFmpProvider();

  let app: INestApplication;
  let prisma: PrismaService;
  let baseSecurityId: string;

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";

    expect(() => getFmpConfig({})).toThrow("FMP_API_KEY is required");

    provider.allowedSymbol = loadedSymbol;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useValue(provider)
      .overrideProvider(STOCK_DATA_CACHE)
      .useValue(new NullStockDataCache())
      .overrideProvider(STOCK_DATA_COORDINATOR)
      .useValue(new InMemoryLoadCoordinator())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    const security = await prisma.security.create({
      data: {
        providerSymbol: baseSymbol,
        symbol: baseSymbol,
        name: "Base Test Corp",
        exchangeCode: "NYSE",
        exchangeName: "New York Stock Exchange",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
        profile: {
          create: {
            description: "Database-backed integration fixture",
            employees: 1234,
          },
        },
      },
    });
    baseSecurityId = security.id;
    await prisma.dailyPrice.createMany({
      data: [
        {
          securityId: security.id,
          date: new Date("2026-08-20T00:00:00.000Z"),
          open: 120,
          high: 125,
          low: 119,
          close: 124,
          volume: 2_000n,
        },
        {
          securityId: security.id,
          date: new Date("2025-09-02T00:00:00.000Z"),
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 1_000n,
        },
      ],
    });
    // One unified derived row per (securityId, date). Repeated intrinsic values across trading
    // days are intentional daily materialization, not duplicated methodology versions.
    await prisma.dailyDerivedState.createMany({
      data: [
        {
          securityId: security.id,
          date: new Date("2025-10-01T00:00:00.000Z"),
          dcfFcff: 141,
          blendBalanced: 136,
          intrinsicSourceDataAsOf: new Date("2025-10-01T14:00:00.000Z"),
          intrinsicCurrency: "USD",
        },
        {
          securityId: security.id,
          date: new Date("2025-11-03T00:00:00.000Z"),
          dcfFcff: 141,
          graham: 125,
          blendBalanced: 136,
          blendConservative: 125,
          intrinsicSourceDataAsOf: new Date("2025-11-03T14:00:00.000Z"),
          intrinsicCurrency: "USD",
        },
        {
          securityId: security.id,
          date: new Date("2026-08-20T00:00:00.000Z"),
          sma20d: 121.5,
          ema20d: 122.25,
        },
      ],
    });
    await prisma.stockDatasetState.createMany({
      data: [
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          earliestDate: new Date(`${runtimeHistoryStart}T00:00:00.000Z`),
          latestDate: new Date(`${runtimeToday}T00:00:00.000Z`),
          lastSuccessfulSyncAt: new Date(),
        },
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_DERIVED_STATE,
          variant: DAILY_DERIVED_STATE_VARIANT,
          earliestDate: new Date(`${runtimeHistoryStart}T00:00:00.000Z`),
          latestDate: new Date(`${runtimeToday}T00:00:00.000Z`),
          lastSuccessfulSyncAt: new Date(),
        },
      ],
    });
    await prisma.stockDatasetCoverage.createMany({
      data: [
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          fromDate: new Date(`${runtimeHistoryStart}T00:00:00.000Z`),
          toDate: new Date(`${runtimeToday}T00:00:00.000Z`),
          lastSuccessfulSyncAt: new Date(),
        },
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_DERIVED_STATE,
          variant: DAILY_DERIVED_STATE_VARIANT,
          fromDate: new Date(`${runtimeHistoryStart}T00:00:00.000Z`),
          toDate: new Date(`${runtimeToday}T00:00:00.000Z`),
          lastSuccessfulSyncAt: new Date(),
        },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: [baseSymbol, loadedSymbol] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("returns bounded Stock Details from durable data", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}`)
      .expect(200);

    expect(response.body.security).toMatchObject({
      id: baseSecurityId,
      symbol: baseSymbol,
      exchangeCode: "NYSE",
    });
    expect(response.body.profile).toMatchObject({ employees: 1234 });
    expect(response.body.prices).toHaveLength(2);
    expect(provider.dailyCalls).toEqual([]);
  });

  it("returns a stable not-found response for an unsupported symbol", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${unknownSymbol}`)
      .expect(404);

    expect(response.body.message).toBe("Stock symbol was not found");
    expect(JSON.stringify(response.body)).not.toContain("FMP");
  });

  it("validates malformed, incomplete, and inverted historical ranges", async () => {
    await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/prices?from=not-a-date&to=2026-08-20`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/prices?from=2026-08-20`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/prices?from=2026-08-21&to=2026-08-20`)
      .expect(400);
  });

  it("returns historical prices in ascending order", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/prices?from=2025-09-01&to=2026-08-20`)
      .expect(200);

    expect(response.body.map((row: { date: string }) => row.date)).toEqual([
      "2025-09-02",
      "2026-08-20",
    ]);
  });

  it("uses the approved daily technical names and omits internal identity", async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/technicals/daily?from=2026-08-20&to=2026-08-20`,
      )
      .expect(200);

    expect(response.body).toEqual([
      { date: "2026-08-20", sma20d: 121.5, ema20d: 122.25 },
    ]);
    expect(response.body[0]).not.toHaveProperty("calculationVersion");
    expect(response.body[0]).not.toHaveProperty("sma20");
    expect(response.body[0]).not.toHaveProperty("securityId");
  });

  it("filters intrinsic models and excludes future source publication times", async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-values?from=2025-01-01&to=2025-12-31&asOf=2025-12-31&models=DCF_FCFF,DDM`,
      )
      .expect(200);

    expect(
      response.body.map((point: { model: string }) => point.model),
    ).toEqual(["DCF_FCFF", "DCF_FCFF"]);
    expect(
      response.body.map((point: { valuationDate: string }) =>
        point.valuationDate,
      ),
    ).toEqual(["2025-10-01", "2025-11-03"]);
    expect(response.body[0].sourceDataAsOf).toBe("2025-10-01T14:00:00.000Z");
    expect(response.body[0].valuePerShare).toBe(141);
    expect(response.body[0]).not.toHaveProperty("calculationVersion");
  });

  it("clamps intrinsic and blend valuation dates to asOf when to is later", async () => {
    const intrinsic = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-values?to=2025-12-31&asOf=2025-09-01&models=GRAHAM`,
      )
      .expect(200);
    const blends = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-value-blends?to=2025-12-31&asOf=2025-09-01&blendIds=CONSERVATIVE`,
      )
      .expect(200);

    expect(intrinsic.body).toEqual([]);
    expect(blends.body).toEqual([]);
  });

  it("filters blend IDs and repeats the eligible daily value without version metadata", async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-value-blends?asOf=2025-12-31&blendIds=BALANCED`,
      )
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        valuationDate: "2025-10-01",
        blendId: "BALANCED",
        valuePerShare: 136,
      }),
      expect.objectContaining({
        valuationDate: "2025-11-03",
        blendId: "BALANCED",
        valuePerShare: 136,
      }),
    ]);
    expect(response.body[0]).not.toHaveProperty("blendVersion");
    expect(response.body[0]).not.toHaveProperty("calculationVersion");
    expect(response.body[0]).not.toHaveProperty("securityId");
  });

  it("hydrates one canonical horizon and reuses it for later projections", async () => {
    const initial = `/stocks/${loadedSymbol}/prices?from=2020-01-01&to=2020-01-03`;
    await request(app.getHttpServer()).get(initial).expect(200);
    await request(app.getHttpServer()).get(initial).expect(200);
    expect(provider.dailyCalls).toEqual([
      { from: runtimeHistoryStart, to: runtimeToday },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/stocks/${loadedSymbol}/prices?from=2019-12-30&to=2020-01-03`)
      .expect(200);
    expect(provider.dailyCalls).toHaveLength(1);
    expect(response.body.map((row: { date: string }) => row.date)).toEqual([
      "2019-12-31",
      "2020-01-03",
    ]);
  });
});
