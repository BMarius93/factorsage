import {
  revisionMismatches,
  type BacktestRevisionMismatch,
} from "@intrinsic/contracts";

/**
 * Versioned execution methodology.
 *
 * `ai/product/backtests.md` requires a submitted run to snapshot the methodology versions that can
 * change its results. These constants are those versions: they are copied into the run snapshot at
 * submission and are never read back out of it to *drive* behaviour — a completed run is data, and
 * re-running it under a newer engine is a new run.
 *
 * They are, however, read back to *refuse* behaviour. A run queued at 10:00 under `execution@2` and
 * claimed at 10:10 by a worker deployed at 10:05 with `execution@3` would otherwise execute the new
 * rules and store a result stamped with the old ones — a lie in the one record that exists to make
 * a run reproducible. `methodologyMismatches` is what a worker checks before it starts; see
 * `ai/architecture/backtest-execution.md`.
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
 * `same-day-close/fractional-shares/exits-before-entries/contribution-dca@2`:
 * - every order fills at the canonical end-of-day close of the signal date;
 * - share quantities are continuous, so a target allocation is met exactly and a small target in an
 *   expensive stock is not silently dropped to zero shares;
 * - exits run before entries, so a slot and the cash a sale frees are usable the same day;
 * - a BUY level percentage is a **target** fill of the full-position budget;
 * - a BUY percentage is an allocation **tier**, and reaching one settles every tier at or below it
 *   for that position lifecycle. Buying to the 100% target satisfies the 25% and 50% levels by
 *   definition, so a later price decline cannot resurrect a smaller one and buy again;
 * - a settled level is reconsidered exactly once per exception: on a date that actually deposits a
 *   monthly contribution it is measured against the post-contribution portfolio and may buy the
 *   shortfall to its recalculated target. It is not a rebalance — a position that merely drifted
 *   below target on an ordinary day is left alone, and a level whose Signal (Trigger included) is
 *   not TRUE on the contribution date does not top up;
 * - a selected tier is settled whether it filled fully, filled as far as the available cash went,
 *   or found nothing to buy. The opportunity is the signal, not the money, so one cent of cash and
 *   no cash at all mean the same thing;
 * - **unless no position exists**. With no free slot, or with nothing spendable, no lifecycle
 *   begins: no zero-share position is created, nothing is settled, and the security stays eligible
 *   for a later date on which its Signal is TRUE again;
 * - a security whose position closes on a date cannot be re-entered on that same date;
 * - FINAL EXIT outranks a matching partial SELL on the same date;
 * - every matching SELL level executes once per position lifecycle, in definition order, each
 *   against the position remaining at that moment.
 *
 * Revision history:
 * - v1: a BUY level fired exactly once per position lifecycle, so new capital from a monthly
 *   contribution could never reach a position whose levels had all fired.
 * - v2: the contribution-date top-up above. It changes numbers, so it is a version bump rather
 *   than a silent correction; runs executed under v1 keep their recorded methodology.
 * - v3: allocation tiers supersede smaller ones, and a selected tier is settled regardless of how
 *   much cash was available — while a *new* position is never opened without spendable cash or a
 *   free slot. v2 let an unfired lower level buy on an ordinary day once a position drifted below
 *   its smaller target, which was continuous rebalancing reached through a multi-level strategy,
 *   and it made a level's fate turn on whether the cash balance was zero or a cent.
 */
export const EXECUTION_METHODOLOGY_VERSION =
  "same-day-close/fractional-shares/exits-before-entries/contribution-dca@3" as const;

/**
 * Fee and slippage assumptions. V1 executes at zero of both, deliberately and visibly, so a later
 * change is a version bump rather than a silent reinterpretation of historical runs.
 */
export const EXECUTION_COST_METHODOLOGY_VERSION =
  "zero-fees/zero-slippage@1" as const;

/**
 * What uninvested cash earns.
 *
 * `zero-interest@1`: nothing. A portfolio sitting in cash for years — before its first security
 * lists, or between exits — grows by exactly zero, where a real one would have earned a money
 * market or T-bill yield. It is not modelled, and saying so is the point of naming it.
 *
 * Stated as its own version rather than folded into `executionCosts` because it is a different
 * assumption about a different thing — what money costs to move versus what money earns while
 * still — and introducing a yield later must be a visible bump, not a silent restatement.
 */
export const CASH_YIELD_METHODOLOGY_VERSION = "zero-interest@1" as const;

/**
 * What a Strategy document *means* when it is evaluated.
 *
 * `signal-evaluation@1`: the tri-state Kleene semantics, `NOT_EVALUABLE` propagation, the
 * crossing predicates' previous-value rule, proximity comparison, weekly carry-forward and the
 * position Gain/Loss triggers — the whole evaluator, as one coarse revision.
 *
 * `STRATEGY_SCHEMA_VERSION` protects the document's *shape*; this protects its *interpretation*.
 * Fixing what "crosses above" does to a series that was flat for a week changes the answer for an
 * unchanged document, an unchanged schema version and an unchanged price dataset — so without a
 * version of its own that change would be invisible to every reproducibility guard.
 *
 * Deliberately one version for the whole evaluator rather than one per predicate: the guard only
 * ever asks "can this build honour what that run recorded", and a finer split would multiply
 * bookkeeping without changing a single answer.
 */
export const STRATEGY_EVALUATION_METHODOLOGY_VERSION =
  "signal-evaluation@1" as const;

/**
 * Which dates a run simulates.
 *
 * `execution-calendar-authoritative@2`: exactly the pinned execution calendar's trading days
 * inside the requested period. The market's own days, and nothing else.
 *
 * A security participates on the subset of those days its frame has a row for; on the rest its
 * predicates are NOT_EVALUABLE and it does nothing, while its holdings stay valued at their most
 * recent close. A security's dates therefore decide what *it* can do, never which days *exist*.
 *
 * This is versioned methodology because it decides which date is "the first simulated date of a
 * month" — and therefore when a contribution lands — and which date the return index is based at.
 *
 * Revision history:
 * - v1: the union of the securities' eligible dates and the execution calendar. A single
 *   anomalous provider row dated on a market holiday could therefore become a portfolio trading
 *   day, and with it the run's first simulated date, its return-index base and a contribution
 *   date. One malformed row in one security could move every number in the run.
 * - v2: the execution calendar alone. A date exists because the market traded, and for no other
 *   reason.
 */
export const CALENDAR_METHODOLOGY_VERSION =
  "execution-calendar-authoritative@2" as const;

/**
 * Where the execution calendar's dates come from.
 *
 * `us-equities/reference-series@1`: the daily bars of one reference series that the engine
 * designates, loaded through the canonical benchmark-data path and pinned at submission to the
 * exact immutable series version the run executes against. The market's own observed trading days,
 * in other words — not a table of holiday rules, which would have to invent the days it could not
 * derive, and not the user's comparison benchmark, which must never influence execution.
 *
 * Required, and pinned per run. A submission that cannot resolve the reference is refused, and an
 * attempt that cannot read the pinned series fails: simulating the securities' own union instead
 * would execute a different methodology than the one the run recorded, chosen by whether an
 * auxiliary series happened to load.
 */
export const EXECUTION_CALENDAR_METHODOLOGY_VERSION =
  "us-equities/reference-series@1" as const;

/**
 * When a monthly contribution lands.
 *
 * `first-eligible-trading-day-of-month@1`: the run's first simulated date is funded by the initial
 * capital and receives no contribution on top of it; from the following calendar month onwards, the
 * contribution is deposited on that month's first simulated trading date. A calendar month with no
 * simulated trading date receives no contribution, and no contribution is ever carried forward.
 *
 * The deposit lands before the day's trading, so it is spendable the same date — which is also what
 * makes the `contribution-dca` rule in `EXECUTION_METHODOLOGY_VERSION` reachable.
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
  calendar: CALENDAR_METHODOLOGY_VERSION,
  executionCalendar: EXECUTION_CALENDAR_METHODOLOGY_VERSION,
  candidateOrdering: CANDIDATE_ORDERING_METHODOLOGY_VERSION,
  execution: EXECUTION_METHODOLOGY_VERSION,
  executionCosts: EXECUTION_COST_METHODOLOGY_VERSION,
  cashYield: CASH_YIELD_METHODOLOGY_VERSION,
  strategyEvaluation: STRATEGY_EVALUATION_METHODOLOGY_VERSION,
  contribution: CONTRIBUTION_METHODOLOGY_VERSION,
  returns: RETURN_METHODOLOGY_VERSION,
  costBasis: "AVERAGE_COST" as const,
} as const;

export type BacktestMethodology = typeof BACKTEST_METHODOLOGY;

/**
 * Every field of a recorded methodology that this build cannot honour.
 *
 * **All of them are execution-affecting**, which is why none is excluded: the calendar and its
 * source decide which dates are simulated, `contribution` when money lands, `candidateOrdering`
 * who is funded first, `execution` what a day does, `executionCosts` and `cashYield` what it costs
 * and earns, `strategyEvaluation` what a Strategy document *means*, `costBasis` what a sale
 * realizes, and `returns` how the curve reports all of it.
 */
export function methodologyMismatches(
  recorded: unknown,
): BacktestRevisionMismatch[] {
  return revisionMismatches(recorded, BACKTEST_METHODOLOGY);
}

/** V1 executes with no transaction costs. Kept as a named seam rather than a scattered `0`. */
export const V1_FEE_PER_TRADE = 0;
export const V1_SLIPPAGE_FRACTION = 0;
