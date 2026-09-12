/**
 * Canonical calendar-date arithmetic on `YYYY-MM-DD` strings.
 *
 * It lives here because `@intrinsic/contracts` is the only package the web app may depend on, and
 * a date rule that the browser and the loader disagree about is a bug waiting to happen: the
 * `MAX` control on the New Backtest form and the loader's retention horizon must compute the same
 * day, leap years included. `@intrinsic/stock-data` re-exports these rather than keeping a second
 * implementation.
 *
 * No timezone is attached. A `YYYY-MM-DD` string is a calendar date, so every operation is done in
 * UTC and formatted back to the same shape.
 */

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Structural *and* calendar validity, so `2023-02-31` is rejected rather than rolled over. */
export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * Subtracts whole years, clamping 29 February to 28 February.
 *
 * The clamp is the reason this is shared rather than reimplemented: a naive
 * `setUTCFullYear(year - n)` on 29 February rolls forward to 1 March, which would make the
 * thirty-year horizon land on a different day every fourth year.
 */
export function subtractYears(value: string, years: number): string {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date '${value}'`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  const lastDayOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfMonth));
  return date.toISOString().slice(0, 10);
}

/**
 * Adds whole years, with the same 29 February clamp as {@link subtractYears}.
 *
 * The exact mirror, and shared for the same reason: without the clamp the two bounds of one
 * thirty-year period disagree every fourth year, so a start date the horizon check accepts is one
 * the length check rejects.
 */
export function addYears(value: string, years: number): string {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date '${value}'`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  const lastDayOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfMonth));
  return date.toISOString().slice(0, 10);
}

/**
 * How many whole years of history a `[startDate, endDate]` period requests.
 *
 * The smallest `n` for which `endDate <= addYears(startDate, n)` — that is, the number the
 * existing "a backtest period can cover at most N years" rule is stated in. Defining it once
 * matters because the same number now answers two questions: the product's absolute retention
 * horizon, and the plan's backtest depth entitlement. Two implementations of "years of history"
 * would eventually disagree by a day, and the disagreement would only show up on a leap year.
 */
export function backtestPeriodYears(
  startDate: string,
  endDate: string,
): number {
  let years = Math.max(
    0,
    Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4)),
  );
  while (years > 0 && endDate <= addYears(startDate, years - 1)) {
    years -= 1;
  }
  while (endDate > addYears(startDate, years)) {
    years += 1;
  }
  return years;
}
