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
