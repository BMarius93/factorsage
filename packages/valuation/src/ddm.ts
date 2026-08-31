import { COST_OF_EQUITY, TERMINAL_GROWTH } from "./constants.js";
import {
  calculated,
  isFiniteNumber,
  notApplicable,
  type ValuationResult,
} from "./types.js";

export type DdmInput = {
  /**
   * Trailing dividend per share. The quarter-by-quarter dividend/share pairing that produces it
   * happens outside this package.
   */
  dpsTtm: number;
};

export type DdmValuation = {
  dpsTtm: number;
  d1: number;
  valuePerShare: number;
};

/**
 * One-stage Gordon growth model at the locked terminal growth rate.
 *
 * V1 uses no company-specific dividend CAGR, so this model does not consume `growthUsed`.
 */
export function calculateDdm(input: DdmInput): ValuationResult<DdmValuation> {
  const { dpsTtm } = input;

  if (!isFiniteNumber(dpsTtm)) {
    return notApplicable("NON_FINITE_INPUT");
  }
  if (dpsTtm <= 0) {
    return notApplicable("NON_POSITIVE_DIVIDEND");
  }

  const spread = COST_OF_EQUITY - TERMINAL_GROWTH;
  if (spread <= 0) {
    return notApplicable("NON_POSITIVE_TERMINAL_SPREAD");
  }

  const d1 = dpsTtm * (1 + TERMINAL_GROWTH);
  const valuePerShare = d1 / spread;
  if (!isFiniteNumber(valuePerShare)) {
    return notApplicable("NON_FINITE_RESULT");
  }
  if (valuePerShare <= 0) {
    return notApplicable("NON_POSITIVE_VALUE_PER_SHARE");
  }

  return calculated({ dpsTtm, d1, valuePerShare });
}
