import type { FundamentalMetricUnit } from "@intrinsic/contracts";
import { formatDay } from "../../../../lib/dates";

/**
 * Shared display formatting for Stock Details.
 *
 * Every surface (header, metrics, valuation, technicals, chart axis) formats values through these
 * helpers so the same quantity never renders two different ways. Formatters take the security's
 * own currency; nothing here assumes USD.
 */

const formatterCache = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, options: Intl.NumberFormatOptions) {
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** `232.139` + `"USD"` → `"$232.14"`. */
export function formatMoney(value: number, currency: string): string {
  return numberFormat(`money:${currency}`, {
    style: "currency",
    currency,
  }).format(value);
}

/** `-1.243` + `"USD"` → `"-$1.24"`, `1.243` → `"+$1.24"`; zero stays unsigned. */
export function formatSignedMoney(value: number, currency: string): string {
  return numberFormat(`signed-money:${currency}`, {
    style: "currency",
    currency,
    signDisplay: "exceptZero",
  }).format(value);
}

/** Fraction in, signed percent out: `0.0124` → `"+1.24%"`. */
export function formatSignedPercent(fraction: number): string {
  return numberFormat("signed-percent", {
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(fraction);
}

/**
 * A Fundamental Metric reading in its own unit, decided by the unit and nothing else:
 * `PERCENT` 15.42 → `"15.42%"`, `MULTIPLE` 0.75 → `"0.75x"`.
 *
 * The number is already in the unit the catalog states — percentage points or a raw ratio — so
 * nothing is scaled: 15.42 is 15.42%, never 1,542% and never 0.1542%. Display rounding keeps two
 * decimals, drops trailing zeros, and gives a multiple at least one decimal so `1` reads `1.0x`
 * and a multiple is never mistaken for a count. Rounding never hides a reading: 0.75 stays
 * `0.75x` rather than `0.8x`, and a non-zero value too small for two decimals keeps two
 * significant digits (`0.004%`) instead of reading as zero. Negative readings keep their sign;
 * there is never exponent notation.
 */
export function formatFundamentalValue(
  value: number,
  unit: FundamentalMetricUnit,
): string {
  switch (unit) {
    case "PERCENT":
      return `${formatReading(value, 0)}%`;
    case "MULTIPLE":
      return `${formatReading(value, 1)}x`;
  }
}

/** Below this magnitude two decimals would print a non-zero reading as zero. */
const SMALLEST_TWO_DECIMAL_READING = 0.005;

function formatReading(value: number, minimumFractionDigits: 0 | 1): string {
  // `-0` would print as "-0"; a signed zero is not a different reading.
  const reading = value === 0 ? 0 : value;
  if (reading !== 0 && Math.abs(reading) < SMALLEST_TWO_DECIMAL_READING) {
    // Always has fraction digits of its own, so the unit's minimum is already met.
    return numberFormat("reading-small", {
      maximumSignificantDigits: 2,
    }).format(reading);
  }
  return numberFormat(`reading:${minimumFractionDigits}`, {
    minimumFractionDigits,
    maximumFractionDigits: 2,
  }).format(reading);
}

/** Large counts such as share volume: `41_237_500` → `"41.2M"`. */
export function formatCompactNumber(value: number): string {
  return numberFormat("compact", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Exact grouped integer, e.g. employees: `164000` → `"164,000"`. */
export function formatInteger(value: number): string {
  return numberFormat("integer", { maximumFractionDigits: 0 }).format(value);
}

/** `"2026-08-28"` → `"Aug 28, 2026"`: a calendar day, through the product's one date module. */
export function formatLocalDate(date: string): string {
  return formatDay(date);
}

/** `"https://www.apple.com/"` → `"apple.com"`, for compact website links. */
export function formatWebsiteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
