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
