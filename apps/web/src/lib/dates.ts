/**
 * The product's one way of writing a date, a date-time and an age (UI-049).
 *
 * Every rendered date goes through here, in one fixed product locale (`en-US`), so the same instant
 * never reads "Mar 4, 2026" on one page and "04.03.2026" on the next depending on the browser.
 * Native date *inputs* are deliberately not touched: they stay in the platform's own locale, which
 * is what makes them accessible and familiar to type into.
 *
 * Two kinds of value arrive from the API and are kept apart on purpose:
 *
 * - a **day** (`"2026-08-28"`) is a calendar date — an exchange session, a membership boundary, a
 *   backtest period. It is formatted in UTC, because it parses to UTC midnight and a western
 *   timezone would otherwise render the previous day, which for a boundary is a wrong fact;
 * - an **instant** (`"2026-08-28T13:02:11.000Z"`) is a moment — a scan, a queue time, an update. It
 *   is formatted in the viewer's timezone.
 */

const LOCALE = "en-US";

const dayFormat = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A calendar day: `"2026-08-28"` → `"Aug 28, 2026"`. The raw value when unparsable. */
export function formatDay(day: string): string {
  const parsed = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? day : dayFormat.format(parsed);
}

/** An instant's date, in the viewer's timezone: `"Aug 28, 2026"`. The raw value when unparsable. */
export function formatDate(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.valueOf()) ? instant : dateFormat.format(parsed);
}

/** An instant: `"Aug 28, 2026, 1:02 PM"`. The raw value when unparsable. */
export function formatDateTime(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.valueOf())
    ? instant
    : dateTimeFormat.format(parsed);
}

/**
 * How long ago an instant was: `just now`, `4 min ago`, `3 h ago`, `2 days ago`. Pair it with
 * `useNow` so the label keeps ticking while the page stays open, and put the absolute value in
 * text a keyboard or screen-reader user can reach (`formatDateTime`).
 */
export function formatRelative(instant: string, now: Date): string {
  const then = Date.parse(instant);
  if (!Number.isFinite(then)) {
    return instant;
  }
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
