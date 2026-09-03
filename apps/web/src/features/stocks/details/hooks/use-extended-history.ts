"use client";

import {
  INTRINSIC_VALUE_SERIES,
  type DailyPriceResponse,
  type DailyTechnicalResponse,
  type IntrinsicValueBlendIdResponse,
  type IntrinsicValueBlendResponse,
  type IntrinsicValueModelResponse,
  type IntrinsicValueResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDailyPriceHistory,
  fetchDailyTechnicalHistory,
  fetchIntrinsicValueBlendHistory,
  fetchIntrinsicValueHistory,
  type StockHistoryWindow,
} from "../api/stock-details-api";
import { todayLocalDate } from "../utils/local-dates";

/**
 * Lower bound for a "load everything" request when the listing date is unknown. The API clamps
 * every read to its own canonical retention horizon, so an early date simply means "all of it".
 */
const FULL_HISTORY_FROM = "1900-01-01";

/**
 * Every intrinsic entry of the canonical catalog is loaded for the long ranges, because any of
 * them can be enabled from the `Indicators` picker. The identifiers come from the catalog rather
 * than a local list, so a new blend or model needs no change here.
 */
const CATALOG_BLEND_IDS = INTRINSIC_VALUE_SERIES.flatMap((series) =>
  series.source.kind === "INTRINSIC_VALUE_BLEND" ? [series.source.blendId] : [],
) as IntrinsicValueBlendIdResponse[];

const CATALOG_MODELS = INTRINSIC_VALUE_SERIES.flatMap((series) =>
  series.source.kind === "INTRINSIC_VALUE_MODEL" ? [series.source.model] : [],
) as IntrinsicValueModelResponse[];

export type ExtendedHistory = {
  readonly prices: DailyPriceResponse[];
  readonly technicals: DailyTechnicalResponse[];
  readonly intrinsicValues: IntrinsicValueResponse[];
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
 * Lazy load of the history behind the long chart ranges (5Y/MAX).
 *
 * Nothing is fetched until a range actually reaches past the loaded window, and then only back to
 * where that range starts — picking 5Y loads five years, not the whole retention horizon. `MAX` is
 * the one unbounded case and resolves to the listing date when it is known.
 *
 * What has been loaded is latched per symbol at its widest: leaving and re-entering a long range
 * keeps the superset and filters client-side, and widening fetches once more while the narrower
 * history stays on screen. Prices are required; the technical and intrinsic overlays degrade to
 * empty series when their reads fail, because a price chart without overlays is still a working
 * chart.
 */
export function useExtendedHistory(
  symbol: string,
  enabled: boolean,
  from: string | undefined,
  ipoDate: string | undefined,
): ExtendedHistoryState {
  const [state, setState] = useState<Omit<ExtendedHistoryState, "retry">>({
    status: "idle",
  });
  const [attempt, setAttempt] = useState(0);
  // The latch is per symbol: a long range on one stock must not preload history for the next.
  const [loaded, setLoaded] = useState<{ symbol: string; from: string } | null>(
    null,
  );
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  // `MAX` has no start of its own, so it asks for everything the API retains.
  const required = enabled ? (from ?? ipoDate ?? FULL_HISTORY_FROM) : undefined;

  useEffect(() => {
    if (!required) {
      return;
    }
    setLoaded((current) =>
      current && current.symbol === symbol && current.from <= required
        ? current
        : { symbol, from: required },
    );
  }, [symbol, required]);

  const activeFrom = loaded?.symbol === symbol ? loaded.from : undefined;

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    if (!activeFrom) {
      setState({ status: "idle" });
      return;
    }
    // A widening load keeps the narrower history on screen rather than dropping the chart back to
    // the details window while the older years are on their way.
    setState((current) => ({
      status: "loading",
      ...(current.history ? { history: current.history } : {}),
    }));
    const controller = new AbortController();
    const window: StockHistoryWindow = {
      from: activeFrom,
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
        fetchIntrinsicValueBlendHistory(symbol, window, CATALOG_BLEND_IDS, {
          signal: controller.signal,
        }),
      ),
      optional(
        fetchIntrinsicValueHistory(symbol, window, CATALOG_MODELS, {
          signal: controller.signal,
        }),
      ),
    ])
      .then(([prices, technicals, intrinsicValueBlends, intrinsicValues]) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setState({
          status: "ready",
          history: {
            prices,
            technicals,
            intrinsicValues,
            intrinsicValueBlends,
            window,
          },
        });
      })
      .catch(() => {
        if (requestId !== latestRequestRef.current || controller.signal.aborted) {
          return;
        }
        setState((current) => ({
          status: "error",
          ...(current.history ? { history: current.history } : {}),
        }));
      });

    return () => controller.abort();
  }, [symbol, activeFrom, attempt]);

  return { ...state, retry };
}
