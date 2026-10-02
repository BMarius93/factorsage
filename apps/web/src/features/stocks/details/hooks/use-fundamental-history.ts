"use client";

import type {
  DailyFundamentalMetricResponse,
  FundamentalMetricId,
} from "@intrinsic/contracts";
import { fetchDailyFundamentalHistory } from "../api/stock-details-api";
import {
  useSeriesHistory,
  type SeriesHistory,
  type SeriesHistoryStatus,
} from "./use-series-history";

export type FundamentalHistoryStatus = SeriesHistoryStatus;

export type FundamentalHistory = SeriesHistory<DailyFundamentalMetricResponse>;

/**
 * The chosen Fundamental Metric's history, kept covering exactly what the page has loaded.
 *
 * Nothing is fetched until a metric is chosen; then only that metric, for the history the price
 * chart holds, and only the gap when older history arrives. Only the newest request may land, and a
 * failure is a failure, never an unavailable interval. `useSeriesHistory` is the lifecycle; every
 * session arrives as the backend materialized it, from the persisted derived state.
 */
export function useFundamentalHistory(input: {
  readonly symbol: string;
  readonly metricId: FundamentalMetricId | null;
  /** The earliest date the page's price history covers. */
  readonly from: string;
  /** The newest session the page's price history holds. */
  readonly to: string;
}): FundamentalHistory {
  return useSeriesHistory({
    symbol: input.symbol,
    id: input.metricId,
    from: input.from,
    to: input.to,
    fetch: fetchDailyFundamentalHistory,
  });
}
