"use client";

import type {
  DailyValuationRatioResponse,
  ValuationRatioId,
} from "@intrinsic/contracts";
import { fetchDailyValuationHistory } from "../api/stock-details-api";
import {
  useSeriesHistory,
  type SeriesHistory,
  type SeriesHistoryStatus,
} from "./use-series-history";

export type ValuationHistoryStatus = SeriesHistoryStatus;

export type ValuationHistory = SeriesHistory<DailyValuationRatioResponse>;

/**
 * The chosen valuation ratio's history, kept covering exactly what the page has loaded.
 *
 * Nothing is fetched until a ratio is chosen; then only that ratio — never the other four — for the
 * history the price chart holds, and only the gap when older history arrives. Only the newest
 * request may land, and a failure is a failure, never an unavailable interval. `useSeriesHistory` is
 * the lifecycle; every session arrives as the backend computed it, with the calculation Strategy,
 * Backtest and Monitor read, absence included.
 */
export function useValuationHistory(input: {
  readonly symbol: string;
  readonly ratioId: ValuationRatioId | null;
  /** The earliest date the page's price history covers. */
  readonly from: string;
  /** The newest session the page's price history holds. */
  readonly to: string;
}): ValuationHistory {
  return useSeriesHistory({
    symbol: input.symbol,
    id: input.ratioId,
    from: input.from,
    to: input.to,
    fetch: fetchDailyValuationHistory,
  });
}
