import {
  WEEKLY_MOVING_AVERAGES,
  type DailyPrice,
  type LocalDate,
  type SecurityId,
  type WeeklyMovingAverageField,
} from "@intrinsic/domain";
import { addDays, compareDates } from "./dates.js";
import { movingAverage } from "./technicals.js";

export type WeeklyPrice = {
  securityId: SecurityId;
  weekStartDate: LocalDate;
  weekEndDate: LocalDate;
  /**
   * First trading day whose end-of-day derived state may use this week.
   *
   * `DailyDerivedState` is an end-of-trading-day state, so a completed week becomes effective on
   * its own final trading day's close — the actual last observed bar of the week, which handles
   * holiday-shortened weeks. Earlier days in that week must never see it: doing so would consume a
   * close that had not happened yet.
   */
  eligibleDate: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type WeeklyHistoryContext = {
  historyStart: LocalDate;
  historyStartOrigin: "HORIZON" | "LISTING";
};

export function startOfIsoWeek(value: LocalDate): LocalDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay();
  return addDays(value, -(day === 0 ? 6 : day - 1));
}

/**
 * Aggregates trading weeks that are known to be complete at `asOf`.
 *
 * The ISO week containing `asOf` is excluded: while it is still in progress there is no way to
 * know which of its days is the final one, and guessing would fabricate a value that a later bar
 * would contradict. Once the week has passed, its last observed bar is its final trading day and
 * the bar becomes eligible from that day's close.
 */
export function aggregateCompletedWeeks(
  prices: readonly DailyPrice[],
  asOf: LocalDate,
  history?: WeeklyHistoryContext,
): WeeklyPrice[] {
  const currentWeekStart = startOfIsoWeek(asOf);
  const artificialFirstWeek =
    history?.historyStartOrigin === "HORIZON" &&
    startOfIsoWeek(history.historyStart) !== history.historyStart
      ? startOfIsoWeek(history.historyStart)
      : undefined;
  const groups = new Map<LocalDate, DailyPrice[]>();
  for (const price of [...prices].sort((left, right) =>
    left.date.localeCompare(right.date),
  )) {
    const weekStart = startOfIsoWeek(price.date);
    if (
      compareDates(weekStart, currentWeekStart) >= 0 ||
      weekStart === artificialFirstWeek
    ) {
      continue;
    }
    const group = groups.get(weekStart) ?? [];
    group.push(price);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([weekStartDate, rows]) => {
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) {
      throw new Error("Weekly aggregation received an empty week");
    }
    return {
      securityId: first.securityId,
      weekStartDate,
      weekEndDate: last.date,
      eligibleDate: last.date,
      open: first.open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: last.close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
    };
  });
}

/** Latest week whose final trading day has closed at or before `asOf`. */
export function latestCompletedWeeklyBar(
  bars: readonly WeeklyPrice[],
  asOf: LocalDate,
): WeeklyPrice | undefined {
  return [...bars]
    .filter((bar) => compareDates(bar.eligibleDate, asOf) <= 0)
    .sort((left, right) =>
      right.eligibleDate.localeCompare(left.eligibleDate),
    )[0];
}

/**
 * Weekly moving-average values of one completed week, keyed by their materialization field.
 *
 * A field is absent while the indicator has not warmed up. Absent never means zero: a week with
 * only thirty completed weekly bars behind it legitimately has `sma20w` and no `sma50w`.
 */
export type WeeklyTechnicalValues = Partial<
  Record<WeeklyMovingAverageField, number>
>;

/**
 * Calculates every catalog weekly moving average over completed weekly bars.
 *
 * The result is indexed by `weekStartDate` so the daily materializer can look up the values of
 * whichever completed week is effective on a trading day. Each indicator is calculated from the
 * weekly closes themselves; no daily indicator participates, and the caller has already excluded
 * the in-progress week from `bars`.
 */
export function calculateWeeklyTechnicalValues(
  bars: readonly WeeklyPrice[],
): Map<LocalDate, WeeklyTechnicalValues> {
  const ascending = [...bars].sort((left, right) =>
    left.weekStartDate.localeCompare(right.weekStartDate),
  );
  const byWeekStart = new Map<LocalDate, WeeklyTechnicalValues>(
    ascending.map((bar) => [bar.weekStartDate, {}]),
  );
  const closes = ascending.map((bar) => bar.close);
  for (const average of WEEKLY_MOVING_AVERAGES) {
    const values = movingAverage(closes, average.type, average.period);
    ascending.forEach((bar, index) => {
      const value = values[index];
      const week = byWeekStart.get(bar.weekStartDate);
      if (value !== undefined && week) {
        week[average.field] = value;
      }
    });
  }
  return byWeekStart;
}
