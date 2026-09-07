/**
 * Shared display formatting for backtests.
 *
 * Every backtest surface — submission form, run collection, KPI tiles, holdings, trade log, chart
 * axis — formats through these helpers so one quantity never renders two different ways.
 */

/**
 * The currency backtest money is presented in.
 *
 * The browser-facing run contract carries no currency: V1 executes one benchmark and a canonical
 * security catalog that are both USD, so there is nothing yet for a run to disagree about. When a
 * run gains its own currency this constant is the single place that changes.
 */
export const BACKTEST_DISPLAY_CURRENCY = "USD";

/** What a KPI renders when the value genuinely does not exist yet. Never a fabricated zero. */
export const METRIC_PLACEHOLDER = "—";

const formatterCache = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, options: Intl.NumberFormatOptions) {
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** `12480.5` → `"$12,480.50"`. */
export function formatMoney(value: number): string {
  return numberFormat("money", {
    style: "currency",
    currency: BACKTEST_DISPLAY_CURRENCY,
  }).format(value);
}

/** `-1240.5` → `"-$1,240.50"`, `1240.5` → `"+$1,240.50"`; zero stays unsigned. */
export function formatSignedMoney(value: number): string {
  return numberFormat("signed-money", {
    style: "currency",
    currency: BACKTEST_DISPLAY_CURRENCY,
    signDisplay: "exceptZero",
  }).format(value);
}

/** Compact money for dense rows: `12480.5` → `"$12.5K"`. */
export function formatCompactMoney(value: number): string {
  return numberFormat("compact-money", {
    style: "currency",
    currency: BACKTEST_DISPLAY_CURRENCY,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Percentage points in, percentage out: the contract already reports `12.34` for 12.34%, so
 * nothing here divides by a hundred.
 */
export function formatPercent(value: number): string {
  return `${numberFormat("percent", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

/** `12.34` → `"+12.34%"`, `-3` → `"-3.00%"`; zero stays unsigned. */
export function formatSignedPercent(value: number): string {
  return `${numberFormat("signed-percent", {
    signDisplay: "exceptZero",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

/**
 * Max drawdown, which the contract reports as a positive magnitude.
 *
 * It is rendered as a decline so the direction cannot be misread as a gain; zero stays unsigned
 * because a run that never fell below its peak has no drawdown to sign.
 */
export function formatDrawdownPercent(value: number): string {
  return value > 0 ? `-${formatPercent(value)}` : formatPercent(value);
}

export function formatCount(value: number): string {
  return numberFormat("integer", { maximumFractionDigits: 0 }).format(value);
}

/** Fractional share counts are real; whole ones must not render as `12.0000`. */
export function formatShares(value: number): string {
  return numberFormat("shares", { maximumFractionDigits: 4 }).format(value);
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  // Canonical dates are plain `YYYY-MM-DD` values; parsing them lands on UTC midnight, so the
  // formatter must stay in UTC or western timezones would render the previous day.
  timeZone: "UTC",
});

/** `"2026-08-28"` → `"Aug 28, 2026"`. Returns the raw value when it is not a parseable date. */
export function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? date : dayFormat.format(parsed);
}

/** `"2026-01-02"`, `"2026-12-31"` → `"Jan 2, 2026 – Dec 31, 2026"`. */
export function formatPeriod(startDate: string, endDate: string): string {
  return `${formatDay(startDate)} – ${formatDay(endDate)}`;
}

/** An ISO timestamp as a local date and time, for "queued" / "completed" metadata. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.valueOf())) {
    return iso;
  }
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The derived full-position fraction as a percentage.
 *
 * `maximumPositions` is the only input; the fraction is `1 / maximumPositions` by product rule and
 * is never entered, so this is presentation of a derivation rather than a second setting.
 */
export function fullPositionPercent(maximumPositions: number): number {
  return maximumPositions > 0 ? 100 / maximumPositions : 0;
}

/** Trims the derived fraction to at most two decimals: `33.333…` → `"33.33"`, `10` → `"10"`. */
export function formatDerivedPercent(value: number): string {
  return numberFormat("derived-percent", {
    maximumFractionDigits: 2,
  }).format(value);
}
