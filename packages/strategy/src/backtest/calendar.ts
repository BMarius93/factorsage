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

/**
 * A navigable view over one authoritative execution-date set.
 *
 * The dates are the **only** input: this type holds no notion of weekends, holidays or market
 * closures, and cannot decide whether a date is a trading session — it can only report whether that
 * date is in the set it was given. That is deliberate and it is the whole point. The market's
 * sessions are established by the pinned execution-calendar series' own bars
 * (`BacktestRunSnapshot.executionCalendar`), evidenced by real data, and a second implementation
 * that computed them from published rules would be a second answer to a question that already has
 * one — right up until the day the two disagreed.
 *
 * {@link buildExecutionCalendar} remains what the simulation calls; this is the same date axis with
 * the positional queries a caller outside the day loop needs — most immediately the QA validation
 * matrix, whose buy-window boundaries have to name real execution dates rather than guess at them.
 *
 * Construction sorts and deduplicates for the same reason `buildExecutionCalendar` does: the axis
 * every query below is expressed against must be guaranteed monotonic, not merely expected to be.
 */
export class ExecutionCalendar {
  /** Ascending, deduplicated execution dates. */
  readonly dates: readonly LocalDate[];

  private readonly index: ReadonlyMap<LocalDate, number>;

  constructor(dates: readonly LocalDate[]) {
    this.dates = [...new Set(dates)].sort();
    this.index = new Map(this.dates.map((date, position) => [date, position]));
  }

  /** The date set restricted to an inclusive period, exactly as the simulation restricts it. */
  static restricted(
    startDate: LocalDate,
    endDate: LocalDate,
    dates: readonly LocalDate[],
  ): ExecutionCalendar {
    return new ExecutionCalendar(
      buildExecutionCalendar(startDate, endDate, dates),
    );
  }

  get length(): number {
    return this.dates.length;
  }

  get first(): LocalDate | undefined {
    return this.dates[0];
  }

  get last(): LocalDate | undefined {
    return this.dates[this.dates.length - 1];
  }

  /** Whether the market traded on `date`, according to the authoritative set. */
  has(date: LocalDate): boolean {
    return this.index.has(date);
  }

  /** The position of `date` in the set, or `-1`. */
  positionOf(date: LocalDate): number {
    return this.index.get(date) ?? -1;
  }

  at(position: number): LocalDate | undefined {
    return this.dates[position];
  }

  /** The first execution date at or after `date`, or `undefined` past the end of the set. */
  onOrAfter(date: LocalDate): LocalDate | undefined {
    // Linear-free: the set is sorted, so a binary search answers in log n even for a thirty-year
    // calendar queried once per fixture.
    let low = 0;
    let high = this.dates.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.dates[middle] as LocalDate) < date) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return this.dates[low];
  }

  /** The last execution date at or before `date`, or `undefined` before the start of the set. */
  onOrBefore(date: LocalDate): LocalDate | undefined {
    const next = this.onOrAfter(date);
    if (next === date) {
      return date;
    }
    const position =
      next === undefined ? this.dates.length : this.positionOf(next);
    return this.dates[position - 1];
  }

  /**
   * The execution date `offset` sessions from `date`, forward or backward.
   *
   * `date` must itself be an execution date: "one session after a day the market was closed" has no
   * single meaning, and a caller asking for it has not decided what it wants.
   */
  advance(date: LocalDate, offset: number): LocalDate | undefined {
    const position = this.positionOf(date);
    if (position < 0) {
      throw new Error(
        `${date} is not an execution date in this calendar; it cannot be stepped from`,
      );
    }
    return this.dates[position + offset];
  }

  /** The first execution date of a calendar year, or `undefined` if the set covers none. */
  firstOfYear(year: number): LocalDate | undefined {
    const candidate = this.onOrAfter(`${year}-01-01`);
    return candidate?.startsWith(`${year}-`) ? candidate : undefined;
  }

  /** The last execution date of a calendar year, or `undefined` if the set covers none. */
  lastOfYear(year: number): LocalDate | undefined {
    const candidate = this.onOrBefore(`${year}-12-31`);
    return candidate?.startsWith(`${year}-`) ? candidate : undefined;
  }
}
