import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  FUNDAMENTAL_METRIC_IDS,
  FUNDAMENTAL_METRICS,
  type DailyFundamentalMetricPoint,
  type DailyPrice,
  type DateRange,
  type FinancialPeriod,
  type FinancialStatementCadence,
  type FinancialStatementDraft,
  type FinancialStatementType,
  type FundamentalMetricId,
  type Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisStockDataCache } from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import { subtractYears } from "./dates.js";
import {
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import {
  CanonicalStockDataService,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  type ProviderRequestEvent,
} from "./service.js";

loadRootEnv();
// PostgreSQL writes go to the dedicated test database; Redis is isolated by a random namespace.
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The Stock Details fundamental history suite requires TEST_REDIS_URL or REDIS_URL: it is the " +
      "proof that the chart reads the persisted derived state through Redis and PostgreSQL alike.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * Stock Details' Fundamental Metric history, end to end on the production read path.
 *
 * `FinancialStatement` revisions in PostgreSQL -> the canonical derived rebuild -> `DailyDerivedState`
 * in PostgreSQL and Redis -> `getDailyFundamentalMetric`, which is all the HTTP endpoint calls. The
 * provider is a counter that must never be asked anything, so everything the chart shows comes from
 * durable state.
 *
 * The statements are designed so every expected reading is a hand-computed literal — none of them
 * is derived from the formulas or the registry under test. Invested capital is 790 on every balance
 * sheet (debt + equity - cash), so ROIC TTM is operating income TTM x 0.79 / 790 x 100. Filings
 * become public the day after they are filed.
 *
 * - Thursday 2024-02-15 (filed 02-14), a trading day: FY2023 Q1-Q4 income (revenue 300, gross
 *   profit 120, operating income 30, EBITDA 45 each) and the 2022 Q4, 2023 Q1 and 2023 Q4 balance
 *   sheets (debt 720, equity 600, cash 530, current assets 900, current liabilities 600, net debt
 *   90). ROIC 12, Debt / Equity 1.2, Current Ratio 1.5, Net Debt / EBITDA 90/180 = 0.5, Gross
 *   Margin 40.
 * - Saturday 2024-05-04 (filed Friday 05-03): FY2024 Q1 income, operating income 90, EBITDA 105.
 *   ROIC's window now ends at 2024 Q1, whose balance sheet is not public yet: **unavailable**,
 *   never the older 12. Net Debt / EBITDA 90/240 = 0.375. Effective Monday 05-06.
 * - Sunday 2024-05-12 (filed Saturday 05-11): the 2024 Q1 balance sheet (debt 480, cash 290,
 *   current assets 1,200, net debt -60). ROIC 18, Debt / Equity 0.8, Current Ratio 2, Net Debt /
 *   EBITDA -0.25 — net cash. Effective Monday 05-13.
 * - Wednesday 2024-06-19, Juneteenth, a market holiday (filed 06-18): a restated 2024 Q1 balance
 *   sheet, levered again. Debt / Equity 1.2, Current Ratio 1.5, Net Debt / EBITDA 0.375, ROIC
 *   still 18. Effective Thursday 06-20.
 * - Thursday 2024-08-08 (filed 08-07): the 2024 Q1 income restated in EUR. Every metric whose window
 *   reads it — ROIC, Gross Margin, Net Debt / EBITDA — is **unavailable**: the statements no longer
 *   share one currency. Debt / Equity and Current Ratio read balance sheets alone and carry on.
 * - Wednesday 2024-10-02 (filed 10-01): the 2024 Q1 income restated in USD again, operating income
 *   70. ROIC 16 — restored at a new value, not at the 18 before the gap — Gross Margin 40, Net Debt
 *   / EBITDA 0.375.
 * - Monday 2024-11-11: a later sync reports the 2024 Q1 balance sheet with its period end moved to
 *   2024-03-30 and no newer filing, so it is dated from that observation, never from the original
 *   filing (debt 360, cash 170, current liabilities 400, net debt 0). Debt / Equity 0.6, Current
 *   Ratio 3, Net Debt / EBITDA exactly 0, ROIC still 16. Nothing before 11-11 moves.
 * - Tuesday 2024-12-03 (filed 12-02): the 2024 Q2 balance sheet, whose Current Ratio,
 *   3,000,000,000,000 / 2, cannot be stored in `DECIMAL(20,8)`: **unavailable** from then on,
 *   while Debt / Equity 0.6, Net Debt / EBITDA -24/240 = -0.1 and ROIC 16 carry on.
 *
 * Revenue Growth TTM YoY needs eight consecutive quarters and there are five: it is unavailable on
 * every session, a whole history with nothing to draw.
 */
describeInfrastructure(
  "Stock Details fundamental history over the canonical derived state",
  () => {
    const NOW = new Date("2024-12-31T21:00:00.000Z");
    const TODAY = "2024-12-31";
    const PRODUCT_YEARS = 30;
    const FIRST_SESSION = "2023-10-02";
    const HOLIDAYS = [
      "2023-11-23",
      "2023-12-25",
      "2024-01-01",
      "2024-01-15",
      "2024-02-19",
      "2024-03-29",
      "2024-05-27",
      "2024-06-19",
      "2024-07-04",
      "2024-09-02",
      "2024-11-28",
      "2024-12-25",
    ];
    const PERIOD = { from: FIRST_SESSION, to: TODAY };

    /** Records every provider call. None may ever happen here. */
    class CountingProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];

      async getProfile(symbol: string) {
        this.calls.push(`profile:${symbol}`);
        return null;
      }

      async getDailyPrices(
        _symbol: string,
        _securityId: string,
        range: DateRange,
      ) {
        this.calls.push(`prices:${range.from}:${range.to}`);
        return [];
      }

      async getFinancialStatements(
        _symbol: string,
        _securityId: string,
        statementType: FinancialStatementType,
        cadence: FinancialStatementCadence,
      ) {
        this.calls.push(`statements:${statementType}:${cadence}`);
        return [];
      }
    }

    function weekdays(from: string, to: string): string[] {
      const dates: string[] = [];
      const cursor = new Date(`${from}T00:00:00.000Z`);
      const end = new Date(`${to}T00:00:00.000Z`);
      while (cursor <= end) {
        const day = cursor.getUTCDay();
        const date = cursor.toISOString().slice(0, 10);
        if (day !== 0 && day !== 6 && !HOLIDAYS.includes(date)) {
          dates.push(date);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return dates;
    }

    const PERIOD_END: Record<Exclude<FinancialPeriod, "FY">, string> = {
      Q1: "03-31",
      Q2: "06-30",
      Q3: "09-30",
      Q4: "12-31",
    };

    function draft(
      securityId: string,
      statementType: FinancialStatementType,
      fiscalYear: number,
      period: Exclude<FinancialPeriod, "FY">,
      values: Record<string, number>,
      filingDate: string,
      overrides: Partial<FinancialStatementDraft> = {},
    ): FinancialStatementDraft {
      return {
        securityId,
        statementType,
        fiscalDate: `${fiscalYear}-${PERIOD_END[period]}`,
        fiscalYear,
        period,
        reportedCurrency: "USD",
        filingDate,
        values,
        ...overrides,
      } as FinancialStatementDraft;
    }

    const INCOME_2023 = {
      revenue: 300,
      grossProfit: 120,
      operatingIncome: 30,
      netIncome: 20,
      epsDiluted: 0.5,
      ebitda: 45,
      ebit: 32,
      interestExpense: 4,
    };
    const INCOME_2024_Q1 = {
      ...INCOME_2023,
      operatingIncome: 90,
      netIncome: 60,
      epsDiluted: 1.5,
      ebitda: 105,
      ebit: 92,
    };
    const INCOME_2024_Q1_RESTATED = { ...INCOME_2024_Q1, operatingIncome: 70 };
    const LEVERED = {
      totalDebt: 720,
      totalStockholdersEquity: 600,
      totalEquity: 600,
      cashAndShortTermInvestments: 530,
      cashAndCashEquivalents: 530,
      totalAssets: 2_000,
      totalCurrentAssets: 900,
      totalCurrentLiabilities: 600,
      netDebt: 90,
    };
    const DELEVERED = {
      ...LEVERED,
      totalDebt: 480,
      cashAndShortTermInvestments: 290,
      cashAndCashEquivalents: 290,
      totalCurrentAssets: 1_200,
      netDebt: -60,
    };
    const MOVED_PERIOD_END = {
      ...LEVERED,
      totalDebt: 360,
      cashAndShortTermInvestments: 170,
      cashAndCashEquivalents: 170,
      totalCurrentAssets: 1_200,
      totalCurrentLiabilities: 400,
      netDebt: 0,
    };
    const UNSTORABLE_CURRENT_RATIO = {
      ...MOVED_PERIOD_END,
      totalCurrentAssets: 3_000_000_000_000,
      totalCurrentLiabilities: 2,
      netDebt: -24,
    };

    /** Everything public by 2024-10-02, delivered by one sync on 2024-10-05. */
    function firstSync(securityId: string): FinancialStatementDraft[] {
      return [
        ...(["Q1", "Q2", "Q3", "Q4"] as const).map((period) =>
          draft(securityId, "INCOME", 2023, period, INCOME_2023, "2024-02-14"),
        ),
        draft(securityId, "BALANCE_SHEET", 2022, "Q4", LEVERED, "2024-02-14"),
        draft(securityId, "BALANCE_SHEET", 2023, "Q1", LEVERED, "2024-02-14"),
        draft(securityId, "BALANCE_SHEET", 2023, "Q4", LEVERED, "2024-02-14"),
        draft(securityId, "INCOME", 2024, "Q1", INCOME_2024_Q1, "2024-05-03"),
        draft(securityId, "BALANCE_SHEET", 2024, "Q1", DELEVERED, "2024-05-11"),
        draft(securityId, "BALANCE_SHEET", 2024, "Q1", LEVERED, "2024-06-18"),
        draft(
          securityId,
          "INCOME",
          2024,
          "Q1",
          INCOME_2024_Q1_RESTATED,
          "2024-08-07",
          { reportedCurrency: "EUR" },
        ),
        draft(
          securityId,
          "INCOME",
          2024,
          "Q1",
          INCOME_2024_Q1_RESTATED,
          "2024-10-01",
        ),
      ];
    }

    type Reading = number | undefined;
    type Expected = {
      roic: Reading;
      debtToEquity: Reading;
      currentRatio: Reading;
      netDebtToEbitda: Reading;
      grossMargin: Reading;
    };

    /** The readings the design above implies, by hand. `undefined` is unavailable. */
    function expectedOn(date: string): Expected {
      if (date < "2024-02-15") {
        return {
          roic: undefined,
          debtToEquity: undefined,
          currentRatio: undefined,
          netDebtToEbitda: undefined,
          grossMargin: undefined,
        };
      }
      const roic =
        date < "2024-05-06"
          ? 12
          : date < "2024-05-13"
            ? undefined
            : date < "2024-08-08"
              ? 18
              : date < "2024-10-02"
                ? undefined
                : 16;
      const debtToEquity =
        date < "2024-05-13"
          ? 1.2
          : date < "2024-06-20"
            ? 0.8
            : date < "2024-11-11"
              ? 1.2
              : 0.6;
      const currentRatio =
        date < "2024-05-13"
          ? 1.5
          : date < "2024-06-20"
            ? 2
            : date < "2024-11-11"
              ? 1.5
              : date < "2024-12-03"
                ? 3
                : undefined;
      const netDebtToEbitda =
        date < "2024-05-06"
          ? 0.5
          : date < "2024-05-13"
            ? 0.375
            : date < "2024-06-20"
              ? -0.25
              : date < "2024-08-08"
                ? 0.375
                : date < "2024-10-02"
                  ? undefined
                  : date < "2024-11-11"
                    ? 0.375
                    : date < "2024-12-03"
                      ? 0
                      : -0.1;
      const grossMargin =
        date < "2024-08-08" ? 40 : date < "2024-10-02" ? undefined : 40;
      return { roic, debtToEquity, currentRatio, netDebtToEbitda, grossMargin };
    }

    /** Which hand-computed reading each designed metric must show. */
    const DESIGNED: ReadonlyArray<[FundamentalMetricId, keyof Expected]> = [
      ["ROIC_TTM", "roic"],
      ["DEBT_TO_EQUITY", "debtToEquity"],
      ["CURRENT_RATIO", "currentRatio"],
      ["NET_DEBT_TO_EBITDA_TTM", "netDebtToEbitda"],
      ["GROSS_MARGIN_TTM", "grossMargin"],
    ];

    let prisma: PrismaClient;
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let cache: RedisStockDataCache;
    let namespace: string;
    let symbol: string;
    let provider: CountingProvider;
    const requests: ProviderRequestEvent[] = [];
    let security: Security;
    let sessions: string[];
    let service: CanonicalStockDataService;
    /** Derived-state writes the first read made: the one canonical rebuild. */
    let hydrationDerivedWrites = 0;

    async function namespaceKeys(): Promise<string[]> {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(
          cursor,
          "MATCH",
          `${namespace}:*`,
          "COUNT",
          500,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      return keys;
    }

    function history(
      metricId: FundamentalMetricId,
      range: Required<DateRange> = PERIOD,
    ): Promise<DailyFundamentalMetricPoint[]> {
      return service.getDailyFundamentalMetric(symbol, metricId, range);
    }

    /** Every one of the fifteen histories, as the chart receives them. */
    async function everyHistory(): Promise<string> {
      const all: Record<string, DailyFundamentalMetricPoint[]> = {};
      for (const metricId of FUNDAMENTAL_METRIC_IDS) {
        all[metricId] = await history(metricId);
      }
      return JSON.stringify(all);
    }

    function valueOn(
      points: readonly DailyFundamentalMetricPoint[],
      date: string,
    ): number | undefined {
      const point = points.find((candidate) => candidate.date === date);
      if (!point) {
        throw new Error(`No session ${date} in the history`);
      }
      return point.value;
    }

    beforeAll(async () => {
      const suffix = randomUUID();
      namespace = `stock-data:v2:test:fundamental-history:${suffix}`;
      symbol = `H${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      prisma = new PrismaClient();
      redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
      store = new PrismaStockDataStore(prisma);
      cache = new RedisStockDataCache(
        new IoredisCacheClient(redis),
        10,
        namespace,
      );
      provider = new CountingProvider();
      const row = await prisma.security.create({
        data: {
          providerSymbol: symbol,
          symbol,
          name: "Fundamental History Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      sessions = weekdays(FIRST_SESSION, TODAY);
      const prices: DailyPrice[] = sessions.map((date, index) => ({
        securityId: row.id,
        date,
        open: 100 + index * 0.1,
        high: 100 + index * 0.1,
        low: 100 + index * 0.1,
        close: 100 + index * 0.1,
        volume: 1_000 + (index % 7) * 100,
      }));
      await store.saveDailyPriceSync({
        securityId: row.id,
        prices,
        successfulCoverage: [
          {
            from: subtractYears(TODAY, priceRetentionYears(PRODUCT_YEARS)),
            to: TODAY,
          },
        ],
        syncedAt: NOW.toISOString(),
        tailDate: TODAY,
        freshThrough: TODAY,
      });
      // Three syncs, oldest filing first inside each: the restatements are later filings of known
      // identities, the moved period end is first observed by the second sync, and the 2024 Q2
      // balance sheet by the third.
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: [...firstSync(row.id)].sort((left, right) =>
          left.filingDate.localeCompare(right.filingDate),
        ),
        syncedAt: "2024-10-05T12:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: [
          draft(
            row.id,
            "BALANCE_SHEET",
            2024,
            "Q1",
            MOVED_PERIOD_END,
            "2024-06-18",
            {
              fiscalDate: "2024-03-30",
            },
          ),
        ],
        syncedAt: "2024-11-11T09:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: [
          draft(
            row.id,
            "BALANCE_SHEET",
            2024,
            "Q2",
            UNSTORABLE_CURRENT_RATIO,
            "2024-12-02",
          ),
        ],
        syncedAt: "2024-12-03T12:00:00.000Z",
      });
      for (const operation of fundamentalsDatasetOperations(PRODUCT_YEARS)) {
        await store.upsertDatasetState({
          securityId: row.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt: NOW.toISOString(),
        });
      }
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt: NOW.toISOString(),
      });
      service = new CanonicalStockDataService(
        store,
        provider,
        cache,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        {
          productHistoryYears: PRODUCT_YEARS,
          now: () => NOW,
          onProviderRequest: (event) => requests.push(event),
        },
      );
      [security] = (await store.findSecuritiesByIds([row.id])) as [Security];

      // The first chart read of a stock whose sources are durable but whose derived state was
      // never built: the canonical rebuild runs once, from the stored statements, and no provider
      // is asked for anything.
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      await history("ROIC_TTM");
      hydrationDerivedWrites = derivedWrites.mock.calls.length;
      derivedWrites.mockRestore();
    }, 120_000);

    afterAll(async () => {
      if (cache && security) {
        await cache.evict(security.id);
      }
      if (redis) {
        const leftovers = await namespaceKeys();
        if (leftovers.length > 0) {
          await redis.del(...leftovers);
        }
      }
      if (prisma && security) {
        await prisma.security.deleteMany({ where: { id: security.id } });
      }
      redis?.disconnect();
      await prisma?.$disconnect();
    });

    it("dated the statements exactly as the design says, the moved period end from its observation", async () => {
      const revisions = await store.getFinancialStatementRevisions({
        securityId: security.id,
      });
      const q1Sheets = revisions
        .filter(
          (revision) =>
            revision.statementType === "BALANCE_SHEET" &&
            revision.fiscalYear === 2024 &&
            revision.period === "Q1",
        )
        .map((revision) => [revision.fiscalDate, revision.availableFromDate]);
      expect(q1Sheets).toEqual([
        // Never public since the original filing: first observed by the 2024-11-11 sync.
        ["2024-03-30", "2024-11-11"],
        ["2024-03-31", "2024-05-12"],
        ["2024-03-31", "2024-06-19"],
      ]);
      const q2Sheet = revisions.find(
        (revision) =>
          revision.statementType === "BALANCE_SHEET" &&
          revision.period === "Q2",
      );
      expect(q2Sheet?.availableFromDate).toBe("2024-12-03");
    });

    it("was built by one canonical rebuild, with no provider request at all", () => {
      expect(hydrationDerivedWrites).toBe(1);
      expect(provider.calls).toEqual([]);
      expect(requests).toEqual([]);
      expect(DERIVED_STATE_REVISION).toBe(7);
    });

    it("answers every trading session and no other day, for every metric", async () => {
      for (const metricId of FUNDAMENTAL_METRIC_IDS) {
        const points = await history(metricId);
        expect(
          points.map((point) => point.date),
          metricId,
        ).toEqual(sessions);
      }
      // No weekend and no holiday is invented, however a statement's availability fell.
      for (const day of [
        "2024-05-04",
        "2024-05-05",
        "2024-05-12",
        "2024-06-19",
      ]) {
        expect(sessions).not.toContain(day);
      }
    });

    it("shows each designed metric's hand-computed reading on every session", async () => {
      for (const [metricId, key] of DESIGNED) {
        const points = await history(metricId);
        for (const point of points) {
          const expected = expectedOn(point.date)[key];
          if (expected === undefined) {
            expect(point, `${point.date} ${metricId}`).toEqual({
              date: point.date,
            });
          } else {
            expect(point, `${point.date} ${metricId}`).toEqual({
              date: point.date,
              value: expected,
            });
          }
        }
      }
      // A metric no statement set can support is unavailable on every session — never zero.
      const growth = await history("REVENUE_GROWTH_TTM_YOY");
      expect(growth.every((point) => !("value" in point))).toBe(true);
    });

    it("places every transition on its canonical first session, and none earlier", async () => {
      const roic = await history("ROIC_TTM");
      const debtToEquity = await history("DEBT_TO_EQUITY");
      const currentRatio = await history("CURRENT_RATIO");
      const netDebt = await history("NET_DEBT_TO_EBITDA_TTM");
      const grossMargin = await history("GROSS_MARGIN_TTM");

      // Before the first statement is public: unavailable, then the Thursday it is.
      expect(valueOn(roic, "2024-02-14")).toBeUndefined();
      expect(valueOn(roic, "2024-02-15")).toBe(12);
      expect(valueOn(debtToEquity, "2024-02-14")).toBeUndefined();
      expect(valueOn(debtToEquity, "2024-02-15")).toBe(1.2);
      expect(valueOn(grossMargin, "2024-02-14")).toBeUndefined();
      expect(valueOn(grossMargin, "2024-02-15")).toBe(40);

      // Public on a Saturday: Friday still has the old state, Monday the new.
      expect(valueOn(roic, "2024-05-03")).toBe(12);
      expect(valueOn(roic, "2024-05-06")).toBeUndefined();
      expect(valueOn(netDebt, "2024-05-03")).toBe(0.5);
      expect(valueOn(netDebt, "2024-05-06")).toBe(0.375);

      // Public on a Sunday: the same, one week later.
      expect(valueOn(roic, "2024-05-10")).toBeUndefined();
      expect(valueOn(roic, "2024-05-13")).toBe(18);
      expect(valueOn(debtToEquity, "2024-05-10")).toBe(1.2);
      expect(valueOn(debtToEquity, "2024-05-13")).toBe(0.8);
      expect(valueOn(netDebt, "2024-05-13")).toBe(-0.25);

      // Public on a market holiday: the day before keeps the old state, the next session the new.
      expect(valueOn(debtToEquity, "2024-06-18")).toBe(0.8);
      expect(valueOn(debtToEquity, "2024-06-20")).toBe(1.2);
      expect(valueOn(currentRatio, "2024-06-18")).toBe(2);
      expect(valueOn(currentRatio, "2024-06-20")).toBe(1.5);

      // A later restatement changes a value only from its own session: the earlier ones keep
      // the state that was public then, even though the restatement is in PostgreSQL now.
      expect(valueOn(roic, "2024-06-18")).toBe(18);
      expect(valueOn(roic, "2024-06-20")).toBe(18);
    });

    it("breaks the line where a currency-changing revision makes a metric unavailable, and restores it after", async () => {
      const roic = await history("ROIC_TTM");
      const grossMargin = await history("GROSS_MARGIN_TTM");
      const netDebt = await history("NET_DEBT_TO_EBITDA_TTM");
      const debtToEquity = await history("DEBT_TO_EQUITY");
      const inside = sessions.filter(
        (date) => date >= "2024-08-08" && date < "2024-10-02",
      );
      expect(inside.length).toBeGreaterThan(30);

      expect(valueOn(roic, "2024-08-07")).toBe(18);
      expect(valueOn(grossMargin, "2024-08-07")).toBe(40);
      for (const date of inside) {
        // Unavailable, never the 18 of the day before carried through the interval.
        expect(valueOn(roic, date), date).toBeUndefined();
        expect(valueOn(grossMargin, date), date).toBeUndefined();
        expect(valueOn(netDebt, date), date).toBeUndefined();
        // A balance-sheet metric reads no income statement and is unaffected.
        expect(valueOn(debtToEquity, date), date).toBe(1.2);
      }
      // Restored at the restated value.
      expect(valueOn(roic, "2024-10-02")).toBe(16);
      expect(valueOn(grossMargin, "2024-10-02")).toBe(40);
      expect(valueOn(netDebt, "2024-10-02")).toBe(0.375);
    });

    it("never lets a moved period end change a session before it was observed", async () => {
      const debtToEquity = await history("DEBT_TO_EQUITY");
      const currentRatio = await history("CURRENT_RATIO");
      const netDebt = await history("NET_DEBT_TO_EBITDA_TTM");
      const roic = await history("ROIC_TTM");

      // Every session before the observation shows the state the original filings produced.
      for (const date of sessions.filter(
        (session) => session >= "2024-06-20" && session < "2024-11-11",
      )) {
        expect(valueOn(debtToEquity, date), date).toBe(1.2);
        expect(valueOn(currentRatio, date), date).toBe(1.5);
      }
      expect(valueOn(debtToEquity, "2024-11-08")).toBe(1.2);
      expect(valueOn(debtToEquity, "2024-11-11")).toBe(0.6);
      expect(valueOn(currentRatio, "2024-11-11")).toBe(3);
      // A real zero on the session it became true, drawn as zero and not as a gap.
      expect(valueOn(netDebt, "2024-11-08")).toBe(0.375);
      expect(valueOn(netDebt, "2024-11-11")).toBe(0);
      expect(valueOn(roic, "2024-11-11")).toBe(16);
    });

    it("shows a metric its column cannot store as absent while every other metric carries on", async () => {
      const currentRatio = await history("CURRENT_RATIO");
      const debtToEquity = await history("DEBT_TO_EQUITY");
      const netDebt = await history("NET_DEBT_TO_EBITDA_TTM");
      const roic = await history("ROIC_TTM");

      expect(valueOn(currentRatio, "2024-12-02")).toBe(3);
      for (const date of sessions.filter(
        (session) => session >= "2024-12-03",
      )) {
        // Absent: not clamped to the column's maximum, not zero, not the 3 before it.
        expect(valueOn(currentRatio, date), date).toBeUndefined();
        expect(valueOn(debtToEquity, date), date).toBe(0.6);
        expect(valueOn(netDebt, date), date).toBe(-0.1);
        expect(valueOn(roic, date), date).toBe(16);
      }
      const stored = await prisma.dailyDerivedState.findUnique({
        where: {
          securityId_date: {
            securityId: security.id,
            date: new Date("2024-12-03T00:00:00.000Z"),
          },
        },
      });
      expect(stored?.currentRatio).toBeNull();
      expect(Number(stored?.debtToEquity)).toBe(0.6);
    });

    it("is exactly what PostgreSQL holds, for every metric and every session", async () => {
      const rows = await prisma.dailyDerivedState.findMany({
        where: { securityId: security.id },
        orderBy: { date: "asc" },
      });
      expect(rows.map((row) => row.date.toISOString().slice(0, 10))).toEqual(
        sessions,
      );
      const counts = { positive: 0, zero: 0, negative: 0, unavailable: 0 };
      for (const metric of FUNDAMENTAL_METRICS) {
        const points = await history(metric.id);
        points.forEach((point, index) => {
          const column = rows[index]?.[metric.field];
          if (column === null || column === undefined) {
            expect(point, `${point.date} ${metric.id}`).toEqual({
              date: point.date,
            });
            counts.unavailable += 1;
            return;
          }
          // No tolerance: the chart reads the stored decimal, not a recalculation of it.
          expect(point, `${point.date} ${metric.id}`).toEqual({
            date: point.date,
            value: Number(column),
          });
          const value = Number(column);
          counts[value > 0 ? "positive" : value < 0 ? "negative" : "zero"] += 1;
        });
      }
      // The comparison covered every kind of reading the chart must keep apart.
      expect(counts.positive).toBeGreaterThan(0);
      expect(counts.zero).toBeGreaterThan(0);
      expect(counts.negative).toBeGreaterThan(0);
      expect(counts.unavailable).toBeGreaterThan(0);
    });

    it("serves an ordinary read from the derived state alone: no statement, rebuild or provider", async () => {
      const statementRevisions = vi.spyOn(
        store,
        "getFinancialStatementRevisions",
      );
      const statements = vi.spyOn(store, "getFinancialStatements");
      const cachedStatements = vi.spyOn(cache, "readFinancialStatements");
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      const cachedDerived = vi.spyOn(cache, "readDailyDerivedState");
      const storedDerived = vi.spyOn(store, "getDailyDerivedState");
      try {
        const callsBefore = provider.calls.length;
        const oneYear = await history("ROIC_TTM", {
          from: "2024-01-02",
          to: TODAY,
        });
        expect(oneYear.length).toBeGreaterThan(240);

        expect(statementRevisions).not.toHaveBeenCalled();
        expect(statements).not.toHaveBeenCalled();
        expect(cachedStatements).not.toHaveBeenCalled();
        expect(derivedWrites).not.toHaveBeenCalled();
        // Resident in Redis, so PostgreSQL is not even asked for the rows.
        expect(cachedDerived).toHaveBeenCalledTimes(1);
        expect(storedDerived).not.toHaveBeenCalled();
        expect(provider.calls.length).toBe(callsBefore);
        expect(requests).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("answers byte for byte the same after a Redis flush, rebuilt from PostgreSQL with no provider and no recalculation", async () => {
      const warm = await everyHistory();

      const statementRevisions = vi.spyOn(
        store,
        "getFinancialStatementRevisions",
      );
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      const storedDerived = vi.spyOn(store, "getDailyDerivedState");
      try {
        const keys = await namespaceKeys();
        expect(keys.length).toBeGreaterThan(0);
        // There is no fundamentals key family to flush separately: the metrics ride in the one
        // daily-state chunk family with every other derived series.
        expect(
          keys
            .map((key) => key.slice(namespace.length))
            .filter((key) => /fundamental/i.test(key)),
        ).toEqual([]);
        await redis.del(...keys);

        const cold = await everyHistory();
        expect(cold).toBe(warm);
        // Reconstructed from PostgreSQL, not recalculated: no derived row is written. Losing Redis
        // republishes every cached family of the stock, so the raw statement cache is refilled
        // too — one read per statement type and cadence, each for its own yearly chunks — but the
        // rebuild's read of every revision at once, the one that feeds the materializers, never
        // happens.
        expect(storedDerived).toHaveBeenCalled();
        expect(derivedWrites).not.toHaveBeenCalled();
        for (const [query] of statementRevisions.mock.calls) {
          expect(query.statementType).toBeDefined();
          expect(query.cadence).toBeDefined();
        }
        expect(provider.calls).toEqual([]);
        expect(requests).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("reads the persisted value even where the statements would say otherwise", async () => {
      // Make the durable derived state disagree with the statements it was built from: a read path
      // that recalculated, or that consulted statements, would show 12 here.
      await prisma.$executeRaw`
        UPDATE "DailyDerivedState"
        SET "roicTtm" = 99.5
        WHERE "securityId" = ${security.id} AND "date" = ${new Date("2024-03-01T00:00:00.000Z")}
      `;
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      try {
        await cache.evict(security.id);
        const roic = await history("ROIC_TTM");
        expect(valueOn(roic, "2024-03-01")).toBe(99.5);
        expect(valueOn(roic, "2024-02-29")).toBe(12);
        // The current revision's coverage is trusted: no rebuild repairs a value that is stored.
        expect(derivedWrites).not.toHaveBeenCalled();
        expect(provider.calls).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("rebuilds through the canonical path when the stored derived state is of an older revision", async () => {
      // The previous test left 99.5 on 2024-03-01. Declaring the stored state an r6 build makes the
      // current revision see no coverage at all, exactly as a methodology bump does.
      const stale = `daily-derived-state:r${DERIVED_STATE_REVISION - 1}`;
      await prisma.$executeRaw`
        UPDATE "StockDatasetCoverage" SET "variant" = ${stale}
        WHERE "securityId" = ${security.id} AND "variant" = ${DAILY_DERIVED_STATE_VARIANT}
      `;
      await prisma.$executeRaw`
        UPDATE "StockDatasetState" SET "variant" = ${stale}
        WHERE "securityId" = ${security.id} AND "variant" = ${DAILY_DERIVED_STATE_VARIANT}
      `;
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      try {
        await cache.evict(security.id);
        const roic = await history("ROIC_TTM");
        // One canonical rebuild from the stored statements, and the canonical value is back.
        expect(derivedWrites).toHaveBeenCalledTimes(1);
        expect(valueOn(roic, "2024-03-01")).toBe(12);
        for (const [metricId, key] of DESIGNED) {
          const points = await history(metricId);
          for (const point of points) {
            expect(point.value, `${point.date} ${metricId}`).toBe(
              expectedOn(point.date)[key],
            );
          }
        }
        expect(provider.calls).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);
