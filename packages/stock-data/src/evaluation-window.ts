/**
 * How many calendar days a durable read must span to yield a number of trading sessions.
 *
 * What remains of the V1 Monitor's window sizing once its provisional-quote frame was removed
 * (`docs/decisions/monitor-eod-v2.md` §8): reads are addressed by date, sessions are counted in
 * trading days, and this is the one conversion between the two.
 */

/**
 * Trading sessions a year yields, after weekends and public holidays.
 *
 * Converting a window at the five-weekdays-per-week ratio is what a short lookback can get away
 * with and a long one cannot: holidays remove about nine sessions a year, so a window asked for at
 * 7/5 comes back short — in proportion to its length. At the ~1,580 sessions an `EMA 200D` needs to
 * match its canonical value, 7/5 under-asks by more than thirty sessions, silently shortening
 * exactly the warm-up the window exists to guarantee.
 */
const TRADING_DAYS_PER_YEAR = 252;
const CALENDAR_DAYS_PER_YEAR = 365.25;

/**
 * Calendar days added on top of the converted window.
 *
 * The conversion is an average; a particular stretch of calendar can still run short of it. This is
 * a fixed floor for that, not the holiday allowance — {@link TRADING_DAYS_PER_YEAR} is.
 */
const MONITOR_WINDOW_MARGIN_CALENDAR_DAYS = 30;

/**
 * Calendar days a durable read must span to yield `observations` trading sessions.
 *
 * A range that yields too few sessions does not fail — it quietly hands the reader a shorter
 * history than it was sized for, which is why the conversion is deliberately generous. The Monitor
 * evaluation sizes its reconstruction reads with it, and the stock data service its leading
 * alternative-data window.
 */
export function monitorWindowCalendarDays(observations: number): number {
  return (
    Math.ceil((observations * CALENDAR_DAYS_PER_YEAR) / TRADING_DAYS_PER_YEAR) +
    MONITOR_WINDOW_MARGIN_CALENDAR_DAYS
  );
}
