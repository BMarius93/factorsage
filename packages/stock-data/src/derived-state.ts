import type { DailyDerivedState, DailyPrice, LocalDate } from "@intrinsic/domain";
import type { DailyIntrinsicState } from "./intrinsic-value-materializer.js";
import { calculateDailyTechnicals } from "./technicals.js";
import { latestCompletedWeeklyBar, type WeeklyPrice } from "./weekly.js";

/**
 * Methodology revision of the unified daily derived state.
 *
 * This is a rebuild trigger, never a row-identity or history dimension. It is recorded only in the
 * dataset-state/coverage variant and in the cache manifest. Bumping it invalidates the existing
 * materialized state so it is recalculated and replaced; it must never be used to keep two
 * methodologies resident for the same trading day.
 *
 * Revision history:
 * - r1: daily technicals and carried-forward completed-week state.
 * - r2: adds materialized point-in-time intrinsic model values, blends, per-model provenance and
 *   the shared intrinsic currency. An r1 row is not a current r2 row, so r1 manifests and coverage
 *   must go stale and the canonical history is rebuilt and replaced as r2.
 */
export const DERIVED_STATE_REVISION = 2;

export const DAILY_DERIVED_STATE_VARIANT = `daily-derived-state:r${DERIVED_STATE_REVISION}`;

/**
 * Builds the unified daily derived state for every supplied trading day.
 *
 * Daily technicals are calculated per trading day. Completed-week values are carried forward: the
 * latest weekly bar whose final trading day has closed is materialized onto the trading day, so
 * the same weekly source repeats until a newer week completes. Because the daily state is an
 * end-of-trading-day state, a week becomes effective on its own last trading day's close and is
 * invisible on every earlier day of that week. Days before the first completed week carry none.
 *
 * Intrinsic-value and blend fields are never calculated here. `intrinsicStates` carries already
 * materialized intrinsic projections, which are merged by exact trading date only. Merging cannot
 * affect prices, technicals or weekly eligibility, and an intrinsic state whose date has no
 * `DailyPrice` is ignored: every row still originates from one trading day of price history.
 */
export function buildDailyDerivedState(input: {
  prices: readonly DailyPrice[];
  weeklyBars?: readonly WeeklyPrice[];
  intrinsicStates?: readonly DailyIntrinsicState[];
}): DailyDerivedState[] {
  const weeklyBars = input.weeklyBars ?? [];
  const intrinsicByDate = new Map<LocalDate, DailyIntrinsicState>(
    (input.intrinsicStates ?? []).map((state) => [state.date, state]),
  );
  return calculateDailyTechnicals(input.prices).map((row) => {
    const weekly = latestCompletedWeeklyBar(weeklyBars, row.date);
    const withWeekly = weekly
      ? { ...row, weeklySourceWeekStart: weekly.weekStartDate }
      : row;
    const intrinsic = intrinsicByDate.get(row.date);
    if (!intrinsic) {
      return withWeekly;
    }
    // The intrinsic projection's own date is the merge key, not a merged field.
    return {
      ...withWeekly,
      ...Object.fromEntries(
        Object.entries(intrinsic).filter(([field]) => field !== "date"),
      ),
    };
  });
}

/** Ascending `(securityId, date)` ordering with at most one row per trading day. */
export function assertOneRowPerTradingDay(
  rows: readonly DailyDerivedState[],
): void {
  const seen = new Set<LocalDate>();
  for (const row of rows) {
    if (seen.has(row.date)) {
      throw new Error(
        `Daily derived state must hold exactly one row per trading day; duplicate ${row.date}`,
      );
    }
    seen.add(row.date);
  }
}
