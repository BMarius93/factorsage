import { describe, expect, it } from "vitest";
import type { FinancialStatement } from "./financial-statements.js";
import {
  ANNUAL_REPORT_DEADLINE_DAYS,
  hasUnusableProviderFilingDate,
  QUARTERLY_REPORT_DEADLINE_DAYS,
  selectFinancialStatements,
  statementPublicAvailabilityDate,
  type FinancialStatementQuery,
} from "./financial-statements.js";

function statement(
  overrides: Partial<FinancialStatement> &
    Pick<FinancialStatement, "contentHash">,
): FinancialStatement {
  return {
    securityId: "security-1",
    statementType: "INCOME",
    fiscalDate: "2020-03-31",
    fiscalYear: 2020,
    period: "Q1",
    reportedCurrency: "USD",
    filingDate: "2020-04-20",
    availableFromDate: "2020-04-21",
    observedAt: "2020-04-20T15:00:00.000Z",
    values: {},
    ...overrides,
    contentHash: overrides.contentHash ?? "hash-a",
  };
}

describe("financial statement selection", () => {
  it("orders canonical reads ascending regardless of provider order", () => {
    const rows = selectFinancialStatements([
      statement({
        statementType: "CASH_FLOW",
        fiscalDate: "2020-06-30",
        period: "Q2",
        filingDate: "2020-08-01",
        availableFromDate: "2020-08-02",
        observedAt: "2020-08-01T10:00:00.000Z",
        contentHash: "hash-c",
      }),
      statement({
        statementType: "BALANCE_SHEET",
        fiscalDate: "2019-12-31",
        fiscalYear: 2019,
        period: "FY",
        filingDate: "2020-02-12",
        availableFromDate: "2020-02-13",
        observedAt: "2020-02-12T09:00:00.000Z",
        contentHash: "hash-b",
      }),
      statement({
        statementType: "INCOME",
        fiscalDate: "2020-03-31",
        period: "Q1",
        filingDate: "2020-05-01",
        availableFromDate: "2020-05-02",
        observedAt: "2020-05-01T11:00:00.000Z",
        contentHash: "hash-a",
      }),
    ]);

    expect(rows.map((row) => [row.fiscalDate, row.statementType, row.period])).toEqual([
      ["2019-12-31", "BALANCE_SHEET", "FY"],
      ["2020-03-31", "INCOME", "Q1"],
      ["2020-06-30", "CASH_FLOW", "Q2"],
    ]);
  });

  it("applies cadence and as-of revision selection deterministically", () => {
    const oldRevision = statement({
      availableFromDate: "2020-04-21",
      observedAt: "2020-04-20T15:00:00.000Z",
      contentHash: "hash-old",
    });
    const laterRevision = statement({
      availableFromDate: "2020-04-28",
      observedAt: "2020-04-27T15:00:00.000Z",
      contentHash: "hash-new",
    });

    const query: FinancialStatementQuery = {
      cadence: "QUARTERLY",
      asOf: "2020-04-26",
    };

    expect(selectFinancialStatements([laterRevision, oldRevision], query)).toEqual([
      oldRevision,
    ]);
    expect(
      selectFinancialStatements([laterRevision, oldRevision], {
        ...query,
        asOf: "2020-04-28",
      }),
    ).toEqual([laterRevision]);
    expect(
      selectFinancialStatements([laterRevision, oldRevision], {
        cadence: "ANNUAL",
      }),
    ).toEqual([]);
  });

  it("returns the latest persisted revision without asOf", () => {
    const older = statement({
      contentHash: "hash-older",
      availableFromDate: "2020-04-21",
      observedAt: "2020-04-20T15:00:00.000Z",
    });
    const newer = statement({
      contentHash: "hash-newer",
      availableFromDate: "2020-04-28",
      observedAt: "2020-04-27T15:00:00.000Z",
    });

    expect(selectFinancialStatements([older, newer])).toEqual([newer]);
  });
});
/**
 * Point-in-time availability (audit finding AUD-03).
 *
 * A statement may not reach a historical calculation before its figures could have been public.
 * The provider sometimes reports the fiscal period end where a filing date belongs, and deriving
 * availability from that made a quarter usable the day after it closed.
 */
describe("public availability of a statement", () => {
  it("uses the day after a real filing date", () => {
    expect(
      statementPublicAvailabilityDate({
        fiscalDate: "2026-03-28",
        filingDate: "2026-05-06",
        period: "Q2",
      }),
    ).toBe("2026-05-07");
  });

  it("refuses a filing date that is the period end, and falls back to the quarterly deadline", () => {
    // DIS Q2 2015 as the provider reports it: period end 2015-03-31, "filingDate" 2015-03-31,
    // "acceptedDate" 2015-03-30 19:00. The 10-Q deadline is 45 days: 2015-05-15, a Friday.
    const statement = {
      fiscalDate: "2015-03-31",
      filingDate: "2015-03-31",
      period: "Q2",
    } as const;
    expect(hasUnusableProviderFilingDate(statement)).toBe(true);
    expect(statementPublicAvailabilityDate(statement)).toBe("2015-05-16");
    expect(QUARTERLY_REPORT_DEADLINE_DAYS).toBe(45);
  });

  it("gives a fiscal year and its fourth quarter the annual deadline", () => {
    // DIS FY2018: period end 2018-09-30. 90 days is 2018-12-29, a Saturday, so the report is due
    // on Monday the 31st and the figures may be used from 2019-01-01.
    for (const period of ["FY", "Q4"] as const) {
      expect(
        statementPublicAvailabilityDate({
          fiscalDate: "2018-09-30",
          filingDate: "2018-09-30",
          period,
        }),
      ).toBe("2019-01-01");
    }
    expect(ANNUAL_REPORT_DEADLINE_DAYS).toBe(90);
  });

  it("never returns a date on or before the period end", () => {
    const periods = ["FY", "Q1", "Q2", "Q3", "Q4"] as const;
    for (let day = 0; day < 400; day += 1) {
      const fiscalDate = new Date(Date.UTC(2024, 0, 1) + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const period of periods) {
        const available = statementPublicAvailabilityDate({
          fiscalDate,
          filingDate: fiscalDate,
          period,
        });
        expect(available > fiscalDate).toBe(true);
        const deadline = period === "FY" || period === "Q4" ? 90 : 45;
        const due = new Date(
          Date.parse(`${fiscalDate}T00:00:00Z`) + deadline * 86_400_000,
        );
        // Never earlier than the statutory deadline, and never more than three days past it.
        expect(Date.parse(`${available}T00:00:00Z`)).toBeGreaterThan(
          due.valueOf(),
        );
        expect(Date.parse(`${available}T00:00:00Z`)).toBeLessThanOrEqual(
          due.valueOf() + 3 * 86_400_000,
        );
        // The date a filing could legally still arrive on is never treated as already public.
        expect(new Date(`${available}T00:00:00Z`).getUTCDay()).not.toBe(0);
      }
    }
  });

  it("keeps a statement invisible until its availability date and visible from it", () => {
    const filed = statement({
      contentHash: "pit",
      fiscalDate: "2015-03-31",
      filingDate: "2015-03-31",
      availableFromDate: statementPublicAvailabilityDate({
        fiscalDate: "2015-03-31",
        filingDate: "2015-03-31",
        period: "Q2",
      }),
      period: "Q2",
    });
    expect(
      selectFinancialStatements([filed], { asOf: "2015-05-15" }),
    ).toHaveLength(0);
    expect(
      selectFinancialStatements([filed], { asOf: "2015-04-01" }),
    ).toHaveLength(0);
    expect(
      selectFinancialStatements([filed], { asOf: "2015-05-16" }),
    ).toHaveLength(1);
  });
});
