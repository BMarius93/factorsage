import type { LocalDate } from "@intrinsic/domain";
import type { EvaluationFrame } from "../frame.js";

/**
 * The portfolio's date axis: the ascending union of the eligible trading dates of every security in
 * the run **and of the engine's execution calendar**, restricted to the requested period.
 *
 * There is no trading-calendar table and each security has its own eligible dates, so a union is
 * what makes a portfolio-level loop possible; an intersection would silently drop dates.
 *
 * The execution calendar is in the union because a portfolio exists from the first day of the
 * requested period even while it holds nothing but cash. Without it, a run whose securities all
 * list years after its start would not exist until the first of them began trading: its curve
 * would appear to start at the first BUY rather than flat at 0% from the beginning, and every
 * monthly contribution before that date would be silently skipped, because a month with no
 * simulated trading date receives none.
 *
 * On an execution-calendar-only date no security has a row, so
 *
 * - every predicate is NOT_EVALUABLE and no action is taken — the existing rule, unchanged;
 * - a held position is valued at its most recent close at or before the date — also unchanged;
 * - the portfolio still has a real, knowable value, because cash is real.
 *
 * **The run's comparison benchmark is not consulted here.** It is passive: two runs that differ
 * only in what they are compared against must produce the same trades and the same portfolio
 * return. The execution calendar comes from the engine's own reference series, which the user does
 * not choose. When it is empty the axis is exactly the securities' union. Nothing is fabricated in
 * either case.
 */
export function buildExecutionCalendar(
  frames: readonly EvaluationFrame[],
  startDate: LocalDate,
  endDate: LocalDate,
  executionCalendarDates: readonly LocalDate[] = [],
): LocalDate[] {
  const dates = new Set<LocalDate>();
  const add = (candidate: LocalDate): void => {
    if (candidate >= startDate && candidate <= endDate) {
      dates.add(candidate);
    }
  };
  for (const frame of frames) {
    for (
      let index = frame.periodStartIndex;
      index < frame.dates.length;
      index += 1
    ) {
      const date = frame.dates[index] as LocalDate;
      if (date > endDate) {
        break;
      }
      add(date);
    }
  }
  for (const date of executionCalendarDates) {
    add(date);
  }
  return [...dates].sort();
}

/**
 * The simulated dates on which a monthly contribution is applied.
 *
 * `CONTRIBUTION_METHODOLOGY_VERSION` = the first simulated trading date of each calendar month,
 * except the run's very first simulated date: that day already receives the initial capital, and
 * adding a contribution on top of it would double the opening deposit. A calendar month with no
 * simulated trading date simply receives no contribution.
 */
export function buildContributionDates(
  calendar: readonly LocalDate[],
): Set<LocalDate> {
  const dates = new Set<LocalDate>();
  let previousMonth: string | null = null;
  for (let index = 0; index < calendar.length; index += 1) {
    const date = calendar[index] as LocalDate;
    const month = date.slice(0, 7);
    if (month !== previousMonth) {
      previousMonth = month;
      if (index > 0) {
        dates.add(date);
      }
    }
  }
  return dates;
}
