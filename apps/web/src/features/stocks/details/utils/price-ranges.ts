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
 * Whether a range reaches further back than the loaded window, meaning the fuller history must be
 * loaded before the range can be rendered from real data.
 *
 * Both sides are anchored to the loaded window, never to the latest trading day. The two anchors
 * differ by however long the market has been closed, so anchoring the range to the last close
 * while comparing against a window that ends today makes the default one-year range look like it
 * reaches past its own window — and every page view would then trigger the full-history load this
 * lazy path exists to avoid. Where the range starts *on screen* is a separate question, answered
 * by `rangeStartDate` against the latest close.
 */
export function rangeExceedsWindow(
  range: PriceRangeKey,
  windowStart: string,
  windowEnd: string,
): boolean {
  const start = rangeStartDate(range, windowEnd);
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
