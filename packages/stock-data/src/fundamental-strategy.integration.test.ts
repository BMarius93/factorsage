import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  FUNDAMENTAL_METRIC_IDS,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  FUNDAMENTAL_METRICS,
  type DailyPrice,
  type DateRange,
  type FinancialPeriod,
  type FinancialStatementCadence,
  type FinancialStatementDraft,
  type FinancialStatementType,
  type Security,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  collectOperands,
  fundamentalMetricOperand,
  PRICE_OPERAND,
  readOperand,
  simulateBacktest,
  type BacktestResult,
  type EvaluationFrame,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisStockDataCache } from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import { subtractYears } from "./dates.js";
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
    "The Fundamental Strategy integration suite requires TEST_REDIS_URL or REDIS_URL: it is the " +
      "end-to-end proof that a Strategy reads materialized Fundamental Metrics and nothing else.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * A Fundamental Strategy, end to end on the production path.
 *
 * `FinancialStatement` revisions in PostgreSQL -> the canonical derived rebuild, which materializes
 * the Fundamental Metrics -> `DailyDerivedState` in PostgreSQL and Redis -> the backtest's own
 * frame read -> `projectEvaluationFrame` -> the engine. Nothing between a statement and a trade is
 * stubbed except the provider, which is a counter that must never be asked anything.
 *
 * The statements are designed so every expected reading is a hand-computed literal:
 *
 * - Invested capital is 790 on every balance sheet (debt + equity - cash), so ROIC TTM is
 *   operating income TTM x 0.79 / 790 x 100: 120 -> 12, then 180 -> 18.
 * - 2024-02-14 filings (public 2024-02-15): FY2023 Q1-Q4 income (operating income 30 each) and the
 *   2022 Q4, 2023 Q1 and 2023 Q4 balance sheets (debt 720, equity 600, cash 530).
 *   ROIC 12, Debt / Equity 1.2.
 * - 2024-05-01 filing (public 2024-05-02): FY2024 Q1 income, operating income 90. ROIC's window now
 *   ends at 2024 Q1 but that quarter's balance sheet is not public yet, so ROIC is **unavailable**,
 *   never the older 12. Debt / Equity is still 2023 Q4's 1.2.
 * - 2024-05-09 filing (public 2024-05-10): the 2024 Q1 balance sheet (debt 480, cash 290). ROIC 18,
 *   Debt / Equity 0.8.
 * - 2024-06-14 filing (public Saturday 2024-06-15): a restated 2024 Q1 balance sheet (debt 720,
 *   cash 530). No weekend row exists, so it takes effect on Monday 2024-06-17: Debt / Equity 1.2,
 *   ROIC unchanged at 18.
 */
describeInfrastructure(
  "a Fundamental Strategy over the canonical derived state",
  () => {
    const NOW = new Date("2024-08-30T21:00:00.000Z");
    const TODAY = "2024-08-30";
    const SYNCED_AT = NOW.toISOString();
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
    ];

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
      revenue: 360,
      grossProfit: 150,
      operatingIncome: 90,
      netIncome: 60,
      epsDiluted: 1.5,
      ebitda: 105,
      ebit: 92,
      interestExpense: 4,
    };
    const LEVERED_BALANCE_SHEET = {
      totalDebt: 720,
      totalStockholdersEquity: 600,
      totalEquity: 600,
      cashAndShortTermInvestments: 530,
      cashAndCashEquivalents: 530,
      totalAssets: 2_000,
      totalCurrentAssets: 900,
      totalCurrentLiabilities: 600,
      netDebt: 190,
    };
    const DELEVERED_BALANCE_SHEET = {
      ...LEVERED_BALANCE_SHEET,
      totalDebt: 480,
      cashAndShortTermInvestments: 290,
      cashAndCashEquivalents: 290,
    };

    function statements(securityId: string): FinancialStatementDraft[] {
      const rows: FinancialStatementDraft[] = [];
      for (const period of ["Q1", "Q2", "Q3", "Q4"] as const) {
        rows.push(
          draft(securityId, "INCOME", 2023, period, INCOME_2023, "2024-02-14"),
        );
      }
      rows.push(
        draft(
          securityId,
          "BALANCE_SHEET",
          2022,
          "Q4",
          LEVERED_BALANCE_SHEET,
          "2024-02-14",
        ),
        draft(
          securityId,
          "BALANCE_SHEET",
          2023,
          "Q1",
          LEVERED_BALANCE_SHEET,
          "2024-02-14",
        ),
        draft(
          securityId,
          "BALANCE_SHEET",
          2023,
          "Q4",
          LEVERED_BALANCE_SHEET,
          "2024-02-14",
        ),
        draft(securityId, "INCOME", 2024, "Q1", INCOME_2024_Q1, "2024-05-01"),
        draft(
          securityId,
          "BALANCE_SHEET",
          2024,
          "Q1",
          DELEVERED_BALANCE_SHEET,
          "2024-05-09",
        ),
        // The restatement: a later filing of the same fiscal identity.
        draft(
          securityId,
          "BALANCE_SHEET",
          2024,
          "Q1",
          LEVERED_BALANCE_SHEET,
          "2024-06-14",
        ),
      );
      return rows;
    }

    /**
     * The readings the design above implies, written out by hand for the two metrics the
     * Strategies read: `undefined` is unavailable.
     */
    function expectedOn(date: string): {
      roic: number | undefined;
      debtToEquity: number | undefined;
    } {
      if (date < "2024-02-15") {
        return { roic: undefined, debtToEquity: undefined };
      }
      if (date < "2024-05-02") {
        return { roic: 12, debtToEquity: 1.2 };
      }
      if (date < "2024-05-10") {
        return { roic: undefined, debtToEquity: 1.2 };
      }
      if (date < "2024-06-17") {
        return { roic: 18, debtToEquity: 0.8 };
      }
      return { roic: 18, debtToEquity: 1.2 };
    }

    const PERIOD = { from: FIRST_SESSION, to: TODAY };
    const ALL_FUNDAMENTALS = FUNDAMENTAL_METRIC_IDS.map(
      fundamentalMetricOperand,
    );

    let prisma: PrismaClient;
    let redis: ReturnType<typeof createStockDataRedisClient>;
    let store: PrismaStockDataStore;
    let cache: RedisStockDataCache;
    let namespace: string;
    let provider: CountingProvider;
    const requests: ProviderRequestEvent[] = [];
    let security: Security;
    let sessions: string[];
    let service: CanonicalStockDataService;
    /** Derived-state writes the preparation made: the one canonical rebuild. */
    let preparationDerivedWrites = 0;

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

    beforeAll(async () => {
      const suffix = randomUUID();
      namespace = `stock-data:v2:test:fundamental-strategy:${suffix}`;
      const symbol = `F${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
          name: "Fundamental Strategy Corp",
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
        syncedAt: SYNCED_AT,
        tailDate: TODAY,
        freshThrough: TODAY,
      });
      // Oldest filing first, so the restatement is a later filing of a known identity.
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: [...statements(row.id)].sort((left, right) =>
          left.filingDate.localeCompare(right.filingDate),
        ),
        syncedAt: SYNCED_AT,
      });
      for (const operation of fundamentalsDatasetOperations(PRODUCT_YEARS)) {
        await store.upsertDatasetState({
          securityId: row.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt: SYNCED_AT,
        });
      }
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt: SYNCED_AT,
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

      // PREPARING_DATA: the one phase allowed to load. The source data is already durable, so the
      // only work is the canonical derived rebuild that materializes the Fundamental Metrics.
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      await service.prepareDailyEvaluationData(security, PERIOD, [
        PRICE_OPERAND,
        ...ALL_FUNDAMENTALS,
      ]);
      preparationDerivedWrites = derivedWrites.mock.calls.length;
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

    function strategy(
      buy: StrategySignal,
      extra: Partial<StrategyDefinition> = {},
    ): StrategyDefinition {
      return {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "b1", percentage: 100, signal: buy }],
        sellLevels: [],
        ...extra,
      };
    }

    const ROIC_ABOVE_15 = strategy({
      conditions: [
        {
          id: "roic-above-15",
          metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
          operator: "IS_ABOVE",
          value: { kind: "PERCENT", value: 15 },
        },
      ],
    });
    const DEBT_TO_EQUITY_BELOW_1 = strategy(
      {
        conditions: [
          {
            id: "debt-to-equity-below-1",
            metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
            operator: "IS_BELOW",
            value: { kind: "MULTIPLE", value: 1 },
          },
        ],
      },
      {
        finalExit: {
          id: "x1",
          rules: [
            {
              id: "x1-rule-1",
              signal: {
                conditions: [
                  {
                    id: "debt-to-equity-above-1.1",
                    metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
                    operator: "IS_ABOVE",
                    value: { kind: "MULTIPLE", value: 1.1 },
                  },
                ],
              },
            },
          ],
        },
      },
    );

    async function readFrame(
      definition: StrategyDefinition,
      range: Required<DateRange> = PERIOD,
    ): Promise<EvaluationFrame> {
      return service.readDailyEvaluationFrame(
        security,
        range,
        collectOperands(definition),
      );
    }

    async function backtest(
      definition: StrategyDefinition,
      frame: EvaluationFrame,
    ): Promise<BacktestResult> {
      const calendar = frame.dates.filter(
        (date) => date >= PERIOD.from && date <= PERIOD.to,
      );
      return simulateBacktest({
        definition,
        securities: [{ frame, buyWindows: { mode: "FULL", ranges: [] } }],
        benchmark: null,
        executionCalendar: calendar,
        startDate: PERIOD.from,
        endDate: PERIOD.to,
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 1,
      });
    }

    function strategyTrades(result: BacktestResult): [string, string][] {
      return result.trades
        .filter((trade) => trade.source === "STRATEGY")
        .map((trade) => [trade.date, trade.action]);
    }

    it("prepared by one canonical rebuild, with no provider request at all", () => {
      expect(preparationDerivedWrites).toBe(1);
      expect(provider.calls).toEqual([]);
      expect(requests).toEqual([]);
    });

    it("materialized the hand-computed history, and the frame reads exactly what PostgreSQL holds", async () => {
      const persisted = await store.getDailyDerivedState(security.id, PERIOD);
      expect(persisted.map((row) => row.date)).toEqual(sessions);
      const frame = await service.readDailyEvaluationFrame(security, PERIOD, [
        PRICE_OPERAND,
        ...ALL_FUNDAMENTALS,
      ]);
      expect(frame.dates).toEqual(sessions);
      for (const [index, date] of sessions.entries()) {
        const expected = expectedOn(date);
        const row = persisted[index]!;
        const roic = readOperand(
          frame,
          fundamentalMetricOperand("ROIC_TTM"),
          index,
        );
        const debtToEquity = readOperand(
          frame,
          fundamentalMetricOperand("DEBT_TO_EQUITY"),
          index,
        );
        if (expected.roic === undefined) {
          expect(row, `${date} ROIC`).not.toHaveProperty("roicTtm");
          expect(roic, `${date} ROIC`).toBeNaN();
        } else {
          expect(roic, `${date} ROIC`).toBeCloseTo(expected.roic, 8);
        }
        if (expected.debtToEquity === undefined) {
          expect(row, `${date} D/E`).not.toHaveProperty("debtToEquity");
          expect(debtToEquity, `${date} D/E`).toBeNaN();
        } else {
          expect(debtToEquity, `${date} D/E`).toBeCloseTo(
            expected.debtToEquity,
            8,
          );
        }
        // Every one of the fifteen columns is exactly the persisted field: a finite value where
        // PostgreSQL has one, absence where it has none, and never a recalculation.
        for (const metric of FUNDAMENTAL_METRICS) {
          const value = readOperand(
            frame,
            fundamentalMetricOperand(metric.id),
            index,
          );
          const stored = row[metric.field];
          if (stored === undefined) {
            expect(value, `${date} ${metric.id}`).toBeNaN();
          } else {
            expect(value, `${date} ${metric.id}`).toBe(stored);
          }
        }
      }
      // The weekend-dated restatement took effect on the next real session, with no weekend row.
      expect(sessions).not.toContain("2024-06-15");
      const friday = sessions.indexOf("2024-06-14");
      const monday = sessions.indexOf("2024-06-17");
      expect(monday).toBe(friday + 1);
      expect(
        readOperand(frame, fundamentalMetricOperand("DEBT_TO_EQUITY"), friday),
      ).toBeCloseTo(0.8, 8);
      expect(
        readOperand(frame, fundamentalMetricOperand("DEBT_TO_EQUITY"), monday),
      ).toBeCloseTo(1.2, 8);
    });

    it("buys on the first session ROIC TTM is above 15%, never on 12 or on an unavailable reading", async () => {
      const result = await backtest(
        ROIC_ABOVE_15,
        await readFrame(ROIC_ABOVE_15),
      );
      expect(strategyTrades(result)).toEqual([["2024-05-10", "BUY"]]);
    });

    it("buys on Debt / Equity below 1.0x only once it is 0.8, and exits on the weekend-dated restatement's Monday", async () => {
      const result = await backtest(
        DEBT_TO_EQUITY_BELOW_1,
        await readFrame(DEBT_TO_EQUITY_BELOW_1),
      );
      // Read as zero, the unavailable months before 2024-02-15 would have bought on the first day.
      expect(strategyTrades(result)).toEqual([
        ["2024-05-10", "BUY"],
        ["2024-06-17", "FINAL_EXIT"],
      ]);
    });

    it("evaluates from arrays alone: no provider, statement read, rebuild or cache access during the run", async () => {
      const definition = strategy(
        {
          conditions: [
            {
              id: "price-above-sma50",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
            {
              id: "roic-above-15",
              metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 15 },
            },
            {
              id: "rvol20-above-0.5",
              metric: { kind: "RELATIVE_VOLUME", period: 20 },
              operator: "IS_ABOVE",
              value: { kind: "MULTIPLE", value: 0.5 },
            },
          ],
        },
        {
          sellLevels: [
            {
              id: "s1",
              percentage: 50,
              signal: {
                conditions: [
                  {
                    id: "debt-to-equity-above-1.1",
                    metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
                    operator: "IS_ABOVE",
                    value: { kind: "MULTIPLE", value: 1.1 },
                  },
                ],
              },
            },
          ],
        },
      );
      const statementReads = vi.spyOn(store, "getFinancialStatementRevisions");
      const statementPeriodReads = vi.spyOn(store, "getFinancialStatements");
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      const storeDerivedReads = vi.spyOn(store, "getDailyDerivedState");
      const cacheDerivedReads = vi.spyOn(cache, "readDailyDerivedState");
      const cacheStatementReads = vi.spyOn(cache, "readFinancialStatements");
      try {
        const callsBefore = provider.calls.length;

        // RUNNING reads one window: a constant number of derived-state reads, however many
        // sessions it holds.
        const monthFrame = await readFrame(definition, {
          from: "2024-05-01",
          to: "2024-05-31",
        });
        const readsForAMonth =
          storeDerivedReads.mock.calls.length +
          cacheDerivedReads.mock.calls.length;
        const frame = await readFrame(definition);
        const readsForTheRun =
          storeDerivedReads.mock.calls.length +
          cacheDerivedReads.mock.calls.length -
          readsForAMonth;
        // The month's frame carries its ten calendar days of leading context too: ~29 rows
        // against the run's 231.
        expect(frame.dates.length).toBeGreaterThan(monthFrame.dates.length * 7);
        expect(readsForTheRun).toBe(readsForAMonth);
        expect(readsForAMonth).toBeLessThanOrEqual(2);

        // Only the columns the Strategy names were projected: two fundamentals, one series, one RVOL.
        expect([...frame.columns.keys()].sort()).toEqual(
          [
            fundamentalMetricOperand("DEBT_TO_EQUITY"),
            fundamentalMetricOperand("ROIC_TTM"),
            "relative-volume:20",
            "series:SMA_50D",
          ].sort(),
        );

        // The day loop itself: nothing but arrays. Every I/O counter is frozen across it.
        const frozen = () => [
          provider.calls.length,
          statementReads.mock.calls.length,
          statementPeriodReads.mock.calls.length,
          derivedWrites.mock.calls.length,
          storeDerivedReads.mock.calls.length,
          cacheDerivedReads.mock.calls.length,
          cacheStatementReads.mock.calls.length,
        ];
        const before = frozen();
        const result = await backtest(definition, frame);
        expect(frozen()).toEqual(before);
        expect(strategyTrades(result).slice(0, 2)).toEqual([
          ["2024-05-10", "BUY"],
          ["2024-06-17", "SELL"],
        ]);

        // Reading and evaluating reached no statement, recalculated nothing and asked no provider.
        expect(statementReads).not.toHaveBeenCalled();
        expect(statementPeriodReads).not.toHaveBeenCalled();
        expect(cacheStatementReads).not.toHaveBeenCalled();
        expect(derivedWrites).not.toHaveBeenCalled();
        expect(provider.calls.length).toBe(callsBefore);
        expect(requests).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("gives identical frames and results on every run, and after a Redis flush", async () => {
      const first = await readFrame(DEBT_TO_EQUITY_BELOW_1);
      const firstResult = JSON.stringify(
        await backtest(DEBT_TO_EQUITY_BELOW_1, first),
      );
      const second = await readFrame(DEBT_TO_EQUITY_BELOW_1);
      expect(second).toEqual(first);
      expect(
        JSON.stringify(await backtest(DEBT_TO_EQUITY_BELOW_1, second)),
      ).toBe(firstResult);

      // A flush costs latency only: the next read rebuilds the cache from PostgreSQL, recalculates
      // nothing and asks no provider, and the run is byte-identical.
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      try {
        const keys = await namespaceKeys();
        expect(keys.length).toBeGreaterThan(0);
        await redis.del(...keys);
        await service.prepareDailyEvaluationData(
          security,
          PERIOD,
          collectOperands(DEBT_TO_EQUITY_BELOW_1),
        );
        const afterFlush = await readFrame(DEBT_TO_EQUITY_BELOW_1);
        expect(afterFlush).toEqual(first);
        expect(
          JSON.stringify(await backtest(DEBT_TO_EQUITY_BELOW_1, afterFlush)),
        ).toBe(firstResult);
        expect(derivedWrites).not.toHaveBeenCalled();
        expect(provider.calls).toEqual([]);
        expect(requests).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("reads the persisted metric even where the statements would say otherwise", async () => {
      // Deliberately make the durable derived state disagree with the statements it was built
      // from: a shadow Fundamentals engine in the read path would recompute 12 here.
      const date = "2024-03-01";
      await prisma.$executeRaw`
        UPDATE "DailyDerivedState"
        SET "roicTtm" = 99.5
        WHERE "securityId" = ${security.id} AND "date" = ${new Date(`${date}T00:00:00.000Z`)}
      `;
      const derivedWrites = vi.spyOn(store, "saveDailyDerivedState");
      try {
        await cache.evict(security.id);
        await service.prepareDailyEvaluationData(
          security,
          PERIOD,
          collectOperands(ROIC_ABOVE_15),
        );
        const frame = await readFrame(ROIC_ABOVE_15);
        const index = frame.dates.indexOf(date);
        expect(
          readOperand(frame, fundamentalMetricOperand("ROIC_TTM"), index),
        ).toBe(99.5);
        expect(
          readOperand(frame, fundamentalMetricOperand("ROIC_TTM"), index - 1),
        ).toBeCloseTo(12, 8);
        // And the Strategy acts on it: the only session "above 15%" before May is the edited one.
        expect(strategyTrades(await backtest(ROIC_ABOVE_15, frame))[0]).toEqual(
          [date, "BUY"],
        );
        expect(derivedWrites).not.toHaveBeenCalled();
        expect(provider.calls).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);
