"use client";

import {
  INTRINSIC_VALUE_SERIES,
  type DailyPriceResponse,
  type DailyTechnicalResponse,
  type IntrinsicValueBlendIdResponse,
  type IntrinsicValueBlendResponse,
  type IntrinsicValueModelResponse,
  type IntrinsicValueResponse,
  type StockHistoryBoundsResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDailyPriceHistory,
  fetchDailyTechnicalHistory,
  fetchIntrinsicValueBlendHistory,
  fetchIntrinsicValueHistory,
  type StockHistoryWindow,
} from "../api/stock-details-api";
import { mergeHistory } from "../utils/history-window";
import { shiftLocalDateDays } from "../utils/local-dates";

/**
 * Every intrinsic entry of the canonical catalog is loaded with each history window, because any
 * of them can be enabled from the `Indicators` picker at any time. The identifiers come from the
 * catalog rather than a local list, so a new blend or model needs no change here.
 */
const CATALOG_BLEND_IDS = INTRINSIC_VALUE_SERIES.flatMap((series) =>
  series.source.kind === "INTRINSIC_VALUE_BLEND" ? [series.source.blendId] : [],
) as IntrinsicValueBlendIdResponse[];

const CATALOG_MODELS = INTRINSIC_VALUE_SERIES.flatMap((series) =>
  series.source.kind === "INTRINSIC_VALUE_MODEL" ? [series.source.model] : [],
) as IntrinsicValueModelResponse[];

export type StockHistory = {
  readonly prices: readonly DailyPriceResponse[];
  readonly technicals: readonly DailyTechnicalResponse[];
  readonly intrinsicValues: readonly IntrinsicValueResponse[];
  readonly intrinsicValueBlends: readonly IntrinsicValueBlendResponse[];
};

export type StockHistoryStatus = "idle" | "loading" | "error";

export type StockHistoryState = {
  readonly history: StockHistory;
  /** Earliest date asked for so far; everything from here to the details window is loaded. */
  readonly loadedFrom: string;
  /** Earliest date this surface may ever request for this security. */
  readonly historyStart: string;
  /**
   * Nothing older can arrive: a load has asked for history back to `historyStart`, the boundary
   * the API reports (the 30-year horizon, the listing date, or the provider's first day proven by
   * complete coverage). This comes from that report and from nothing else — an empty window is
   * never evidence of where history begins.
   */
  readonly exhausted: boolean;
  readonly status: StockHistoryStatus;
  /** Asks for history back to `from`. Already-covered, in-flight and out-of-bound asks are no-ops. */
  readonly requestFrom: (from: string) => void;
  readonly retry: () => void;
};

/**
 * The loaded Stock Details history, extended backwards on demand.
 *
 * The page opens on the bounded window the composite endpoint already returned and this hook owns
 * everything after that: which older windows have been asked for, which one is in flight, and when
 * there is nothing older left to ask for. It never refetches history it already holds and never
 * has two loads outstanding, so panning quickly across an already-covered range costs no requests
 * at all and panning quickly past the edge costs one — the widest ask wins and the rest collapse
 * into it.
 *
 * Each load asks only for the gap, `[from, loadedFrom - 1]`, and merges it in. The canonical
 * loader materializes that window plus its own derived warm-up, so the oldest newly arrived day
 * carries the same complete set of moving averages, oscillators and intrinsic values as any other
 * day. Nothing is calculated here; a series that has no value on a day stays absent.
 *
 * History is exhausted only when a load has asked for the boundary the API reports as
 * `history.start` — the 30-year horizon, the listing date, or the provider's first day, which the
 * API reports only once it has proven complete coverage. An empty window is never evidence of
 * where history begins: a provider can answer one window with nothing and still hold rows before
 * it, and reading emptiness as the listing date is exactly what turned a truncated provider
 * response into a fake listing date. An empty window still advances `loadedFrom`, so it is never
 * asked for again; the next gesture asks for the next older window, until the boundary.
 *
 * Prices are required. The technical and intrinsic reads degrade to empty on failure, because a
 * price chart without overlays is still a working chart.
 */
export function useStockHistory(input: {
  readonly symbol: string;
  readonly bounds: StockHistoryBoundsResponse;
  readonly initial: StockHistory;
  /** Start of the window `initial` was loaded for. */
  readonly initialFrom: string;
}): StockHistoryState {
  const { symbol, initialFrom } = input;
  const historyStart = input.bounds.start;

  const [history, setHistory] = useState<StockHistory>(input.initial);
  const [loadedFrom, setLoadedFrom] = useState(initialFrom);
  const [status, setStatus] = useState<StockHistoryStatus>("idle");
  const [exhausted, setExhausted] = useState(initialFrom <= historyStart);

  // Coordination is ref-based on purpose: a pan asks on every animation frame, and answering
  // "already covered" or "already in flight" must not cost a render.
  const loadedFromRef = useRef(initialFrom);
  const exhaustedRef = useRef(exhausted);
  const inFlightRef = useRef<string | null>(null);
  /** The widest start asked for while a load was in flight, replayed when it settles. */
  const pendingRef = useRef<string | null>(null);
  const failedRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const load = useCallback(
    (from: string) => {
      inFlightRef.current = from;
      setStatus("loading");
      const controller = new AbortController();
      abortRef.current = controller;
      // Only the gap: everything from `loadedFrom` onwards is already on screen.
      const window: StockHistoryWindow = {
        from,
        to: shiftLocalDateDays(loadedFromRef.current, -1),
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
          if (!mountedRef.current || controller.signal.aborted) {
            return;
          }
          inFlightRef.current = null;
          failedRef.current = null;
          loadedFromRef.current = from;
          setLoadedFrom(from);
          setHistory((current) => ({
            prices: mergeHistory(
              current.prices,
              prices,
              (row) => row.date,
              (row) => row.date,
            ),
            technicals: mergeHistory(
              current.technicals,
              technicals,
              (row) => row.date,
              (row) => row.date,
            ),
            intrinsicValues: mergeHistory(
              current.intrinsicValues,
              intrinsicValues,
              (row) => `${row.valuationDate}|${row.model}`,
              (row) => row.valuationDate,
            ),
            intrinsicValueBlends: mergeHistory(
              current.intrinsicValueBlends,
              intrinsicValueBlends,
              (row) => `${row.valuationDate}|${row.blendId}`,
              (row) => row.valuationDate,
            ),
          }));
          // Only the reported boundary exhausts history. An empty gap says nothing about where
          // history begins — it is recorded as loaded above so it is not asked for again, and the
          // next gesture simply asks for the window before it.
          if (from <= historyStart) {
            exhaustedRef.current = true;
            setExhausted(true);
          }
          setStatus("idle");
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (
            pending !== null &&
            !exhaustedRef.current &&
            pending < loadedFromRef.current
          ) {
            load(pending);
          }
        })
        .catch(() => {
          if (!mountedRef.current || controller.signal.aborted) {
            return;
          }
          inFlightRef.current = null;
          pendingRef.current = null;
          // The failed start is remembered so the viewport, which keeps asking on every frame,
          // cannot turn one transient failure into a request loop. `retry` clears it.
          failedRef.current = from;
          setStatus("error");
        });
    },
    [symbol, historyStart],
  );

  const requestFrom = useCallback(
    (from: string) => {
      if (exhaustedRef.current) {
        return;
      }
      const clamped = from < historyStart ? historyStart : from;
      if (clamped >= loadedFromRef.current) {
        return;
      }
      if (failedRef.current !== null && clamped >= failedRef.current) {
        return;
      }
      if (inFlightRef.current !== null) {
        if (pendingRef.current === null || clamped < pendingRef.current) {
          pendingRef.current = clamped;
        }
        return;
      }
      load(clamped);
    },
    [historyStart, load],
  );

  const retry = useCallback(() => {
    const failed = failedRef.current;
    failedRef.current = null;
    if (failed !== null && inFlightRef.current === null) {
      load(failed);
    }
  }, [load]);

  return {
    history,
    loadedFrom,
    historyStart,
    exhausted,
    status,
    requestFrom,
    retry,
  };
}
