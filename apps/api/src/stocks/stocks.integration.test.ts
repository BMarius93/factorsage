import { randomUUID } from "node:crypto";
import { getFmpConfig, loadRootEnv } from "@intrinsic/config";
import {
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import { MOVING_AVERAGE_SERIES } from "@intrinsic/contracts";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  type DateRange,
} from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import {
  DAILY_DERIVED_STATE_VARIANT,
  InMemoryLoadCoordinator,
  NullStockDataCache,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
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

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

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

    // Catalog identity only, with no persisted history: nothing discovers a security lazily any
    // more, so the loaded-symbol scenario needs its catalog entry up front and then hydrates its
    // price history on demand.
    await prisma.security.create({
      data: {
        providerSymbol: loadedSymbol,
        symbol: loadedSymbol,
        name: "Persisted Test Corp",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
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
          residualIncome: 130,
          graham: 125,
          blendBalanced: 136,
          // Per-model provenance: the blend's own sourceDataAsOf is the max of its components.
          dcfFcffSourceAsOf: new Date("2025-10-01T14:00:00.000Z"),
          residualIncomeSourceAsOf: new Date("2025-09-15T14:00:00.000Z"),
          grahamSourceAsOf: new Date("2025-08-20T14:00:00.000Z"),
          intrinsicCurrency: "USD",
        },
        {
          securityId: security.id,
          date: new Date("2025-11-03T00:00:00.000Z"),
          dcfFcff: 141,
          residualIncome: 130,
          graham: 125,
          blendBalanced: 136,
          blendConservative: 125,
          dcfFcffSourceAsOf: new Date("2025-11-03T14:00:00.000Z"),
          residualIncomeSourceAsOf: new Date("2025-09-15T14:00:00.000Z"),
          grahamSourceAsOf: new Date("2025-10-20T14:00:00.000Z"),
          intrinsicCurrency: "USD",
        },
        {
          securityId: security.id,
          date: new Date("2026-08-20T00:00:00.000Z"),
          sma20d: 121.5,
          ema20d: 122.25,
        },
        // Monday-Thursday of the week starting 2026-08-24 carry the previous completed week
        // (2026-08-17) forward. `sma200w` is deliberately absent: still warming up.
        ...["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27"].map((date) => ({
          securityId: security.id,
          date: new Date(`${date}T00:00:00.000Z`),
          sma20d: 121.5,
          weeklySourceWeekStart: new Date("2026-08-17T00:00:00.000Z"),
          sma20w: 116.1,
          ema20w: 112.5,
        })),
        // Friday closes the week starting 2026-08-24, so its own weekly values become eligible
        // on that day and every catalog moving average is representable on one row.
        {
          securityId: security.id,
          date: new Date("2026-08-28T00:00:00.000Z"),
          sma20d: 130.1,
          sma50d: 129.2,
          sma100d: 128.3,
          sma200d: 127.4,
          ema20d: 131.1,
          ema50d: 130.2,
          ema200d: 129.3,
          weeklySourceWeekStart: new Date("2026-08-24T00:00:00.000Z"),
          sma20w: 126.1,
          sma50w: 125.2,
          sma100w: 124.3,
          sma200w: 123.4,
          ema20w: 122.5,
          ema50w: 121.6,
          ema200w: 120.7,
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
    // DCF's own provenance, not the newest instant on the row.
    expect(response.body[0].sourceDataAsOf).toBe("2025-10-01T14:00:00.000Z");
    expect(response.body[1].sourceDataAsOf).toBe("2025-11-03T14:00:00.000Z");
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
        // max(DCF 10-01, RI 09-15, Graham 08-20)
        sourceDataAsOf: "2025-10-01T14:00:00.000Z",
      }),
      expect.objectContaining({
        valuationDate: "2025-11-03",
        blendId: "BALANCED",
        valuePerShare: 136,
        sourceDataAsOf: "2025-11-03T14:00:00.000Z",
      }),
    ]);
    expect(response.body[0]).not.toHaveProperty("blendVersion");
    expect(response.body[0]).not.toHaveProperty("calculationVersion");
    expect(response.body[0]).not.toHaveProperty("securityId");
  });

  it("exposes every catalog moving average, daily and weekly, on one technical row", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/technicals/daily?from=2026-08-28&to=2026-08-28`)
      .expect(200);

    expect(response.body).toHaveLength(1);
    const row = response.body[0] as Record<string, unknown>;
    for (const series of MOVING_AVERAGE_SERIES) {
      if (series.source.kind !== "MOVING_AVERAGE") {
        throw new Error("unreachable");
      }
      expect(row[series.source.field]).toBeTypeOf("number");
    }
    // Every catalog moving average plus the date; nothing else leaks onto the contract.
    expect(Object.keys(row)).toHaveLength(MOVING_AVERAGE_SERIES.length + 1);
    expect(row).not.toHaveProperty("securityId");
    expect(row).not.toHaveProperty("weeklySourceWeekStart");
    expect(row).not.toHaveProperty("calculationVersion");
  });

  it("never exposes a completed-week value to earlier days of that same week", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/technicals/daily?from=2026-08-24&to=2026-08-28`)
      .expect(200);

    const rows = response.body as { date: string; sma20w?: number }[];
    expect(rows.map((row) => row.date)).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
    ]);
    // Monday-Thursday repeat the previous completed week; only Friday's own close introduces the
    // newer weekly value.
    expect(rows.slice(0, 4).map((row) => row.sma20w)).toEqual([
      116.1, 116.1, 116.1, 116.1,
    ]);
    expect(rows[4]?.sma20w).toBe(126.1);
  });

  it("omits an unavailable weekly value instead of returning zero or null", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/technicals/daily?from=2026-08-24&to=2026-08-24`)
      .expect(200);

    const row = response.body[0] as Record<string, unknown>;
    expect(row.sma20w).toBe(116.1);
    for (const field of ["sma50w", "sma100w", "sma200w", "ema50w", "ema200w"]) {
      expect(field in row).toBe(false);
    }
    expect(JSON.stringify(row)).not.toContain("null");
  });

  it("filters the technical projection to selected catalog series", async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/technicals/daily?from=2026-08-28&to=2026-08-28&series=SMA_200W,EMA_50D`,
      )
      .expect(200);

    expect(response.body).toEqual([
      { date: "2026-08-28", sma200w: 123.4, ema50d: 130.2 },
    ]);
  });

  it("accepts every catalog moving-average id and projects that series alone", async () => {
    // Completeness rather than a spot check: a catalog entry the API cannot address, or one whose
    // id resolves to the wrong persisted field, fails here instead of only being noticed when the
    // picker draws an empty overlay.
    for (const series of MOVING_AVERAGE_SERIES) {
      if (series.source.kind !== "MOVING_AVERAGE") {
        throw new Error("unreachable");
      }
      const response = await request(app.getHttpServer())
        .get(
          `/stocks/${baseSymbol}/technicals/daily?from=2026-08-28&to=2026-08-28&series=${series.id}`,
        )
        .expect(200);

      const row = response.body[0] as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual(
        ["date", series.source.field].sort(),
      );
      expect(row[series.source.field]).toBeTypeOf("number");
    }
  });

  it("rejects selection identifiers that are not in the canonical catalog", async () => {
    for (const series of ["SMA_300W", "sma_20w", "BALANCED", "PRICE"]) {
      await request(app.getHttpServer())
        .get(
          `/stocks/${baseSymbol}/technicals/daily?from=2026-08-28&to=2026-08-28&series=${series}`,
        )
        .expect(400);
    }
    await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/intrinsic-values?models=NOT_A_MODEL`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/intrinsic-value-blends?blendIds=NOT_A_BLEND`)
      .expect(400);
  });

  it("serves the catalog's four models and three blends from the same daily state", async () => {
    const models = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-values?from=2025-01-01&to=2025-12-31&asOf=2025-12-31&models=${INTRINSIC_VALUE_MODELS.join(",")}`,
      )
      .expect(200);
    const blends = await request(app.getHttpServer())
      .get(
        `/stocks/${baseSymbol}/intrinsic-value-blends?from=2025-01-01&to=2025-12-31&asOf=2025-12-31&blendIds=${INTRINSIC_VALUE_BLEND_IDS.join(",")}`,
      )
      .expect(200);

    // Every catalog model/blend identifier is accepted; only the ones this fixture materialized
    // come back, and an unavailable one is simply absent rather than substituted.
    expect(
      new Set(models.body.map((point: { model: string }) => point.model)),
    ).toEqual(new Set(["DCF_FCFF", "RESIDUAL_INCOME", "GRAHAM"]));
    expect(
      new Set(blends.body.map((point: { blendId: string }) => point.blendId)),
    ).toEqual(new Set(["BALANCED", "CONSERVATIVE"]));
    for (const point of [...models.body, ...blends.body]) {
      expect(point.valuePerShare).toBeGreaterThan(0);
    }
  });

  it("returns the same weekly state through Stock Details as through the technical endpoint", async () => {
    const details = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}?from=2026-08-24&to=2026-08-28`)
      .expect(200);
    const technicals = await request(app.getHttpServer())
      .get(`/stocks/${baseSymbol}/technicals/daily?from=2026-08-24&to=2026-08-28`)
      .expect(200);

    expect(details.body.technicals).toEqual(technicals.body);
    expect(
      details.body.technicals.map((row: { date: string }) => row.date),
    ).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
    ]);
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
