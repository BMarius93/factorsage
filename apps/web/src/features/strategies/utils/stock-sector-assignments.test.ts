import { describe, expect, it } from "vitest";
import { listOf, summarizeStockSectors } from "./stock-sector-assignments";

const tech = (symbol: string) => ({
  symbol,
  sector: "Technology",
  code: "ETF_XLK",
  ticker: "XLK",
});

describe("summarizeStockSectors", () => {
  it("groups the stocks by the fund they read, funds in ticker order", () => {
    expect(
      summarizeStockSectors([
        tech("MSFT"),
        { symbol: "XOM", sector: "Energy", code: "ETF_XLE", ticker: "XLE" },
        tech("AAPL"),
      ]),
    ).toEqual({
      resolved: "XOM reads XLE, MSFT and AAPL read XLK",
      unresolved: null,
      unresolvedCount: 0,
    });
  });

  it("names each stock without a fund and why", () => {
    expect(
      summarizeStockSectors([
        { symbol: "NOSEC", sector: null, code: null, ticker: null },
        { symbol: "ODD", sector: "Shell Companies", code: null, ticker: null },
      ]),
    ).toEqual({
      resolved: null,
      unresolved:
        "NOSEC (no FMP sector) and ODD (“Shell Companies” is not one of the eleven sectors)",
      unresolvedCount: 2,
    });
  });

  it("names six stocks per group and counts the rest", () => {
    const symbols = ["A", "B", "C", "D", "E", "F", "G", "H"];
    expect(summarizeStockSectors(symbols.map(tech)).resolved).toBe(
      "A, B, C, D, E, F and 2 more read XLK",
    );
  });

  it("joins lists as prose", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["A"])).toBe("A");
    expect(listOf(["A", "B"])).toBe("A and B");
    expect(listOf(["A", "B", "C"])).toBe("A, B and C");
  });
});
