"use client";

import type { StockSummaryResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../../lib/api/client";
import { fetchStockSummary } from "../api/stock-details-api";

export type StockSummaryStatus = "loading" | "ready" | "not-found" | "error";

export type StockSummaryState = {
  readonly status: StockSummaryStatus;
  readonly summary?: StockSummaryResponse;
  /** Asks for the summary again after a failure. Never touches the chart's own request. */
  readonly retry: () => void;
};

/**
 * Loads the page's latest-state summary for a symbol: identity, the newest bar and every financial
 * card's reading.
 *
 * Its lifecycle is its own. It starts with the page, beside the chart's request rather than after
 * it, and a failure or a retry here never reloads the chart; the chart's failures never reach it.
 * A 404 (or a 400 for a route segment that never was a plausible symbol) is the product's
 * not-found state; anything else is a transient error the user may retry. Responses are
 * sequence-guarded and aborted on a symbol change, so a slow answer for the previous stock can
 * never land on this one.
 */
export function useStockSummary(symbol: string): StockSummaryState {
  type Tracked = {
    readonly status: StockSummaryStatus;
    readonly summary?: StockSummaryResponse;
    readonly symbolKey: string;
  };
  const [state, setState] = useState<Tracked>({
    status: "loading",
    symbolKey: symbol,
  });
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    if (symbol === "") {
      setState({ status: "not-found", symbolKey: symbol });
      return;
    }
    setState({ status: "loading", symbolKey: symbol });
    const controller = new AbortController();
    fetchStockSummary(symbol, { signal: controller.signal })
      .then((summary) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setState({ status: "ready", summary, symbolKey: symbol });
      })
      .catch((error: unknown) => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        const status =
          error instanceof ApiError &&
          (error.status === 404 || error.status === 400)
            ? "not-found"
            : "error";
        setState({ status, symbolKey: symbol });
      });
    return () => controller.abort();
  }, [symbol, attempt]);

  // The render after a symbol change, before the effect above has run: the previous stock's
  // summary must not appear under the new ticker for even one frame.
  if (state.symbolKey !== symbol) {
    return { status: "loading", retry };
  }
  return {
    status: state.status,
    ...(state.summary ? { summary: state.summary } : {}),
    retry,
  };
}
