import { BACKTEST_MAX_PERIOD_YEARS, subtractYears } from "@intrinsic/contracts";
import { ExecutionCalendar } from "@intrinsic/strategy";

/**
 * The matrix execution clock, and every date derived from it.
 *
 * **Why a clock rather than pinned literals.** The product horizon is relative: the loader clips
 * every projection to `[today - STOCK_HISTORY_YEARS, today]`, and the submission form offers
 * `subtractYears(today, BACKTEST_MAX_PERIOD_YEARS)` as the earliest selectable start. A fixture
 * with a hard-coded start is therefore correct only on the day it was written — the day after, it
 * asks for a period whose oldest part the loader silently clips away, and the "thirty-year" run
 * quietly becomes a 29-year-and-364-day run against a horizon nobody re-checked.
 *
 * **Why an execution calendar rather than a holiday rule.** Which dates a run simulates is settled
 * by the pinned execution-calendar series' own bars, and by nothing else
 * (`ai/architecture/backtest-execution.md`). The matrix therefore never decides whether a date is a
 * trading session: it asks {@link ExecutionCalendar}, which can only answer from the authoritative
 * date set it was constructed with. Every session-shaped value below — the first date a run
 * simulates, its last, the session before another — is an index into that set.
 *
 * **Determinism.** Every value here is a pure function of `(asOfDate, executionCalendar)`, so the
 * same clock and the same canonical date set always yield the identical matrix.
 */

/** `YYYY-MM-DD`. */
type LocalDate = string;

export type QaMatrixPeriod = {
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  /** The first date the engine actually simulates: the first execution date at or after the start. */
  readonly firstExecutionDate: LocalDate;
};

export type QaMatrixPeriods = {
  /** The declared clock. */
  readonly asOfDate: LocalDate;
  /**
   * The exact product horizon for this clock — the oldest date any run may request.
   *
   * `subtractYears(asOfDate, BACKTEST_MAX_PERIOD_YEARS)`: the same day the New Backtest form offers
   * as its earliest start and the same rule the loader clamps its product target with. It is a
   * *calendar* date, deliberately — the product boundary is not a market session — and the first
   * date actually simulated is the first execution date at or after it.
   */
  readonly horizonStart: LocalDate;
  /**
   * The last simulated date every configuration shares: always an execution date, never merely a
   * calendar day, and never beyond what the calendar itself holds.
   */
  readonly periodEnd: LocalDate;
  readonly thirtyYear: QaMatrixPeriod;
  readonly tenYear: QaMatrixPeriod;
  readonly threeYear: QaMatrixPeriod;
  readonly oneYear: QaMatrixPeriod;
};

/**
 * Raised when the supplied execution calendar cannot support the matrix at this clock.
 *
 * A refusal rather than a silent shrug: the alternative is fixtures cut against a calendar nobody
 * looked at, which is precisely the class of bug this whole design exists to remove.
 */
export class QaMatrixCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaMatrixCalendarError";
  }
}

/**
 * The API's own year arithmetic for the period cap, reproduced exactly.
 *
 * `parseCreateBacktestRunRequest` rejects `endDate > addYears(startDate, 30)` using a plain
 * `setUTCFullYear`, which is deliberately **not** `subtractYears`' 29-February clamp. The two
 * disagree by one day when the clock lands on a leap day, and the matrix has to satisfy the
 * validator that actually runs, not the one it would prefer.
 */
function addYearsAsTheApiDoes(date: LocalDate, years: number): LocalDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted.toISOString().slice(0, 10);
}

function minDate(left: LocalDate, right: LocalDate): LocalDate {
  return left <= right ? left : right;
}

/** Today, as the matrix clock sees it. */
export function currentAsOfDate(now: Date = new Date()): LocalDate {
  return now.toISOString().slice(0, 10);
}

/**
 * Every matrix date for one clock, resolved against one authoritative execution calendar.
 *
 * The thirty-year period begins **exactly** at `horizonStart`, not a day inside it: the point of the
 * longest configuration is to exercise the boundary the product actually enforces. Its first
 * *simulated* date is then whatever the calendar's first session at or after that boundary is.
 *
 * `periodEnd` is the last execution date at or before the clock, additionally capped so the
 * thirty-year period cannot exceed what the submission validator permits from `horizonStart`. That
 * cap binds on exactly one kind of day — a leap day, where the horizon clamps back to 28 February
 * and the validator's cap lands a day short of the clock — and costs nothing on every other. It also
 * naturally clamps to a calendar whose data ends before the clock: a run cannot simulate past the
 * last date its execution calendar holds.
 */
export function qaMatrixPeriods(
  asOfDate: LocalDate,
  calendar: ExecutionCalendar,
): QaMatrixPeriods {
  if (calendar.length === 0) {
    throw new QaMatrixCalendarError(
      "The QA matrix needs a non-empty execution calendar: its boundary fixtures name real " +
        "execution dates and cannot be resolved without them.",
    );
  }

  const horizonStart = subtractYears(asOfDate, BACKTEST_MAX_PERIOD_YEARS);
  const latestPermitted = minDate(
    asOfDate,
    addYearsAsTheApiDoes(horizonStart, BACKTEST_MAX_PERIOD_YEARS),
  );
  const periodEnd = calendar.onOrBefore(latestPermitted);
  if (!periodEnd) {
    throw new QaMatrixCalendarError(
      `The execution calendar holds no date at or before ${latestPermitted}; its earliest is ` +
        `${calendar.first}. Capture or seed a calendar that reaches the matrix clock.`,
    );
  }

  const period = (startDate: LocalDate): QaMatrixPeriod => {
    const firstExecutionDate = calendar.onOrAfter(startDate);
    if (!firstExecutionDate || firstExecutionDate > periodEnd) {
      throw new QaMatrixCalendarError(
        `The execution calendar holds no date between ${startDate} and ${periodEnd}; a matrix ` +
          "period cannot be resolved against it.",
      );
    }
    return { startDate, endDate: periodEnd, firstExecutionDate };
  };

  return {
    asOfDate,
    horizonStart,
    periodEnd,
    thirtyYear: period(horizonStart),
    tenYear: period(subtractYears(periodEnd, 10)),
    threeYear: period(subtractYears(periodEnd, 3)),
    oneYear: period(subtractYears(periodEnd, 1)),
  };
}

/**
 * The execution dates the `L10` boundary fixtures are cut against.
 *
 * Every one is an index into the authoritative set — `first`, `last`, `advance(±1)`, `firstOfYear`,
 * `lastOfYear` — so none of them can be a day the market was shut. Naming them here rather than
 * inside the list definition lets a test assert the *intent* ("one session after the ten-year run
 * opens") against the same anchor the fixture was built from, instead of re-deriving the answer and
 * agreeing with itself.
 */
export type QaMatrixBoundaryDates = {
  /** The first date the thirty-year run simulates. */
  readonly firstExecutionDate: LocalDate;
  /** The execution date immediately after it. */
  readonly secondExecutionDate: LocalDate;
  /** The last date every run simulates. */
  readonly lastExecutionDate: LocalDate;
  /** One session after the ten-year run opens: excludes its opening date and nothing else. */
  readonly oneAfterTenYearOpen: LocalDate;
  /** One session before the one-year run opens: the last date eligible before it. */
  readonly oneBeforeOneYearOpen: LocalDate;
  /** A single session comfortably inside the one-year run. */
  readonly singleSessionInsideOneYear: LocalDate;
  /**
   * The last execution date before the calendar-year boundary that **every** configuration crosses.
   *
   * A one-year period ending on `periodEnd` always contains exactly one 1 January — that of
   * `periodEnd`'s own year — so a window cut around it is inside the shortest run as well as the
   * longest, and both of its sides are dates the market actually traded.
   */
  readonly yearEndExecutionDate: LocalDate;
  /** The first execution date after that boundary — the very next session. */
  readonly yearStartExecutionDate: LocalDate;
};

function required(
  value: LocalDate | undefined,
  description: string,
): LocalDate {
  if (!value) {
    throw new QaMatrixCalendarError(
      `The execution calendar does not contain ${description}; the QA matrix boundary fixtures ` +
        "cannot be resolved against it.",
    );
  }
  return value;
}

export function qaMatrixBoundaryDates(
  periods: QaMatrixPeriods,
  calendar: ExecutionCalendar,
): QaMatrixBoundaryDates {
  // The year boundary the one-year period crosses, which every longer period therefore crosses too.
  const boundaryYear = Number(periods.periodEnd.slice(0, 4));
  const yearStart = required(
    calendar.firstOfYear(boundaryYear),
    `an execution date in ${boundaryYear}`,
  );

  return {
    firstExecutionDate: periods.thirtyYear.firstExecutionDate,
    secondExecutionDate: required(
      calendar.advance(periods.thirtyYear.firstExecutionDate, 1),
      "a second execution date after the longest run opens",
    ),
    lastExecutionDate: periods.periodEnd,
    oneAfterTenYearOpen: required(
      calendar.advance(periods.tenYear.firstExecutionDate, 1),
      "an execution date after the ten-year run opens",
    ),
    oneBeforeOneYearOpen: required(
      calendar.advance(periods.oneYear.firstExecutionDate, -1),
      "an execution date before the one-year run opens",
    ),
    singleSessionInsideOneYear: required(
      calendar.advance(periods.oneYear.firstExecutionDate, 10),
      "ten execution dates inside the one-year run",
    ),
    yearEndExecutionDate: required(
      calendar.advance(yearStart, -1),
      `an execution date before ${yearStart}`,
    ),
    yearStartExecutionDate: yearStart,
  };
}
