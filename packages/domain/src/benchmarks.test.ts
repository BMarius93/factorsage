import { describe, expect, it } from "vitest";
import {
  backtestSelectableBenchmarks,
  BENCHMARK_CATALOG,
  benchmarkDisplayName,
  DEFAULT_BENCHMARK_CODE,
  EXECUTION_CALENDAR_REFERENCE_CODE,
  findBenchmarkCatalogEntry,
  MARKET_REFERENCE_SERIES,
} from "./benchmarks.js";

/**
 * The catalog is the one source of benchmark metadata, so these are the product's own rules rather
 * than a restatement of the array: what `SP500` is, what a market reference is, and the two
 * properties that keep those apart.
 */
describe("benchmark catalog", () => {
  it("keeps SP500 the SPY-backed, user-selectable backtest benchmark", () => {
    const sp500 = findBenchmarkCatalogEntry("SP500");

    // The backtest benchmark is an investable ETF proxy: a funded comparison portfolio has to be
    // able to buy what it is compared against, and completed runs pinned this meaning.
    expect(sp500).toMatchObject({
      code: "SP500",
      name: "SPY",
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: "SPY",
      currency: "USD",
      methodologyVersion: 1,
      isActive: true,
      isBacktestSelectable: true,
    });
  });

  it("shows a run's frozen benchmark under the catalog's name only while the series is unchanged (BT-1)", () => {
    // A run submitted when SP500 was called "S&P 500" compared against the same SPY series.
    expect(
      benchmarkDisplayName({
        code: "SP500",
        name: "S&P 500",
        sourceKind: "FMP_SYMBOL",
        methodologyVersion: 1,
      }),
    ).toBe("SPY");
    // A redefined series, or one the catalog no longer has, keeps what the run froze.
    expect(
      benchmarkDisplayName({
        code: "SP500",
        name: "S&P 500",
        sourceKind: "FMP_SYMBOL",
        methodologyVersion: 2,
      }),
    ).toBe("S&P 500");
    expect(
      benchmarkDisplayName({
        code: "RETIRED",
        name: "Alternate Live Benchmark",
        sourceKind: "FMP_SYMBOL",
        methodologyVersion: 1,
      }),
    ).toBe("Alternate Live Benchmark");
  });

  it("still defaults submissions and the execution calendar to SP500", () => {
    expect(DEFAULT_BENCHMARK_CODE).toBe("SP500");
    expect(EXECUTION_CALENDAR_REFERENCE_CODE).toBe("SP500");
    expect(findBenchmarkCatalogEntry(EXECUTION_CALENDAR_REFERENCE_CODE)).toBe(
      findBenchmarkCatalogEntry("SP500"),
    );
  });

  it("registers the three market references as active but not selectable", () => {
    for (const [code, providerSymbol] of [
      ["SP500_INDEX", "^GSPC"],
      ["DJIA_INDEX", "^DJI"],
      ["VIX_INDEX", "^VIX"],
    ] as const) {
      expect(findBenchmarkCatalogEntry(code)).toMatchObject({
        code,
        providerSymbol,
        seriesType: "INDEX",
        // Active: the system loads and stores them exactly like any other benchmark.
        isActive: true,
        // Not selectable: nothing buys an index, and `^VIX` is not even a price.
        isBacktestSelectable: false,
      });
    }
  });

  it("offers only S&P 500 for a backtest", () => {
    expect(backtestSelectableBenchmarks().map((entry) => entry.code)).toEqual([
      "SP500",
    ]);
  });

  it("never substitutes an ETF for an index, or an index for the benchmark", () => {
    const bySymbol = new Map(
      BENCHMARK_CATALOG.map((entry) => [entry.code, entry.providerSymbol]),
    );
    // The two S&P series are different series, not one corrected into the other.
    expect(bySymbol.get("SP500")).toBe("SPY");
    expect(bySymbol.get("SP500_INDEX")).toBe("^GSPC");
    // `VXX` is a volatility *futures* ETN and tracks something else entirely.
    expect([...bySymbol.values()]).not.toContain("VXX");
    // The DJIA market reference is the index level. `DIA` is in the catalog since the market
    // overview arrived, but only as its own ETF series, never as the index reference.
    expect(bySymbol.get("DJIA_INDEX")).toBe("^DJI");
    expect(findBenchmarkCatalogEntry("ETF_DIA")).toMatchObject({
      providerSymbol: "DIA",
      seriesType: "ETF_PROXY",
      isBacktestSelectable: false,
    });
  });

  it("gives every entry a unique code and a distinct provider symbol", () => {
    const codes = BENCHMARK_CATALOG.map((entry) => entry.code);
    const symbols = BENCHMARK_CATALOG.map((entry) => entry.providerSymbol);
    expect(new Set(codes).size).toBe(codes.length);
    // Two codes sharing a provider symbol would hydrate the same provider data into two series.
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("names the market references the product reports, in order, with their card labels", () => {
    expect(MARKET_REFERENCE_SERIES).toEqual([
      { code: "SP500_INDEX", label: "S&P 500" },
      { code: "DJIA_INDEX", label: "DJIA" },
      { code: "VIX_INDEX", label: "VIX" },
    ]);
    // Deliberately absent: Nasdaq, a Fear & Greed score, Bitcoin, breadth, a valuation pulse.
    expect(MARKET_REFERENCE_SERIES).toHaveLength(3);
  });

  it("every market reference resolves to a catalog entry that is not selectable", () => {
    for (const reference of MARKET_REFERENCE_SERIES) {
      const entry = findBenchmarkCatalogEntry(reference.code);
      expect(entry).toBeDefined();
      expect(entry?.isActive).toBe(true);
      expect(entry?.isBacktestSelectable).toBe(false);
      expect(entry?.seriesType).toBe("INDEX");
    }
  });
});
