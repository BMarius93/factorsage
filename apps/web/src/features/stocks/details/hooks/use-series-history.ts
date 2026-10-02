"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StockHistoryWindow } from "../api/stock-details-api";
import { mergeHistory } from "../utils/history-window";
import { shiftLocalDateDays } from "../utils/local-dates";

export type SeriesHistoryStatus = "idle" | "loading" | "error";

export type SeriesHistory<Row> = {
  /**
   * The chosen series' sessions, oldest first, exactly as the API returned them — only ever for the
   * series currently chosen. Empty while that series' first window is still on its way.
   */
  readonly rows: readonly Row[];
  /** The chosen series' rows have arrived at least once, so an empty `rows` means no sessions. */
  readonly loaded: boolean;
  readonly status: SeriesHistoryStatus;
  /** Asks again for whatever the chosen series is still missing. */
  readonly retry: () => void;
};

/** How one family's history is asked for: one series of one security over one window. */
export type SeriesHistoryFetch<Id extends string, Row> = (
  symbol: string,
  window: StockHistoryWindow,
  id: Id,
  options: { readonly signal?: AbortSignal },
) => Promise<Row[]>;

type LoadedSeries<Id extends string, Row> = {
  readonly symbol: string;
  readonly id: Id;
  /** Everything from here to `to` is held for this series of this security. */
  readonly coveredFrom: string;
  readonly to: string;
  readonly rows: readonly Row[];
};

/**
 * What a set of held rows answers for: one series of one security up to one window end. Rows held
 * for anything else are never shown or extended — not another security's, and not a window that
 * ended elsewhere.
 */
function sameHistory<Id extends string, Row>(
  loaded: LoadedSeries<Id, Row> | null,
  symbol: string,
  id: Id | null,
  to: string,
): loaded is LoadedSeries<Id, Row> {
  return (
    loaded !== null &&
    loaded.symbol === symbol &&
    loaded.id === id &&
    loaded.to === to
  );
}

const NO_ROWS: readonly never[] = [];

/**
 * The chosen series' history, kept covering exactly what the page has loaded: the one loader behind
 * every single-choice series the chart draws in a pane of its own — a Fundamental Metric, a valuation
 * ratio. Each family keeps its own hook over this one, with its own request and its own meaning; the
 * request lifecycle is the only thing they share.
 *
 * Selective by construction: nothing is fetched until a series is chosen, and then only that
 * series, for the history the price chart already holds — `[from, to]`, where `from` is the page's
 * loaded-from watermark. When older price history arrives and the watermark moves back, only the
 * gap is asked for and merged in, so panning with a series on costs one small request per window
 * and nothing already held is fetched again. Choosing a different series asks for that series'
 * whole window; its rows replace the previous series', which are never shown under the new
 * series' name — not even for the render before its answer arrives.
 *
 * Only the newest request may land. Every change of security, series, watermark or retry aborts the
 * request in flight and tags the next one, so a slow answer for a series the user has already moved
 * away from can never overwrite the one they chose after it. A failed request merges nothing and
 * moves no watermark: `retry` asks for exactly what is still missing, and a failure is never drawn
 * as an unavailable interval, which would be a false statement about the company.
 *
 * Nothing here calculates or carries a value. Every session arrives as the backend answered it,
 * absence included.
 */
export function useSeriesHistory<
  Id extends string,
  Row extends { date: string },
>(input: {
  readonly symbol: string;
  readonly id: Id | null;
  /** The earliest date the page's price history covers. */
  readonly from: string;
  /** The newest session the page's price history holds. */
  readonly to: string;
  /** The family's request. A module-level function, so it never re-runs the effect. */
  readonly fetch: SeriesHistoryFetch<Id, Row>;
}): SeriesHistory<Row> {
  const { symbol, id, from, to, fetch } = input;
  const [loadedSeries, setLoadedSeries] = useState<LoadedSeries<
    Id,
    Row
  > | null>(null);
  // The status belongs to the series it was reached for, so one series' failure is never shown
  // under the next series' name in the render before that series' own request starts.
  const requestKey = id === null ? null : `${symbol}|${id}|${to}`;
  const [request, setRequest] = useState<{
    readonly key: string | null;
    readonly status: SeriesHistoryStatus;
  }>({ key: null, status: "idle" });
  const [attempt, setAttempt] = useState(0);
  // The request decision reads what is held without depending on it, so a landed answer never
  // re-runs the effect that asked for it.
  const loadedRef = useRef<LoadedSeries<Id, Row> | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // Every run invalidates whatever was asked for before it, answered or not.
    const requestId = ++requestRef.current;
    if (id === null) {
      setRequest({ key: null, status: "idle" });
      return;
    }
    const key = `${symbol}|${id}|${to}`;
    const held = loadedRef.current;
    const same = sameHistory(held, symbol, id, to);
    if (same && held.coveredFrom <= from) {
      setRequest({ key, status: "idle" });
      return;
    }
    // The same series extends backwards by the gap alone; another series needs its whole window.
    const window: StockHistoryWindow = same
      ? { from, to: shiftLocalDateDays(held.coveredFrom, -1) }
      : { from, to };
    const controller = new AbortController();
    setRequest({ key, status: "loading" });
    fetch(symbol, window, id, { signal: controller.signal })
      .then((rows) => {
        if (requestId !== requestRef.current || controller.signal.aborted) {
          return;
        }
        const base = loadedRef.current;
        const next: LoadedSeries<Id, Row> = {
          symbol,
          id,
          coveredFrom: window.from,
          to,
          rows: sameHistory(base, symbol, id, to)
            ? mergeHistory(
                base.rows,
                rows,
                (row) => row.date,
                (row) => row.date,
              )
            : rows,
        };
        loadedRef.current = next;
        setLoadedSeries(next);
        setRequest({ key, status: "idle" });
      })
      .catch(() => {
        if (requestId !== requestRef.current || controller.signal.aborted) {
          return;
        }
        setRequest({ key, status: "error" });
      });
    return () => controller.abort();
  }, [symbol, id, from, to, attempt, fetch]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  const current = sameHistory(loadedSeries, symbol, id, to)
    ? loadedSeries
    : null;
  let status: SeriesHistoryStatus;
  if (requestKey === null) {
    status = "idle";
  } else if (request.key === requestKey) {
    status = request.status;
  } else {
    // The render before this series' effect has run: rows it does not have yet are loading —
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
