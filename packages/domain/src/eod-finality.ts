import {
  tradingSessionCloseInstant,
  tradingSessionDate,
} from "./security-universe.js";
import type { LocalDate } from "./stock-data.js";

/**
 * When an end-of-day bar becomes final, as a pure clock (`docs/decisions/eod-finality-v1.md`).
 *
 * FactorSage prices everything from **finalized** end-of-day bars. The provider's EOD endpoint lists
 * the current session while it is still trading, so a bar dated today is not final merely because it
 * exists: it becomes final once its session has closed and the provider has had time to publish the
 * close. That instant is the session's regular close plus a publication delay — the same convention
 * the ETF market-data refresh already applies (`docs/decisions/etf-market-data-v1.md` §7).
 *
 * This module is the clock half of finality and nothing else. It knows no holidays: whether a date
 * was a session is the trading calendar's question, and whether a stored bar was read after its
 * session became final is the provider synchronization watermark's. A date this clock calls final
 * that was not a session simply holds no bar.
 */

/** The default publication delay: a session's bar is final 30 minutes after its regular close. */
export const DEFAULT_EOD_PUBLICATION_DELAY_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant `session`'s end-of-day bar is accepted as final: its 16:00 New York close plus the delay. */
export function eodSessionFinalizedAt(
  session: LocalDate,
  publicationDelayMs: number,
): Date {
  assertDelay(publicationDelayMs);
  return new Date(
    tradingSessionCloseInstant(session).getTime() + publicationDelayMs,
  );
}

/**
 * The newest calendar date whose end-of-day bar is final at `now` — the **EOD cutoff**.
 *
 * Every price read, provider request and stored row is bounded by it: before 16:00 New York plus the
 * delay it is the previous calendar day, afterwards it is today. It is a calendar date, not
 * necessarily a session — on a Saturday evening it is that Saturday, which holds no bar — so a
 * caller that needs the newest *session* asks the trading calendar for the newest session on or
 * before it.
 *
 * Exact across daylight-saving changes: the close is resolved in New York time for the date itself,
 * never by subtracting a fixed offset from `now`.
 */
export function eodCutoffDate(now: Date, publicationDelayMs: number): LocalDate {
  assertDelay(publicationDelayMs);
  const instant = now.getTime();
  if (!Number.isFinite(instant)) {
    throw new Error("eodCutoffDate needs a valid instant");
  }
  // The New York calendar day of `now` is the latest date that can have closed by `now`; a delay of
  // more than a day would need to step back further, which the loop also handles.
  let date = tradingSessionDate(now);
  while (eodSessionFinalizedAt(date, publicationDelayMs).getTime() > instant) {
    date = shiftDate(date, -1);
  }
  return date;
}

/** Whether `session`'s bar is final at `now`. */
export function isEodSessionFinal(
  session: LocalDate,
  now: Date,
  publicationDelayMs: number,
): boolean {
  return (
    eodSessionFinalizedAt(session, publicationDelayMs).getTime() <=
    now.getTime()
  );
}

function shiftDate(date: LocalDate, days: number): LocalDate {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`\`${date}\` is not a canonical YYYY-MM-DD product date.`);
  }
  return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

function assertDelay(publicationDelayMs: number): void {
  if (!Number.isFinite(publicationDelayMs) || publicationDelayMs < 0) {
    throw new Error("The EOD publication delay must be a non-negative number");
  }
}
