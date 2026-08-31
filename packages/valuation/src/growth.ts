import { DEFAULT_GROWTH, MAX_FORECAST_GROWTH } from "./constants.js";
import { isFiniteNumber } from "./types.js";

/**
 * The locked growth methodology is a 5-year CAGR between two exact fiscal-year endpoints.
 *
 * This package operates only on the endpoint numeric values: selecting which fiscal years those
 * are, and proving they are point-in-time eligible, belongs to the orchestration layer.
 */
const CAGR_YEARS = 5;

export const GROWTH_SOURCES = [
  "REVENUE_CAGR",
  "NET_INCOME_CAGR",
  "DEFAULT",
] as const;
export type GrowthSource = (typeof GROWTH_SOURCES)[number];

/** Endpoint pair for one series: the fiscal year `N` value and the fiscal year `N - 5` value. */
export type GrowthEndpoints = {
  latest: number;
  fiveYearsEarlier: number;
};

export type GrowthEstimateInput = {
  revenue?: GrowthEndpoints;
  netIncome?: GrowthEndpoints;
};

export type GrowthEstimate = {
  /** The uncapped rate that the selected source produced. */
  rawGrowth: number;
  /** `min(rawGrowth, MAX_FORECAST_GROWTH)`; there is deliberately no negative floor. */
  growthUsed: number;
  source: GrowthSource;
};

/**
 * 5-year CAGR, or `undefined` when the endpoint pair cannot produce one.
 *
 * Both endpoints must be finite and strictly positive: a non-positive endpoint has no meaningful
 * compound rate.
 */
export function fiveYearCagr(endpoints: GrowthEndpoints): number | undefined {
  const { latest, fiveYearsEarlier } = endpoints;
  if (!isFiniteNumber(latest) || !isFiniteNumber(fiveYearsEarlier)) {
    return undefined;
  }
  if (latest <= 0 || fiveYearsEarlier <= 0) {
    return undefined;
  }
  const cagr = (latest / fiveYearsEarlier) ** (1 / CAGR_YEARS) - 1;
  return isFiniteNumber(cagr) ? cagr : undefined;
}

/** Caps the upside only. A validly calculated negative CAGR passes through unfloored. */
export function capGrowth(rawGrowth: number): number {
  return Math.min(rawGrowth, MAX_FORECAST_GROWTH);
}

/**
 * Revenue CAGR first, net-income CAGR as the fallback, then `DEFAULT_GROWTH`.
 *
 * Growth is never unavailable: an issuer without usable endpoints is forecast at the default rate
 * rather than made inapplicable.
 */
export function estimateGrowth(input: GrowthEstimateInput): GrowthEstimate {
  const revenueCagr = input.revenue ? fiveYearCagr(input.revenue) : undefined;
  if (revenueCagr !== undefined) {
    return {
      rawGrowth: revenueCagr,
      growthUsed: capGrowth(revenueCagr),
      source: "REVENUE_CAGR",
    };
  }

  const netIncomeCagr = input.netIncome
    ? fiveYearCagr(input.netIncome)
    : undefined;
  if (netIncomeCagr !== undefined) {
    return {
      rawGrowth: netIncomeCagr,
      growthUsed: capGrowth(netIncomeCagr),
      source: "NET_INCOME_CAGR",
    };
  }

  return {
    rawGrowth: DEFAULT_GROWTH,
    growthUsed: capGrowth(DEFAULT_GROWTH),
    source: "DEFAULT",
  };
}
