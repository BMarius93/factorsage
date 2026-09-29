import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { FinancialStatementDraft } from "@intrinsic/domain";
import {
  PrismaStockDataStore,
  materializeDailyFundamentals,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadRootEnv();
useTestDatabase();

/**
 * When each kind of statement revision becomes visible (audit section 7), through the real
 * `PrismaStockDataStore` and the production materializer's session mapping.
 *
 * Every expected date is stated by hand from `docs/decisions/fundamentals-loader.md`: a real filing is
 * public the day after it; a period-end placeholder at its statutory deadline (45 days for Q1-Q3, 90
 * for Q4 and FY, a weekend deadline moved to Monday), plus a day; a revision of a stored quarter that
 * brings no newer public filing is dated from the sync that first observed it. The first session a
 * revision can change is the first trading day on or after that date — never the weekend, never the
 * holiday, never earlier.
 */
describe("statement availability through the real loader, mapped onto trading sessions", () => {
  let prisma: PrismaClient;
  let store: PrismaStockDataStore;
  const created: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
    store = new PrismaStockDataStore(prisma);
  });

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function security(): Promise<string> {
    const symbol = `PA${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: "PIT Availability Audit",
        exchangeCode: "NYSE",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    created.push(row.id);
    return row.id;
  }

  function draft(
    securityId: string,
    fiscalYear: number,
    period: "Q1" | "Q2" | "Q3" | "Q4",
    fiscalDate: string,
    filingDate: string,
    revenue: number,
  ): FinancialStatementDraft {
    return {
      securityId,
      statementType: "INCOME",
      fiscalDate,
      fiscalYear,
      period,
      reportedCurrency: "USD",
      filingDate,
      values: { revenue },
    };
  }

  async function availability(
    securityId: string,
  ): Promise<Record<string, string>> {
    const revisions = await store.getFinancialStatementRevisions({
      securityId,
    });
    return Object.fromEntries(
      revisions.map((revision) => [
        `${revision.fiscalDate}|${revision.filingDate}|${(revision.values as { revenue: number }).revenue}`,
        revision.availableFromDate,
      ]),
    );
  }

  /** NYSE sessions of 2024-2025 around the dates below (weekends and the named holidays removed). */
  function sessions(from: string, to: string): string[] {
    const holidays = new Set([
      "2024-07-04",
      "2024-12-25",
      "2025-01-01",
      "2025-01-09",
      "2025-04-18",
      "2025-05-26",
      "2025-07-04",
    ]);
    const out: string[] = [];
    for (
      let day = new Date(`${from}T00:00:00.000Z`);
      day <= new Date(`${to}T00:00:00.000Z`);
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const date = day.toISOString().slice(0, 10);
      if (
        day.getUTCDay() !== 0 &&
        day.getUTCDay() !== 6 &&
        !holidays.has(date)
      ) {
        out.push(date);
      }
    }
    return out;
  }

  it("dates real filings the day after they were filed, whatever weekday that is", async () => {
    const id = await security();
    await store.saveFinancialStatements({
      securityId: id,
      statements: [
        draft(id, 2024, "Q1", "2024-03-31", "2024-05-08", 1), // Wednesday -> Thursday
        draft(id, 2024, "Q2", "2024-06-30", "2024-08-09", 2), // Friday -> Saturday
        draft(id, 2024, "Q3", "2024-09-30", "2024-11-09", 3), // Saturday -> Sunday
        draft(id, 2024, "Q4", "2024-12-31", "2025-07-03", 4), // Thursday -> Friday 07-04, a holiday
      ],
      syncedAt: "2025-09-01T12:00:00.000Z",
    });
    expect(await availability(id)).toEqual({
      "2024-03-31|2024-05-08|1": "2024-05-09",
      "2024-06-30|2024-08-09|2": "2024-08-10",
      "2024-09-30|2024-11-09|3": "2024-11-10",
      "2024-12-31|2025-07-03|4": "2025-07-04",
    });
  });

  it("dates a period-end placeholder from its statutory deadline, a weekend deadline moved to Monday", async () => {
    const id = await security();
    await store.saveFinancialStatements({
      securityId: id,
      statements: [
        // 2025-03-31 + 45 days = Thursday 2025-05-15 -> public Friday 05-16.
        draft(id, 2025, "Q1", "2025-03-31", "2025-03-31", 1),
        // 2024-12-31 + 90 days = Monday 2025-03-31 -> public Tuesday 04-01.
        draft(id, 2024, "Q4", "2024-12-31", "2024-12-31", 2),
        // 2025-06-30 + 45 days = Thursday 2025-08-14 -> public Friday 08-15.
        draft(id, 2025, "Q2", "2025-06-30", "2025-06-30", 3),
        // 2024-09-28 + 45 days = Tuesday 2024-11-12 -> Wednesday 11-13. A 52/53-week period end.
        draft(id, 2024, "Q3", "2024-09-28", "2024-09-28", 4),
        // 2024-06-26 + 45 days = Saturday 2024-08-10 -> moved to Monday 08-12 -> public Tuesday 08-13.
        draft(id, 2024, "Q2", "2024-06-26", "2024-06-26", 5),
      ],
      syncedAt: "2025-09-01T12:00:00.000Z",
    });
    expect(await availability(id)).toEqual({
      "2025-03-31|2025-03-31|1": "2025-05-16",
      "2024-12-31|2024-12-31|2": "2025-04-01",
      "2025-06-30|2025-06-30|3": "2025-08-15",
      "2024-09-28|2024-09-28|4": "2024-11-13",
      "2024-06-26|2024-06-26|5": "2024-08-13",
    });
  });

  it("dates revisions of a stored quarter: a newer real filing from its filing, anything else from its observation", async () => {
    const id = await security();
    await store.saveFinancialStatements({
      securityId: id,
      statements: [draft(id, 2025, "Q1", "2025-03-31", "2025-05-08", 100)],
      syncedAt: "2025-05-09T20:00:00.000Z",
    });
    await store.saveFinancialStatements({
      securityId: id,
      statements: [
        // Same identity, same filing date, new content: first observed 2025-06-10.
        draft(id, 2025, "Q1", "2025-03-31", "2025-05-08", 110),
      ],
      syncedAt: "2025-06-10T15:00:00.000Z",
    });
    await store.saveFinancialStatements({
      securityId: id,
      statements: [
        // A real amendment filed 2025-06-20, observed a month later: public from its own filing.
        draft(id, 2025, "Q1", "2025-03-31", "2025-06-20", 120),
        // The period end moved, same filing date as the original: no newer public filing.
        draft(id, 2025, "Q1", "2025-04-02", "2025-05-08", 130),
      ],
      syncedAt: "2025-07-22T15:00:00.000Z",
    });
    expect(await availability(id)).toEqual({
      "2025-03-31|2025-05-08|100": "2025-05-09",
      "2025-03-31|2025-05-08|110": "2025-06-10",
      "2025-03-31|2025-06-20|120": "2025-06-21",
      "2025-04-02|2025-05-08|130": "2025-07-22",
    });
  });

  it("maps each availability onto the first session on or after it, and two revisions of one weekend onto one Monday", async () => {
    const id = await security();
    const quarter = (
      fiscalYear: number,
      period: "Q1" | "Q2" | "Q3" | "Q4",
      fiscalDate: string,
      filingDate: string,
      grossProfit: number,
    ): FinancialStatementDraft => ({
      securityId: id,
      statementType: "INCOME",
      fiscalDate,
      fiscalYear,
      period,
      reportedCurrency: "USD",
      filingDate,
      values: { revenue: 100, grossProfit },
    });
    await store.saveFinancialStatements({
      securityId: id,
      statements: [
        quarter(2024, "Q2", "2024-06-30", "2024-08-08", 40),
        quarter(2024, "Q3", "2024-09-30", "2024-11-07", 40),
        quarter(2024, "Q4", "2024-12-31", "2025-02-06", 40),
        quarter(2025, "Q1", "2025-03-31", "2025-05-08", 40),
      ],
      syncedAt: "2025-05-09T20:00:00.000Z",
    });
    // FY2025 Q1 refiled on Friday 2025-06-13 (public Saturday) and again on Saturday 06-14 (public
    // Sunday). Gross Margin TTM: 160 / 400 = 40%, then (120 + 60) / 400 = 45%, then (120 + 80) / 400.
    await store.saveFinancialStatements({
      securityId: id,
      statements: [quarter(2025, "Q1", "2025-03-31", "2025-06-13", 60)],
      syncedAt: "2025-06-16T12:00:00.000Z",
    });
    await store.saveFinancialStatements({
      securityId: id,
      statements: [quarter(2025, "Q1", "2025-03-31", "2025-06-14", 80)],
      syncedAt: "2025-06-16T13:00:00.000Z",
    });
    const revisions = await store.getFinancialStatementRevisions({
      securityId: id,
    });
    expect(
      revisions.find((revision) => revision.filingDate === "2025-06-13")
        ?.availableFromDate,
    ).toBe("2025-06-14");
    expect(
      revisions.find((revision) => revision.filingDate === "2025-06-14")
        ?.availableFromDate,
    ).toBe("2025-06-15");
    const rows = materializeDailyFundamentals({
      securityId: id,
      tradingDates: sessions("2025-06-11", "2025-06-18"),
      statements: revisions,
    });
    // No weekend row; the 45% revision is never seen, because the 50% one is public before any
    // session could show it; Monday is the first session of both.
    expect(rows.map((row) => [row.date, row.grossMarginTtm])).toEqual([
      ["2025-06-11", 40],
      ["2025-06-12", 40],
      ["2025-06-13", 40],
      ["2025-06-16", 50],
      ["2025-06-17", 50],
      ["2025-06-18", 50],
    ]);
    // A revision public on a holiday reaches the next session: 2025-07-03 filing, public 07-04.
    await store.saveFinancialStatements({
      securityId: id,
      statements: [quarter(2025, "Q1", "2025-03-31", "2025-07-03", 20)],
      syncedAt: "2025-07-07T12:00:00.000Z",
    });
    const later = materializeDailyFundamentals({
      securityId: id,
      tradingDates: sessions("2025-07-02", "2025-07-08"),
      statements: await store.getFinancialStatementRevisions({
        securityId: id,
      }),
    });
    expect(later.map((row) => [row.date, row.grossMarginTtm])).toEqual([
      ["2025-07-02", 50],
      ["2025-07-03", 50],
      ["2025-07-07", 35],
      ["2025-07-08", 35],
    ]);
  });
});
