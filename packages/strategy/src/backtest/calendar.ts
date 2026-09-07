import type { LocalDate } from "@intrinsic/domain";
import type { EvaluationFrame } from "../frame.js";

/**
 * The portfolio's date axis: the ascending union of the eligible trading dates of every security in
 * the run, restricted to the requested period.
 *
 * There is no trading-calendar table and each security has its own eligible dates, so the union is
 * what makes a portfolio-level loop possible. The intersection would silently drop dates, and
 * adopting the benchmark's calendar would add a data dependency and a product decision.
 *
 * Two rules keep it honest, and both live in the day loop rather than here:
 * - predicates are never carried forward — a security with no row on a union date takes no action;
 * - valuation *is* carried forward — a held position is valued at its most recent close at or
 *   before the date, which is the only point-in-time-correct value available.
 */
export function buildUnionCalendar(
  frames: readonly EvaluationFrame[],
  startDate: LocalDate,
  endDate: LocalDate,
): LocalDate[] {
  const dates = new Set<LocalDate>();
  for (const frame of frames) {
    for (
      let index = frame.periodStartIndex;
      index < frame.dates.length;
      index += 1
    ) {
      const date = frame.dates[index] as LocalDate;
      if (date < startDate) {
        continue;
      }
      if (date > endDate) {
        break;
      }
      dates.add(date);
    }
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
