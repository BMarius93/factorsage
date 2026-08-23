import { describe, expect, it } from "vitest";
import {
  mapFmpDailyPrices,
  mapFmpProfile,
  normalizeFmpPercentage,
} from "./mapping.js";

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
});
