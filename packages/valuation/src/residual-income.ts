import {
  COST_OF_EQUITY,
  FORECAST_YEARS,
  TERMINAL_GROWTH,
} from "./constants.js";
import {
  discount,
  grow,
  presentValueOfGrowingSeries,
  terminalValue,
} from "./discounting.js";
import {
  calculated,
  isFiniteNumber,
  notApplicable,
  type ValuationResult,
} from "./types.js";

export type ResidualIncomeInput = {
  netIncomeTtm: number;
  /** Latest known (ending) book value, not an opening book value. */
  bookValue: number;
  shares: number;
  growthUsed: number;
};

export type ResidualIncomeValuation = {
  residualIncome0: number;
  pvForecast: number;
  pvTerminal: number;
  equityValue: number;
  valuePerShare: number;
};

/**
 * Residual income over `FORECAST_YEARS` with a Gordon terminal residual income.
 *
 * A negative base residual income is a legitimate result — an issuer earning below its equity
 * charge — and does not by itself make the model inapplicable. Only a non-positive final equity
 * value does.
 */
export function calculateResidualIncome(
  input: ResidualIncomeInput,
): ValuationResult<ResidualIncomeValuation> {
  const { netIncomeTtm, bookValue, shares, growthUsed } = input;

  if (![netIncomeTtm, bookValue, shares, growthUsed].every(isFiniteNumber)) {
    return notApplicable("NON_FINITE_INPUT");
  }
  if (bookValue <= 0) {
    return notApplicable("NON_POSITIVE_BOOK_VALUE");
  }
  if (shares <= 0) {
    return notApplicable("NON_POSITIVE_SHARES");
  }
  if (COST_OF_EQUITY - TERMINAL_GROWTH <= 0) {
    return notApplicable("NON_POSITIVE_TERMINAL_SPREAD");
  }

  const residualIncome0 = netIncomeTtm - bookValue * COST_OF_EQUITY;
  const pvForecast = presentValueOfGrowingSeries(
    residualIncome0,
    growthUsed,
    COST_OF_EQUITY,
    FORECAST_YEARS,
  );
  const finalForecastResidualIncome = grow(
    residualIncome0,
    growthUsed,
    FORECAST_YEARS,
  );
  const pvTerminal = discount(
    terminalValue(
      finalForecastResidualIncome,
      TERMINAL_GROWTH,
      COST_OF_EQUITY,
    ),
    COST_OF_EQUITY,
    FORECAST_YEARS,
  );
  const equityValue = bookValue + pvForecast + pvTerminal;
  if (!isFiniteNumber(equityValue)) {
    return notApplicable("NON_FINITE_RESULT");
  }
  if (equityValue <= 0) {
    return notApplicable("NON_POSITIVE_EQUITY_VALUE");
  }

  const valuePerShare = equityValue / shares;
  if (!isFiniteNumber(valuePerShare)) {
    return notApplicable("NON_FINITE_RESULT");
  }
  if (valuePerShare <= 0) {
    return notApplicable("NON_POSITIVE_VALUE_PER_SHARE");
  }

  return calculated({
    residualIncome0,
    pvForecast,
    pvTerminal,
    equityValue,
    valuePerShare,
  });
}
