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
   * The week's last **scheduled** exchange session: the first date whose end-of-day derived state
   * may use this week.
   *
   * `DailyDerivedState` is an end-of-trading-day state, so a completed week becomes effective at
   * the finalized close of the last session the venue scheduled that week — Friday in an ordinary
   * week, Thursday when Good Friday closes the market (`resolveWeekSessionEnds`). When the security
   * printed that session it is the week's own last bar; when it did not (a halt), no row of the
   * week ever sees it, and the security's next bar does. Earlier days must never see it: that would
   * consume a close, or knowledge that no later close was coming, that did not exist yet.
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

/** The Friday of the ISO week starting `weekStart`: the latest weekday a venue can schedule. */
export function fridayOfIsoWeek(weekStart: LocalDate): LocalDate {
  return addDays(weekStart, 4);
}

/**
 * The last scheduled session of each ISO week whose final bar is not its Friday, keyed by the
 * week's start (`resolveWeekSessionEnds`). A week missing from it is resolved conservatively by
 * {@link aggregateCompletedWeeks}: its Friday is assumed to be a session, which can only make the
 * week visible later, never earlier.
 */
export type WeekSessionEnds = ReadonlyMap<LocalDate, LocalDate>;

/**
 * Whether a date is a scheduled session on the security's venue: `true`, `false`, or `undefined`
 * when the schedule cannot say. `EodFinalityPolicy.isScheduledSession` in production.
 */
export type ScheduledSessionCheck = (
  date: LocalDate,
) => Promise<boolean | undefined>;

/**
 * Asks the venue schedule which session ended each week whose final bar is not its Friday — the
 * only weeks where the bars alone cannot tell a holiday from a halt.
 *
 * Every weekday after the week's last bar is checked from the Friday back. The first scheduled one
 * is the week's last session (the security did not print it); when none is, the last bar's own day
 * was the week's last session (a holiday-shortened week, Good Friday's Thursday). A schedule that
 * cannot answer leaves the week out, and the conservative Friday applies.
 *
 * Only weeks starting on or after `fromWeek` are asked about: a rebuild writes rows from a date on,
 * and an older week's visibility on those rows does not depend on which session ended it (its
 * Friday and its last bar are both earlier). A year the schedule cannot answer is asked once per
 * call, not once per week.
 */
export async function resolveWeekSessionEnds(input: {
  dates: readonly LocalDate[];
  isScheduledSession: ScheduledSessionCheck;
  fromWeek?: LocalDate;
}): Promise<Map<LocalDate, LocalDate>> {
  const lastBarByWeek = new Map<LocalDate, LocalDate>();
  for (const date of input.dates) {
    const weekStart = startOfIsoWeek(date);
    const last = lastBarByWeek.get(weekStart);
    if (last === undefined || date > last) {
      lastBarByWeek.set(weekStart, date);
    }
  }
  const ends = new Map<LocalDate, LocalDate>();
  const unanswerableYears = new Set<string>();
  for (const [weekStart, lastBar] of lastBarByWeek) {
    if (input.fromWeek !== undefined && weekStart < input.fromWeek) {
      continue;
    }
    const friday = fridayOfIsoWeek(weekStart);
    if (lastBar >= friday) {
      continue;
    }
    let end: LocalDate | undefined = lastBar;
    for (let day = friday; day > lastBar; day = addDays(day, -1)) {
      const year = day.slice(0, 4);
      if (unanswerableYears.has(year)) {
        end = undefined;
        break;
      }
      const scheduled = await input.isScheduledSession(day);
      if (scheduled === undefined) {
        unanswerableYears.add(year);
        end = undefined;
        break;
      }
      if (scheduled) {
        end = day;
        break;
      }
    }
    if (end !== undefined) {
      ends.set(weekStart, end);
    }
  }
  return ends;
}

/**
 * Aggregates the trading weeks that are complete at `asOf`, each eligible from its last scheduled
 * session's close.
 *
 * A week is complete once its last **scheduled** session is final: that session is on or before
 * `asOf`, the EOD cutoff the caller materializes through. Friday ends an ordinary week; Thursday
 * ends a Good Friday week; a week whose Friday is scheduled but whose security did not print it is
 * still ended by that Friday, so its last printed day never sees it. `sessionEnds` carries the venue
 * schedule's answer for every week whose last bar is not its Friday; a week it does not answer for
 * is taken to end on its Friday, which can only delay a week, never reveal one early. The rule
 * depends only on the stored bars and the venue schedule, never on the date the state was
 * materialized: a session's row is the same whenever it is calculated, which is what lets a Monitor
 * deciding Friday evening read exactly the row a backtest reads later
 * (`docs/decisions/monitor-eod-v2.md` §9).
 */
export function aggregateCompletedWeeks(
  prices: readonly DailyPrice[],
  asOf: LocalDate,
  history?: WeeklyHistoryContext,
  sessionEnds?: WeekSessionEnds,
): WeeklyPrice[] {
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
    if (weekStart === artificialFirstWeek) {
      continue;
    }
    const group = groups.get(weekStart) ?? [];
    group.push(price);
    groups.set(weekStart, group);
  }

  const weeks: WeeklyPrice[] = [];
  for (const [weekStartDate, rows] of groups) {
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) {
      throw new Error("Weekly aggregation received an empty week");
    }
    const friday = fridayOfIsoWeek(weekStartDate);
    const sessionEnd =
      last.date >= friday
        ? last.date
        : (sessionEnds?.get(weekStartDate) ?? friday);
    // Still in progress, or its last session not final yet: there is nothing to publish.
    if (compareDates(sessionEnd, asOf) > 0) {
      continue;
    }
    weeks.push({
      securityId: first.securityId,
      weekStartDate,
      weekEndDate: last.date,
      eligibleDate: sessionEnd,
      open: first.open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: last.close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
    });
  }
  return weeks;
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
 * {@link latestCompletedWeeklyBar} for many dates over one set of bars.
 *
 * The daily materializer asks the question once per trading day. Answering each by filtering and
 * sorting every weekly bar again made a thirty-year history cost its days times its weeks — some
 * fifteen million comparisons, most of a second — for an answer that only ever moves forward. Here
 * the bars are ordered once and each date is a binary search, so the same history costs its days
 * times the logarithm of its weeks.
 *
 * The answer is the same bar, in every case, including the degenerate ones: bars given in any
 * order, a date before the first eligible bar (`undefined`), and several bars sharing one eligible
 * date, where the first of them as given is returned exactly as the sort in
 * `latestCompletedWeeklyBar` returns it. `weekly.test.ts` holds the two to each other.
 */
export function completedWeeklyBarLookup(
  bars: readonly WeeklyPrice[],
): (asOf: LocalDate) => WeeklyPrice | undefined {
  // Ascending, and stable: bars sharing an eligible date keep the order they were given in.
  const ordered = [...bars].sort((left, right) =>
    left.eligibleDate.localeCompare(right.eligibleDate),
  );
  return (asOf) => {
    // The first position whose bar is not yet eligible at `asOf`.
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareDates(ordered[middle]!.eligibleDate, asOf) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    let index = low - 1;
    if (index < 0) {
      return undefined;
    }
    while (
      index > 0 &&
      compareDates(
        ordered[index - 1]!.eligibleDate,
        ordered[index]!.eligibleDate,
      ) === 0
    ) {
      index -= 1;
    }
    return ordered[index];
  };
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
