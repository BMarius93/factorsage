import type { DailyPriceResponse } from "@intrinsic/contracts";

/**
 * Display-level summary of the latest end-of-day bar within a loaded price window.
 *
 * These are presentation derivations over canonical EOD history, not new market semantics: the
 * change is simply latest close versus the previous trading day's close, and the window range is
 * the high/low across the rows supplied (Stock Details loads a one-year window, making it the
 * conventional 52-week range).
 */
export type PriceChange = {
  absolute: number;
  /** Change as a fraction of the previous close, e.g. `0.0124` for +1.24%. */
  fraction: number;
  previousClose: number;
  previousDate: string;
};

export type PriceSummary = {
  latestClose: number;
  latestDate: string;
  latestVolume: number;
  dayHigh: number;
  dayLow: number;
  change?: PriceChange;
  windowHigh: number;
  windowLow: number;
};

/** Expects ascending EOD rows; returns `undefined` when the window is empty. */
export function summarizePrices(
  prices: readonly DailyPriceResponse[],
): PriceSummary | undefined {
  const latest = prices.at(-1);
  if (!latest) {
    return undefined;
  }
  const previous = prices.at(-2);
  const change =
    previous && previous.close > 0
      ? {
          absolute: latest.close - previous.close,
          fraction: (latest.close - previous.close) / previous.close,
          previousClose: previous.close,
          previousDate: previous.date,
        }
      : undefined;
  let windowHigh = latest.high;
  let windowLow = latest.low;
  for (const row of prices) {
    windowHigh = Math.max(windowHigh, row.high);
    windowLow = Math.min(windowLow, row.low);
  }
  return {
    latestClose: latest.close,
    latestDate: latest.date,
    latestVolume: latest.volume,
    dayHigh: latest.high,
    dayLow: latest.low,
    ...(change ? { change } : {}),
    windowHigh,
    windowLow,
  };
}
