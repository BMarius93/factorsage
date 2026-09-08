import type { LocalDate } from "@intrinsic/domain";
import type { EvaluationFrame } from "../frame.js";

/**
 * The portfolio's date axis: the ascending union of the eligible trading dates of every security in
 * the run **and of the benchmark**, restricted to the requested period.
 *
 * There is no trading-calendar table and each security has its own eligible dates, so a union is
 * what makes a portfolio-level loop possible; an intersection would silently drop dates.
 *
 * The benchmark's dates are included because a portfolio exists from the moment the run starts,
 * even while it holds nothing but cash. A run whose securities all list years after its start
 * would otherwise simply not exist until the first of them began trading — its curve would appear
 * to start at the first BUY rather than at 0% from the beginning of the period. The benchmark is
 * the market's own calendar and is already loaded for exactly this period, so using it costs
 * nothing and invents nothing: on a benchmark-only date no security has a row, so
 *
 * - every predicate is NOT_EVALUABLE and no action is taken — the existing rule, unchanged;
 * - a held position is valued at its most recent close at or before the date — also unchanged;
 * - the portfolio still has a real, knowable value, because cash is real.
 *
 * When the benchmark has no data of its own the axis is exactly what it was before: the securities'
 * union. Nothing is fabricated in either case.
 */
export function buildUnionCalendar(
  frames: readonly EvaluationFrame[],
  startDate: LocalDate,
  endDate: LocalDate,
  benchmarkDates: readonly LocalDate[] = [],
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
  for (const date of benchmarkDates) {
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
