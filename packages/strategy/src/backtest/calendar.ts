import type { LocalDate } from "@intrinsic/domain";

/**
 * The portfolio's date axis: the pinned execution calendar, restricted to the requested period.
 *
 * The execution calendar is the market's own trading days, taken from the reference series the
 * engine designates. It is **authoritative**, not one contributor to a union: a security's own
 * dates decide what that security can do, never which days the portfolio has.
 *
 * The difference is not academic. A single anomalous provider row — a bar dated on a day the
 * market was closed — used to become a portfolio trading day, and with it the run's first
 * simulated date, the base of the return index, and a month's first eligible date for the monthly
 * contribution. One malformed row in one security could move every number in the run. Intersecting
 * instead means a date exists because the market traded, and for no other reason.
 *
 * A security simply acts on the subset of these dates for which its frame has an eligible row:
 *
 * - on a date it has no row, every predicate is NOT_EVALUABLE and it takes no action;
 * - a held position is valued at its most recent close at or before the date;
 * - the portfolio still has a real, knowable value there, because cash is real.
 *
 * **The run's comparison benchmark is not consulted.** It is passive: two runs that differ only in
 * what they are compared against must produce the same trades and the same portfolio return. And
 * the calendar is required — `simulateBacktest` rejects an empty one rather than falling back to
 * the securities' dates, which would be a different methodology.
 */
export function buildExecutionCalendar(
  startDate: LocalDate,
  endDate: LocalDate,
  executionCalendarDates: readonly LocalDate[],
): LocalDate[] {
  const dates: LocalDate[] = [];
  for (const candidate of executionCalendarDates) {
    if (candidate >= startDate && candidate <= endDate) {
      dates.push(candidate);
    }
  }
  // Sorted and deduplicated here rather than trusted: the reference series is read from a store
  // that returns it ascending, but the axis every other rule is expressed against must be
  // guaranteed monotonic, not merely expected to be.
  return [...new Set(dates)].sort();
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
