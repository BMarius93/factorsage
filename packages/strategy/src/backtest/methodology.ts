/**
 * Versioned execution methodology.
 *
 * `ai/product/backtests.md` requires a submitted run to snapshot the methodology versions that can
 * change its results. These constants are those versions: they are copied into the run snapshot at
 * submission and are never read back out of it to *drive* behaviour — a completed run is data, and
 * re-running it under a newer engine is a new run.
 *
 * Bump a version when the rule it names changes in a way that can move a number.
 */

/**
 * How candidates are ordered when cash or position slots cannot satisfy every matching symbol.
 *
 * `top-ups-first/percentage-desc/symbol-asc@1`:
 * 1. topping up a security that already holds a position comes before opening a new one — a top-up
 *    consumes no additional position slot and completes a staged entry the strategy already began;
 * 2. then descending BUY level percentage, so the strongest matching signal is funded first;
 * 3. then ascending symbol, and finally ascending security id, which makes the order total and
 *    independent of list row order, insertion order and any hash iteration.
 */
export const CANDIDATE_ORDERING_METHODOLOGY_VERSION =
  "top-ups-first/percentage-desc/symbol-asc@1" as const;

/**
 * How one simulated day executes.
 *
 * `same-day-close/fractional-shares/exits-before-entries@1`:
 * - every order fills at the canonical end-of-day close of the signal date;
 * - share quantities are continuous, so a target allocation is met exactly and a small target in an
 *   expensive stock is not silently dropped to zero shares;
 * - exits run before entries, so a slot and the cash a sale frees are usable the same day;
 * - a BUY level percentage is a **target** fill of the full-position budget, and a level fires at
 *   most once per position lifecycle;
 * - a security whose position closes on a date cannot be re-entered on that same date;
 * - FINAL EXIT outranks a matching partial SELL on the same date;
 * - every matching SELL level executes once per position lifecycle, in definition order, each
 *   against the position remaining at that moment.
 */
export const EXECUTION_METHODOLOGY_VERSION =
  "same-day-close/fractional-shares/exits-before-entries@1" as const;

/**
 * Fee and slippage assumptions. V1 executes at zero of both, deliberately and visibly, so a later
 * change is a version bump rather than a silent reinterpretation of historical runs.
 */
export const EXECUTION_COST_METHODOLOGY_VERSION =
  "zero-fees/zero-slippage@1" as const;

/**
 * When a monthly contribution lands.
 *
 * `first-eligible-trading-day-of-month@1`: on the first simulated trading date of each calendar
 * month, except the run's very first simulated date, on which the initial capital is deposited
 * instead. A month with no simulated trading date receives no contribution.
 */
export const CONTRIBUTION_METHODOLOGY_VERSION =
  "first-eligible-trading-day-of-month@1" as const;

/**
 * How the comparable percentage-growth curves are formed.
 *
 * `time-weighted-index@1`: the portfolio curve is a time-weighted return index based at 1.0 on the
 * first simulated date, chaining `value(d) / (value(d-1) + contribution(d))`, so a contribution
 * raises portfolio value without inventing return. The benchmark curve is its close divided by the
 * close in effect on the first simulated date. Both are therefore percentage growth from the same
 * starting point, and alpha is their difference.
 */
export const RETURN_METHODOLOGY_VERSION = "time-weighted-index@1" as const;

/** The complete set stamped into a run snapshot. */
export const BACKTEST_METHODOLOGY = {
  candidateOrdering: CANDIDATE_ORDERING_METHODOLOGY_VERSION,
  execution: EXECUTION_METHODOLOGY_VERSION,
  executionCosts: EXECUTION_COST_METHODOLOGY_VERSION,
  contribution: CONTRIBUTION_METHODOLOGY_VERSION,
  returns: RETURN_METHODOLOGY_VERSION,
  costBasis: "AVERAGE_COST" as const,
} as const;

export type BacktestMethodology = typeof BACKTEST_METHODOLOGY;

/** V1 executes with no transaction costs. Kept as a named seam rather than a scattered `0`. */
export const V1_FEE_PER_TRADE = 0;
export const V1_SLIPPAGE_FRACTION = 0;
