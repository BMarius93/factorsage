import { describe, expect, it } from "vitest";
import { DEFAULT_GROWTH, MAX_FORECAST_GROWTH } from "./constants.js";
import { capGrowth, estimateGrowth, fiveYearCagr } from "./growth.js";

describe("growth estimation", () => {
  it("uses the revenue CAGR when both revenue endpoints are valid", () => {
    // 100 -> 127.62815625 is exactly 5% compounded over five years.
    const estimate = estimateGrowth({
      revenue: { latest: 127.62815625, fiveYearsEarlier: 100 },
      netIncome: { latest: 400, fiveYearsEarlier: 100 },
    });

    expect(estimate.source).toBe("REVENUE_CAGR");
    expect(estimate.rawGrowth).toBeCloseTo(0.05, 12);
    expect(estimate.growthUsed).toBeCloseTo(0.05, 12);
  });

  it("falls back to the net-income CAGR when revenue endpoints are unusable", () => {
    const estimate = estimateGrowth({
      // A non-positive endpoint has no meaningful compound rate.
      revenue: { latest: 150, fiveYearsEarlier: 0 },
      netIncome: { latest: 127.62815625, fiveYearsEarlier: 100 },
    });

    expect(estimate.source).toBe("NET_INCOME_CAGR");
    expect(estimate.rawGrowth).toBeCloseTo(0.05, 12);
  });

  it("falls back to the default growth when neither CAGR can be calculated", () => {
    expect(estimateGrowth({})).toEqual({
      rawGrowth: DEFAULT_GROWTH,
      growthUsed: DEFAULT_GROWTH,
      source: "DEFAULT",
    });
    expect(
      estimateGrowth({
        revenue: { latest: -10, fiveYearsEarlier: 100 },
        netIncome: { latest: 80, fiveYearsEarlier: -5 },
      }).source,
    ).toBe("DEFAULT");
  });

  it("caps the upside at the maximum forecast growth", () => {
    // 100 -> 400 is roughly 32% compounded; only the capped rate is forecast.
    const estimate = estimateGrowth({
      revenue: { latest: 400, fiveYearsEarlier: 100 },
    });

    expect(estimate.rawGrowth).toBeGreaterThan(MAX_FORECAST_GROWTH);
    expect(estimate.growthUsed).toBe(MAX_FORECAST_GROWTH);
  });

  it("does not floor a validly negative CAGR", () => {
    // 100 -> 77.3780936 is about -5% compounded over five years.
    const estimate = estimateGrowth({
      revenue: { latest: 77.3780936, fiveYearsEarlier: 100 },
    });

    expect(estimate.rawGrowth).toBeCloseTo(-0.05, 8);
    expect(estimate.growthUsed).toBeCloseTo(-0.05, 8);
    expect(capGrowth(-0.4)).toBe(-0.4);
  });

  it("rejects non-finite and non-positive endpoints", () => {
    expect(fiveYearCagr({ latest: Number.NaN, fiveYearsEarlier: 100 })).toBeUndefined();
    expect(
      fiveYearCagr({ latest: Number.POSITIVE_INFINITY, fiveYearsEarlier: 100 }),
    ).toBeUndefined();
    expect(fiveYearCagr({ latest: 120, fiveYearsEarlier: -100 })).toBeUndefined();
    expect(fiveYearCagr({ latest: 0, fiveYearsEarlier: 100 })).toBeUndefined();
  });
});
