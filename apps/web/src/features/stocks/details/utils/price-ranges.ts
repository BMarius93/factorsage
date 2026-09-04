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
 *
 * `MAX` has no calendar shift of its own and returns `undefined`: its start is the security's
 * permitted history bound, which the API reports and the page reads from there.
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
