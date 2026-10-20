import type {
  DailyPriceResponse,
  StockSummaryQuoteResponse,
} from "@intrinsic/contracts";

/**
 * Display-level summary of the latest end-of-day bar.
 *
 * These are presentation derivations over canonical EOD data, not new market semantics: the change
 * is simply the latest close versus the previous trading day's close, and the range is the high and
 * low of the trailing year — the conventional 52-week range. The page builds it from the summary's
 * quote, which the API selects over that year, or — when only the chart's window has arrived — from
 * that one-year window's rows; both describe the same canonical bars.
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

/**
 * The same summary from the API's latest-state quote: the newest bar, the session before it and the
 * trailing year's high and low, already selected by the server. The change is derived exactly as
 * {@link summarizePrices} derives it.
 */
export function summarizeQuote(quote: StockSummaryQuoteResponse): PriceSummary {
  const change =
    quote.previousClose !== undefined &&
    quote.previousDate !== undefined &&
    quote.previousClose > 0
      ? {
          absolute: quote.close - quote.previousClose,
          fraction: (quote.close - quote.previousClose) / quote.previousClose,
          previousClose: quote.previousClose,
          previousDate: quote.previousDate,
        }
      : undefined;
  return {
    latestClose: quote.close,
    latestDate: quote.date,
    latestVolume: quote.volume,
    dayHigh: quote.high,
    dayLow: quote.low,
    ...(change ? { change } : {}),
    windowHigh: quote.rangeHigh,
    windowLow: quote.rangeLow,
  };
}
