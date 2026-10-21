import type {
  MarketOverviewPeriod,
  MarketOverviewSparkline,
} from "@intrinsic/contracts";

/**
 * How a return reads, and what it means.
 *
 * - `positive` / `negative` — signed, always: `+4.3%`, `−1.2%` (a real minus sign, U+2212, so the
 *   two widths match in tabular figures);
 * - `zero` — a return that rounds to nothing at display precision, `0.0%` with no sign and no
 *   colour: the instrument did not move, which is a fact;
 * - `unavailable` — `—`: the history cannot support this period. Never `0.0%`, which would claim a
 *   fact the data does not hold.
 */
export type ReturnTone = "positive" | "negative" | "zero" | "unavailable";

const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const TWO_DECIMALS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A return as the grid shows it: one decimal, signed, with its tone.
 *
 * One decimal because a watchlist row is read at a glance, and a tenth of a percent is the resolution
 * an overview is read at. The tone is decided from the *displayed* value,
 * so `+0.0%` in green can never appear: anything that rounds to zero is `zero`.
 */
export function formatReturn(value: number | null): {
  readonly text: string;
  readonly tone: ReturnTone;
} {
  if (value === null || !Number.isFinite(value)) {
    return { text: "—", tone: "unavailable" };
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) {
    return { text: "0.0%", tone: "zero" };
  }
  const magnitude = ONE_DECIMAL.format(Math.abs(rounded));
  return rounded > 0
    ? { text: `+${magnitude}%`, tone: "positive" }
    : { text: `−${magnitude}%`, tone: "negative" };
}

/** What each period label stands for, for a screen reader and a tooltip. */
export const PERIOD_NAMES: Record<MarketOverviewPeriod, string> = {
  "1W": "1 week",
  "1M": "1 month",
  "3M": "3 months",
  "6M": "6 months",
  YTD: "Year to date",
  "1Y": "1 year",
};

/** A return in words, at two decimals: `1 month: up 4.32%`. */
export function describeReturn(
  period: MarketOverviewPeriod,
  value: number | null,
): string {
  const name = PERIOD_NAMES[period];
  if (value === null || !Number.isFinite(value)) {
    return `${name}: not available`;
  }
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) {
    return `${name}: unchanged`;
  }
  return `${name}: ${rounded > 0 ? "up" : "down"} ${TWO_DECIMALS.format(Math.abs(rounded))}%`;
}

/**
 * A trend line's colour: the direction of the return it is drawn beside, read from the *displayed*
 * return so a line is never green next to `0.0%`. No return, no direction.
 */
export function returnDirection(
  value: number | null,
): "positive" | "negative" | "flat" {
  const { tone } = formatReturn(value);
  return tone === "positive" || tone === "negative" ? tone : "flat";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function parseSessionDate(date: string): Date | null {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

/**
 * A session as `9 Oct`.
 *
 * Read in UTC, not the reader's zone: the session is a calendar date the exchange decided, not an
 * instant, and rendering `2026-10-09` locally turns it into `8 Oct` for anybody west of Greenwich.
 * The names are a fixed table rather than `Intl`, because ICU renders September as `Sep` in one
 * runtime and `Sept` in the next, and these strings end up in screenshots and assertions.
 */
export function formatSessionDate(date: string): string {
  const parsed = parseSessionDate(date);
  if (!parsed) {
    return date;
  }
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()] as string}`;
}

/** A session as `9 Oct 2026`. */
function formatSessionDateWithYear(date: string): string {
  const parsed = parseSessionDate(date);
  return parsed ? `${formatSessionDate(date)} ${parsed.getUTCFullYear()}` : date;
}

/**
 * What a screen reader is told about one period's trend line: the fund, the period, the sessions it
 * spans and where it went. Built from the response, never from the drawing.
 */
export function describeSparkline(
  ticker: string,
  period: MarketOverviewPeriod,
  sparkline: MarketOverviewSparkline | null,
  value: number | null,
): string {
  const name = PERIOD_NAMES[period].toLowerCase();
  if (!sparkline) {
    return `${ticker} ${name} trend: not available`;
  }
  const span = `${formatSessionDateWithYear(sparkline.startDate)} to ${formatSessionDateWithYear(sparkline.endDate)}`;
  const direction = describeReturn(period, value).replace(/^[^:]+: /, "");
  return `${ticker} ${name} trend, closes from ${span}, ${direction}`;
}
