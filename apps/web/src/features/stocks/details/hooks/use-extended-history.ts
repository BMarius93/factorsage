"use client";

import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDailyPriceHistory,
  fetchDailyTechnicalHistory,
  fetchIntrinsicValueBlendHistory,
  type StockHistoryWindow,
} from "../api/stock-details-api";
import { todayLocalDate } from "../utils/local-dates";

/**
 * Lower bound for a "load everything" request when the listing date is unknown. The API clamps
 * every read to its own canonical retention horizon, so an early date simply means "all of it".
 */
const FULL_HISTORY_FROM = "1900-01-01";

export type ExtendedHistory = {
  readonly prices: DailyPriceResponse[];
  readonly technicals: DailyTechnicalResponse[];
  readonly intrinsicValueBlends: IntrinsicValueBlendResponse[];
  readonly window: StockHistoryWindow;
};

export type ExtendedHistoryStatus = "idle" | "loading" | "ready" | "error";

export type ExtendedHistoryState = {
  readonly status: ExtendedHistoryStatus;
  readonly history?: ExtendedHistory;
  readonly retry: () => void;
};

/**
 * One-time full-history load behind the long chart ranges (5Y/MAX).
 *
 * Nothing is fetched until `enabled` first becomes true for the symbol; from then on the request
 * stays latched, so leaving and re-entering a long range keeps the loaded superset and range
 * switching filters client-side instead of refetching. Prices are required; the technical and
 * intrinsic overlays degrade to empty series when their reads fail, because a price chart without
 * overlays is still a working chart.
 */
export function useExtendedHistory(
  symbol: string,
  enabled: boolean,
  ipoDate: string | undefined,
): ExtendedHistoryState {
  const [state, setState] = useState<Omit<ExtendedHistoryState, "retry">>({
    status: "idle",
  });
  const [attempt, setAttempt] = useState(0);
  // The latch is per symbol: a long range on one stock must not preload history for the next.
  const [activatedFor, setActivatedFor] = useState<string | null>(null);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (enabled) {
      setActivatedFor(symbol);
    }
  }, [enabled, symbol]);

  const active = activatedFor === symbol;

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    if (!active) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const controller = new AbortController();
    const window: StockHistoryWindow = {
      from: ipoDate ?? FULL_HISTORY_FROM,
      to: todayLocalDate(),
    };
    const optional = <T>(request: Promise<T[]>): Promise<T[]> =>
      request.catch(() => []);

    Promise.all([
      fetchDailyPriceHistory(symbol, window, { signal: controller.signal }),
      optional(
        fetchDailyTechnicalHistory(symbol, window, {
          signal: controller.signal,
        }),
      ),
      optional(
        fetchIntrinsicValueBlendHistory(symbol, window, ["BALANCED"], {
          signal: controller.signal,
        }),
      ),
    ])
      .then(([prices, technicals, intrinsicValueBlends]) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setState({
          status: "ready",
          history: { prices, technicals, intrinsicValueBlends, window },
        });
      })
      .catch(() => {
        if (requestId !== latestRequestRef.current || controller.signal.aborted) {
          return;
        }
        setState({ status: "error" });
      });

    return () => controller.abort();
  }, [symbol, active, ipoDate, attempt]);

  return { ...state, retry };
}
