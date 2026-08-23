import { randomUUID } from "node:crypto";
import { getFmpConfig, loadRootEnv } from "@intrinsic/config";
import {
  IntrinsicValueBlendId,
  IntrinsicValueModel,
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import type { DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import {
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
    const date = range.to ?? range.from;
    return date
      ? [
          {
            securityId,
            date,
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 1_000,
          },
        ]
      : [];
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
    await prisma.dailyTechnical.create({
      data: {
        securityId: security.id,
        date: new Date("2026-08-20T00:00:00.000Z"),
        sma20d: 121.5,
        ema20d: 122.25,
        calculationVersion: 1,
      },
    });
    await prisma.stockDatasetState.createMany({
      data: [
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          earliestDate: new Date("2020-01-01T00:00:00.000Z"),
          latestDate: new Date("2026-08-23T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-23T01:00:00.000Z"),
        },
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_TECHNICAL,
          variant: "1D:v1",
          earliestDate: new Date("2020-01-01T00:00:00.000Z"),
          latestDate: new Date("2026-08-23T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-23T01:00:00.000Z"),
          calculationVersion: 1,
        },
      ],
    });
    await prisma.stockDatasetCoverage.createMany({
      data: [
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_PRICE,
          variant: "split-adjusted-eod-full",
          fromDate: new Date("2020-01-01T00:00:00.000Z"),
          toDate: new Date("2026-08-23T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-23T01:00:00.000Z"),
        },
        {
          securityId: security.id,
          dataset: StockDataset.DAILY_TECHNICAL,
          variant: "1D:v1",
          fromDate: new Date("2020-01-01T00:00:00.000Z"),
          toDate: new Date("2026-08-23T00:00:00.000Z"),
          lastSuccessfulSyncAt: new Date("2026-08-23T01:00:00.000Z"),
        },
      ],
    });
    await prisma.intrinsicValue.createMany({
      data: [
        {
          securityId: security.id,
          valuationDate: new Date("2025-10-01T00:00:00.000Z"),
          sourceDataAsOf: new Date("2025-10-01T14:00:00.000Z"),
          model: IntrinsicValueModel.DCF_FCFF,
          valuePerShare: 140,
          currency: "USD",
          calculationVersion: 1,
        },
        {
          securityId: security.id,
          valuationDate: new Date("2025-10-01T00:00:00.000Z"),
          sourceDataAsOf: new Date("2026-01-01T14:00:00.000Z"),
          model: IntrinsicValueModel.DDM,
          valuePerShare: 130,
          currency: "USD",
          calculationVersion: 1,
        },
      ],
    });
    await prisma.intrinsicValueBlend.create({
      data: {
        securityId: security.id,
        valuationDate: new Date("2025-10-01T00:00:00.000Z"),
        sourceDataAsOf: new Date("2025-10-01T15:00:00.000Z"),
        blendId: IntrinsicValueBlendId.BALANCED,
        valuePerShare: 135,
        currency: "USD",
        calculationVersion: 1,
        blendVersion: 1,
      },
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
      {
        date: "2026-08-20",
        sma20d: 121.5,
        ema20d: 122.25,
        calculationVersion: 1,
      },
    ]);
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
    ).toEqual(["DCF_FCFF"]);
    expect(response.body[0].sourceDataAsOf).toBe("2025-10-01T14:00:00.000Z");
  });

  it("filters blend IDs and returns version metadata", async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-value-blends?asOf=2025-12-31&blendIds=BALANCED`,
      )
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        blendId: "BALANCED",
        blendVersion: 1,
        calculationVersion: 1,
      }),
    ]);
  });

  it("reuses persisted data and requests only a later missing prefix", async () => {
    const initial = `/stocks/${loadedSymbol}/prices?from=2020-01-01&to=2020-01-03`;
    await request(app.getHttpServer()).get(initial).expect(200);
    await request(app.getHttpServer()).get(initial).expect(200);
    expect(provider.dailyCalls).toEqual([
      { from: "2020-01-01", to: "2020-01-03" },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/stocks/${loadedSymbol}/prices?from=2019-12-30&to=2020-01-03`)
      .expect(200);
    expect(provider.dailyCalls.at(-1)).toEqual({
      from: "2019-12-30",
      to: "2019-12-31",
    });
    expect(response.body.map((row: { date: string }) => row.date)).toEqual([
      "2019-12-31",
      "2020-01-03",
    ]);
  });
});
