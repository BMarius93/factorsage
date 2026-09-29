"use client";

import type {
  DailyFundamentalMetricResponse,
  FundamentalMetricId,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDailyFundamentalHistory,
  type StockHistoryWindow,
} from "../api/stock-details-api";
import { mergeHistory } from "../utils/history-window";
import { shiftLocalDateDays } from "../utils/local-dates";

export type FundamentalHistoryStatus = "idle" | "loading" | "error";

export type FundamentalHistory = {
  /**
   * The chosen metric's sessions, oldest first, exactly as the API returned them — only ever for
   * the metric currently chosen. Empty while that metric's first window is still on its way.
   */
  readonly rows: readonly DailyFundamentalMetricResponse[];
  /** The chosen metric's rows have arrived at least once, so an empty `rows` means no sessions. */
  readonly loaded: boolean;
  readonly status: FundamentalHistoryStatus;
  /** Asks again for whatever the chosen metric is still missing. */
  readonly retry: () => void;
};

type LoadedMetric = {
  readonly metricId: FundamentalMetricId;
  /** Everything from here to the window end is held for this metric. */
  readonly coveredFrom: string;
  readonly rows: readonly DailyFundamentalMetricResponse[];
};

const NO_ROWS: readonly DailyFundamentalMetricResponse[] = [];

/**
 * The chosen Fundamental Metric's history, kept covering exactly what the page has loaded.
 *
 * Selective by construction: nothing is fetched until a metric is chosen, and then only that
 * metric, for the history the price chart already holds — `[from, to]`, where `from` is the page's
 * loaded-from watermark. When older price history arrives and the watermark moves back, only the
 * gap is asked for and merged in, so panning with a metric on costs one small request per window
 * and nothing already held is fetched again. Choosing a different metric asks for that metric's
 * whole window; its rows replace the previous metric's, which are never shown under the new
 * metric's name — not even for the render before its answer arrives.
 *
 * Only the newest request may land. Every change of metric, watermark or retry aborts the request
 * in flight and tags the next one, so a slow answer for a metric the user has already moved away
 * from can never overwrite the one they chose after it. A failed request merges nothing and moves
 * no watermark: `retry` asks for exactly what is still missing, and a failure is never drawn as an
 * unavailable interval, which would be a false statement about the company.
 *
 * Nothing here calculates or carries a value. Every session arrives already materialized by the
 * backend, absence included.
 */
export function useFundamentalHistory(input: {
  readonly symbol: string;
  readonly metricId: FundamentalMetricId | null;
  /** The earliest date the page's price history covers. */
  readonly from: string;
  /** The end of the page's window. */
  readonly to: string;
}): FundamentalHistory {
  const { symbol, metricId, from, to } = input;
  const [loadedMetric, setLoadedMetric] = useState<LoadedMetric | null>(null);
  // The status belongs to the metric it was reached for, so one metric's failure is never shown
  // under the next metric's name in the render before that metric's own request starts.
  const [request, setRequest] = useState<{
    readonly metricId: FundamentalMetricId | null;
    readonly status: FundamentalHistoryStatus;
  }>({ metricId: null, status: "idle" });
  const [attempt, setAttempt] = useState(0);
  // The request decision reads what is held without depending on it, so a landed answer never
  // re-runs the effect that asked for it.
  const loadedRef = useRef<LoadedMetric | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // Every run invalidates whatever was asked for before it, answered or not.
    const requestId = ++requestRef.current;
    if (metricId === null) {
      setRequest({ metricId, status: "idle" });
      return;
    }
    const held = loadedRef.current;
    const same = held !== null && held.metricId === metricId;
    if (same && held.coveredFrom <= from) {
      setRequest({ metricId, status: "idle" });
      return;
    }
    // The same metric extends backwards by the gap alone; another metric needs its whole window.
    const window: StockHistoryWindow = same
      ? { from, to: shiftLocalDateDays(held.coveredFrom, -1) }
      : { from, to };
    const controller = new AbortController();
    setRequest({ metricId, status: "loading" });
    fetchDailyFundamentalHistory(symbol, window, metricId, {
      signal: controller.signal,
    })
      .then((rows) => {
        if (requestId !== requestRef.current || controller.signal.aborted) {
          return;
        }
        const base = loadedRef.current;
        const next: LoadedMetric = {
          metricId,
          coveredFrom: window.from,
          rows:
            base !== null && base.metricId === metricId
              ? mergeHistory(
                  base.rows,
                  rows,
                  (row) => row.date,
                  (row) => row.date,
                )
              : rows,
        };
        loadedRef.current = next;
        setLoadedMetric(next);
        setRequest({ metricId, status: "idle" });
      })
      .catch(() => {
        if (requestId !== requestRef.current || controller.signal.aborted) {
          return;
        }
        setRequest({ metricId, status: "error" });
      });
    return () => controller.abort();
  }, [symbol, metricId, from, to, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  const current =
    metricId !== null && loadedMetric?.metricId === metricId
      ? loadedMetric
      : null;
  let status: FundamentalHistoryStatus;
  if (metricId === null) {
    status = "idle";
  } else if (request.metricId === metricId) {
    status = request.status;
  } else {
    // The render before this metric's effect has run: rows it does not have yet are loading —
    // nothing may read as "no values" in that frame — and rows it already holds are current.
    status = current === null ? "loading" : "idle";
  }
  return {
    rows: current?.rows ?? NO_ROWS,
    loaded: current !== null,
    status,
    retry,
  };
}
