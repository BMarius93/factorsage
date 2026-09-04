/**
 * Calendar math over canonical `YYYY-MM-DD` local dates.
 *
 * All arithmetic runs in UTC so a date string never shifts across a timezone boundary. These are
 * display/windowing helpers for the frontend; canonical historical correctness stays in the
 * backend.
 */

/** Today's calendar date in UTC, matching how the API derives its own "today". */
export function todayLocalDate(now: () => Date = () => new Date()): string {
  return now().toISOString().slice(0, 10);
}

/**
 * Shifts a date by whole months/years, clamping to the end of the target month rather than
 * rolling over (`2026-03-31` minus one month is `2026-02-28`, not `2026-03-03`).
 */
export function shiftLocalDate(
  date: string,
  shift: { years?: number; months?: number },
): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid local date '${date}'`);
  }
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + (shift.years ?? 0));
  parsed.setUTCMonth(parsed.getUTCMonth() + (shift.months ?? 0));
  const lastDayOfMonth = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  ).getUTCDate();
  parsed.setUTCDate(Math.min(day, lastDayOfMonth));
  return parsed.toISOString().slice(0, 10);
}

/** Shifts a date by whole calendar days. */
export function shiftLocalDateDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid local date '${date}'`);
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
