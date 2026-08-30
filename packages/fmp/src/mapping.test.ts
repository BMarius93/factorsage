import { describe, expect, it } from "vitest";
import {
  mapFmpDailyPrices,
  mapFmpFinancialStatements,
  mapFmpProfile,
  normalizeFmpPercentage,
} from "./mapping.js";
import {
  BALANCE_SHEET_FIELDS,
  CASH_FLOW_FIELDS,
  INCOME_STATEMENT_FIELDS,
} from "@intrinsic/domain";

function financialRow(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL",
    date: "2020-03-31",
    reportedCurrency: "USD",
    filingDate: "2020-05-01",
    acceptedDate: "2020-05-01 16:05:00",
    fiscalYear: 2020,
    period: "Q1",
    ...overrides,
  };
}

describe("FMP mapping", () => {
  it("maps profile identity separately from provider quirks", () => {
    const mapped = mapFmpProfile({
      symbol: "aapl",
      companyName: "Apple Inc.",
      exchange: "NASDAQ",
      exchangeFullName: "Nasdaq Global Select",
      currency: "USD",
      cik: "0000320193",
      isin: "US0378331005",
      cusip: "037833100",
      country: "US",
      sector: "Technology",
      industry: "Consumer Electronics",
      ipoDate: "1980-12-12",
      isEtf: false,
      isFund: false,
      isAdr: false,
      isActivelyTrading: true,
      fullTimeEmployees: "164000",
      description: "Consumer electronics and services.",
    });

    expect(mapped.providerSymbol).toBe("AAPL");
    expect(mapped.security).toMatchObject({
      symbol: "AAPL",
      exchangeCode: "NASDAQ",
      type: "STOCK",
    });
    expect(mapped.profile.employees).toBe(164_000);
    expect(mapped.security).not.toHaveProperty("fullTimeEmployees");
  });

  it("omits nullable identifiers instead of fabricating values", () => {
    const mapped = mapFmpProfile({
      symbol: "TEST",
      companyName: "Test Corp",
      exchange: "NYSE",
      currency: "USD",
      cik: null,
      isin: "null",
      cusip: " ",
    });

    expect(mapped.security.cik).toBeUndefined();
    expect(mapped.security.isin).toBeUndefined();
    expect(mapped.security.cusip).toBeUndefined();
  });

  it("normalizes percentage units explicitly per endpoint family", () => {
    expect(normalizeFmpPercentage(12.5, "PERCENT_POINTS")).toBe(0.125);
    expect(normalizeFmpPercentage("0.125", "DECIMAL")).toBe(0.125);
  });

  it("maps split-adjusted EOD rows and sorts newest-first payloads ascending", () => {
    const mapped = mapFmpDailyPrices("security-1", [
      {
        date: "2020-08-31",
        open: 127.58,
        high: 131,
        low: 126,
        close: 129.04,
        volume: 225_702_700,
      },
      {
        date: "2020-08-28",
        open: 126.01,
        high: 126.44,
        low: 124.58,
        close: 124.81,
        volume: 187_630_000,
      },
    ]);

    expect(mapped.map((row) => row.date)).toEqual(["2020-08-28", "2020-08-31"]);
    expect(mapped[0]?.close).toBeCloseTo(124.81);
  });

  it("maps statement metadata and cadence explicitly", () => {
    const quarterly = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "INCOME",
      rows: [financialRow({ period: "q1" })],
    });
    const annual = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "BALANCE_SHEET",
      rows: [financialRow({ period: "fy", fiscalYear: 2019 })],
    });

    expect(quarterly[0]).toMatchObject({
      securityId: "security-1",
      statementType: "INCOME",
      fiscalDate: "2020-03-31",
      period: "Q1",
      reportedCurrency: "USD",
      filingDate: "2020-05-01",
      providerAcceptedDate: "2020-05-01 16:05:00",
    });
    expect(annual[0]?.period).toBe("FY");
  });

  it("maps every catalog field when numeric and preserves missing and zero values", () => {
    for (const [statementType, fields] of [
      ["INCOME", INCOME_STATEMENT_FIELDS],
      ["BALANCE_SHEET", BALANCE_SHEET_FIELDS],
      ["CASH_FLOW", CASH_FLOW_FIELDS],
    ] as const) {
      const payload = financialRow(
        Object.fromEntries(fields.map((field, index) => [field, index + 1])),
      );
      const mapped = mapFmpFinancialStatements({
        securityId: "security-1",
        statementType,
        rows: [payload],
      });
      const values = mapped[0]?.values as Record<string, number | undefined>;
      expect(Object.keys(mapped[0]?.values ?? {}).sort()).toEqual(
        [...fields].sort(),
      );
      for (const [index, field] of fields.entries()) {
        expect(values[field]).toBe(index + 1);
      }
    }

    const sparse = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "INCOME",
      rows: [financialRow({ revenue: 0, grossProfit: 42 })],
    });
    expect(sparse[0]?.values.revenue).toBe(0);
    expect(sparse[0]?.values.grossProfit).toBe(42);
    expect(sparse[0]?.values.costOfRevenue).toBeUndefined();
  });

  it("fails deterministically for invalid metadata or non-numeric values", () => {
    expect(() =>
      mapFmpFinancialStatements({
        securityId: "security-1",
        statementType: "INCOME",
        rows: [financialRow({ date: "bad-date" })],
      }),
    ).toThrow("Invalid FMP financial statement date");

    expect(() =>
      mapFmpFinancialStatements({
        securityId: "security-1",
        statementType: "INCOME",
        rows: [financialRow({ revenue: "abc" })],
      }),
    ).toThrow("Invalid FMP revenue");

    expect(() =>
      mapFmpFinancialStatements({
        securityId: "security-1",
        statementType: "INCOME",
        rows: [financialRow({ symbol: "" })],
      }),
    ).toThrow("Invalid FMP financial statement symbol");
  });
});

/**
 * Verified provider semantics for the fields future valuation code depends on.
 *
 * These were confirmed against current real FMP statement data. The mapper is a pass-through: it
 * must never normalize a sign, recalculate a derived field, or convert cadences. Financial
 * calculations interpret the provider convention explicitly, so it is pinned here.
 */
describe("FMP financial statement value semantics", () => {
  const cashFlowRow = financialRow({
    period: "FY",
    date: "2026-06-30",
    filingDate: "2026-07-30",
    operatingCashFlow: 147_761_000_000,
    // Signed outflow: already negative as reported.
    capitalExpenditure: -60_881_000_000,
    // Provider-supplied result of operatingCashFlow + capitalExpenditure.
    freeCashFlow: 86_880_000_000,
    commonDividendsPaid: -23_531_000_000,
    netDividendsPaid: -23_531_000_000,
    changeInWorkingCapital: 1_185_000_000,
    depreciationAndAmortization: 27_470_000_000,
  });

  function cashFlowValues(overrides: Record<string, unknown> = {}) {
    const mapped = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "CASH_FLOW",
      rows: [{ ...cashFlowRow, ...overrides }],
    });
    return mapped[0]?.values as Record<string, number | undefined>;
  }

  it("preserves signed cash outflows exactly as the provider reports them", () => {
    const values = cashFlowValues();

    // Capital expenditure and dividends paid are signed outflows, not positive magnitudes.
    expect(values.capitalExpenditure).toBe(-60_881_000_000);
    expect(values.commonDividendsPaid).toBe(-23_531_000_000);
    expect(values.netDividendsPaid).toBe(-23_531_000_000);
    expect(values.operatingCashFlow).toBe(147_761_000_000);
  });

  it("keeps changeInWorkingCapital signed in both directions", () => {
    // It is already the signed cash-flow contribution, so either sign is a valid provider value
    // and neither may be reinterpreted as a conventional positive delta-NWC.
    expect(cashFlowValues({ changeInWorkingCapital: 1_185_000_000 })
      .changeInWorkingCapital).toBe(1_185_000_000);
    expect(cashFlowValues({ changeInWorkingCapital: -2_400_000_000 })
      .changeInWorkingCapital).toBe(-2_400_000_000);
  });

  it("keeps interestExpense as the positive expense magnitude the provider reports", () => {
    const mapped = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "INCOME",
      rows: [financialRow({ interestExpense: 559_000_000, incomeTaxExpense: 4_713_000_000 })],
    });

    expect(mapped[0]?.values.interestExpense).toBe(559_000_000);
    expect(mapped[0]?.values.incomeTaxExpense).toBe(4_713_000_000);
  });

  it("passes freeCashFlow through instead of recalculating it", () => {
    // The provider identity holds on real data...
    const consistent = cashFlowValues();
    expect(consistent.freeCashFlow).toBe(
      (consistent.operatingCashFlow ?? 0) + (consistent.capitalExpenditure ?? 0),
    );

    // ...but the mapper never derives or corrects it: a deliberately inconsistent provider value
    // survives untouched, so freeCashFlow is provider data, not a calculated field.
    const inconsistent = cashFlowValues({ freeCashFlow: 1_234_000_000 });
    expect(inconsistent.freeCashFlow).toBe(1_234_000_000);
    expect(inconsistent.operatingCashFlow).toBe(147_761_000_000);
    expect(inconsistent.capitalExpenditure).toBe(-60_881_000_000);
  });

  it("preserves a reported zero instead of dropping it or substituting a sign", () => {
    const values = cashFlowValues({
      capitalExpenditure: 0,
      commonDividendsPaid: 0,
      changeInWorkingCapital: 0,
    });

    expect(values.capitalExpenditure).toBe(0);
    expect(values.commonDividendsPaid).toBe(0);
    expect(values.changeInWorkingCapital).toBe(0);
  });

  it("maps standalone quarters without converting cumulative or YTD values", () => {
    const quarters = [
      {
        period: "Q1",
        date: "2025-09-30",
        operatingCashFlow: 34_180_000_000,
        capitalExpenditure: -11_237_000_000,
        freeCashFlow: 22_943_000_000,
        changeInWorkingCapital: -2_400_000_000,
        commonDividendsPaid: -5_575_000_000,
      },
      {
        period: "Q2",
        date: "2025-12-31",
        operatingCashFlow: 33_774_000_000,
        capitalExpenditure: -15_800_000_000,
        freeCashFlow: 17_974_000_000,
        changeInWorkingCapital: 1_150_000_000,
        commonDividendsPaid: -5_576_000_000,
      },
      {
        period: "Q3",
        date: "2026-03-31",
        operatingCashFlow: 37_195_000_000,
        capitalExpenditure: -16_745_000_000,
        freeCashFlow: 20_450_000_000,
        changeInWorkingCapital: -830_000_000,
        commonDividendsPaid: -6_190_000_000,
      },
      {
        period: "Q4",
        date: "2026-06-30",
        operatingCashFlow: 42_612_000_000,
        capitalExpenditure: -17_099_000_000,
        freeCashFlow: 25_513_000_000,
        changeInWorkingCapital: 3_265_000_000,
        commonDividendsPaid: -6_190_000_000,
      },
    ];
    const mapped = mapFmpFinancialStatements({
      securityId: "security-1",
      statementType: "CASH_FLOW",
      rows: quarters.map((quarter) => financialRow(quarter)),
    });

    // One canonical row per provider row: no aggregation, no YTD-to-standalone conversion, and no
    // synthesized trailing period.
    expect(mapped).toHaveLength(4);
    expect(mapped.map((row) => row.period)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    for (const [index, quarter] of quarters.entries()) {
      expect(mapped[index]?.values.operatingCashFlow).toBe(
        quarter.operatingCashFlow,
      );
      expect(mapped[index]?.values.capitalExpenditure).toBe(
        quarter.capitalExpenditure,
      );
      expect(mapped[index]?.values.commonDividendsPaid).toBe(
        quarter.commonDividendsPaid,
      );
      expect(mapped[index]?.values.changeInWorkingCapital).toBe(
        quarter.changeInWorkingCapital,
      );
    }

    // Standalone quarters sum to the annual row; this is the provider's cadence semantics, and
    // the application relies on it rather than recomputing quarters from cumulative values.
    const annual = cashFlowValues();
    const sum = (field: "operatingCashFlow" | "capitalExpenditure" | "commonDividendsPaid" | "changeInWorkingCapital") =>
      quarters.reduce((total, quarter) => total + quarter[field], 0);
    expect(sum("operatingCashFlow")).toBe(annual.operatingCashFlow);
    expect(sum("capitalExpenditure")).toBe(annual.capitalExpenditure);
    expect(sum("commonDividendsPaid")).toBe(annual.commonDividendsPaid);
    expect(sum("changeInWorkingCapital")).toBe(annual.changeInWorkingCapital);
  });
});
