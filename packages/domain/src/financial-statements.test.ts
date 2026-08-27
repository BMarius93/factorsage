import { describe, expect, it } from "vitest";
import type { FinancialStatement } from "./financial-statements.js";
import {
  selectFinancialStatements,
  type FinancialStatementQuery,
} from "./financial-statements.js";

function statement(
  overrides: Partial<FinancialStatement> & Pick<FinancialStatement, "contentHash">,
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