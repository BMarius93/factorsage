import { describe, expect, it } from "vitest";
import {
  backtestSelectableBenchmarks,
  BENCHMARK_CATALOG,
  DEFAULT_BENCHMARK_CODE,
  EXECUTION_CALENDAR_REFERENCE_CODE,
  findBenchmarkCatalogEntry,
  MARKET_REFERENCE_SERIES,
} from "./benchmarks.js";
import {
  MARKET_OVERVIEW_ETF_GROUPS,
  MARKET_OVERVIEW_HISTORY_FLOOR,
  marketOverviewBenchmarkCodes,
  marketOverviewCatalogEntries,
  marketOverviewEtfs,
} from "./market-overview-etfs.js";

/**
 * The approved market-overview universe (`docs/decisions/etf-market-data-v1.md`): exactly twenty
 * ETFs in three groups, every one stored as an ordinary benchmark series that no user can select.
 */
describe("market-overview ETF catalog", () => {
  it("holds exactly the twenty approved ETFs, in the approved groups and order", () => {
    expect(
      MARKET_OVERVIEW_ETF_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        tickers: group.etfs.map((etf) => etf.ticker),
      })),
    ).toEqual([
      {
        id: "BENCHMARKS",
        label: "Benchmarks",
        tickers: ["SPY", "QQQ", "DIA", "IWM", "RSP"],
      },
      {
        id: "US_SECTORS",
        label: "Sector Performance",
        tickers: [
          "XLK",
          "XLF",
          "XLE",
          "XLV",
          "XLI",
          "XLY",
          "XLP",
          "XLU",
          "XLB",
          "XLRE",
          "XLC",
        ],
      },
      {
        id: "MACRO_ALTERNATIVES",
        label: "Macro & Alternatives",
        tickers: ["GLD", "USO", "TLT", "HYG"],
      },
    ]);
    expect(marketOverviewEtfs()).toHaveLength(20);
    // Explicitly out of scope for V1.
    for (const excluded of ["EFA", "EEM", "VXX", "UVXY", "VIXY"]) {
      expect(marketOverviewEtfs().map((etf) => etf.ticker)).not.toContain(
        excluded,
      );
    }
  });

  it("reads SPY through the existing SP500 series instead of storing it twice", () => {
    const spy = marketOverviewEtfs().find((etf) => etf.ticker === "SPY");
    expect(spy?.benchmarkCode).toBe(DEFAULT_BENCHMARK_CODE);
    expect(spy?.benchmarkCode).toBe(EXECUTION_CALENDAR_REFERENCE_CODE);
    // One SPY series in the whole catalog: a second would fetch and store SPY twice.
    expect(
      BENCHMARK_CATALOG.filter((entry) => entry.providerSymbol === "SPY"),
    ).toHaveLength(1);
  });

  it("stores every ETF under its own ticker as an ETF proxy, active and never selectable", () => {
    const entries = marketOverviewCatalogEntries();
    expect(entries).toHaveLength(20);
    expect(new Set(marketOverviewBenchmarkCodes()).size).toBe(20);

    marketOverviewEtfs().forEach((etf, index) => {
      const entry = entries[index];
      expect(entry?.providerSymbol).toBe(etf.ticker);
      expect(entry?.seriesType).toBe("ETF_PROXY");
      expect(entry?.sourceKind).toBe("FMP_SYMBOL");
      expect(entry?.currency).toBe("USD");
      expect(entry?.isActive).toBe(true);
      if (etf.ticker !== "SPY") {
        expect(entry?.isBacktestSelectable).toBe(false);
      }
    });
  });

  it("leaves the backtest catalog, the execution calendar and the market references unchanged", () => {
    expect(backtestSelectableBenchmarks().map((entry) => entry.code)).toEqual([
      "SP500",
    ]);
    expect(findBenchmarkCatalogEntry("SP500")?.providerSymbol).toBe("SPY");
    expect(MARKET_REFERENCE_SERIES.map((reference) => reference.code)).toEqual([
      "SP500_INDEX",
      "DJIA_INDEX",
      "VIX_INDEX",
    ]);
  });

  it("identifies USO as an oil-futures fund, never as the price of oil", () => {
    const uso = marketOverviewEtfs().find((etf) => etf.ticker === "USO");
    expect(uso?.note).toMatch(/futures/i);
    expect(uso?.note).toMatch(/not the spot price/i);
    expect(findBenchmarkCatalogEntry("ETF_USO")?.description).toMatch(
      /futures/i,
    );
  });

  it("never names an index level as an ETF", () => {
    for (const entry of marketOverviewCatalogEntries()) {
      expect(entry.providerSymbol.startsWith("^")).toBe(false);
      expect(entry.seriesType).not.toBe("INDEX");
    }
  });

  it("asks for history from a floor that precedes every listing month", () => {
    for (const etf of marketOverviewEtfs()) {
      expect(etf.listedIn).toMatch(/^\d{4}-\d{2}$/);
      expect(`${etf.listedIn}-01` >= MARKET_OVERVIEW_HISTORY_FLOOR).toBe(true);
    }
  });
});
