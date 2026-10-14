import {
  STRATEGY_ETF_SOURCE_GROUPS,
  STRATEGY_ETF_SOURCES,
} from "@intrinsic/contracts";
import {
  BENCHMARK_CATALOG,
  MARKET_OVERVIEW_ETF_GROUPS,
  marketOverviewEtfs,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";

/**
 * Drift guard between the Strategy ETF source catalog (`@intrinsic/contracts`, what the Builder,
 * validator and worker read) and the market-overview ETF catalog (`@intrinsic/domain`, what the
 * refresh child and bootstrap maintain). The two are one product list stated twice because the web
 * app may depend only on contracts — exactly the `RELATIVE_VOLUME_PERIODS` arrangement — and this
 * suite, like `selectable-series-catalog.test.ts`, is what stops either side gaining, losing,
 * renaming, regrouping or reordering an ETF without the other.
 */
describe("the Strategy ETF source catalog mirrors the market-overview catalog exactly", () => {
  it("lists the same groups, in the same order, under the same labels", () => {
    expect(
      STRATEGY_ETF_SOURCE_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        shortLabel: group.shortLabel,
      })),
    ).toEqual(
      MARKET_OVERVIEW_ETF_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        shortLabel: group.shortLabel,
      })),
    );
  });

  it("lists the same twenty ETFs, in the same order, with the same identities and labels", () => {
    expect(
      STRATEGY_ETF_SOURCES.map((etf) => ({
        code: etf.code,
        ticker: etf.ticker,
        label: etf.label,
      })),
    ).toEqual(
      marketOverviewEtfs().map((etf) => ({
        code: etf.benchmarkCode,
        ticker: etf.ticker,
        label: etf.label,
      })),
    );
    expect(
      STRATEGY_ETF_SOURCE_GROUPS.map((group) => group.etfs.length),
    ).toEqual(MARKET_OVERVIEW_ETF_GROUPS.map((group) => group.etfs.length));
  });

  it("names only benchmark codes the catalog defines, every one an active ETF proxy", () => {
    for (const etf of STRATEGY_ETF_SOURCES) {
      const entry = BENCHMARK_CATALOG.find(
        (candidate) => candidate.code === etf.code,
      );
      expect(entry, `catalog entry for ${etf.code}`).toBeDefined();
      expect(entry?.seriesType).toBe("ETF_PROXY");
      expect(entry?.isActive).toBe(true);
    }
  });

  it("never admits an index series: a condition reads the actual ETF's own data", () => {
    const codes = STRATEGY_ETF_SOURCES.map((etf) => etf.code);
    expect(codes).not.toContain("SP500_INDEX");
    expect(codes).not.toContain("DJIA_INDEX");
    expect(codes).not.toContain("VIX_INDEX");
  });
});
