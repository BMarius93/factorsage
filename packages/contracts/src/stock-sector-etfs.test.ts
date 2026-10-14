import { describe, expect, it } from "vitest";
import {
  FMP_STOCK_SECTORS,
  resolveStockSectorEtf,
  STOCK_SECTOR_ETF_CODES,
  stockSectorAssignment,
  stockSectorEtfTicker,
} from "./stock-sector-etfs.js";
import {
  findStrategyEtfSource,
  STRATEGY_ETF_SOURCE_GROUPS,
} from "./strategy-etf-sources.js";

/**
 * The mapping table the product decision states, written out independently of the module — the
 * test fails if either side drifts.
 */
const EXPECTED: readonly (readonly [string, string, string])[] = [
  ["Technology", "ETF_XLK", "XLK"],
  ["Financial Services", "ETF_XLF", "XLF"],
  ["Energy", "ETF_XLE", "XLE"],
  ["Healthcare", "ETF_XLV", "XLV"],
  ["Industrials", "ETF_XLI", "XLI"],
  ["Consumer Cyclical", "ETF_XLY", "XLY"],
  ["Consumer Defensive", "ETF_XLP", "XLP"],
  ["Utilities", "ETF_XLU", "XLU"],
  ["Basic Materials", "ETF_XLB", "XLB"],
  ["Real Estate", "ETF_XLRE", "XLRE"],
  ["Communication Services", "ETF_XLC", "XLC"],
];

describe("the FMP sector → sector ETF mapping", () => {
  it("maps each of FMP's eleven sectors to exactly the decision's Select Sector SPDR fund", () => {
    expect(FMP_STOCK_SECTORS).toEqual(EXPECTED.map(([sector]) => sector));
    for (const [sector, code, ticker] of EXPECTED) {
      expect(resolveStockSectorEtf(sector)).toEqual({
        status: "RESOLVED",
        sector,
        code,
      });
      expect(stockSectorEtfTicker(code as never)).toBe(ticker);
      expect(findStrategyEtfSource(code)?.ticker).toBe(ticker);
    }
  });

  it("is a bijection onto the catalog's eleven sector funds and nothing else", () => {
    const codes = Object.values(STOCK_SECTOR_ETF_CODES);
    expect(new Set(codes).size).toBe(11);
    const sectorGroup = STRATEGY_ETF_SOURCE_GROUPS.find(
      (group) => group.id === "US_SECTORS",
    );
    expect([...codes].sort()).toEqual(
      sectorGroup?.etfs.map((etf) => etf.code).sort(),
    );
    // Never a broad-market, macro or alternative fund — SPY is not a sector's fallback.
    for (const forbidden of ["SP500", "ETF_QQQ", "ETF_DIA", "ETF_IWM", "ETF_RSP", "ETF_GLD", "ETF_USO", "ETF_TLT", "ETF_HYG"]) {
      expect(codes).not.toContain(forbidden);
    }
  });

  it("calls a missing sector missing: null, undefined, empty and blank", () => {
    for (const missing of [null, undefined, "", "   ", "\t\n"]) {
      expect(resolveStockSectorEtf(missing)).toEqual({ status: "MISSING" });
    }
  });

  it("tolerates only case and whitespace, the one difference a stored string can carry", () => {
    expect(resolveStockSectorEtf("technology")).toMatchObject({ code: "ETF_XLK" });
    expect(resolveStockSectorEtf("  TECHNOLOGY ")).toMatchObject({ code: "ETF_XLK" });
    expect(resolveStockSectorEtf("Financial  Services")).toMatchObject({
      status: "RESOLVED",
      sector: "Financial Services",
      code: "ETF_XLF",
    });
    expect(resolveStockSectorEtf("consumer\tcyclical")).toMatchObject({
      code: "ETF_XLY",
    });
  });

  it("refuses every alias and near-miss as unsupported — no guessing, no substitute fund", () => {
    for (const alias of [
      // GICS names and common spellings that never appear in the stored data.
      "Information Technology",
      "Financials",
      "Financial",
      "Health Care",
      "Consumer Discretionary",
      "Consumer Staples",
      "Materials",
      "Communication",
      "Telecommunication Services",
      "Real-Estate",
      "Tech",
      // Values FMP or a stale row could plausibly hold that are not one of the eleven.
      "Conglomerates",
      "Shell Companies",
      "N/A",
      "XLK",
      "ETF_XLK",
    ]) {
      expect(resolveStockSectorEtf(alias)).toEqual({
        status: "UNSUPPORTED",
        sector: alias,
      });
    }
    expect(resolveStockSectorEtf("  Health Care ")).toEqual({
      status: "UNSUPPORTED",
      sector: "Health Care",
    });
  });

  it("states each stock's assignment for the surfaces that show it", () => {
    expect(stockSectorAssignment("AAPL", "Technology")).toEqual({
      symbol: "AAPL",
      sector: "Technology",
      code: "ETF_XLK",
      ticker: "XLK",
    });
    expect(stockSectorAssignment("JPM", " Financial Services ")).toEqual({
      symbol: "JPM",
      sector: "Financial Services",
      code: "ETF_XLF",
      ticker: "XLF",
    });
    expect(stockSectorAssignment("NONE", null)).toEqual({
      symbol: "NONE",
      sector: null,
      code: null,
      ticker: null,
    });
    expect(stockSectorAssignment("BLANK", "  ")).toEqual({
      symbol: "BLANK",
      sector: null,
      code: null,
      ticker: null,
    });
    expect(stockSectorAssignment("ODD", "Conglomerates")).toEqual({
      symbol: "ODD",
      sector: "Conglomerates",
      code: null,
      ticker: null,
    });
  });
});
