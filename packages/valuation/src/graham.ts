import {
  calculated,
  isFiniteNumber,
  notApplicable,
  type ValuationResult,
} from "./types.js";

/**
 * Legacy Graham growth multiplier. The revised bond-yield-adjusted form is not used in V1 because
 * there is no point-in-time historical AAA corporate bond-yield series.
 */
const GRAHAM_BASE_MULTIPLIER = 8.5;
const GRAHAM_GROWTH_FACTOR = 2;

export type GrahamInput = {
  epsTtm: number;
  growthUsed: number;
};

export type GrahamValuation = {
  /** Growth expressed in percentage points, as the legacy formula requires. */
  gPercent: number;
  multiplier: number;
  valuePerShare: number;
};

/** Market price is never an input to the Graham intrinsic value. */
export function calculateGraham(
  input: GrahamInput,
): ValuationResult<GrahamValuation> {
  const { epsTtm, growthUsed } = input;

  if (![epsTtm, growthUsed].every(isFiniteNumber)) {
    return notApplicable("NON_FINITE_INPUT");
  }
  if (epsTtm <= 0) {
    return notApplicable("NON_POSITIVE_EPS");
  }

  const gPercent = growthUsed * 100;
  const multiplier = GRAHAM_BASE_MULTIPLIER + GRAHAM_GROWTH_FACTOR * gPercent;
  if (multiplier <= 0) {
    return notApplicable("NON_POSITIVE_MULTIPLIER");
  }

  const valuePerShare = epsTtm * multiplier;
  if (!isFiniteNumber(valuePerShare)) {
    return notApplicable("NON_FINITE_RESULT");
  }
  if (valuePerShare <= 0) {
    return notApplicable("NON_POSITIVE_VALUE_PER_SHARE");
  }

  return calculated({ gPercent, multiplier, valuePerShare });
}
