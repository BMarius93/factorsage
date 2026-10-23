import { describe, expect, it } from "vitest";
import {
  formatHeadlinePercent,
  sharedBacktestDescription,
  sharedBacktestImageAlt,
  sharedBacktestPeriodLabel,
  sharedBacktestTitle,
  type SharedBacktestHeadlineInput,
} from "./share-headline";

const HEADLINE: SharedBacktestHeadlineInput = {
  startDate: "2000-01-03",
  endDate: "2025-10-21",
  benchmarkName: "SPY",
  securityCount: 750,
  strategyRuleCount: 12,
  portfolioCagrPercent: 18.44,
  benchmarkCagrPercent: 10.2,
  portfolioReturnPercent: 7_420,
  benchmarkReturnPercent: 1_120,
};

describe("the shared backtest's headline", () => {
  it("leads with the annualized returns, the run's and its benchmark's", () => {
    expect(sharedBacktestTitle(HEADLINE)).toBe(
      "18.4% Annualized vs 10.2% SPY | FactorSage",
    );
  });

  it("describes the period, the universe and the strategy by size alone", () => {
    expect(sharedBacktestDescription(HEADLINE)).toBe(
      "26-year backtest · 750 securities · 12 strategy rules",
    );
    expect(
      sharedBacktestDescription({
        ...HEADLINE,
        securityCount: 1,
        strategyRuleCount: 1,
        startDate: "2025-01-02",
        endDate: "2025-07-31",
      }),
    ).toBe("6-month backtest · 1 security · 1 strategy rule");
  });

  it("falls back to total returns for a run too short to annualize", () => {
    expect(
      sharedBacktestTitle({
        ...HEADLINE,
        portfolioCagrPercent: null,
        benchmarkCagrPercent: null,
        portfolioReturnPercent: 4.26,
        benchmarkReturnPercent: -1.04,
      }),
    ).toBe("4.3% Total return vs -1.0% SPY | FactorSage");
  });

  it("states its own figure alone when there is no benchmark figure", () => {
    expect(
      sharedBacktestTitle({ ...HEADLINE, benchmarkCagrPercent: null }),
    ).toBe("18.4% Annualized | FactorSage");
  });

  it("writes headline percentages with one decimal and no negative zero", () => {
    expect(formatHeadlinePercent(18.44)).toBe("18.4%");
    expect(formatHeadlinePercent(-3.06)).toBe("-3.1%");
    expect(formatHeadlinePercent(-0.04)).toBe("0.0%");
    expect(formatHeadlinePercent(1_234.5)).toBe("1,234.5%");
  });

  it("counts years with the product's own definition of a period's years", () => {
    expect(sharedBacktestPeriodLabel("2020-01-01", "2025-01-01")).toBe(
      "5-year backtest",
    );
    expect(sharedBacktestPeriodLabel("2020-01-01", "2025-01-02")).toBe(
      "6-year backtest",
    );
    expect(sharedBacktestPeriodLabel("2025-01-02", "2025-12-31")).toBe(
      "11-month backtest",
    );
    expect(sharedBacktestPeriodLabel("2024-01-02", "2025-01-02")).toBe(
      "1-year backtest",
    );
  });

  it("gives the image a text alternative with the same facts", () => {
    expect(sharedBacktestImageAlt(HEADLINE)).toBe(
      "FactorSage backtest chart. 18.4% Annualized vs 10.2% SPY. 26-year backtest · 750 securities · 12 strategy rules.",
    );
  });
});
