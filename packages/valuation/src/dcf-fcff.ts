import {
  DCF_WACC,
  FORECAST_YEARS,
  TAX_RATE,
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

/**
 * Already-assembled TTM inputs. Assembling them from point-in-time statements — including the
 * common four-quarter fiscal window they must share — happens outside this package.
 */
export type DcfFcffInput = {
  operatingCashFlowTtm: number;
  /** Already signed negative, exactly as the provider reports it. */
  capitalExpenditureTtm: number;
  /** Positive expense magnitude. An explicit reported zero is a valid input. */
  interestExpenseTtm: number;
  growthUsed: number;
  cash: number;
  debt: number;
  shares: number;
};

export type DcfFcffValuation = {
  fcff0: number;
  pvForecast: number;
  pvTerminal: number;
  enterpriseValue: number;
  equityValue: number;
  valuePerShare: number;
};

/**
 * FCFF DCF over `FORECAST_YEARS` with a Gordon terminal value.
 *
 * `capitalExpenditureTtm` is added, never subtracted, because it arrives signed negative.
 * `changeInWorkingCapital` is deliberately absent: its effect is already inside operating cash
 * flow. Provider `freeCashFlow` is a reconciliation value elsewhere and is not an input here.
 */
export function calculateDcfFcff(
  input: DcfFcffInput,
): ValuationResult<DcfFcffValuation> {
  const {
    operatingCashFlowTtm,
    capitalExpenditureTtm,
    interestExpenseTtm,
    growthUsed,
    cash,
    debt,
    shares,
  } = input;

  if (
    ![
      operatingCashFlowTtm,
      capitalExpenditureTtm,
      interestExpenseTtm,
      growthUsed,
      cash,
      debt,
      shares,
    ].every(isFiniteNumber)
  ) {
    return notApplicable("NON_FINITE_INPUT");
  }
  if (shares <= 0) {
    return notApplicable("NON_POSITIVE_SHARES");
  }
  if (DCF_WACC - TERMINAL_GROWTH <= 0) {
    return notApplicable("NON_POSITIVE_TERMINAL_SPREAD");
  }

  const fcff0 =
    operatingCashFlowTtm +
    capitalExpenditureTtm +
    interestExpenseTtm * (1 - TAX_RATE);
  if (fcff0 <= 0) {
    return notApplicable("NON_POSITIVE_FCFF");
  }

  const pvForecast = presentValueOfGrowingSeries(
    fcff0,
    growthUsed,
    DCF_WACC,
    FORECAST_YEARS,
  );
  const finalForecastFcff = grow(fcff0, growthUsed, FORECAST_YEARS);
  const pvTerminal = discount(
    terminalValue(finalForecastFcff, TERMINAL_GROWTH, DCF_WACC),
    DCF_WACC,
    FORECAST_YEARS,
  );
  const enterpriseValue = pvForecast + pvTerminal;
  const equityValue = enterpriseValue + cash - debt;
  if (!isFiniteNumber(enterpriseValue) || !isFiniteNumber(equityValue)) {
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
    fcff0,
    pvForecast,
    pvTerminal,
    enterpriseValue,
    equityValue,
    valuePerShare,
  });
}
