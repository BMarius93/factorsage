import type { LocalDate } from "@intrinsic/domain";
import { createEvaluationFrame, type EvaluationFrame } from "../frame.js";
import type { OperandKey } from "../operands.js";

/**
 * One calendar-year slice of a run's execution calendar.
 *
 * A window is a **data-loading and progress boundary only**. The simulation that consumes them is
 * one continuous run: cash, positions, level state, accumulators and the comparison scenarios all
 * flow from one window into the next, so splitting a period into years cannot move a number. See
 * `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md`.
 *
 * `from`/`to` are the *requested* range a loader should project for this window — the calendar year
 * clamped to the run's own period — while `dates` are the execution-calendar days actually
 * simulated inside it. They differ at both ends of the run: a run starting 2000-05-10 asks its
 * first window for 2000-05-10..2000-12-31, not for the whole of 2000.
 */
export type BacktestExecutionWindow = {
  /** The calendar year, as `YYYY`. */
  year: string;
  /** 0-based position in the run's window sequence. */
  index: number;
  /** First requested date: the run's start date, or `YYYY-01-01` for a later year. */
  from: LocalDate;
  /** Last requested date: `YYYY-12-31`, or the run's end date for the final year. */
  to: LocalDate;
  /** Execution-calendar dates inside this window, ascending. Never empty. */
  dates: readonly LocalDate[];
};

/**
 * Splits a run's execution calendar into consecutive calendar-year windows.
 *
 * Calendar years, deliberately, rather than rolling 365-day chunks: the canonical price and derived
 * projections are already stored and cached per calendar year (`prices:1D:<year>`,
 * `daily-state:<year>`), so a year-aligned window reads whole chunks instead of straddling two.
 *
 * A year the calendar has no trading day in produces no window — there would be nothing to load and
 * nothing to simulate — which also makes `dates` non-empty by construction.
 */
export function planExecutionWindows(
  calendar: readonly LocalDate[],
  startDate: LocalDate,
  endDate: LocalDate,
): BacktestExecutionWindow[] {
  const windows: BacktestExecutionWindow[] = [];
  let current: { year: string; dates: LocalDate[] } | null = null;

  for (const date of calendar) {
    const year = date.slice(0, 4);
    if (!current || current.year !== year) {
      current = { year, dates: [] };
      windows.push({
        year,
        index: windows.length,
        from: maxDate(startDate, `${year}-01-01`),
        to: minDate(endDate, `${year}-12-31`),
        dates: current.dates,
      });
    }
    current.dates.push(date);
  }

  return windows;
}

function maxDate(left: LocalDate, right: LocalDate): LocalDate {
  return left >= right ? left : right;
}

function minDate(left: LocalDate, right: LocalDate): LocalDate {
  return left <= right ? left : right;
}

/**
 * One security's last projected row, kept between windows.
 *
 * This is the whole of the prior-year context a Trigger needs. `evaluateMarketTrigger` reads
 * exactly `index - 1` of the security's **own** frame, so a `Price crosses above EMA` on the first
 * eligible trading day of a new year needs precisely one preceding eligible row — the one that
 * actually held, whenever it was.
 *
 * A fixed calendar-day lookback cannot supply that. A security whose last 2000 bar is 2000-12-15
 * and whose next bar is 2001-01-20 has no row inside any small window before 2001-01-01, so its
 * Trigger would silently become NOT_EVALUABLE where a continuous run had a value — a year boundary
 * changing a result, which is exactly what must not happen. Carrying the row itself is exact
 * regardless of how long the gap is.
 *
 * It is read-only context: it is never simulated again, never funded again and never produces a
 * trade or an equity point, because the window's execution-calendar dates all lie after it.
 */
export type EvaluationFrameContextRow = {
  date: LocalDate;
  close: number;
  values: ReadonlyMap<OperandKey, number>;
};

/** The last row of a projected frame, or null when the frame is empty. */
export function evaluationFrameContextRow(
  frame: EvaluationFrame,
): EvaluationFrameContextRow | null {
  const index = frame.dates.length - 1;
  const date = frame.dates[index];
  if (date === undefined) {
    return null;
  }
  const values = new Map<OperandKey, number>();
  for (const [key, column] of frame.columns) {
    values.set(key, column[index] ?? Number.NaN);
  }
  return { date, close: frame.closes[index] ?? Number.NaN, values };
}

/**
 * Prepends the previous window's last row so the first date of this window has its `t - 1` value.
 *
 * Rows at or before the context row are dropped rather than kept beside it: a loader widens each
 * window by a few calendar days of its own context, so the tail of the previous year usually
 * arrives twice. Dropping the duplicates and prepending the retained row leaves exactly one row
 * before the window — the same row a continuous projection would have had at `index - 1` — whether
 * the security traded on the previous session or last traded years earlier.
 */
export function withLeadingContextRow(
  frame: EvaluationFrame,
  context: EvaluationFrameContextRow | null,
): EvaluationFrame {
  if (!context) {
    return frame;
  }

  let start = 0;
  while (
    start < frame.dates.length &&
    (frame.dates[start] as LocalDate) <= context.date
  ) {
    start += 1;
  }

  const length = frame.dates.length - start + 1;
  const dates: LocalDate[] = [context.date];
  const closes = new Float64Array(length);
  closes[0] = context.close;
  const columns = new Map<OperandKey, Float64Array>();
  for (const key of frame.columns.keys()) {
    const column = new Float64Array(length);
    column[0] = context.values.get(key) ?? Number.NaN;
    columns.set(key, column);
  }

  for (let index = start; index < frame.dates.length; index += 1) {
    const target = index - start + 1;
    dates.push(frame.dates[index] as LocalDate);
    closes[target] = frame.closes[index] ?? Number.NaN;
    for (const [key, column] of columns) {
      column[target] = frame.columns.get(key)?.[index] ?? Number.NaN;
    }
  }

  // The period boundary keeps naming the same date it named before, so a frame that reports where
  // the requested period begins still reports it after the context row shifted every index by one.
  const boundary = frame.dates[frame.periodStartIndex];
  let periodStartIndex = dates.length;
  if (boundary !== undefined) {
    for (let index = 0; index < dates.length; index += 1) {
      if ((dates[index] as LocalDate) >= boundary) {
        periodStartIndex = index;
        break;
      }
    }
  }

  return createEvaluationFrame({
    securityId: frame.securityId,
    symbol: frame.symbol,
    name: frame.name,
    dates,
    closes,
    columns,
    periodStartIndex,
  });
}
