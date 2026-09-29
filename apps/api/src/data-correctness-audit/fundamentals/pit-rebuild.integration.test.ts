import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DailyPrice,
  DateRange,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  CanonicalStockDataService,
  IoredisCacheClient,
  PrismaStockDataStore,
  RedisStockDataCache,
  RedlockLoadCoordinator,
  createStockDataRedisClient,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  subtractYears,
} from "@intrinsic/stock-data";
import { FUNDAMENTAL_AUDIT_METRICS, useTestDatabase } from "@intrinsic/testing";
import { describe, expect, it, vi } from "vitest";
import { oracleFundamentalOutcomes } from "../oracle/fundamentals";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
const describeInfrastructure = redisUrl ? describe : describe.skip;

/**
 * Point-in-time revisions through the real refresh path (audit sections 7, 8, 15 and 16).
 *
 * A security is hydrated on 2026-08-24 from durable statements and prices. On 2026-09-14, after the
 * close, the product refreshes it the ordinary way: three weeks of new price bars arrive through
 * coverage repair and the recent-tail refresh, and the fundamentals refresh brings one revision of
 * FY2026 Q1 — which the real `PrismaStockDataStore` dates itself. Every column of every
 * `DailyDerivedState` row is captured, as PostgreSQL's own text, before and after.
 *
 * The four revisions re-audit the moved-period-end look-ahead independently of the tests that fixed
 * it:
 *
 * | Case | Revision of FY2026 Q1 | Public from | First session it may touch |
 * | --- | --- | --- | --- |
 * | later | period end 04-03, the original filing date 05-10 | its observation, 09-14 | 09-14 |
 * | earlier | period end 03-28, the original filing date | its observation, 09-14 | 09-14 |
 * | refiled | period end 03-28, a real filing on 07-20 | 07-21 | 07-21 |
 * | placeholder | the original "filed" on its period end (AUD-03); the revision moves the placeholder with it to 04-03 | its observation, 09-14 | 09-14 |
 *
 * For each: no row before the first session the revision may touch changes in any column —
 * technicals, intrinsic values or Fundamental Metrics — and every row, before and after, carries the
 * independent oracle's reading of the stored revisions. The refresh rebuilds from the earliest
 * availability of the fiscal year it touched, never from the start of the history, and reads the
 * retained revisions once per rebuild for both statement-derived families.
 */
describeInfrastructure("PIT revisions through the real refresh path", () => {
  const T1 = "2026-08-24";
  const T2 = "2026-09-14";
  const HOLIDAYS = new Set([
    "2022-07-04",
    "2023-07-04",
    "2024-07-04",
    "2025-07-04",
    "2026-07-03",
    "2026-09-07",
  ]);
  const FIRST_SESSION = "2022-01-03";

  function sessions(from: string, to: string): string[] {
    const dates: string[] = [];
    for (
      let day = new Date(`${from}T00:00:00.000Z`);
      day <= new Date(`${to}T00:00:00.000Z`);
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const date = day.toISOString().slice(0, 10);
      if (
        day.getUTCDay() !== 0 &&
        day.getUTCDay() !== 6 &&
        !HOLIDAYS.has(date)
      ) {
        dates.push(date);
      }
    }
    return dates;
  }

  function addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }

  const QUARTER_END = ["03-31", "06-30", "09-30", "12-31"];

  /** FY2020 Q1 … FY2026 Q2, filed forty days after each period end unless the case says otherwise. */
  function history(
    securityId: string,
    placeholderQ1: boolean,
  ): FinancialStatementDraft[] {
    const drafts: FinancialStatementDraft[] = [];
    for (let fiscalYear = 2020; fiscalYear <= 2026; fiscalYear += 1) {
      QUARTER_END.forEach((end, index) => {
        if (fiscalYear === 2026 && index > 1) {
          return;
        }
        const period = `Q${index + 1}` as FinancialStatementDraft["period"];
        const fiscalDate = `${fiscalYear}-${end}`;
        const step = (fiscalYear - 2020) * 4 + index;
        const filingDate =
          placeholderQ1 && fiscalYear === 2026 && period === "Q1"
            ? fiscalDate
            : addDays(fiscalDate, 40);
        const base = {
          securityId,
          fiscalDate,
          fiscalYear,
          period,
          reportedCurrency: "USD",
          filingDate,
        };
        drafts.push(
          {
            ...base,
            statementType: "INCOME",
            values: {
              revenue: 1_000 + step * 25,
              grossProfit: 420 + step * 6,
              operatingIncome: 150 + step * 4,
              netIncome: 100 + step * 3,
              epsDiluted: 1 + step / 50,
              weightedAverageShsOutDil: 100,
              ebitda: 230 + step * 4,
              ebit: 165 + step * 4,
              interestExpense: 12,
              incomeTaxExpense: 25,
              incomeBeforeTax: 125 + step * 3,
            },
          },
          {
            ...base,
            statementType: "CASH_FLOW",
            values: {
              operatingCashFlow: 190 + step * 5,
              capitalExpenditure: -60,
              commonDividendsPaid: -20,
            },
          },
          {
            ...base,
            statementType: "BALANCE_SHEET",
            values: {
              totalDebt: 800,
              totalStockholdersEquity: 1_500 + step * 12,
              cashAndShortTermInvestments: 300,
              cashAndCashEquivalents: 250,
              totalAssets: 4_000 + step * 30,
              totalCurrentAssets: 1_250,
              totalCurrentLiabilities: 900,
              netDebt: 500,
            },
          },
        );
      });
    }
    return drafts;
  }

  class ScriptedProvider implements FmpStockProviderPort {
    readonly calls: string[] = [];
    readonly statements = new Map<string, FinancialStatementDraft[]>();
    constructor(private readonly prices: readonly DailyPrice[]) {}
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
      return this.prices.filter(
        (price) =>
          (!range.from || price.date >= range.from) &&
          (!range.to || price.date <= range.to),
      );
    }
    async getFinancialStatements(
      _symbol: string,
      _securityId: string,
      statementType: FinancialStatementType,
      cadence: FinancialStatementCadence,
      limit: number,
    ) {
      this.calls.push(`statements:${statementType}:${cadence}:${limit}`);
      return this.statements.get(`${statementType}:${cadence}`) ?? [];
    }
  }

  async function provision(options: {
    placeholderQ1: boolean;
    firstSession?: string;
  }) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const symbol = `PR${suffix}`;
    const namespace = `stock-data:v2:test:fundamental-pit:${suffix}`;
    const prisma = new PrismaClient();
    const redis = createStockDataRedisClient(
      redisUrl ?? "redis://localhost:6379",
    );
    const store = new PrismaStockDataStore(prisma);
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      10,
      namespace,
    );
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "PIT Rebuild Audit Corp",
        exchangeCode: "NYSE",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    const truth: DailyPrice[] = sessions(
      options.firstSession ?? FIRST_SESSION,
      T2,
    ).map((date, index) => {
      const close = 80 + (index % 29) * 0.41 + index * 0.013;
      return {
        securityId: row.id,
        date,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 10_000 + (index % 11) * 100,
      };
    });
    const provider = new ScriptedProvider(truth);
    const t1At = `${T1}T12:00:00.000Z`;
    await store.saveDailyPriceSync({
      securityId: row.id,
      prices: truth.filter((price) => price.date <= T1),
      successfulCoverage: [
        { from: subtractYears(T1, priceRetentionYears(30)), to: T1 },
      ],
      syncedAt: t1At,
      tailDate: T1,
      freshThrough: T1,
    });
    await store.saveFinancialStatements({
      securityId: row.id,
      statements: history(row.id, options.placeholderQ1),
      syncedAt: t1At,
    });
    for (const operation of fundamentalsDatasetOperations(30)) {
      await store.upsertDatasetState({
        securityId: row.id,
        dataset: operation.dataset,
        variant: operation.variant,
        syncedAt: t1At,
      });
    }
    await store.upsertDatasetState({
      securityId: row.id,
      dataset: "SECURITY_PROFILE",
      variant: "",
      syncedAt: t1At,
    });
    const service = (now: string) =>
      new CanonicalStockDataService(
        store,
        provider,
        cache,
        new RedlockLoadCoordinator(redis, {
          lockDurationMs: 30_000,
          lockWaitMs: 30_000,
        }),
        {
          productHistoryYears: 30,
          now: () => new Date(now),
          fundamentalsFreshnessMs: 6 * 60 * 60 * 1_000,
          recentPriceFreshnessMs: 6 * 60 * 60 * 1_000,
        },
      );
    const allColumns = async () => {
      const rows = await prisma.$queryRawUnsafe<
        { date: string; row: string }[]
      >(
        `select date::text as date, row_to_json(d)::text as row from "DailyDerivedState" d where "securityId" = $1 order by date`,
        row.id,
      );
      return new Map(rows.map((entry) => [entry.date, entry.row]));
    };
    const fundamentalsText = async () => {
      const columns = FUNDAMENTAL_AUDIT_METRICS.map(
        (metric) => `"${metric.field}"::text as "${metric.field}"`,
      );
      const rows = await prisma.$queryRawUnsafe<
        ({ date: string } & Record<string, string | null>)[]
      >(
        `select date::text as date, ${columns.join(", ")} from "DailyDerivedState" where "securityId" = $1 order by date`,
        row.id,
      );
      return rows;
    };
    const dispose = async () => {
      await cache.evict(row.id);
      let cursor = "0";
      const keys: string[] = [];
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
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await prisma.security.deleteMany({ where: { id: row.id } });
      redis.disconnect();
      await prisma.$disconnect();
    };
    return {
      prisma,
      redis,
      store,
      cache,
      symbol,
      securityId: row.id,
      provider,
      service,
      allColumns,
      fundamentalsText,
      truth,
      dispose,
    };
  }

  /** Every stored Fundamental Metric against the oracle over the stored revisions, on every row. */
  async function expectOracleAgreement(
    fixture: Awaited<ReturnType<typeof provision>>,
  ): Promise<number> {
    const revisions = await fixture.store.getFinancialStatementRevisions({
      securityId: fixture.securityId,
    });
    const rows = await fixture.fundamentalsText();
    let compared = 0;
    for (const row of rows) {
      const outcomes = oracleFundamentalOutcomes(revisions, row.date);
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const outcome = outcomes[metric.id];
        const stored = row[metric.field];
        if (outcome.status === "UNAVAILABLE") {
          expect(
            stored,
            `${row.date} ${metric.id} (${outcome.reason})`,
          ).toBeNull();
        } else {
          expect(stored, `${row.date} ${metric.id}`).not.toBeNull();
          // Storage keeps eight decimals of a value bound through sixteen significant digits.
          const tolerance = 0.5e-8 + Math.abs(outcome.value) * 1e-15 + 1e-12;
          expect(
            Math.abs(Number(stored) - outcome.value),
            `${row.date} ${metric.id} ${stored} vs ${outcome.value}`,
          ).toBeLessThanOrEqual(tolerance);
        }
        compared += 1;
      }
    }
    return compared;
  }

  const CASES = [
    {
      name: "period end moved later, same filing date",
      fiscalDate: "2026-04-03",
      filingDate: "2026-05-10",
      placeholderQ1: false,
      availableFrom: T2,
      firstTouched: T2,
      boundary: "2026-05-11",
    },
    {
      name: "period end moved earlier, same filing date",
      fiscalDate: "2026-03-28",
      filingDate: "2026-05-10",
      placeholderQ1: false,
      availableFrom: T2,
      firstTouched: T2,
      boundary: "2026-05-11",
    },
    {
      name: "period end moved earlier with a real newer filing",
      fiscalDate: "2026-03-28",
      filingDate: "2026-07-20",
      placeholderQ1: false,
      availableFrom: "2026-07-21",
      firstTouched: "2026-07-21",
      boundary: "2026-05-11",
    },
    // The placeholder original is public at its deadline: 2026-03-31 + 45 = Friday 05-15, + 1 day.
    {
      name: "a period-end placeholder moved with the period end",
      fiscalDate: "2026-04-03",
      filingDate: "2026-04-03",
      placeholderQ1: true,
      availableFrom: T2,
      firstTouched: T2,
      boundary: "2026-05-18",
    },
  ] as const;

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "%s: nothing before its first session moves, in any column; everything agrees with the oracle",
    async (_name, testCase) => {
      const fixture = await provision({
        placeholderQ1: testCase.placeholderQ1,
      });
      try {
        const range = { from: FIRST_SESSION, to: T2 };
        await fixture
          .service(`${T1}T12:00:00.000Z`)
          .getDailyDerivedState(fixture.symbol, {
            from: FIRST_SESSION,
            to: T1,
          });
        expect(fixture.provider.calls).toEqual([]);
        const before = await fixture.allColumns();
        const beforeCompared = await expectOracleAgreement(fixture);
        expect(beforeCompared).toBeGreaterThan(10_000);

        const original = (
          await fixture.store.getFinancialStatementRevisions({
            securityId: fixture.securityId,
            statementType: "INCOME",
            cadence: "QUARTERLY",
          })
        ).find(
          (revision) =>
            revision.fiscalYear === 2026 && revision.period === "Q1",
        )!;
        fixture.provider.statements.set("INCOME:QUARTERLY", [
          {
            securityId: fixture.securityId,
            statementType: "INCOME",
            fiscalDate: testCase.fiscalDate,
            fiscalYear: 2026,
            period: "Q1",
            reportedCurrency: "USD",
            filingDate: testCase.filingDate,
            values: {
              ...(original.values as Record<string, number>),
              grossProfit: 900,
              operatingIncome: 400,
              netIncome: 330,
              epsDiluted: 4.5,
            },
          },
        ]);
        const writes = vi.spyOn(fixture.store, "saveDailyDerivedState");
        const statementReads = vi.spyOn(
          fixture.store,
          "getFinancialStatementRevisions",
        );
        await fixture
          .service(`${T2}T20:30:00.000Z`)
          .getDailyDerivedState(fixture.symbol, range);
        const writeInputs = writes.mock.calls.map((call) => call[0]);
        // Reads the product made during the refresh, before this test reads anything itself.
        const readInputs = statementReads.mock.calls.map((call) => call[0]);
        writes.mockRestore();
        statementReads.mockRestore();

        // The loader dated the revision itself, exactly as the table above says.
        const moved = (
          await fixture.store.getFinancialStatementRevisions({
            securityId: fixture.securityId,
          })
        ).find(
          (revision) =>
            revision.fiscalDate === testCase.fiscalDate &&
            revision.statementType === "INCOME",
        );
        expect(moved?.availableFromDate).toBe(testCase.availableFrom);

        // No row that existed before, and precedes the revision's first session, changed in any column.
        const after = await fixture.allColumns();
        let untouched = 0;
        let changedFromFirstTouched = 0;
        for (const [date, text] of before) {
          if (date < testCase.firstTouched) {
            expect(after.get(date), date).toBe(text);
            untouched += 1;
          } else if (after.get(date) !== text) {
            changedFromFirstTouched += 1;
          }
        }
        expect(untouched).toBeGreaterThan(1_000);
        // On the first session the revision may touch, both statement-derived families moved.
        const onFirst = JSON.parse(after.get(testCase.firstTouched)!) as Record<
          string,
          unknown
        >;
        const eve = [...after.keys()]
          .filter((date) => date < testCase.firstTouched)
          .at(-1)!;
        const onEve = JSON.parse(after.get(eve)!) as Record<string, unknown>;
        expect(onFirst.grossMarginTtm).not.toBe(onEve.grossMarginTtm);
        expect(onFirst.roicTtm).not.toBe(onEve.roicTtm);
        expect(onFirst.graham).not.toBe(onEve.graham);
        if (testCase.firstTouched === T2) {
          // Only T2 itself carries the revision; it is a row that did not exist before, so every
          // row that did exist was compared above and kept its text.
          expect(before.has(T2)).toBe(false);
          expect(untouched).toBe(before.size);
        } else {
          expect(changedFromFirstTouched).toBeGreaterThan(0);
        }
        // Every row, old and new, carries the oracle's reading of the stored revisions.
        expect(await expectOracleAgreement(fixture)).toBe(after.size * 15);

        // One bounded rebuild from the fiscal year the refresh touched — never the whole history.
        expect(writeInputs).toHaveLength(1);
        const refreshWrite = writeInputs[0]!;
        expect(refreshWrite.rows[0]?.date).toBe(testCase.boundary);
        expect(refreshWrite.rows.at(-1)?.date).toBe(T2);
        expect(refreshWrite.rows.length).toBeLessThan(after.size / 5);
        // The retained revisions are read once per rebuild, for both families together; the other
        // reads are the refresh's bounded per-dataset reads of the fiscal years it touched.
        const sharedReads = readInputs.filter(
          (input) => input.statementType === undefined,
        );
        expect(sharedReads).toHaveLength(1);
        expect(readInputs.length).toBeLessThanOrEqual(1 + 6 + 6);

        // Redis: every affected year's chunk is the complete PostgreSQL year, January included.
        const persisted2026 = await fixture.store.getDailyDerivedState(
          fixture.securityId,
          { from: "2026-01-01", to: T2 },
        );
        expect(persisted2026[0]?.date).toBe(sessions("2026-01-01", T2)[0]);
        await expect(
          fixture.cache.readDailyDerivedState(fixture.securityId, {
            from: "2026-01-01",
            to: T2,
          }),
        ).resolves.toEqual(persisted2026);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );

  it("reads statements a fixed number of times whatever the length of the history (no per-day read)", async () => {
    const counts: Record<string, { statementReads: number; rows: number }> = {};
    for (const firstSession of ["2026-03-02", FIRST_SESSION]) {
      const fixture = await provision({ placeholderQ1: false, firstSession });
      try {
        const reads = vi.spyOn(fixture.store, "getFinancialStatementRevisions");
        const statementQueries = vi.spyOn(
          fixture.store,
          "getFinancialStatements",
        );
        await fixture
          .service(`${T1}T12:00:00.000Z`)
          .getDailyDerivedState(fixture.symbol, { from: firstSession, to: T1 });
        counts[firstSession] = {
          statementReads:
            reads.mock.calls.length + statementQueries.mock.calls.length,
          rows: (await fixture.allColumns()).size,
        };
        reads.mockRestore();
        statementQueries.mockRestore();
      } finally {
        await fixture.dispose();
      }
    }
    const short = counts["2026-03-02"]!;
    const long = counts[FIRST_SESSION]!;
    expect(long.rows).toBeGreaterThan(short.rows * 5);
    expect(long.statementReads).toBe(short.statementReads);
    expect(long.statementReads).toBeLessThanOrEqual(8);
  }, 240_000);
});
