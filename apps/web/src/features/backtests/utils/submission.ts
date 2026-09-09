import {
  BACKTEST_MAX_INITIAL_CAPITAL,
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_MONTHLY_CONTRIBUTION,
  BACKTEST_MAX_PERIOD_YEARS,
  subtractYears,
  BACKTEST_MIN_INITIAL_CAPITAL,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
  type CreateBacktestRunRequest,
} from "@intrinsic/contracts";
import {
  formatDerivedPercent,
  formatMoney,
  fullPositionPercent,
} from "./format";

/**
 * The submission form's raw values.
 *
 * Numbers stay strings until they are validated: an `<input type="number">` reports an
 * uninterpretable entry as an empty string, and coercing early would turn "not filled in" and
 * "zero" into the same thing.
 */
export type BacktestFormValues = {
  readonly strategyId: string;
  readonly stockListId: string;
  readonly benchmarkCode: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly initialCapital: string;
  readonly monthlyContribution: string;
  readonly maximumPositions: string;
};

export type BacktestFormErrors = Partial<
  Record<keyof BacktestFormValues, string>
>;

export type BacktestFormValidation = {
  readonly errors: BacktestFormErrors;
  /** The request to send, or null when anything was rejected. */
  readonly request: CreateBacktestRunRequest | null;
};

/** Canonical `YYYY-MM-DD` at UTC midnight, or null when the value is not a usable date. */
function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.valueOf();
}

function toDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * The period a fresh form opens with: the last five years, ending today.
 *
 * Taken from an injected clock rather than read at module scope because it must be computed after
 * mount — the server and the browser would not agree on "today" during hydration.
 */
/**
 * The earliest start a V1 backtest may request: the canonical horizon back from today.
 *
 * `subtractYears` is the repository's one implementation of that arithmetic — the same one the
 * loader clamps its retention with — so the browser and the server land on the same day, 29
 * February included.
 */
export function maximumBacktestStart(now: Date): string {
  return subtractYears(toDay(now.valueOf()), BACKTEST_MAX_PERIOD_YEARS);
}

export function defaultBacktestPeriod(now: Date): {
  readonly startDate: string;
  readonly endDate: string;
} {
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const start = Date.UTC(
    now.getUTCFullYear() - 5,
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return { startDate: toDay(start), endDate: toDay(end) };
}

/**
 * The derived full-position help text.
 *
 * `maximumPositions` is the only allocation input a user gives: the full-position fraction is
 * `1 / maximumPositions` by product rule, and a strategy's BUY level percentage is a share of
 * *that* budget. Spelling both out is what keeps users from looking for a maximum-allocation field
 * that deliberately does not exist.
 */
export function fullPositionHelpText(maximumPositions: number): string {
  const full = fullPositionPercent(maximumPositions);
  return (
    `${maximumPositions} ${maximumPositions === 1 ? "position" : "positions"} → ` +
    `a full position is ${formatDerivedPercent(full)}% of the portfolio; ` +
    `a 25% BUY level targets ${formatDerivedPercent(full / 4)}%`
  );
}

/**
 * Validates a submission with the shared limits the API enforces, so the common rejections are
 * answered instantly and in product vocabulary rather than as a round trip.
 *
 * This is not a second authority: the API validates the same document again and its 400 message is
 * rendered inline when it disagrees.
 */
export function validateBacktestForm(
  values: BacktestFormValues,
): BacktestFormValidation {
  const errors: Record<string, string> = {};

  if (values.strategyId === "") {
    errors.strategyId = "Choose the strategy this backtest should run.";
  }
  if (values.stockListId === "") {
    errors.stockListId = "Choose the stock list this backtest should trade.";
  }
  if (values.benchmarkCode === "") {
    errors.benchmarkCode = "Choose a benchmark to compare the run against.";
  }

  const start = parseDay(values.startDate);
  const end = parseDay(values.endDate);
  if (start === null) {
    errors.startDate = "A backtest needs a start date.";
  }
  if (end === null) {
    errors.endDate = "A backtest needs an end date.";
  }
  if (start !== null && end !== null) {
    if (end <= start) {
      errors.endDate = "The end date must be after the start date.";
      // Calendar years, not average ones. Dividing elapsed days by 365.25 makes a period of
      // exactly the maximum measure slightly over it — thirty calendar years is 10,957 or 10,958
      // days depending on leap days — so the browser would reject the very range the MAX control
      // produces and the API accepts. This mirrors the API's own calendar comparison.
    } else if (
      values.startDate <
      subtractYears(values.endDate, BACKTEST_MAX_PERIOD_YEARS)
    ) {
      errors.endDate = `A backtest period cannot be longer than ${BACKTEST_MAX_PERIOD_YEARS} years.`;
    }
  }

  const initialCapital = Number(values.initialCapital);
  if (
    values.initialCapital === "" ||
    !Number.isFinite(initialCapital) ||
    initialCapital < BACKTEST_MIN_INITIAL_CAPITAL ||
    initialCapital > BACKTEST_MAX_INITIAL_CAPITAL
  ) {
    errors.initialCapital =
      `Initial capital must be between ${formatMoney(BACKTEST_MIN_INITIAL_CAPITAL)} ` +
      `and ${formatMoney(BACKTEST_MAX_INITIAL_CAPITAL)}.`;
  }

  // Empty means no recurring contribution, which is a valid configuration rather than a mistake.
  const contributionEntered = values.monthlyContribution.trim() !== "";
  const monthlyContribution = contributionEntered
    ? Number(values.monthlyContribution)
    : 0;
  if (
    contributionEntered &&
    (!Number.isFinite(monthlyContribution) ||
      monthlyContribution < 0 ||
      monthlyContribution > BACKTEST_MAX_MONTHLY_CONTRIBUTION)
  ) {
    errors.monthlyContribution =
      `A monthly contribution must be between ${formatMoney(0)} and ` +
      `${formatMoney(BACKTEST_MAX_MONTHLY_CONTRIBUTION)}.`;
  }

  const maximumPositions = Number(values.maximumPositions);
  if (
    values.maximumPositions === "" ||
    !Number.isInteger(maximumPositions) ||
    maximumPositions < BACKTEST_MIN_MAXIMUM_POSITIONS ||
    maximumPositions > BACKTEST_MAX_MAXIMUM_POSITIONS
  ) {
    errors.maximumPositions =
      `Maximum positions must be a whole number between ${BACKTEST_MIN_MAXIMUM_POSITIONS} ` +
      `and ${BACKTEST_MAX_MAXIMUM_POSITIONS}.`;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, request: null };
  }

  return {
    errors: {},
    request: {
      strategyId: values.strategyId,
      stockListId: values.stockListId,
      benchmarkCode: values.benchmarkCode,
      startDate: values.startDate,
      endDate: values.endDate,
      initialCapital,
      ...(monthlyContribution > 0 ? { monthlyContribution } : {}),
      maximumPositions,
    },
  };
}
