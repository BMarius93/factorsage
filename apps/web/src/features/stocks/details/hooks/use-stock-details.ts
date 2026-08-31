"use client";

import type { StockDetailsResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../../lib/api/client";
import {
  fetchStockDetails,
  type StockHistoryWindow,
} from "../api/stock-details-api";
import { shiftLocalDate, todayLocalDate } from "../utils/local-dates";

export type StockDetailsStatus = "loading" | "ready" | "not-found" | "error";

export type StockDetailsState = {
  readonly status: StockDetailsStatus;
  readonly details?: StockDetailsResponse;
  /** The bounded window the ready details were requested for. */
  readonly window?: StockHistoryWindow;
  /** Re-issues the load after a transient failure. */
  readonly retry: () => void;
};

/** Stock Details defaults to one year of history; longer ranges load lazily on demand. */
export function detailsWindow(now: () => Date = () => new Date()): StockHistoryWindow {
  const to = todayLocalDate(now);
  return { from: shiftLocalDate(to, { years: -1 }), to };
}

/**
 * Loads the composite Stock Details payload for a symbol.
 *
 * A 404 is a product state, not a failure: the symbol is not in the supported Security catalog.
 * A 400 means the route segment never was a plausible symbol, which the page treats the same way.
 * Anything else is a transient error the user may retry. Responses are sequence-guarded so a slow
 * response for a previous symbol can never overwrite the current one.
 */
export function useStockDetails(symbol: string): StockDetailsState {
  type TrackedState = Omit<StockDetailsState, "retry"> & { symbolKey: string };
  const [state, setState] = useState<TrackedState>({
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
    const window = detailsWindow();

    fetchStockDetails(symbol, window, { signal: controller.signal })
      .then((details) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setState({ status: "ready", details, window, symbolKey: symbol });
      })
      .catch((error: unknown) => {
        if (requestId !== latestRequestRef.current || controller.signal.aborted) {
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

  // A symbol change re-renders before the load effect runs; the previous stock's state must not
  // leak into that frame.
  if (state.symbolKey !== symbol) {
    return { status: "loading", retry };
  }
  return {
    status: state.status,
    ...(state.details ? { details: state.details } : {}),
    ...(state.window ? { window: state.window } : {}),
    retry,
  };
}
