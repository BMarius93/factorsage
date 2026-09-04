/**
 * Deterministic cross-layer infrastructure suite for the stock API.
 *
 * Exercises the complete production wiring:
 *
 *   HTTP -> StocksController -> LoggedStockDataService -> CanonicalStockDataService
 *        -> PrismaStockDataStore (real PostgreSQL)
 *        -> RedisStockDataCache (real Redis)
 *        -> RedlockLoadCoordinator (real Redis)
 *        -> HTTP response
 *
 * Only the FMP provider boundary is replaced with a deterministic fixture, so no
 * FMP_API_KEY is required. PostgreSQL, Redis, and the distributed coordinator are
 * never mocked; when they are missing or unreachable the suite fails with an
 * explanation instead of silently substituting fakes.
 *
 * Infrastructure isolation:
 * - PostgreSQL: `useTestDatabase()` requires TEST_DATABASE_URL and never falls back to the
 *   development DATABASE_URL. Prepare the database once with `pnpm db:test:prepare`.
 * - Redis: uses TEST_REDIS_URL when set, otherwise REDIS_URL, always under a randomized
 *   key namespace so developer Redis state is never touched.
 * - Every stock uses a randomized symbol; cleanup deletes only rows and keys this suite
 *   created. No FLUSHDB, no migrate reset, no reliance on pre-existing data.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType, StockDataset } from "@intrinsic/database";
import {
  INTRINSIC_VALUE_BLENDS,
  type DailyPrice,
  type DateRange,
  type FinancialStatementCadence,
  type FinancialStatementDraft,
  type FinancialStatementType,
  type IntrinsicValueBlendId,
} from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalStockDataService,
  DAILY_DERIVED_STATE_VARIANT,
  DAILY_PRICE_FRESHNESS_VARIANT,
  DAILY_PRICE_VARIANT,
  DERIVED_STATE_REVISION,
  FINANCIAL_STATEMENT_VERSION,
  IoredisCacheClient,
  PRICE_DATASET_VERSION,
  RedisStockDataCache,
  addDays,
  createStockDataRedisClient,
  fundamentalsDatasetVariant,
  type StockManifest,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { LoggedStockDataService } from "./logged-stock-data.service";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_REDIS,
  STOCK_DATA_SERVICE,
  STOCK_DATA_STORE,
} from "./stock-data.tokens";

const SLOW = 120_000;

/** Deterministic "today": a Monday, so weekend availability scenarios are stable. */
const T0 = "2026-08-24T12:00:00.000Z";
const TODAY = "2026-08-24";
const HISTORY_YEARS = 4;
const CANONICAL_START = "2022-08-24";
// Fundamentals retention reaches back historyYears + 7 warm-up years, i.e. to 2015-08-24.
const PRICE_FRESHNESS_MS = 60 * 60 * 1000;
const FUNDAMENTALS_FRESHNESS_MS = 120 * 60 * 1000;
/**
 * A deeper retention horizon for the widening scenario, and its canonical start.
 *
 * The rest of the suite runs at four years, where the derived warm-up alone reaches the horizon
 * and every request materializes all of it. A partially loaded stock only exists when the horizon
 * is meaningfully deeper than one window plus that warm-up.
 */
const WIDENING_HISTORY_YEARS = 12;
const WIDENING_START = "2014-08-24";
/**
 * The state the v1 price loader left behind, reproduced for one stock at the widening horizon:
 * the provider's history begins years after that horizon, and only its last two years were ever
 * persisted — what one capped response happened to return — while coverage claimed the horizon.
 */
const LEGACY_PROVIDER_START = "2018-01-02";
const LEGACY_PERSISTED_START = "2024-08-26";
/** The unversioned v1 coverage variant, spelled out: the loader must never read it again. */
const LEGACY_DAILY_PRICE_VARIANT = "split-adjusted-eod-full";

const QUARTERLY_BACKFILL_LIMIT = (HISTORY_YEARS + 7) * 4 + 8;
const ANNUAL_BACKFILL_LIMIT = HISTORY_YEARS + 7 + 2;

/**
 * Golden per-quarter statement values shared with the validated service-level tests.
 * Any TTM window over identical quarters yields the same known model outputs
 * (default 5% growth when no usable annual endpoints exist).
 */
const INCOME_QUARTER = {
  netIncome: 20,
  interestExpense: 2.5,
  epsDiluted: 2,
  weightedAverageShsOutDil: 10,
};
const CASH_FLOW_QUARTER = {
  operatingCashFlow: 30,
  capitalExpenditure: -5,
  commonDividendsPaid: -5,
};
const BALANCE_SHEET_QUARTER = {
  cashAndShortTermInvestments: 50,
  totalDebt: 30,
  totalStockholdersEquity: 500,
};
const GOLDEN = {
  DCF_FCFF: 178.8977101328,
  RESIDUAL_INCOME: 99.1837933641,
  DDM: 27.3333333333,
  GRAHAM: 148,
  BALANCED: 148.8039930756,
  CONSERVATIVE: 145.7142220623,
  DIVIDEND: 102.3291760593,
};

const QUARTER_END = {
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
} as const;
type QuarterPeriod = keyof typeof QUARTER_END;

type PriceTemplate = Omit<DailyPrice, "securityId">;
type DraftTemplate = Omit<FinancialStatementDraft, "securityId">;
type StatementKey = `${FinancialStatementType}:${FinancialStatementCadence}`;

type StockFixture = {
  name: string;
  prices: PriceTemplate[];
  statements: Map<StatementKey, DraftTemplate[]>;
};

function businessDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(date);
    }
  }
  return days;
}

function priceSeries(from: string, to: string, base = 100): PriceTemplate[] {
  return businessDays(from, to).map((date, index) => {
    const close = base + (index % 40) * 0.25;
    return {
      date,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index,
    };
  });
}

function quarterDraft(
  statementType: FinancialStatementType,
  fiscalYear: number,
  period: QuarterPeriod,
  values: Record<string, number>,
  filingDate = addDays(`${fiscalYear}-${QUARTER_END[period]}`, 31),
): DraftTemplate {
  return {
    statementType,
    fiscalDate: `${fiscalYear}-${QUARTER_END[period]}`,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate,
    values,
  };
}

function annualIncomeDraft(
  fiscalYear: number,
  values: Record<string, number>,
  filingDate = `${fiscalYear + 1}-02-15`,
): DraftTemplate {
  return {
    statementType: "INCOME",
    fiscalDate: `${fiscalYear}-12-31`,
    fiscalYear,
    period: "FY",
    reportedCurrency: "USD",
    filingDate,
    values,
  };
}

/** Standard fully-calculable quarters (all three families) for the given fiscal quarters. */
function standardQuarters(
  quarters: ReadonlyArray<{ fiscalYear: number; period: QuarterPeriod }>,
): Map<StatementKey, DraftTemplate[]> {
  const statements = new Map<StatementKey, DraftTemplate[]>();
  statements.set(
    "INCOME:QUARTERLY",
    quarters.map((q) => quarterDraft("INCOME", q.fiscalYear, q.period, INCOME_QUARTER)),
  );
  statements.set(
    "CASH_FLOW:QUARTERLY",
    quarters.map((q) =>
      quarterDraft("CASH_FLOW", q.fiscalYear, q.period, CASH_FLOW_QUARTER),
    ),
  );
  statements.set(
    "BALANCE_SHEET:QUARTERLY",
    quarters.map((q) =>
      quarterDraft("BALANCE_SHEET", q.fiscalYear, q.period, BALANCE_SHEET_QUARTER),
    ),
  );
  return statements;
}

function fiscalQuarterRange(
  fromYear: number,
  fromPeriod: QuarterPeriod,
  toYear: number,
  toPeriod: QuarterPeriod,
): Array<{ fiscalYear: number; period: QuarterPeriod }> {
  const periods: QuarterPeriod[] = ["Q1", "Q2", "Q3", "Q4"];
  const quarters: Array<{ fiscalYear: number; period: QuarterPeriod }> = [];
  const start = fromYear * 4 + periods.indexOf(fromPeriod);
  const end = toYear * 4 + periods.indexOf(toPeriod);
  for (let rank = start; rank <= end; rank += 1) {
    quarters.push({
      fiscalYear: Math.floor(rank / 4),
      period: periods[rank % 4] as QuarterPeriod,
    });
  }
  return quarters;
}

class DeterministicFmpProvider implements FmpStockProviderPort {
  readonly fixtures = new Map<string, StockFixture>();
  readonly profileCalls: string[] = [];
  readonly dailyPriceCalls: Array<{ symbol: string; from?: string; to?: string }> = [];
  readonly statementCalls: Array<{
    symbol: string;
    statementType: FinancialStatementType;
    cadence: FinancialStatementCadence;
    limit: number;
  }> = [];

  register(symbol: string, fixture: StockFixture): void {
    this.fixtures.set(symbol, fixture);
  }

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    this.profileCalls.push(symbol);
    const fixture = this.fixtures.get(symbol);
    if (!fixture) {
      return null;
    }
    return {
      providerSymbol: symbol,
      security: {
        symbol,
        name: fixture.name,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      profile: { description: `Deterministic fixture for ${symbol}` },
    };
  }

  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    this.dailyPriceCalls.push({ symbol, from: range.from, to: range.to });
    const fixture = this.fixtures.get(symbol);
    if (!fixture) {
      return [];
    }
    return fixture.prices
      .filter((row) => !range.from || row.date >= range.from)
      .filter((row) => !range.to || row.date <= range.to)
      .map((row) => ({ ...row, securityId }));
  }

  async getFinancialStatements(
    symbol: string,
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    limit: number,
  ): Promise<FinancialStatementDraft[]> {
    this.statementCalls.push({ symbol, statementType, cadence, limit });
    const rows =
      this.fixtures.get(symbol)?.statements.get(`${statementType}:${cadence}`) ?? [];
    return rows.map((row) => ({ ...row, securityId }));
  }

  callCounts() {
    return {
      profiles: this.profileCalls.length,
      prices: this.dailyPriceCalls.length,
      statements: this.statementCalls.length,
    };
  }
}

function expectedBlendValue(
  blendId: IntrinsicValueBlendId,
  modelValues: Partial<Record<string, number>>,
): number {
  return INTRINSIC_VALUE_BLENDS[blendId].components.reduce((sum, component) => {
    const value = modelValues[component.model];
    if (value === undefined) {
      throw new Error(`Missing ${component.model} value for ${blendId}`);
    }
    return sum + component.weight * value;
  }, 0);
}

// Before PrismaService constructs its client during Nest module compilation.
const databaseUrl = useTestDatabase();

describe("stock API infrastructure (HTTP + real PostgreSQL + real Redis)", () => {
  const redisUrl = process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();

  const suffix = randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase();
  const namespace = `stock-data:v2:test:infra:${randomUUID()}`;
  const lruNamespace = `${namespace}:lru`;
  const symbols = {
    lifecycle: `A${suffix}`,
    pit: `P${suffix}`,
    warmup: `W${suffix}`,
    isolationX: `X${suffix}`,
    isolationY: `Y${suffix}`,
    restart: `R${suffix}`,
    redisLoss: `C${suffix}`,
    authority: `E${suffix}`,
    lruOne: `L1${suffix}`,
    lruTwo: `L2${suffix}`,
    widening: `G${suffix}`,
    legacy: `V${suffix}`,
  };

  const clock = { instant: new Date(T0) };
  const advanceClockMinutes = (minutes: number) => {
    clock.instant = new Date(clock.instant.valueOf() + minutes * 60_000);
  };

  const provider = new DeterministicFmpProvider();
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: ReturnType<typeof createStockDataRedisClient>;

  const closers: Array<() => Promise<void>> = [];

  async function createStockApp(input: {
    provider: FmpStockProviderPort;
    namespace: string;
    maxResidentStocks?: number;
    historyYears?: number;
  }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useValue(input.provider)
      .overrideProvider(STOCK_DATA_CACHE)
      .useFactory({
        inject: [STOCK_DATA_REDIS],
        factory: (client: ReturnType<typeof createStockDataRedisClient>) =>
          new RedisStockDataCache(
            new IoredisCacheClient(client),
            input.maxResidentStocks ?? 100,
            input.namespace,
          ),
      })
      .overrideProvider(STOCK_DATA_SERVICE)
      .useFactory({
        inject: [
          STOCK_DATA_STORE,
          STOCK_DATA_PROVIDER,
          STOCK_DATA_CACHE,
          STOCK_DATA_COORDINATOR,
        ],
        factory: (store, stockProvider, cache, coordinator) =>
          new LoggedStockDataService(
            new CanonicalStockDataService(store, stockProvider, cache, coordinator, {
              defaultHistoryDays: 365,
              historyYears: input.historyYears ?? HISTORY_YEARS,
              recentPriceFreshnessMs: PRICE_FRESHNESS_MS,
              fundamentalsFreshnessMs: FUNDAMENTALS_FRESHNESS_MS,
              recentTailCalendarDays: 10,
              now: () => clock.instant,
            }),
            createLogger({
              service: "api",
              level: "silent",
              environment: "test",
              base: { component: "stock-data" },
            }),
          ),
      })
      .compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  }

  const http = () => request(app.getHttpServer());

  async function securityIdOf(symbol: string): Promise<string> {
    const security = await prisma.security.findFirst({
      where: { providerSymbol: symbol },
    });
    if (!security) {
      throw new Error(`No persisted security for ${symbol}`);
    }
    return security.id;
  }

  function chunkKey(securityId: string, family: string, year: number): string {
    return `${namespace}:security:${securityId}:${family}:${year}`;
  }

  async function readRedisDailyStateYear(
    securityId: string,
    year: number,
  ): Promise<Array<Record<string, unknown>> | null> {
    const payload = await redis.get(chunkKey(securityId, "daily-state", year));
    return payload === null ? null : JSON.parse(payload);
  }

  async function readRedisManifest(securityId: string): Promise<StockManifest | null> {
    const payload = await redis.get(`${namespace}:security:${securityId}:manifest`);
    return payload === null ? null : JSON.parse(payload);
  }

  async function readRedisStockKeys(securityId: string): Promise<string[]> {
    return redis.smembers(`${namespace}:security:${securityId}:keys`);
  }

  async function readDbDerivedRows(securityId: string, range?: Required<DateRange>) {
    const rows = await prisma.dailyDerivedState.findMany({
      where: {
        securityId,
        ...(range
          ? {
              date: {
                gte: new Date(`${range.from}T00:00:00.000Z`),
                lte: new Date(`${range.to}T00:00:00.000Z`),
              },
            }
          : {}),
      },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      sma20d: row.sma20d === null ? undefined : Number(row.sma20d),
      dcfFcff: row.dcfFcff === null ? undefined : Number(row.dcfFcff),
      residualIncome:
        row.residualIncome === null ? undefined : Number(row.residualIncome),
      ddm: row.ddm === null ? undefined : Number(row.ddm),
      graham: row.graham === null ? undefined : Number(row.graham),
      blendBalanced:
        row.blendBalanced === null ? undefined : Number(row.blendBalanced),
      blendConservative:
        row.blendConservative === null ? undefined : Number(row.blendConservative),
      blendDividend:
        row.blendDividend === null ? undefined : Number(row.blendDividend),
      dcfFcffSourceAsOf: row.dcfFcffSourceAsOf?.toISOString(),
      residualIncomeSourceAsOf: row.residualIncomeSourceAsOf?.toISOString(),
      ddmSourceAsOf: row.ddmSourceAsOf?.toISOString(),
      grahamSourceAsOf: row.grahamSourceAsOf?.toISOString(),
      intrinsicCurrency: row.intrinsicCurrency ?? undefined,
    }));
  }

  async function readDbStockSnapshot(securityId: string) {
    // Ordered explicitly: two reads of unchanged rows must compare equal, and without an order the
    // planner is free to return them in heap order one time and index order the next.
    const [prices, statements, derived, states, coverage] = await Promise.all([
      prisma.dailyPrice.count({ where: { securityId } }),
      prisma.financialStatement.count({ where: { securityId } }),
      prisma.dailyDerivedState.count({ where: { securityId } }),
      prisma.stockDatasetState.findMany({
        where: { securityId },
        orderBy: [{ dataset: "asc" }, { variant: "asc" }],
      }),
      prisma.stockDatasetCoverage.findMany({
        where: { securityId },
        orderBy: [{ dataset: "asc" }, { variant: "asc" }, { fromDate: "asc" }],
      }),
    ]);
    return { prices, statements, derived, states, coverage };
  }

  /** HTTP, PostgreSQL, and Redis must agree on prices, technicals, models, and blends. */
  async function expectApiDbRedisConsistent(
    symbol: string,
    securityId: string,
    range: Required<DateRange>,
  ): Promise<void> {
    const [pricesRes, technicalsRes, intrinsicRes, blendsRes] = await Promise.all([
      http().get(`/stocks/${symbol}/prices?from=${range.from}&to=${range.to}`).expect(200),
      http()
        .get(`/stocks/${symbol}/technicals/daily?from=${range.from}&to=${range.to}`)
        .expect(200),
      http()
        .get(
          `/stocks/${symbol}/intrinsic-values?from=${range.from}&to=${range.to}&models=DCF_FCFF`,
        )
        .expect(200),
      http()
        .get(
          `/stocks/${symbol}/intrinsic-value-blends?from=${range.from}&to=${range.to}&blendIds=BALANCED`,
        )
        .expect(200),
    ]);

    const dbPrices = await prisma.dailyPrice.findMany({
      where: {
        securityId,
        date: {
          gte: new Date(`${range.from}T00:00:00.000Z`),
          lte: new Date(`${range.to}T00:00:00.000Z`),
        },
      },
      orderBy: { date: "asc" },
    });
    expect(
      pricesRes.body.map((row: { date: string; close: number }) => [row.date, row.close]),
    ).toEqual(
      dbPrices.map((row) => [row.date.toISOString().slice(0, 10), Number(row.close)]),
    );

    const dbDerived = await readDbDerivedRows(securityId, range);
    expect(
      technicalsRes.body.map((row: { date: string }) => row.date),
    ).toEqual(dbDerived.map((row) => row.date));
    for (const apiRow of technicalsRes.body as Array<{
      date: string;
      sma20d?: number;
    }>) {
      const dbRow = dbDerived.find((row) => row.date === apiRow.date);
      expect(dbRow, apiRow.date).toBeDefined();
      expect(apiRow.sma20d).toBe(dbRow?.sma20d);
    }

    const dbDcfPoints = dbDerived.filter(
      (row) => row.dcfFcff !== undefined && row.dcfFcffSourceAsOf !== undefined,
    );
    expect(
      intrinsicRes.body.map(
        (point: { valuationDate: string; valuePerShare: number }) => [
          point.valuationDate,
          point.valuePerShare,
        ],
      ),
    ).toEqual(dbDcfPoints.map((row) => [row.date, row.dcfFcff]));

    const dbBalancedPoints = dbDerived.filter(
      (row) => row.blendBalanced !== undefined,
    );
    expect(
      blendsRes.body.map((point: { valuationDate: string; valuePerShare: number }) => [
        point.valuationDate,
        point.valuePerShare,
      ]),
    ).toEqual(
      dbBalancedPoints
        .filter(
          (row) =>
            row.dcfFcff !== undefined &&
            row.residualIncome !== undefined &&
            row.graham !== undefined,
        )
        .map((row) => [row.date, row.blendBalanced]),
    );

    // Redis carries the same unified daily state in yearly chunks.
    for (
      let year = Number(range.from.slice(0, 4));
      year <= Number(range.to.slice(0, 4));
      year += 1
    ) {
      const chunk = await readRedisDailyStateYear(securityId, year);
      expect(chunk, `daily-state:${year}`).not.toBeNull();
      for (const cached of chunk as Array<{
        date: string;
        sma20d?: number;
        intrinsicValues?: Record<string, number>;
      }>) {
        if (cached.date < range.from || cached.date > range.to) {
          continue;
        }
        const dbRow = dbDerived.find((row) => row.date === cached.date);
        expect(dbRow, cached.date).toBeDefined();
        expect(cached.sma20d).toBe(dbRow?.sma20d);
        expect(cached.intrinsicValues?.DCF_FCFF).toBe(dbRow?.dcfFcff);
        expect(cached.intrinsicValues?.GRAHAM).toBe(dbRow?.graham);
      }
    }
  }

  beforeAll(async () => {
    if (!redisUrl) {
      throw new Error(
        "Stock infrastructure tests need Redis: set TEST_REDIS_URL or REDIS_URL " +
          "(start local infrastructure with `pnpm infra:up`).",
      );
    }
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.REDIS_URL = redisUrl;

    const preflight = new PrismaClient();
    try {
      await preflight.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new Error(
        `PostgreSQL at ${databaseUrl.replace(/:\/\/[^@]*@/, "://***@")} is unreachable: ` +
          `${String(error)}. Start it with \`pnpm infra:up\`.`,
      );
    }
    try {
      await preflight.security.count();
    } catch (error) {
      throw new Error(
        `The test database schema is not migrated: ${String(error)}. Run ` +
          "`TEST_DATABASE_URL=<url> pnpm db:test:prepare` (prisma migrate deploy) first.",
      );
    } finally {
      await preflight.$disconnect();
    }

    redis = createStockDataRedisClient(redisUrl);
    try {
      await redis.ping();
    } catch (error) {
      throw new Error(
        `Redis at the configured test REDIS_URL is unreachable: ${String(error)}. ` +
          "Start it with `pnpm infra:up`.",
      );
    }

    // Fixtures: every stock is an isolated randomized symbol with its own data.
    provider.register(symbols.lifecycle, {
      name: "Lifecycle Corp",
      prices: priceSeries("2025-01-02", TODAY),
      statements: standardQuarters(fiscalQuarterRange(2024, "Q1", 2026, "Q2")),
    });

    const pitStatements = standardQuarters(fiscalQuarterRange(2024, "Q1", 2025, "Q3"));
    pitStatements
      .get("INCOME:QUARTERLY")!
      .push(
        quarterDraft(
          "INCOME",
          2025,
          "Q4",
          { netIncome: 24, interestExpense: 2.5, epsDiluted: 2.4, weightedAverageShsOutDil: 10 },
          "2026-02-02",
        ),
        // Later immutable revision: restated income, PIT-effective from 2026-04-10.
        quarterDraft(
          "INCOME",
          2025,
          "Q4",
          { netIncome: 18, interestExpense: 2.5, epsDiluted: 1.8, weightedAverageShsOutDil: 10 },
          "2026-04-09",
        ),
        // Invalidating revision: epsDiluted missing, GRAHAM must drop from 2026-06-02.
        quarterDraft(
          "INCOME",
          2025,
          "Q4",
          { netIncome: 18, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
          "2026-06-01",
        ),
        // Restoring revision from 2026-07-02.
        quarterDraft(
          "INCOME",
          2025,
          "Q4",
          { netIncome: 19, interestExpense: 2.5, epsDiluted: 1.9, weightedAverageShsOutDil: 10 },
          "2026-07-01",
        ),
      );
    pitStatements
      .get("CASH_FLOW:QUARTERLY")!
      .push(quarterDraft("CASH_FLOW", 2025, "Q4", CASH_FLOW_QUARTER, "2026-02-02"));
    pitStatements.get("BALANCE_SHEET:QUARTERLY")!.push(
      // Filed Friday 2026-02-06 -> available Saturday 2026-02-07 -> effective Monday 02-09.
      quarterDraft(
        "BALANCE_SHEET",
        2025,
        "Q4",
        { cashAndShortTermInvestments: 50, totalDebt: 30, totalStockholdersEquity: 560 },
        "2026-02-06",
      ),
    );
    provider.register(symbols.pit, {
      name: "Point In Time Corp",
      prices: priceSeries("2026-01-02", TODAY),
      statements: pitStatements,
    });

    const warmupStatements = standardQuarters(fiscalQuarterRange(2021, "Q3", 2022, "Q2"));
    warmupStatements.set("INCOME:ANNUAL", [
      annualIncomeDraft(2021, { revenue: 400 * 1.1 ** 5, netIncome: 80 }),
      annualIncomeDraft(2016, { revenue: 400, netIncome: 50 }),
      // Older than historyYears + 7 warm-up years: must be discarded by retention.
      annualIncomeDraft(2014, { revenue: 300, netIncome: 30 }),
    ]);
    provider.register(symbols.warmup, {
      name: "Warmup Retention Corp",
      prices: priceSeries(CANONICAL_START, "2022-12-30"),
      statements: warmupStatements,
    });

    const smallStatements = () => standardQuarters(fiscalQuarterRange(2025, "Q1", 2025, "Q4"));
    const smallPrices = () => priceSeries("2026-06-01", TODAY);
    provider.register(symbols.isolationX, {
      name: "Isolation X Corp",
      prices: smallPrices(),
      statements: smallStatements(),
    });
    provider.register(symbols.isolationY, {
      name: "Isolation Y Corp",
      prices: priceSeries("2026-06-01", TODAY, 200),
      statements: smallStatements(),
    });
    provider.register(symbols.restart, {
      name: "Restart Corp",
      prices: smallPrices(),
      statements: smallStatements(),
    });
    provider.register(symbols.redisLoss, {
      name: "Redis Loss Corp",
      prices: priceSeries("2025-01-02", TODAY, 150),
      statements: standardQuarters(fiscalQuarterRange(2024, "Q1", 2026, "Q2")),
    });
    provider.register(symbols.authority, {
      name: "Postgres Authority Corp",
      prices: smallPrices(),
      statements: smallStatements(),
    });
    provider.register(symbols.lruOne, {
      name: "LRU One Corp",
      prices: smallPrices(),
      statements: smallStatements(),
    });
    provider.register(symbols.lruTwo, {
      name: "LRU Two Corp",
      prices: priceSeries("2026-06-01", TODAY, 300),
      statements: smallStatements(),
    });
    // Price history across a horizon deep enough that a one-year window plus the derived warm-up
    // is genuinely partial, with real rows before it — an empty answer would hide a missed gap.
    provider.register(symbols.widening, {
      name: "Widening History Corp",
      prices: priceSeries(WIDENING_START, TODAY, 120),
      statements: standardQuarters(fiscalQuarterRange(2007, "Q1", 2026, "Q2")),
    });
    // A provider whose history begins years after the widening horizon, so the boundary it proves
    // is distinct from the horizon. Its fundamentals are seeded as already resident, so the scenario
    // never asks it for statements.
    provider.register(symbols.legacy, {
      name: "Legacy Revision Corp",
      prices: priceSeries(LEGACY_PROVIDER_START, TODAY, 90),
      statements: new Map(),
    });

    app = await createStockApp({ provider, namespace });
    prisma = app.get(PrismaService);

    // `Security` is the catalog of supported stocks and nothing discovers one lazily any more, so
    // every fixture is admitted to the catalog first — the same precondition the admin universe
    // synchronization establishes in production. Only identity is seeded: prices, fundamentals and
    // derived state still hydrate lazily on first request, which is what these tests exercise.
    for (const [symbol, fixture] of provider.fixtures) {
      await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: fixture.name,
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
    }
  }, SLOW);

  afterAll(async () => {
    // Targeted cleanup: only this suite's randomized symbols and namespace keys.
    if (prisma) {
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: Object.values(symbols) } },
      });
    }
    for (const close of closers) {
      await close();
    }
    if (app) {
      await app.close();
    }
    if (redis) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${namespace}*`,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
      redis.disconnect();
    }
  }, SLOW);

  describe("cold hydration through the full stack", () => {
    it(
      "hydrates a cold stock once and answers from every layer consistently",
      async () => {
        const symbol = symbols.lifecycle;
        const before = provider.callCounts();
        const response = await http()
          .get(`/stocks/${symbol}?from=2025-01-01&to=${TODAY}`)
          .expect(200);

        // HTTP surface.
        expect(response.body.security).toMatchObject({
          symbol,
          exchangeCode: "NASDAQ",
          currency: "USD",
        });
        expect(response.body.profile.description).toContain(symbol);
        const tradingDays = businessDays("2025-01-02", TODAY);
        expect(response.body.prices).toHaveLength(tradingDays.length);
        expect(response.body.technicals).toHaveLength(tradingDays.length);
        const lastTechnical = response.body.technicals.at(-1);
        expect(lastTechnical.sma20d).toBeGreaterThan(0);
        expect(lastTechnical.ema20d).toBeGreaterThan(0);

        // Weekly moving averages travel the same HTTP -> service -> PostgreSQL/Redis path as the
        // daily ones. The fixture spans roughly 87 completed weeks, so 20W/50W are warmed up while
        // 100W/200W are legitimately absent — never zero, never a shorter period standing in.
        expect(lastTechnical.sma20w).toBeGreaterThan(0);
        expect(lastTechnical.ema50w).toBeGreaterThan(0);
        expect(lastTechnical).not.toHaveProperty("sma100w");
        expect(lastTechnical).not.toHaveProperty("sma200w");
        expect(lastTechnical).not.toHaveProperty("ema200w");

        // A completed week becomes visible on its own final trading day and is then repeated:
        // Thursday cannot already carry the value that Friday's close produces.
        const weeklyByDate = new Map<string, number | undefined>(
          response.body.technicals.map(
            (row: { date: string; sma20w?: number }) => [row.date, row.sma20w],
          ),
        );
        const friday = "2026-06-19";
        expect(weeklyByDate.get("2026-06-18")).not.toBe(weeklyByDate.get(friday));
        for (const carried of ["2026-06-22", "2026-06-23", "2026-06-24"]) {
          expect(weeklyByDate.get(carried)).toBe(weeklyByDate.get(friday));
        }
        // Intrinsic values exist only where inputs support them: first full TTM window
        // becomes point-in-time eligible on Monday 2025-02-03 (Q4-2024 available Sat 02-01).
        const grahamPoints = response.body.intrinsicValues.filter(
          (point: { model: string }) => point.model === "GRAHAM",
        );
        expect(grahamPoints[0].valuationDate).toBe("2025-02-03");
        expect(grahamPoints[0].valuePerShare).toBeCloseTo(GOLDEN.GRAHAM, 6);
        expect(grahamPoints[0].currency).toBe("USD");
        const lastByModel = new Map<string, number>(
          response.body.intrinsicValues
            .filter((point: { valuationDate: string }) => point.valuationDate === TODAY)
            .map((point: { model: string; valuePerShare: number }) => [
              point.model,
              point.valuePerShare,
            ]),
        );
        expect(lastByModel.get("DCF_FCFF")).toBeCloseTo(GOLDEN.DCF_FCFF, 6);
        expect(lastByModel.get("RESIDUAL_INCOME")).toBeCloseTo(GOLDEN.RESIDUAL_INCOME, 6);
        expect(lastByModel.get("DDM")).toBeCloseTo(GOLDEN.DDM, 6);
        expect(lastByModel.get("GRAHAM")).toBeCloseTo(GOLDEN.GRAHAM, 6);
        const lastBlends = new Map<string, number>(
          response.body.intrinsicValueBlends
            .filter((point: { valuationDate: string }) => point.valuationDate === TODAY)
            .map((point: { blendId: string; valuePerShare: number }) => [
              point.blendId,
              point.valuePerShare,
            ]),
        );
        expect(lastBlends.get("BALANCED")).toBeCloseTo(GOLDEN.BALANCED, 6);
        expect(lastBlends.get("CONSERVATIVE")).toBeCloseTo(GOLDEN.CONSERVATIVE, 6);
        expect(lastBlends.get("DIVIDEND")).toBeCloseTo(GOLDEN.DIVIDEND, 6);
        for (const blendId of ["BALANCED", "CONSERVATIVE", "DIVIDEND"] as const) {
          expect(lastBlends.get(blendId)).toBeCloseTo(
            expectedBlendValue(blendId, Object.fromEntries(lastByModel)),
            6,
          );
        }

        // Provider boundary: exactly one profile, one full-horizon price delta,
        // and the six-source fundamentals backfill with retention-aware limits.
        const after = provider.callCounts();
        expect(after.profiles - before.profiles).toBe(1);
        expect(provider.dailyPriceCalls.filter((call) => call.symbol === symbol)).toEqual([
          { symbol, from: CANONICAL_START, to: TODAY },
        ]);
        const statementCalls = provider.statementCalls.filter(
          (call) => call.symbol === symbol,
        );
        expect(statementCalls).toHaveLength(6);
        for (const call of statementCalls) {
          expect(call.limit).toBe(
            call.cadence === "QUARTERLY" ? QUARTERLY_BACKFILL_LIMIT : ANNUAL_BACKFILL_LIMIT,
          );
        }

        // PostgreSQL is the durable source of truth.
        const securityId = await securityIdOf(symbol);
        expect(
          await prisma.security.count({ where: { providerSymbol: symbol } }),
        ).toBe(1);
        const profile = await prisma.securityProfile.findUnique({
          where: { securityId },
        });
        expect(profile?.description).toContain(symbol);
        const snapshot = await readDbStockSnapshot(securityId);
        expect(snapshot.prices).toBe(tradingDays.length);
        expect(snapshot.derived).toBe(tradingDays.length);
        // 10 fiscal quarters x 3 statement families, each an immutable revision row.
        expect(snapshot.statements).toBe(30);
        const derivedState = snapshot.states.find(
          (state) => state.dataset === StockDataset.DAILY_DERIVED_STATE,
        );
        expect(derivedState?.variant).toBe(DAILY_DERIVED_STATE_VARIANT);
        expect(derivedState?.variant).toBe(
          `daily-derived-state:r${DERIVED_STATE_REVISION}`,
        );
        // r4 is the current methodology: daily technicals, the seven catalog weekly moving
        // averages, materialized intrinsic values/blends, and the daily RSI oscillators.
        expect(DERIVED_STATE_REVISION).toBe(4);
        const fundamentalsVariants = snapshot.states
          .filter((state) =>
            ["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"].includes(state.dataset),
          )
          .map((state) => state.variant)
          .sort();
        expect(fundamentalsVariants).toEqual([
          `standard:annual:v1:h${HISTORY_YEARS}:w7`,
          `standard:annual:v1:h${HISTORY_YEARS}:w7`,
          `standard:annual:v1:h${HISTORY_YEARS}:w7`,
          `standard:quarter:v1:h${HISTORY_YEARS}:w7`,
          `standard:quarter:v1:h${HISTORY_YEARS}:w7`,
          `standard:quarter:v1:h${HISTORY_YEARS}:w7`,
        ]);
        expect(
          snapshot.coverage.some(
            (row) =>
              row.dataset === StockDataset.DAILY_PRICE &&
              row.fromDate.toISOString().slice(0, 10) === CANONICAL_START &&
              row.toDate.toISOString().slice(0, 10) === TODAY,
          ),
        ).toBe(true);
        expect(
          snapshot.coverage.some(
            (row) =>
              row.dataset === StockDataset.DAILY_DERIVED_STATE &&
              row.variant === DAILY_DERIVED_STATE_VARIANT,
          ),
        ).toBe(true);
        const lastDbRow = (await readDbDerivedRows(securityId)).at(-1);
        // Technicals and intrinsic fields coexist on one unified row.
        expect(lastDbRow?.sma20d).toBeGreaterThan(0);
        expect(lastDbRow?.dcfFcff).toBeCloseTo(GOLDEN.DCF_FCFF, 6);
        expect(lastDbRow?.graham).toBeCloseTo(GOLDEN.GRAHAM, 6);
        expect(lastDbRow?.blendBalanced).toBeCloseTo(GOLDEN.BALANCED, 6);
        expect(lastDbRow?.dcfFcffSourceAsOf).toBe("2026-08-01T00:00:00.000Z");
        expect(lastDbRow?.intrinsicCurrency).toBe("USD");

        // Redis: READY manifest and the yearly chunk families, nothing more.
        const manifest = await readRedisManifest(securityId);
        expect(manifest).toMatchObject({
          status: "READY",
          historyYears: HISTORY_YEARS,
          derivedStateRevision: DERIVED_STATE_REVISION,
          canonicalHistoryStart: "2025-01-02",
          canonicalHistoryEnd: TODAY,
        });
        const keys = await readRedisStockKeys(securityId);
        for (let year = 2022; year <= 2026; year += 1) {
          expect(keys).toContain(chunkKey(securityId, "prices:1D", year));
          expect(keys).toContain(chunkKey(securityId, "daily-state", year));
        }
        // Retained fundamentals years (warm-up included) live under the existing family.
        expect(keys).toContain(chunkKey(securityId, "financials:income:quarter:v1", 2015));
        expect(keys).toContain(chunkKey(securityId, "financials:income:quarter:v1", 2026));
        expect(keys).toContain(chunkKey(securityId, "financials:balance-sheet:quarter:v1", 2024));
        expect(keys).toContain(chunkKey(securityId, "financials:cash-flow:annual:v1", 2020));
        // No separate intrinsic/valuation/blend key family exists.
        expect(keys.filter((key) => /intrinsic|valuation|blend/i.test(key))).toEqual([]);
        const chunk2026 = await readRedisDailyStateYear(securityId, 2026);
        const cachedLast = chunk2026?.at(-1) as {
          date: string;
          sma20d?: number;
          intrinsicValues?: Record<string, number>;
          intrinsicValueBlends?: Record<string, number>;
          intrinsicCurrency?: string;
        };
        expect(cachedLast.date).toBe(TODAY);
        expect(cachedLast.sma20d).toBeGreaterThan(0);
        expect(cachedLast.intrinsicValues?.GRAHAM).toBeCloseTo(GOLDEN.GRAHAM, 6);
        expect(cachedLast.intrinsicValueBlends?.BALANCED).toBeCloseTo(GOLDEN.BALANCED, 6);
        expect(cachedLast.intrinsicCurrency).toBe("USD");
      },
      SLOW,
    );

    it(
      "serves repeated requests and projections from the same canonical state",
      async () => {
        const symbol = symbols.lifecycle;
        const securityId = await securityIdOf(symbol);
        const before = provider.callCounts();
        const dbBefore = await readDbStockSnapshot(securityId);

        const details = await http()
          .get(`/stocks/${symbol}?from=2025-01-01&to=${TODAY}`)
          .expect(200);
        const prices = await http()
          .get(`/stocks/${symbol}/prices?from=2025-01-01&to=${TODAY}`)
          .expect(200);
        const technicals = await http()
          .get(`/stocks/${symbol}/technicals/daily?from=2025-01-01&to=${TODAY}`)
          .expect(200);
        const intrinsics = await http()
          .get(`/stocks/${symbol}/intrinsic-values?from=2025-01-01&to=${TODAY}&asOf=${TODAY}`)
          .expect(200);
        const blends = await http()
          .get(
            `/stocks/${symbol}/intrinsic-value-blends?from=2025-01-01&to=${TODAY}&asOf=${TODAY}`,
          )
          .expect(200);

        // No second backfill, no new rows, no duplicate financial revisions.
        expect(provider.callCounts()).toEqual(before);
        expect(await readDbStockSnapshot(securityId)).toMatchObject({
          prices: dbBefore.prices,
          statements: dbBefore.statements,
          derived: dbBefore.derived,
        });
        expect((await readRedisManifest(securityId))?.status).toBe("READY");

        // The projection endpoints expose the same canonical state as Stock Details.
        expect(prices.body).toEqual(details.body.prices);
        expect(technicals.body).toEqual(details.body.technicals);
        expect(intrinsics.body).toEqual(details.body.intrinsicValues);
        expect(blends.body).toEqual(details.body.intrinsicValueBlends);
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2026-08-01",
          to: TODAY,
        });
      },
      SLOW,
    );

    it("normalizes lowercase symbols and validates model, blend, and asOf inputs", async () => {
      const symbol = symbols.lifecycle;
      const before = provider.callCounts();
      const lowered = await http()
        .get(`/stocks/${symbol.toLowerCase()}?from=2026-08-01&to=${TODAY}`)
        .expect(200);
      expect(lowered.body.security.symbol).toBe(symbol);
      expect(provider.callCounts()).toEqual(before);

      await http()
        .get(`/stocks/${symbol}/intrinsic-values?models=NOT_A_MODEL`)
        .expect(400);
      await http()
        .get(`/stocks/${symbol}/intrinsic-value-blends?blendIds=NOT_A_BLEND`)
        .expect(400);
      await http()
        .get(`/stocks/${symbol}/intrinsic-values?asOf=not-a-date`)
        .expect(400);
      // Projection rows never leak internal identity or version metadata.
      const points = await http()
        .get(`/stocks/${symbol}/intrinsic-values?from=${TODAY}&to=${TODAY}`)
        .expect(200);
      for (const point of points.body) {
        expect(point).not.toHaveProperty("securityId");
        expect(point).not.toHaveProperty("calculationVersion");
      }
    });
  });

  describe("a partially loaded stock widening its history", () => {
    // Its own app because the scenario needs a horizon deeper than one window plus the derived
    // warm-up; everything else about the wiring — PostgreSQL, Redis, Redlock, the controller — is
    // the same production stack the rest of the suite drives.
    let wideningApp: INestApplication;

    const wideningHttp = () => request(wideningApp.getHttpServer());

    beforeAll(async () => {
      wideningApp = await createStockApp({
        provider,
        namespace,
        historyYears: WIDENING_HISTORY_YEARS,
      });
      closers.push(async () => wideningApp.close());
    }, SLOW);

    it(
      "detects the missing older interval and fetches only that, once",
      async () => {
        const symbol = symbols.widening;
        const priceRangesFor = () =>
          provider.dailyPriceCalls.filter((call) => call.symbol === symbol);

        // 1. The page opens on a bounded window, exactly as Stock Details asks for it.
        await wideningHttp()
          .get(`/stocks/${symbol}?from=2026-01-02&to=${TODAY}`)
          .expect(200);
        const securityId = await securityIdOf(symbol);

        expect(priceRangesFor()).toHaveLength(1);
        const resident = await readRedisManifest(securityId);
        // Caller-scoped: the requested window plus the derived warm-up, not the whole horizon.
        const coverageStart = resident?.coverageStart;
        expect(coverageStart).toBeDefined();
        expect(coverageStart! > WIDENING_START).toBe(true);

        const rowsAfterOpen = await prisma.dailyPrice.count({ where: { securityId } });
        expect(rowsAfterOpen).toBeGreaterThan(0);

        // 2. The user pans back past what is resident. Price rows, a Redis manifest, a coverage
        //    record and derived rows all already exist for this security — none of that may be
        //    read as "the older interval is available".
        const older = addDays(coverageStart!, -200);
        const widened = await wideningHttp()
          .get(`/stocks/${symbol}/prices?from=${older}&to=${TODAY}`)
          .expect(200);

        expect(priceRangesFor()).toHaveLength(2);
        // Only the prefix: the interval already covered is not requested from the provider again.
        const delta = provider.dailyPriceCalls.at(-1)!;
        expect(delta.to! < coverageStart!).toBe(true);
        expect(delta.from! >= WIDENING_START).toBe(true);

        // The older rows are genuinely there, ascending, and the widening never narrowed the tail.
        const prices = widened.body as Array<{ date: string }>;
        expect(prices[0]!.date < coverageStart!).toBe(true);
        expect(prices.at(-1)!.date).toBe(TODAY);
        expect([...prices].sort((a, b) => a.date.localeCompare(b.date))).toEqual(prices);

        // 3. No duplicate rows at the seam between the two loads.
        const dates = await prisma.dailyPrice.findMany({
          where: { securityId },
          select: { date: true },
        });
        expect(new Set(dates.map((row) => row.date.valueOf())).size).toBe(dates.length);

        // 4. The derived state was materialized for the new interval too — with its own warm-up,
        //    so the oldest newly visible day carries the series rather than an empty row.
        const technicals = await wideningHttp()
          .get(`/stocks/${symbol}/technicals/daily?from=${older}&to=${coverageStart}`)
          .expect(200);
        const technicalRows = technicals.body as Array<Record<string, unknown>>;
        expect(technicalRows.length).toBeGreaterThan(0);
        expect(technicalRows[0]!.sma20d).toBeTypeOf("number");
        expect(technicalRows[0]!.rsi14d).toBeTypeOf("number");
        expect(technicalRows[0]!.sma200d).toBeTypeOf("number");

        // 5. Re-reading the same interval, and anything inside it, fetches nothing further.
        await wideningHttp()
          .get(`/stocks/${symbol}/prices?from=${older}&to=${TODAY}`)
          .expect(200);
        await wideningHttp()
          .get(`/stocks/${symbol}/prices?from=${addDays(older, 40)}&to=${TODAY}`)
          .expect(200);
        expect(priceRangesFor()).toHaveLength(2);
      },
      SLOW,
    );

    it(
      "reports the Stock Details bound and refuses to reach past it",
      async () => {
        const symbol = symbols.widening;

        const details = await wideningHttp()
          .get(`/stocks/${symbol}?from=1900-01-01&to=${TODAY}`)
          .expect(200);

        // The surface reports how far back it may go, from the loader that owns the clock and the
        // horizon, so the client navigates against the bound that will actually be honoured.
        expect(details.body.history).toEqual({
          start: WIDENING_START,
          end: TODAY,
          startOrigin: "HORIZON",
        });
        // ...and an out-of-bound `from` is clamped at the edge rather than reaching further back.
        expect(details.body.prices[0].date >= WIDENING_START).toBe(true);
        const outOfBound = provider.dailyPriceCalls.filter(
          (call) => call.symbol === symbol && call.from! < WIDENING_START,
        );
        expect(outOfBound).toEqual([]);
      },
      SLOW,
    );
  });

  describe("a stock persisted under price-dataset revision 1 heals itself", () => {
    // The state the v1 loader left behind for a long-listed stock, as AAPL was found: durable
    // coverage and a READY manifest claiming the whole horizon, price and derived rows only from
    // the day the provider's capped response happened to start, derived coverage claiming the
    // horizon too, and the fundamentals datasets already resident. The current loader can no
    // longer produce this state, so it is seeded directly, then driven through the same production
    // stack as the widening scenario at the same deeper horizon — no manual reset anywhere.
    let legacyApp: INestApplication;
    let securityId: string;
    let fixture: StockFixture;
    let manifestKey: string;
    let registryKey: string;

    const legacyHttp = () => request(legacyApp.getHttpServer());
    const priceCallsFor = () =>
      provider.dailyPriceCalls.filter((call) => call.symbol === symbols.legacy);
    const statementCallsFor = () =>
      provider.statementCalls.filter((call) => call.symbol === symbols.legacy);
    const dbDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
    const isoDate = (date: Date) => date.toISOString().slice(0, 10);
    const persistedPriceDates = async () =>
      (
        await prisma.dailyPrice.findMany({
          where: { securityId },
          select: { date: true },
          orderBy: { date: "asc" },
        })
      ).map((row) => isoDate(row.date));

    beforeAll(async () => {
      legacyApp = await createStockApp({
        provider,
        namespace,
        historyYears: WIDENING_HISTORY_YEARS,
      });
      closers.push(async () => legacyApp.close());

      securityId = await securityIdOf(symbols.legacy);
      fixture = provider.fixtures.get(symbols.legacy)!;
      manifestKey = `${namespace}:security:${securityId}:manifest`;
      registryKey = `${namespace}:security:${securityId}:keys`;
      const persisted = fixture.prices.filter(
        (row) => row.date >= LEGACY_PERSISTED_START,
      );
      const syncedAt = clock.instant;

      // Price rows: only the tail one capped v1 response returned. Derived rows exist for exactly
      // those days and nothing older.
      await prisma.dailyPrice.createMany({
        data: persisted.map((row) => ({
          securityId,
          date: dbDate(row.date),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: BigInt(row.volume),
        })),
      });
      await prisma.dailyDerivedState.createMany({
        data: persisted.map((row) => ({ securityId, date: dbDate(row.date) })),
      });

      // Coverage and state under the unversioned v1 variant claim the whole horizon, and so does
      // the derived coverage: nothing durable admits that the older years were never loaded.
      const horizonClaim = {
        fromDate: dbDate(WIDENING_START),
        toDate: dbDate(TODAY),
        lastSuccessfulSyncAt: syncedAt,
      };
      await prisma.stockDatasetCoverage.createMany({
        data: [
          {
            securityId,
            dataset: StockDataset.DAILY_PRICE,
            variant: LEGACY_DAILY_PRICE_VARIANT,
            ...horizonClaim,
          },
          {
            securityId,
            dataset: StockDataset.DAILY_DERIVED_STATE,
            variant: DAILY_DERIVED_STATE_VARIANT,
            ...horizonClaim,
          },
        ],
      });
      const horizonState = {
        earliestDate: dbDate(WIDENING_START),
        latestDate: dbDate(TODAY),
        lastSuccessfulSyncAt: syncedAt,
      };
      await prisma.stockDatasetState.createMany({
        data: [
          {
            securityId,
            dataset: StockDataset.DAILY_PRICE,
            variant: LEGACY_DAILY_PRICE_VARIANT,
            ...horizonState,
          },
          // The recent-tail freshness watermark is not revisioned, and the tail was current.
          {
            securityId,
            dataset: StockDataset.DAILY_PRICE,
            variant: DAILY_PRICE_FRESHNESS_VARIANT,
            earliestDate: dbDate(TODAY),
            latestDate: dbDate(TODAY),
            lastSuccessfulSyncAt: syncedAt,
          },
          {
            securityId,
            dataset: StockDataset.DAILY_DERIVED_STATE,
            variant: DAILY_DERIVED_STATE_VARIANT,
            ...horizonState,
          },
          // Fundamentals were resident and current: the price revision is the only stale thing.
          ...(
            ["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"] as const
          ).flatMap((dataset) =>
            (["QUARTERLY", "ANNUAL"] as const).map((cadence) => ({
              securityId,
              dataset: StockDataset[dataset],
              variant: fundamentalsDatasetVariant(
                cadence,
                WIDENING_HISTORY_YEARS,
              ),
              lastSuccessfulSyncAt: syncedAt,
            })),
          ),
        ],
      });

      // The v1 READY manifest, registered exactly as the cache registers its own keys, with the
      // stock resident in the LRU. Everything but the price-dataset revision is current.
      const legacyManifest: StockManifest = {
        securityId,
        status: "READY",
        historyYears: WIDENING_HISTORY_YEARS,
        coverageStart: WIDENING_START,
        coverageEnd: TODAY,
        canonicalHistoryStart: persisted[0]!.date,
        canonicalHistoryEnd: persisted.at(-1)!.date,
        hydratedAt: syncedAt.toISOString(),
        lastPriceRefreshAt: syncedAt.toISOString(),
        lastFundamentalsRefreshAt: syncedAt.toISOString(),
        priceDatasetVersion: 1,
        financialStatementVersion: FINANCIAL_STATEMENT_VERSION,
        derivedStateRevision: DERIVED_STATE_REVISION,
      };
      await redis.set(manifestKey, JSON.stringify(legacyManifest));
      await redis.sadd(registryKey, manifestKey);
      await redis.zadd(
        `${namespace}:resident-stocks`,
        await redis.incr(`${namespace}:access-sequence`),
        securityId,
      );
    }, SLOW);

    it(
      "recovers the history the v1 claim hid and moves the stock to the current revision",
      async () => {
        expect(priceCallsFor()).toEqual([]);
        const expectedDates = fixture.prices.map((row) => row.date);

        const healed = await legacyHttp()
          .get(
            `/stocks/${symbols.legacy}/prices?from=${WIDENING_START}&to=${TODAY}`,
          )
          .expect(200);

        // HTTP: the provider's complete history, from its first trading day through today, each
        // day once and in order.
        const dates = (healed.body as Array<{ date: string }>).map(
          (row) => row.date,
        );
        expect(dates[0]).toBe(LEGACY_PROVIDER_START);
        expect(dates.at(-1)).toBe(TODAY);
        expect(dates).toEqual(expectedDates);

        // Provider boundary: the v1 claim was not evidence. The caller's whole target was asked
        // for again, exactly once, and the resident fundamentals were left alone.
        expect(priceCallsFor()).toEqual([
          { symbol: symbols.legacy, from: WIDENING_START, to: TODAY },
        ]);
        expect(statementCallsFor()).toEqual([]);

        // PostgreSQL: every provider row persisted once; one generation of price coverage, under
        // the current revision and spanning the target; the v1 rows gone from both tables and
        // the freshness watermark kept.
        expect(await persistedPriceDates()).toEqual(expectedDates);
        const priceCoverage = await prisma.stockDatasetCoverage.findMany({
          where: { securityId, dataset: StockDataset.DAILY_PRICE },
        });
        expect(
          priceCoverage.map((row) => ({
            variant: row.variant,
            from: isoDate(row.fromDate),
            to: isoDate(row.toDate),
          })),
        ).toEqual([
          { variant: DAILY_PRICE_VARIANT, from: WIDENING_START, to: TODAY },
        ]);
        const priceStates = await prisma.stockDatasetState.findMany({
          where: { securityId, dataset: StockDataset.DAILY_PRICE },
        });
        expect(priceStates.map((row) => row.variant).sort()).toEqual(
          [DAILY_PRICE_VARIANT, DAILY_PRICE_FRESHNESS_VARIANT].sort(),
        );

        // Derived state: rebuilt from the recovered origin rather than patched in front of the
        // rows that used to exist. One row per trading day; a day a year into the recovered
        // prefix carries the warmed-up series, and so does the last day, whose seeded row had none.
        const derived = await prisma.dailyDerivedState.findMany({
          where: { securityId },
          orderBy: { date: "asc" },
        });
        expect(derived.map((row) => isoDate(row.date))).toEqual(expectedDates);
        const yearIn = addDays(LEGACY_PROVIDER_START, 365);
        const insidePrefix = derived.find(
          (row) => isoDate(row.date) >= yearIn,
        )!;
        expect(isoDate(insidePrefix.date) < LEGACY_PERSISTED_START).toBe(true);
        for (const row of [insidePrefix, derived.at(-1)!]) {
          expect(row.sma20d?.toNumber()).toBeTypeOf("number");
          expect(row.sma200d?.toNumber()).toBeTypeOf("number");
          expect(row.rsi14d?.toNumber()).toBeTypeOf("number");
        }

        // Redis: a READY manifest on the current revision, describing the recovered history.
        expect(await readRedisManifest(securityId)).toMatchObject({
          status: "READY",
          historyYears: WIDENING_HISTORY_YEARS,
          priceDatasetVersion: PRICE_DATASET_VERSION,
          coverageStart: WIDENING_START,
          coverageEnd: TODAY,
          canonicalHistoryStart: LEGACY_PROVIDER_START,
          canonicalHistoryEnd: TODAY,
        });
      },
      SLOW,
    );

    it(
      "reports the proven provider boundary as the history start without inventing a listing date",
      async () => {
        const details = await legacyHttp()
          .get(
            `/stocks/${symbols.legacy}?from=${addDays(TODAY, -365)}&to=${TODAY}`,
          )
          .expect(200);

        // Complete current-revision coverage from the horizon to the day before the first row is
        // the proof that the provider has nothing older, so the boundary is the provider's...
        expect(details.body.history).toEqual({
          start: LEGACY_PROVIDER_START,
          end: TODAY,
          startOrigin: "PROVIDER",
        });
        // ...and a boundary is not a listing date: the catalog identity is exactly as seeded.
        expect(details.body.security).not.toHaveProperty("ipoDate");
        const security = await prisma.security.findUniqueOrThrow({
          where: { id: securityId },
        });
        expect(security.ipoDate).toBeNull();
        expect(priceCallsFor()).toHaveLength(1);
      },
      SLOW,
    );

    it(
      "asks the provider nothing further once the repair is durable, even after Redis loses the stock",
      async () => {
        const expectedDates = fixture.prices.map((row) => row.date);
        const dbBefore = await readDbStockSnapshot(securityId);

        // The same range again, then a narrower one inside it.
        await legacyHttp()
          .get(
            `/stocks/${symbols.legacy}/prices?from=${WIDENING_START}&to=${TODAY}`,
          )
          .expect(200);
        await legacyHttp()
          .get(`/stocks/${symbols.legacy}/prices?from=2020-01-02&to=2020-12-31`)
          .expect(200);
        expect(priceCallsFor()).toHaveLength(1);

        // Lose only this stock's Redis state; PostgreSQL is untouched.
        const registered = await readRedisStockKeys(securityId);
        expect(registered).toContain(manifestKey);
        await redis.del(...registered, registryKey);
        await redis.zrem(`${namespace}:resident-stocks`, securityId);

        const recovered = await legacyHttp()
          .get(
            `/stocks/${symbols.legacy}/prices?from=${WIDENING_START}&to=${TODAY}`,
          )
          .expect(200);
        expect(
          (recovered.body as Array<{ date: string }>).map((row) => row.date),
        ).toEqual(expectedDates);
        // Current-revision coverage is durable evidence, so nothing is refetched and nothing
        // durable changes; the cache is rebuilt on the current revision.
        expect(priceCallsFor()).toHaveLength(1);
        expect(statementCallsFor()).toEqual([]);
        expect(await readDbStockSnapshot(securityId)).toEqual(dbBefore);
        expect(await readRedisManifest(securityId)).toMatchObject({
          status: "READY",
          priceDatasetVersion: PRICE_DATASET_VERSION,
          coverageStart: WIDENING_START,
          canonicalHistoryStart: LEGACY_PROVIDER_START,
        });
      },
      SLOW,
    );
  });

  describe("point-in-time intrinsic lifecycle end to end", () => {
    const grahamSeries = async (
      query: string,
    ): Promise<Array<{ valuationDate: string; valuePerShare: number; sourceDataAsOf: string }>> => {
      const response = await http()
        .get(`/stocks/${symbols.pit}/intrinsic-values?models=GRAHAM&${query}`)
        .expect(200);
      return response.body;
    };
    const grahamOn = async (date: string) => {
      const points = await grahamSeries(`from=${date}&to=${date}`);
      return points[0];
    };

    it(
      "replays statement revisions into PIT-correct daily valuations",
      async () => {
        const symbol = symbols.pit;
        await http().get(`/stocks/${symbol}?from=2026-01-01&to=${TODAY}`).expect(200);
        const securityId = await securityIdOf(symbol);

        // Opening state from statements that were already public.
        expect((await grahamOn("2026-01-30"))?.valuePerShare).toBeCloseTo(148, 6);

        // The Q4-2025 income statement becomes available on 2026-02-03 and shifts TTM EPS.
        expect(await grahamOn("2026-02-02")).toMatchObject({
          valuePerShare: expect.closeTo(148, 6),
          sourceDataAsOf: "2025-11-01T00:00:00.000Z",
        });
        expect(await grahamOn("2026-02-03")).toMatchObject({
          valuePerShare: expect.closeTo(155.4, 6),
          sourceDataAsOf: "2026-02-03T00:00:00.000Z",
        });

        // The Q4-2025 balance sheet becomes available on Saturday 2026-02-07: invisible on
        // Friday, effective on the next supplied trading day, Monday 2026-02-09.
        const rows = await readDbDerivedRows(securityId, {
          from: "2026-02-06",
          to: "2026-02-09",
        });
        const friday = rows.find((row) => row.date === "2026-02-06");
        const monday = rows.find((row) => row.date === "2026-02-09");
        expect(rows.map((row) => row.date)).toEqual(["2026-02-06", "2026-02-09"]);
        expect(friday?.residualIncomeSourceAsOf).toBe("2026-02-03T00:00:00.000Z");
        expect(monday?.residualIncomeSourceAsOf).toBe("2026-02-07T00:00:00.000Z");
        expect(monday?.residualIncome).not.toBe(friday?.residualIncome);
        // DCF consumed the same balance sheet: provenance advances even though the
        // cash/debt inputs kept its value identical.
        expect(friday?.dcfFcff).toBe(monday?.dcfFcff);
        expect(friday?.dcfFcffSourceAsOf).toBe("2026-02-03T00:00:00.000Z");
        expect(monday?.dcfFcffSourceAsOf).toBe("2026-02-07T00:00:00.000Z");
        // GRAHAM does not use the balance sheet: per-model provenance stays put.
        expect(monday?.grahamSourceAsOf).toBe("2026-02-03T00:00:00.000Z");

        // Blend provenance is the max of its required components' provenance.
        const balanced = await http()
          .get(
            `/stocks/${symbol}/intrinsic-value-blends?blendIds=BALANCED&from=2026-02-09&to=2026-02-09`,
          )
          .expect(200);
        expect(balanced.body[0].sourceDataAsOf).toBe("2026-02-07T00:00:00.000Z");
        expect(balanced.body[0].valuePerShare).toBeCloseTo(
          expectedBlendValue("BALANCED", {
            DCF_FCFF: monday?.dcfFcff,
            RESIDUAL_INCOME: monday?.residualIncome,
            GRAHAM: monday?.graham,
          }),
          6,
        );

        // Carry-forward between events, and no future revision leaks into history:
        // the 2026-04-09 restatement exists in PostgreSQL but March valuations keep
        // the previous revision's values even when queried today.
        expect((await grahamOn("2026-03-16"))?.valuePerShare).toBeCloseTo(155.4, 6);
        expect((await grahamOn("2026-04-09"))?.valuePerShare).toBeCloseTo(155.4, 6);
        expect(await grahamOn("2026-04-10")).toMatchObject({
          valuePerShare: expect.closeTo(144.3, 6),
          sourceDataAsOf: "2026-04-10T00:00:00.000Z",
        });

        // Invalidating revision: GRAHAM drops from 2026-06-02, blends that require it
        // disappear, blends that do not require it survive.
        expect((await grahamOn("2026-06-01"))?.valuePerShare).toBeCloseTo(144.3, 6);
        expect(await grahamSeries("from=2026-06-02&to=2026-07-01")).toEqual([]);
        const midOutage = await http()
          .get(
            `/stocks/${symbol}/intrinsic-value-blends?from=2026-06-15&to=2026-06-15`,
          )
          .expect(200);
        expect(
          midOutage.body.map((point: { blendId: string }) => point.blendId),
        ).toEqual(["DIVIDEND"]);
        const outageRow = (
          await readDbDerivedRows(securityId, { from: "2026-06-02", to: "2026-06-02" })
        )[0];
        expect(outageRow?.graham).toBeUndefined();
        expect(outageRow?.grahamSourceAsOf).toBeUndefined();
        expect(outageRow?.blendBalanced).toBeUndefined();
        expect(outageRow?.blendConservative).toBeUndefined();
        expect(outageRow?.blendDividend).toBeGreaterThan(0);

        // A later valid revision restores the model and the dependent blends.
        expect(await grahamOn("2026-07-02")).toMatchObject({
          valuePerShare: expect.closeTo(146.15, 6),
          sourceDataAsOf: "2026-07-02T00:00:00.000Z",
        });
        const restored = await http()
          .get(
            `/stocks/${symbol}/intrinsic-value-blends?blendIds=BALANCED&from=2026-07-02&to=2026-07-02`,
          )
          .expect(200);
        expect(restored.body).toHaveLength(1);

        // Redis daily-state chunks carry the same transitions as PostgreSQL.
        const chunk = (await readRedisDailyStateYear(securityId, 2026)) as Array<{
          date: string;
          intrinsicValues?: Record<string, number>;
          residualIncomeSourceAsOf?: string;
          grahamSourceAsOf?: string;
        }>;
        const cachedFriday = chunk.find((row) => row.date === "2026-02-06");
        const cachedMonday = chunk.find((row) => row.date === "2026-02-09");
        const cachedOutage = chunk.find((row) => row.date === "2026-06-02");
        expect(cachedFriday?.intrinsicValues?.GRAHAM).toBeCloseTo(155.4, 6);
        expect(cachedMonday?.residualIncomeSourceAsOf).toBe("2026-02-07T00:00:00.000Z");
        expect(cachedMonday?.grahamSourceAsOf).toBe("2026-02-03T00:00:00.000Z");
        expect(cachedOutage?.intrinsicValues?.GRAHAM).toBeUndefined();

        // Weekend dates are never invented as valuation rows.
        const weekend = await grahamSeries("from=2026-02-07&to=2026-02-08");
        expect(weekend).toEqual([]);
      },
      SLOW,
    );

    it("applies asOf cutoffs without leaking later-sourced state", async () => {
      const early = await grahamSeries(`from=2026-01-02&to=${TODAY}&asOf=2026-02-06`);
      expect(early.at(-1)).toMatchObject({
        valuationDate: "2026-02-06",
        valuePerShare: expect.closeTo(155.4, 6),
      });
      expect(early.some((point) => point.valuationDate > "2026-02-06")).toBe(false);

      const beforeQ4 = await grahamSeries(`from=2026-01-02&to=${TODAY}&asOf=2026-01-15`);
      expect(beforeQ4.at(-1)).toMatchObject({
        valuationDate: "2026-01-15",
        valuePerShare: expect.closeTo(148, 6),
      });
      for (const point of beforeQ4) {
        expect(point.sourceDataAsOf <= "2026-01-15T23:59:59.999Z").toBe(true);
      }
    });
  });

  describe("warm-up fundamentals retention", () => {
    it(
      "values the first visible trading day from retained pre-range statements",
      async () => {
        const symbol = symbols.warmup;
        const response = await http()
          .get(`/stocks/${symbol}?from=${CANONICAL_START}&to=${TODAY}`)
          .expect(200);
        const securityId = await securityIdOf(symbol);

        // Visible price/derived history starts exactly at the canonical horizon.
        expect(response.body.prices[0].date).toBe(CANONICAL_START);
        expect(
          await prisma.dailyPrice.count({
            where: { securityId, date: { lt: new Date(`${CANONICAL_START}T00:00:00.000Z`) } },
          }),
        ).toBe(0);
        expect(
          await prisma.dailyDerivedState.count({
            where: { securityId, date: { lt: new Date(`${CANONICAL_START}T00:00:00.000Z`) } },
          }),
        ).toBe(0);

        // Pre-range quarterly fundamentals support a TTM on the very first visible day,
        // and the exact FY2021/FY2016 annual endpoints give a 10% CAGR: Graham is
        // 8 * (8.5 + 2 * 10) = 228 instead of the default-growth 148.
        const firstDay = response.body.intrinsicValues.filter(
          (point: { valuationDate: string }) => point.valuationDate === CANONICAL_START,
        );
        const models = new Map<string, number>(
          firstDay.map((point: { model: string; valuePerShare: number }) => [
            point.model,
            point.valuePerShare,
          ]),
        );
        expect([...models.keys()].sort()).toEqual([
          "DCF_FCFF",
          "DDM",
          "GRAHAM",
          "RESIDUAL_INCOME",
        ]);
        expect(models.get("GRAHAM")).toBeCloseTo(228, 6);
        for (const point of firstDay) {
          expect(point.sourceDataAsOf <= `${CANONICAL_START}T23:59:59.999Z`).toBe(true);
        }

        // PostgreSQL retains warm-up statements, bounded by historyYears + 7.
        const fiscalDates = (
          await prisma.financialStatement.findMany({
            where: { securityId },
            select: { fiscalDate: true, period: true },
          })
        ).map((row) => `${row.fiscalDate.toISOString().slice(0, 10)}:${row.period}`);
        expect(fiscalDates).toContain("2016-12-31:FY");
        expect(fiscalDates).toContain("2021-09-30:Q3");
        expect(fiscalDates).not.toContain("2014-12-31:FY");

        // Redis retains the warm-up years under the existing yearly key family.
        const annual2016 = await redis.get(
          chunkKey(securityId, "financials:income:annual:v1", 2016),
        );
        expect(annual2016).not.toBeNull();
        expect(JSON.parse(annual2016 as string)).toHaveLength(1);
        expect(
          await redis.get(chunkKey(securityId, "financials:income:annual:v1", 2014)),
        ).toBeNull();

        // Public financial-statement reads stay bounded to the visible product history.
        const service = app.get<LoggedStockDataService>(STOCK_DATA_SERVICE);
        const publicStatements = await service.getFinancialStatements(symbol, {});
        expect(
          publicStatements.filter((row) => row.fiscalDate < CANONICAL_START),
        ).toEqual([]);
      },
      SLOW,
    );
  });

  describe("multi-symbol isolation", () => {
    it(
      "keeps two hydrated stocks fully isolated in PostgreSQL and Redis",
      async () => {
        await http().get(`/stocks/${symbols.isolationX}?from=2026-06-01&to=${TODAY}`).expect(200);
        await http().get(`/stocks/${symbols.isolationY}?from=2026-06-01&to=${TODAY}`).expect(200);
        const idX = await securityIdOf(symbols.isolationX);
        const idY = await securityIdOf(symbols.isolationY);
        expect(idX).not.toBe(idY);

        const tradingDays = businessDays("2026-06-01", TODAY).length;
        expect(await prisma.dailyPrice.count({ where: { securityId: idX } })).toBe(tradingDays);
        expect(await prisma.dailyPrice.count({ where: { securityId: idY } })).toBe(tradingDays);
        const keysX = await readRedisStockKeys(idX);
        const keysY = await readRedisStockKeys(idY);
        expect(keysX).toContain(`${namespace}:security:${idX}:manifest`);
        expect(keysY).toContain(`${namespace}:security:${idY}:manifest`);
        expect(keysX.some((key) => key.includes(idY))).toBe(false);
        expect(keysX.filter((key) => keysY.includes(key))).toEqual([]);

        // Querying one stock never alters the other stock's durable data or cache.
        const snapshotY = await readDbStockSnapshot(idY);
        const chunkY = JSON.stringify(await readRedisDailyStateYear(idY, 2026));
        await http()
          .get(`/stocks/${symbols.isolationX}/prices?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        await http()
          .get(`/stocks/${symbols.isolationX}/intrinsic-values?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        expect(await readDbStockSnapshot(idY)).toEqual(snapshotY);
        expect(JSON.stringify(await readRedisDailyStateYear(idY, 2026))).toBe(chunkY);
      },
      SLOW,
    );

    it(
      "recovers an LRU-evicted stock from durable PostgreSQL without provider calls",
      async () => {
        const lruProvider = new DeterministicFmpProvider();
        lruProvider.fixtures.set(symbols.lruOne, provider.fixtures.get(symbols.lruOne)!);
        lruProvider.fixtures.set(symbols.lruTwo, provider.fixtures.get(symbols.lruTwo)!);
        const lruApp = await createStockApp({
          provider: lruProvider,
          namespace: lruNamespace,
          maxResidentStocks: 1,
        });
        closers.push(async () => lruApp.close());

        await request(lruApp.getHttpServer())
          .get(`/stocks/${symbols.lruOne}?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        await request(lruApp.getHttpServer())
          .get(`/stocks/${symbols.lruTwo}?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        const idOne = await securityIdOf(symbols.lruOne);
        const idTwo = await securityIdOf(symbols.lruTwo);

        // Capacity 1: hydrating the second stock evicts the first from Redis only.
        expect(await redis.smembers(`${lruNamespace}:security:${idOne}:keys`)).toEqual([]);
        expect(await redis.zscore(`${lruNamespace}:resident-stocks`, idOne)).toBeNull();
        expect(await redis.zscore(`${lruNamespace}:resident-stocks`, idTwo)).not.toBeNull();
        const durable = await readDbStockSnapshot(idOne);
        expect(durable.prices).toBeGreaterThan(0);
        expect(durable.derived).toBeGreaterThan(0);

        // The evicted stock recovers entirely from PostgreSQL.
        const before = lruProvider.callCounts();
        const recovered = await request(lruApp.getHttpServer())
          .get(`/stocks/${symbols.lruOne}/prices?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        expect(recovered.body).toHaveLength(durable.prices);
        expect(lruProvider.callCounts()).toEqual(before);
        expect(await readDbStockSnapshot(idOne)).toEqual(durable);
      },
      SLOW,
    );
  });

  describe("process restart durability", () => {
    it(
      "answers identically from a fresh process without refetching history",
      async () => {
        const symbol = symbols.restart;
        const firstApp = await createStockApp({ provider, namespace });
        const original = await request(firstApp.getHttpServer())
          .get(`/stocks/${symbol}?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        await firstApp.close();

        const securityId = await securityIdOf(symbol);
        const dbBefore = await readDbStockSnapshot(securityId);
        const freshProvider = new DeterministicFmpProvider();
        freshProvider.fixtures.set(symbol, provider.fixtures.get(symbol)!);
        const restartedApp = await createStockApp({
          provider: freshProvider,
          namespace,
        });
        closers.push(async () => restartedApp.close());

        const replayed = await request(restartedApp.getHttpServer())
          .get(`/stocks/${symbol}?from=2026-06-01&to=${TODAY}`)
          .expect(200);
        expect(replayed.body).toEqual(original.body);
        // Nothing depended on process memory: no profile, price, or statement refetch.
        expect(freshProvider.callCounts()).toEqual({
          profiles: 0,
          prices: 0,
          statements: 0,
        });
        expect(await readDbStockSnapshot(securityId)).toEqual(dbBefore);
        expect((await readRedisManifest(securityId))?.status).toBe("READY");
      },
      SLOW,
    );
  });

  describe("Redis is disposable", () => {
    it(
      "recovers a fully evicted stock from PostgreSQL without provider traffic",
      async () => {
        const symbol = symbols.redisLoss;
        await http().get(`/stocks/${symbol}?from=2025-01-01&to=${TODAY}`).expect(200);
        const securityId = await securityIdOf(symbol);
        const dbBefore = await readDbStockSnapshot(securityId);
        const derivedBefore = await readDbDerivedRows(securityId, {
          from: "2026-08-01",
          to: TODAY,
        });

        // Lose only this stock's Redis state; PostgreSQL is untouched.
        const registered = await readRedisStockKeys(securityId);
        expect(registered.length).toBeGreaterThan(0);
        await redis.del(...registered, `${namespace}:security:${securityId}:keys`);
        await redis.zrem(`${namespace}:resident-stocks`, securityId);

        const before = provider.callCounts();
        const response = await http()
          .get(`/stocks/${symbol}?from=2025-01-01&to=${TODAY}`)
          .expect(200);
        expect(response.body.prices).toHaveLength(dbBefore.prices);

        // Covered history and retained fundamentals were not refetched.
        expect(provider.callCounts()).toEqual(before);
        expect(await readDbStockSnapshot(securityId)).toEqual(dbBefore);
        // The cache was rebuilt from the durable store, intrinsic state included.
        expect((await readRedisManifest(securityId))?.status).toBe("READY");
        const restoredChunk = (await readRedisDailyStateYear(securityId, 2026)) as Array<{
          date: string;
          intrinsicValues?: Record<string, number>;
        }>;
        const restoredLast = restoredChunk.at(-1);
        expect(restoredLast?.date).toBe(TODAY);
        expect(restoredLast?.intrinsicValues?.GRAHAM).toBe(
          derivedBefore.at(-1)?.graham,
        );
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2026-08-01",
          to: TODAY,
        });
      },
      SLOW,
    );

    it(
      "self-heals a missing yearly daily-state chunk without touching durable state",
      async () => {
        const symbol = symbols.redisLoss;
        const securityId = await securityIdOf(symbol);
        const reference = await http()
          .get(`/stocks/${symbol}/technicals/daily?from=2025-06-01&to=2025-06-30`)
          .expect(200);
        const dbBefore = await readDbStockSnapshot(securityId);

        await redis.del(chunkKey(securityId, "daily-state", 2025));
        const before = provider.callCounts();
        const healed = await http()
          .get(`/stocks/${symbol}/technicals/daily?from=2025-06-01&to=2025-06-30`)
          .expect(200);

        // Coherent response, durable state unchanged, cache restored, no provider calls.
        expect(healed.body).toEqual(reference.body);
        expect(provider.callCounts()).toEqual(before);
        expect(await readDbStockSnapshot(securityId)).toEqual(dbBefore);
        expect(await readRedisDailyStateYear(securityId, 2025)).not.toBeNull();
        expect((await readRedisManifest(securityId))?.status).toBe("READY");
        // No partial or mislabelled intrinsic state: the restored chunk matches PostgreSQL.
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2025-06-01",
          to: "2025-06-30",
        });
      },
      SLOW,
    );
  });

  describe("PostgreSQL authority over a stale cached security identity", () => {
    it(
      "recovers when Redis still maps the symbol to a security PostgreSQL no longer has",
      async () => {
        const symbol = symbols.authority;
        await http().get(`/stocks/${symbol}?from=2026-06-01&to=${TODAY}`).expect(200);
        const staleId = await securityIdOf(symbol);

        // Reproduce the manual failure: the durable row is gone (cascade removes all
        // stock data), while Redis keeps the symbol -> security identity mapping but no
        // longer has a usable manifest.
        await prisma.security.delete({ where: { id: staleId } });
        await redis.del(`${namespace}:security:${staleId}:manifest`);
        const cachedIdentity = await redis.get(`${namespace}:symbol:${symbol}:security`);
        expect(cachedIdentity).not.toBeNull();
        expect((JSON.parse(cachedIdentity as string) as { id: string }).id).toBe(staleId);

        // Architecture-consistent behavior: PostgreSQL is the source of truth and Redis is
        // disposable, so the stale identity is never served. It is also never re-created: a
        // security absent from the catalog is an unsupported stock, and only an explicit catalog
        // synchronization may admit one. The request fails cleanly instead of inserting against
        // the deleted identity's foreign key.
        const profileCallsBefore = provider.profileCalls.length;
        await http()
          .get(`/stocks/${symbol}?from=2026-06-01&to=${TODAY}`)
          .expect(404);

        expect(provider.profileCalls.length).toBe(profileCallsBefore);
        expect(await prisma.security.count({ where: { providerSymbol: symbol } })).toBe(0);
      },
      SLOW,
    );
  });

  describe("refresh lifecycle against real infrastructure", () => {
    // These tests advance the deterministic clock, so they run last: every earlier
    // scenario depends on hydration staying fresh at T0.
    it(
      "price-only refresh updates prices and technicals but rematerializes intrinsic state coherently",
      async () => {
        const symbol = symbols.lifecycle;
        const securityId = await securityIdOf(symbol);
        const fixture = provider.fixtures.get(symbol)!;
        const chunk2025Before = await redis.get(chunkKey(securityId, "daily-state", 2025));
        const statementsBefore = await prisma.financialStatement.count({
          where: { securityId },
        });
        const intrinsicBefore = (
          await readDbDerivedRows(securityId, { from: TODAY, to: TODAY })
        )[0];

        // A refined EOD close arrives for the latest trading day; fundamentals unchanged.
        const lastRow = fixture.prices.at(-1)!;
        lastRow.close += 5;
        lastRow.high += 5;
        const priceCallsBefore = provider.dailyPriceCalls.length;
        const statementCallsBefore = provider.statementCalls.length;
        advanceClockMinutes(90); // price freshness (60m) exceeded, fundamentals (120m) not
        const response = await http()
          .get(`/stocks/${symbol}/prices?from=2026-08-01&to=${TODAY}`)
          .expect(200);

        expect(provider.dailyPriceCalls.length).toBe(priceCallsBefore + 1);
        expect(provider.dailyPriceCalls.at(-1)).toEqual({
          symbol,
          from: addDays(TODAY, -10),
          to: TODAY,
        });
        expect(provider.statementCalls.length).toBe(statementCallsBefore);
        expect(
          await prisma.financialStatement.count({ where: { securityId } }),
        ).toBe(statementsBefore);

        // HTTP, PostgreSQL, and Redis all see the refined close.
        expect(response.body.at(-1).close).toBe(lastRow.close);
        const dbLastPrice = await prisma.dailyPrice.findFirst({
          where: { securityId, date: new Date(`${TODAY}T00:00:00.000Z`) },
        });
        expect(Number(dbLastPrice?.close)).toBe(lastRow.close);
        const intrinsicAfter = (
          await readDbDerivedRows(securityId, { from: TODAY, to: TODAY })
        )[0];
        expect(intrinsicAfter?.sma20d).not.toBe(intrinsicBefore?.sma20d);
        // Intrinsic values do not depend on prices; the rebuild must rematerialize them
        // identically rather than dropping or corrupting them.
        expect(intrinsicAfter?.graham).toBe(intrinsicBefore?.graham);
        expect(intrinsicAfter?.dcfFcff).toBe(intrinsicBefore?.dcfFcff);
        expect(intrinsicAfter?.blendBalanced).toBe(intrinsicBefore?.blendBalanced);
        // Unrelated historical years remain byte-identical in Redis.
        expect(await redis.get(chunkKey(securityId, "daily-state", 2025))).toBe(
          chunk2025Before,
        );
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2026-08-01",
          to: TODAY,
        });
      },
      SLOW,
    );

    it(
      "fundamentals-only refresh persists a new revision and rebuilds from its PIT day",
      async () => {
        const symbol = symbols.lifecycle;
        const securityId = await securityIdOf(symbol);
        const fixture = provider.fixtures.get(symbol)!;
        const allDerivedBefore = await readDbDerivedRows(securityId);
        const pricesBefore = await prisma.dailyPrice.findMany({
          where: { securityId },
          orderBy: { date: "asc" },
        });
        const statementsBefore = await prisma.financialStatement.count({
          where: { securityId },
        });
        const chunk2025Before = await redis.get(chunkKey(securityId, "daily-state", 2025));

        // A restated Q2-2026 income statement is filed Friday 2026-08-21, becomes
        // available Saturday 2026-08-22, and is PIT-effective Monday 2026-08-24.
        fixture.statements
          .get("INCOME:QUARTERLY")!
          .push(
            quarterDraft(
              "INCOME",
              2026,
              "Q2",
              { netIncome: 25, interestExpense: 2.5, epsDiluted: 2.5, weightedAverageShsOutDil: 10 },
              "2026-08-21",
            ),
          );
        const priceCallsBefore = provider.dailyPriceCalls.length;
        advanceClockMinutes(40); // fundamentals stale (130m), prices fresh again (40m)
        await http().get(`/stocks/${symbol}?from=2026-08-01&to=${TODAY}`).expect(200);

        // Strictly fundamentals-only: no price provider call, price data unchanged.
        expect(provider.dailyPriceCalls.length).toBe(priceCallsBefore);
        const refreshCalls = provider.statementCalls.filter(
          (call) => call.symbol === symbol,
        ).slice(-6);
        expect(refreshCalls).toHaveLength(6);
        for (const call of refreshCalls) {
          expect(call.limit).toBe(call.cadence === "QUARTERLY" ? 12 : 3);
        }
        const pricesAfter = await prisma.dailyPrice.findMany({
          where: { securityId },
          orderBy: { date: "asc" },
        });
        expect(pricesAfter).toEqual(pricesBefore);

        // Exactly one new immutable revision; the originals are untouched.
        expect(
          await prisma.financialStatement.count({ where: { securityId } }),
        ).toBe(statementsBefore + 1);
        const revisions = await prisma.financialStatement.findMany({
          where: {
            securityId,
            statementType: "INCOME",
            fiscalDate: new Date("2026-06-30T00:00:00.000Z"),
          },
          orderBy: { availableFromDate: "asc" },
        });
        expect(revisions).toHaveLength(2);
        expect(revisions[1]?.availableFromDate.toISOString().slice(0, 10)).toBe(
          "2026-08-22",
        );

        // Derived state changes only from the PIT-effective trading day onward.
        const allDerivedAfter = await readDbDerivedRows(securityId);
        expect(allDerivedAfter.length).toBe(allDerivedBefore.length);
        expect(allDerivedAfter.filter((row) => row.date < TODAY)).toEqual(
          allDerivedBefore.filter((row) => row.date < TODAY),
        );
        const changed = allDerivedAfter.at(-1);
        expect(changed?.date).toBe(TODAY);
        // TTM EPS becomes 2 + 2 + 2 + 2.5 = 8.5 -> Graham 8.5 * 18.5.
        expect(changed?.graham).toBeCloseTo(157.25, 6);
        expect(changed?.grahamSourceAsOf).toBe("2026-08-22T00:00:00.000Z");
        expect(changed?.blendBalanced).toBeCloseTo(
          expectedBlendValue("BALANCED", {
            DCF_FCFF: changed?.dcfFcff,
            RESIDUAL_INCOME: changed?.residualIncome,
            GRAHAM: changed?.graham,
          }),
          6,
        );

        // Only the affected Redis year was republished from PostgreSQL.
        expect(await redis.get(chunkKey(securityId, "daily-state", 2025))).toBe(
          chunk2025Before,
        );
        const chunk2026 = (await readRedisDailyStateYear(securityId, 2026)) as Array<{
          date: string;
          intrinsicValues?: Record<string, number>;
        }>;
        expect(chunk2026.at(-1)?.intrinsicValues?.GRAHAM).toBeCloseTo(157.25, 6);
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2026-08-01",
          to: TODAY,
        });
      },
      SLOW,
    );

    it(
      "combined price and fundamentals refresh converges to one coherent row per trading day",
      async () => {
        const symbol = symbols.lifecycle;
        const securityId = await securityIdOf(symbol);
        const fixture = provider.fixtures.get(symbol)!;
        const tradingDays = businessDays("2025-01-02", TODAY).length;
        const rowBefore = (
          await readDbDerivedRows(securityId, { from: TODAY, to: TODAY })
        )[0];

        const lastRow = fixture.prices.at(-1)!;
        lastRow.close += 3;
        fixture.statements
          .get("BALANCE_SHEET:QUARTERLY")!
          .push(
            quarterDraft(
              "BALANCE_SHEET",
              2026,
              "Q2",
              { cashAndShortTermInvestments: 50, totalDebt: 30, totalStockholdersEquity: 520 },
              "2026-08-21",
            ),
          );
        advanceClockMinutes(130); // both price (170m) and fundamentals (130m) stale
        await http().get(`/stocks/${symbol}?from=2026-08-01&to=${TODAY}`).expect(200);

        // Exactly one unified row per trading day; no parallel or stale methodology rows.
        expect(
          await prisma.dailyDerivedState.count({ where: { securityId } }),
        ).toBe(tradingDays);
        const rowAfter = (
          await readDbDerivedRows(securityId, { from: TODAY, to: TODAY })
        )[0];
        // Technical and intrinsic fields coexist and both causes landed.
        expect(rowAfter?.sma20d).not.toBe(rowBefore?.sma20d);
        expect(rowAfter?.residualIncome).not.toBe(rowBefore?.residualIncome);
        expect(rowAfter?.graham).toBeCloseTo(157.25, 6);
        expect(rowAfter?.residualIncomeSourceAsOf).toBe("2026-08-22T00:00:00.000Z");
        expect(rowAfter?.intrinsicCurrency).toBe("USD");
        const dbLastPrice = await prisma.dailyPrice.findFirst({
          where: { securityId, date: new Date(`${TODAY}T00:00:00.000Z`) },
        });
        expect(Number(dbLastPrice?.close)).toBe(lastRow.close);
        await expectApiDbRedisConsistent(symbol, securityId, {
          from: "2026-08-01",
          to: TODAY,
        });
      },
      SLOW,
    );
  });
});
