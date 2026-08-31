import { shiftLocalDate } from "./local-dates";

/**
 * Chart time ranges offered by Stock Details.
 *
 * Ranges are calendar windows anchored to the latest available trading day, never row counts:
 * "1M" means one calendar month of history, however many trading days that contains.
 */
export const PRICE_RANGE_KEYS = ["1M", "3M", "6M", "1Y", "5Y", "MAX"] as const;

export type PriceRangeKey = (typeof PRICE_RANGE_KEYS)[number];

export const DEFAULT_PRICE_RANGE: PriceRangeKey = "1Y";

const RANGE_SHIFTS: Record<
  Exclude<PriceRangeKey, "MAX">,
  { years?: number; months?: number }
> = {
  "1M": { months: -1 },
  "3M": { months: -3 },
  "6M": { months: -6 },
  "1Y": { years: -1 },
  "5Y": { years: -5 },
};

/**
 * First calendar date included in a range that ends on `latestDate`.
 * `MAX` has no lower bound and returns `undefined`.
 */
export function rangeStartDate(
  range: PriceRangeKey,
  latestDate: string,
): string | undefined {
  if (range === "MAX") {
    return undefined;
  }
  return shiftLocalDate(latestDate, RANGE_SHIFTS[range]);
}

/**
 * Whether a range reaches further back than an already-loaded data window, meaning the fuller
 * history must be loaded before the range can be rendered from real data.
 */
export function rangeExceedsWindow(
  range: PriceRangeKey,
  windowStart: string,
  latestDate: string,
): boolean {
  const start = rangeStartDate(range, latestDate);
  return start === undefined || start < windowStart;
}

/**
 * Ascending dated rows on/after `from`; the whole input when `from` is undefined (MAX).
 * Client-side range switching filters already-loaded data instead of refetching.
 */
export function sliceFromDate<T>(
  rows: readonly T[],
  from: string | undefined,
  dateOf: (row: T) => string,
): T[] {
  if (from === undefined) {
    return [...rows];
  }
  return rows.filter((row) => dateOf(row) >= from);
}
