import { randomUUID } from "node:crypto";
import {
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DailyPrice,
  DateRange,
  FinancialPeriod,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
  Security,
  StockSplit,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { readOperand, valuationRatioOperand } from "@intrinsic/strategy";
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
  type DailyValuationRatioPoint,
  type ProviderRequestEvent,
} from "./service.js";
import {
  buildValuationTimeline,
  VALUATION_RATIO_REVISION,
  valuationRatioColumns,
} from "./valuation-ratios.js";

loadRootEnv();
// PostgreSQL writes go to the dedicated test database; Redis is isolated by a random namespace.
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The Stock Details valuation history suite requires TEST_REDIS_URL or REDIS_URL: it is the " +
      "proof that the chart reads the same valuation a Strategy reads, through Redis and PostgreSQL.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * Stock Details' valuation ratio history, end to end on the production read path.
 *
 * Stored closes, `FinancialStatement` revisions, the price basis, measured re-bases and the
 * provider's split list in PostgreSQL -> `getDailyValuationRatio`, which is all the HTTP endpoint
 * calls. The same stored inputs are read by the Strategy evaluation frame, a backtest's prepared
 * window read and a Monitor's closed sessions, and every one of them must show the same number on
 * the same session — or none. The provider is a counter that is asked for nothing but, once, the
 * split list.
 *
 * Every expectation that names a value is a hand-computed literal. 1,111,000 diluted shares on every
 * quarter; filings become public the day after they are filed:
 *
 * - FY2023 Q1-Q4, filed 2024-02-14 and observed 2024-03-01: net income 3M, revenue 1.5M, EBITDA 1M,
 *   operating cash flow 1M and capital expenditure -0.25M a quarter; equity 4M and net debt 30M.
 * - FY2024 Q1, filed Friday 2024-05-03 and observed 2024-06-15: the same quarter again.
 * - FY2024 Q2, filed 2024-08-07 and observed 2024-08-20 — more than thirty days before the listed
 *   event of 2024-10-01, so not a count rule 5 withholds before it: the same income and cash flow;
 *   equity 4M and **net cash** of 355.52M. At a close of 120 the market capitalisation is 133.32M,
 *   so P/E is 11.11, P/S 22.22, P/B 33.33, P/FCF 44.44 and EV/EBITDA (133.32M - 355.52M) / 4M =
 *   -55.55.
 * - FY2024 Q3, filed 2024-11-04 and observed 2024-11-15: net income 6M, revenue 3M, EBITDA 2M,
 *   operating cash flow 2M and capital expenditure -0.5M; equity 5M and net debt 50M. The trailing
 *   year becomes 15M, 7.5M, 5M and 3.75M from Tuesday 2024-11-05.
 *
 * The history was verified on 2024-06-01. The provider's split list holds two entries:
 *
 * - a **distribution** on 2024-04-01, history by then (rule 4.1): every ratio is unavailable until
 *   every statement it reads covers a fiscal period ending on or after it — FY2024 Q2, public from
 *   2024-08-08. Statements exist from 2024-02-15, so this gap is the split list's alone.
 * - a **listed event** on 2024-10-01, after verification and never measured (rule 8): the session
 *   and the thirty calendar days after it are unavailable, 2024-10-01 to 2024-10-31; 2024-11-01
 *   reads again.
 */
describeInfrastructure(
  "Stock Details valuation history over the canonical calculation",
  () => {
    const NOW = new Date("2024-12-31T21:00:00.000Z");
    const TODAY = "2024-12-31";
    const PRODUCT_YEARS = 30;
    const FIRST_SESSION = "2023-10-02";
    const VERIFIED_AT = "2024-06-01T12:00:00.000Z";
    const SHARES = 1_111_000;
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
    /** Closes set by hand on the sessions whose readings are written out below. */
    const CLOSES: Readonly<Record<string, number>> = {
      "2024-08-15": 120,
      "2024-11-04": 125,
      "2024-11-05": 125,
    };

    /** Records every provider call: the split list once, and nothing else, ever. */
    class CountingProvider implements FmpStockProviderPort {
      readonly calls: string[] = [];
      splits: StockSplit[] = [];

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

      async getStockSplits(symbol: string) {
        this.calls.push(`splits:${symbol}`);
        return this.splits;
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

    const INCOME = {
      weightedAverageShsOutDil: SHARES,
      netIncome: 3_000_000,
      revenue: 1_500_000,
      ebitda: 1_000_000,
    };
    const CASH_FLOW = {
      operatingCashFlow: 1_000_000,
      capitalExpenditure: -250_000,
    };
    const LEVERED = { totalStockholdersEquity: 4_000_000, netDebt: 30_000_000 };
    const NET_CASH = {
      totalStockholdersEquity: 4_000_000,
      netDebt: -355_520_000,
    };

    /** One fiscal quarter's three statements, filed together. */
    function quarter(
      securityId: string,
      fiscalYear: number,
      period: Exclude<FinancialPeriod, "FY">,
      filingDate: string,
      values: {
        income: Record<string, number>;
        cashFlow: Record<string, number>;
        balanceSheet: Record<string, number>;
      },
    ): FinancialStatementDraft[] {
      const common = {
        securityId,
        fiscalDate: `${fiscalYear}-${PERIOD_END[period]}`,
        fiscalYear,
        period,
        reportedCurrency: "USD",
        filingDate,
      };
      return [
        { ...common, statementType: "INCOME", values: values.income },
        { ...common, statementType: "CASH_FLOW", values: values.cashFlow },
        {
          ...common,
          statementType: "BALANCE_SHEET",
          values: values.balanceSheet,
        },
      ] as FinancialStatementDraft[];
    }

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
      ratioId: ValuationRatioId,
      range: Required<DateRange> = PERIOD,
    ): Promise<DailyValuationRatioPoint[]> {
      return service.getDailyValuationRatio(symbol, ratioId, range);
    }

    function valueOn(
      points: readonly DailyValuationRatioPoint[],
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
      namespace = `stock-data:v2:test:valuation-history:${suffix}`;
      symbol = `V${suffix.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
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
          name: "Valuation History Corp",
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
      });
      sessions = weekdays(FIRST_SESSION, TODAY);
      const prices: DailyPrice[] = sessions.map((date, index) => {
        const close = CLOSES[date] ?? 100 + index * 0.1;
        return {
          securityId: row.id,
          date,
          open: close,
          high: close,
          low: close,
          close,
          volume: 1_000 + (index % 7) * 100,
        };
      });
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
      await store.createPriceBasis({
        securityId: row.id,
        verifiedAt: VERIFIED_AT,
      });
      const ordinary = {
        income: INCOME,
        cashFlow: CASH_FLOW,
        balanceSheet: LEVERED,
      };
      // Four syncs, each observing what was filed since the one before it.
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: (["Q1", "Q2", "Q3", "Q4"] as const).flatMap((period) =>
          quarter(row.id, 2023, period, "2024-02-14", ordinary),
        ),
        syncedAt: "2024-03-01T12:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: quarter(row.id, 2024, "Q1", "2024-05-03", ordinary),
        syncedAt: "2024-06-15T12:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: quarter(row.id, 2024, "Q2", "2024-08-07", {
          ...ordinary,
          balanceSheet: NET_CASH,
        }),
        syncedAt: "2024-08-20T12:00:00.000Z",
      });
      await store.saveFinancialStatements({
        securityId: row.id,
        statements: quarter(row.id, 2024, "Q3", "2024-11-04", {
          income: {
            ...INCOME,
            netIncome: 6_000_000,
            revenue: 3_000_000,
            ebitda: 2_000_000,
          },
          cashFlow: {
            operatingCashFlow: 2_000_000,
            capitalExpenditure: -500_000,
          },
          balanceSheet: {
            totalStockholdersEquity: 5_000_000,
            netDebt: 50_000_000,
          },
        }),
        syncedAt: "2024-11-15T12:00:00.000Z",
      });
      provider.splits = [
        {
          securityId: row.id,
          date: "2024-04-01",
          numerator: 1907,
          denominator: 2000,
          label: "spin-off",
        },
        {
          securityId: row.id,
          date: "2024-10-01",
          numerator: 131,
          denominator: 125,
          label: "stock-split",
        },
      ];
      // Read today: within a day, so the first chart read finds it fresh.
      await store.replaceStockSplits({
        securityId: row.id,
        splits: provider.splits,
        syncedAt: NOW.toISOString(),
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
      // The first chart read hydrates the stock from durable state alone.
      await history("PRICE_TO_EARNINGS_TTM");
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

    it("hydrated from durable state with no provider request, under the current valuation revision", () => {
      expect(provider.calls).toEqual([]);
      expect(requests).toEqual([]);
      expect(VALUATION_RATIO_REVISION).toBe(4);
    });

    it("answers every trading session of the window and no other day, for every ratio", async () => {
      for (const ratioId of VALUATION_RATIO_IDS) {
        expect(
          (await history(ratioId)).map((point) => point.date),
          ratioId,
        ).toEqual(sessions);
      }
    });

    it("reads each ratio's own hand-computed value on an ordinary session, a negative EV/EBITDA included", async () => {
      // Close 120 x 1,111,000 = 133.32M against the four quarters to 2024 Q2.
      const expected: Record<ValuationRatioId, number> = {
        PRICE_TO_EARNINGS_TTM: 11.11,
        PRICE_TO_SALES_TTM: 22.22,
        PRICE_TO_BOOK: 33.33,
        PRICE_TO_FCF_TTM: 44.44,
        EV_TO_EBITDA_TTM: -55.55,
      };
      expect(Object.keys(expected)).toEqual([...VALUATION_RATIO_IDS]);
      for (const ratioId of VALUATION_RATIO_IDS) {
        const points = await history(ratioId, {
          from: "2024-08-15",
          to: "2024-08-15",
        });
        expect(points, ratioId).toEqual([
          { date: "2024-08-15", value: expected[ratioId] },
        ]);
      }
    });

    it("changes on the first session a statement is public, by the statements alone", async () => {
      // The same close of 125 on both sessions: the step is the 2024 Q3 filing's, nothing else.
      const marketCap = 125 * SHARES;
      const before: Record<ValuationRatioId, number> = {
        PRICE_TO_EARNINGS_TTM: marketCap / 12_000_000,
        PRICE_TO_SALES_TTM: marketCap / 6_000_000,
        PRICE_TO_BOOK: marketCap / 4_000_000,
        PRICE_TO_FCF_TTM: marketCap / 3_000_000,
        EV_TO_EBITDA_TTM: (marketCap - 355_520_000) / 4_000_000,
      };
      const after: Record<ValuationRatioId, number> = {
        PRICE_TO_EARNINGS_TTM: marketCap / 15_000_000,
        PRICE_TO_SALES_TTM: marketCap / 7_500_000,
        PRICE_TO_BOOK: marketCap / 5_000_000,
        PRICE_TO_FCF_TTM: marketCap / 3_750_000,
        EV_TO_EBITDA_TTM: (marketCap + 50_000_000) / 5_000_000,
      };
      for (const ratioId of VALUATION_RATIO_IDS) {
        const points = await history(ratioId);
        expect(valueOn(points, "2024-11-04"), ratioId).toBeCloseTo(
          before[ratioId],
          9,
        );
        expect(valueOn(points, "2024-11-05"), ratioId).toBeCloseTo(
          after[ratioId],
          9,
        );
      }
    });

    it("leaves the split list's unsafe intervals unavailable and resumes exactly where the rules do", async () => {
      for (const ratioId of VALUATION_RATIO_IDS) {
        const points = await history(ratioId);
        // Rule 4.1: before the distribution every close carries a factor nothing measured, and after
        // it the statements describe the company before it — until FY2024 Q2, public 2024-08-08.
        // Statements exist from 2024-02-15: this interval is the split list's, not the inputs'.
        for (const date of sessions.filter((day) => day < "2024-08-08")) {
          expect(valueOn(points, date), `${date} ${ratioId}`).toBeUndefined();
        }
        expect(valueOn(points, "2024-08-08"), ratioId).toBeDefined();
        // Rule 8: the listed event's session and the thirty days after it, then the line resumes.
        expect(valueOn(points, "2024-09-30"), ratioId).toBeDefined();
        const listed = sessions.filter(
          (day) => day >= "2024-10-01" && day <= "2024-10-31",
        );
        expect(listed).toHaveLength(23);
        for (const date of listed) {
          // Absent: never zero, and never the 2024-09-30 reading carried through.
          expect(valueOn(points, date), `${date} ${ratioId}`).toBeUndefined();
        }
        expect(valueOn(points, "2024-11-01"), ratioId).toBeDefined();
        expect(valueOn(points, TODAY), ratioId).toBeDefined();
      }
    });

    it("is exactly valuationRatioColumns over the stored inputs, on every session", async () => {
      const [prices, statements, basis, events, splits] = await Promise.all([
        store.getDailyPrices(security.id, PERIOD),
        store.getFinancialStatementRevisions({
          securityId: security.id,
          cadence: "QUARTERLY",
        }),
        store.getPriceBasis(security.id),
        store.getPriceBasisEvents(security.id),
        store.getStockSplits(security.id),
      ]);
      const columns = valuationRatioColumns({
        timeline: buildValuationTimeline({
          securityId: security.id,
          currency: "USD",
          statements,
          verifiedAt: basis?.verifiedAt ?? null,
          events,
          splits,
        }),
        dates: prices.map((price) => price.date),
        closes: prices.map((price) => price.close),
        ratios: VALUATION_RATIO_IDS,
      });
      for (const ratioId of VALUATION_RATIO_IDS) {
        const column = columns.get(ratioId) as Float64Array;
        const points = await history(ratioId);
        points.forEach((point, index) => {
          const calculated = column[index] as number;
          if (Number.isNaN(calculated)) {
            expect(point, `${point.date} ${ratioId}`).toEqual({
              date: point.date,
            });
          } else {
            // No tolerance: one calculation, one number.
            expect(point, `${point.date} ${ratioId}`).toEqual({
              date: point.date,
              value: calculated,
            });
          }
        });
      }
    });

    it("gives the chart exactly the reading a Strategy, a backtest and a Monitor read, on every session", async () => {
      const operands = VALUATION_RATIO_IDS.map(valuationRatioOperand);
      const frame = await service.getDailyEvaluationFrame(
        security,
        PERIOD,
        operands,
      );
      // A backtest prepares once and reads its window with the prepared inputs.
      const prepared = await service.prepareDailyEvaluationData(
        security,
        PERIOD,
        operands,
      );
      const window = await service.readDailyEvaluationFrame(
        security,
        PERIOD,
        operands,
        {
          priceBasisGeneration: prepared!.priceBasisGeneration,
          valuation: prepared!.valuation!,
        },
      );
      // A Monitor's closed sessions behind its provisional observation.
      await service.prepareMonitorEvaluationData(security, 80, TODAY, operands);
      const monitor = await service.readMonitorEvaluationFrame({
        security,
        operands,
        observations: 80,
        asOf: TODAY,
        // Inside the ex-date hold's band around the newest close, about 131.
        observation: { price: 130 },
        observationDate: "2025-01-02",
      });
      expect(monitor).not.toBeNull();

      const kinds = { value: 0, negative: 0, unavailable: 0 };
      let compared = 0;
      for (const ratioId of VALUATION_RATIO_IDS) {
        const operand = valuationRatioOperand(ratioId);
        const chart = await history(ratioId);
        for (const point of chart) {
          for (const [reader, read] of [
            ["frame", frame],
            ["backtest", window],
            ...(monitor && monitor.frame.dates.indexOf(point.date) >= 0
              ? [["monitor", monitor.frame] as const]
              : []),
          ] as const) {
            const index = read.dates.indexOf(point.date);
            expect(index, `${reader} ${point.date}`).toBeGreaterThanOrEqual(0);
            const value = readOperand(read, operand, index);
            if (point.value === undefined) {
              expect(value, `${reader} ${point.date} ${ratioId}`).toBeNaN();
            } else {
              expect(value, `${reader} ${point.date} ${ratioId}`).toBe(
                point.value,
              );
            }
            compared += 1;
          }
          if (point.value === undefined) {
            kinds.unavailable += 1;
          } else {
            kinds[point.value < 0 ? "negative" : "value"] += 1;
          }
        }
      }
      // Every session twice, and the Monitor's closed window once more; every kind of reading.
      expect(compared).toBe(
        VALUATION_RATIO_IDS.length * (sessions.length * 2 + 80),
      );
      expect(kinds.value).toBeGreaterThan(0);
      expect(kinds.negative).toBeGreaterThan(0);
      expect(kinds.unavailable).toBeGreaterThan(0);
    });

    it("serves a warm read with no provider request, one statement read and the stored split list", async () => {
      const revisions = vi.spyOn(store, "getFinancialStatementRevisions");
      const splitState = vi.spyOn(store, "getDatasetState");
      const derived = vi.spyOn(cache, "readDailyDerivedState");
      try {
        const callsBefore = provider.calls.length;
        const oneYear = await history("PRICE_TO_BOOK", {
          from: "2024-01-02",
          to: TODAY,
        });
        expect(oneYear.length).toBeGreaterThan(240);
        expect(provider.calls.length).toBe(callsBefore);
        expect(requests).toEqual([]);
        // The statements once, for the timeline; the split list's freshness once; no derived state,
        // which a valuation does not read.
        expect(revisions).toHaveBeenCalledTimes(1);
        expect(
          splitState.mock.calls.filter(
            ([, dataset]) => dataset === "STOCK_SPLIT",
          ),
        ).toHaveLength(1);
        expect(derived).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("answers byte for byte the same after a Redis flush, with no provider request", async () => {
      const warm = JSON.stringify(
        await Promise.all(
          VALUATION_RATIO_IDS.map((ratioId) => history(ratioId)),
        ),
      );
      const keys = await namespaceKeys();
      expect(keys.length).toBeGreaterThan(0);
      // There is no valuation key family to flush: nothing about a ratio is cached per session.
      expect(
        keys
          .map((key) => key.slice(namespace.length))
          .filter((key) => /valuation/i.test(key)),
      ).toEqual([]);
      await redis.del(...keys);
      const cold = JSON.stringify(
        await Promise.all(
          VALUATION_RATIO_IDS.map((ratioId) => history(ratioId)),
        ),
      );
      expect(cold).toBe(warm);
      expect(provider.calls).toEqual([]);
    });

    it("asks the provider for the split list once it is a day old, and reads it from then on", async () => {
      const before = await history("PRICE_TO_SALES_TTM");
      // The stored list was read a day and an hour ago; everything else is as current as it was.
      await prisma.stockDatasetState.update({
        where: {
          securityId_dataset_variant: {
            securityId: security.id,
            dataset: "STOCK_SPLIT",
            variant: "",
          },
        },
        data: {
          lastSuccessfulSyncAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        },
      });
      const after = await history("PRICE_TO_SALES_TTM");
      await history("PRICE_TO_SALES_TTM");
      // One provider request, for the list, whatever number of sessions the read covers.
      expect(provider.calls).toEqual([`splits:${symbol}`]);
      expect(requests.map((request) => request.reason)).toEqual([
        "VALUATION_SPLIT_LIST",
      ]);
      // The provider's list is the stored one, so nothing moves.
      expect(after).toEqual(before);
    });

    it("withholds the sessions a measured re-base cannot place, and reads the rest on the basis the counts were observed on", async () => {
      // The loader measured a 2:1 re-base effective 2024-12-02, detected the next day: every share
      // count stored was observed before it, so sessions before it read the close restored to the
      // basis those counts were observed on (x2), and the sessions from it on cannot be placed.
      await prisma.priceBasisEvent.create({
        data: {
          securityId: security.id,
          generation: 1,
          kind: "MEASURED",
          effectiveDate: new Date("2024-12-02T00:00:00.000Z"),
          priceRatio: 2,
          detectedAt: new Date("2024-12-03T12:00:00.000Z"),
          evidence: {
            runs: [],
            comparedSessions: 0,
            changedSessions: 0,
            unfittedSessions: 0,
          },
        },
      });
      await prisma.securityPriceBasis.update({
        where: { securityId: security.id },
        data: { generation: 1 },
      });
      const points = await history("PRICE_TO_EARNINGS_TTM");
      expect(valueOn(points, "2024-08-15")).toBe(22.22);
      expect(valueOn(points, "2024-11-04")).toBeDefined();
      // FY2024 Q3's count, public from 2024-11-05, was first observed on 2024-11-15: in the month
      // before the re-base, so it may already be restated and no session before it reads it (rule 5,
      // before the event; owner, 2026-10-06).
      for (const date of sessions.filter(
        (day) => day >= "2024-11-05" && day < "2024-12-02",
      )) {
        expect(valueOn(points, date), date).toBeUndefined();
      }
      for (const date of sessions.filter((day) => day >= "2024-12-02")) {
        expect(valueOn(points, date), date).toBeUndefined();
      }
      const ev = await history("EV_TO_EBITDA_TTM", {
        from: "2024-08-15",
        to: "2024-08-15",
      });
      // (2 x 133.32M - 355.52M) / 4M: the enterprise value moves with the restored capitalisation.
      expect(ev).toEqual([{ date: "2024-08-15", value: -22.22 }]);

      // The Strategy frame reads the same basis on every session.
      const operand = valuationRatioOperand("PRICE_TO_EARNINGS_TTM");
      const frame = await service.getDailyEvaluationFrame(security, PERIOD, [
        operand,
      ]);
      for (const point of points) {
        const value = readOperand(
          frame,
          operand,
          frame.dates.indexOf(point.date),
        );
        if (point.value === undefined) {
          expect(value, point.date).toBeNaN();
        } else {
          expect(value, point.date).toBe(point.value);
        }
      }
    });
  },
);
