"use client";

import type { StockSearchResultResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchStocks } from "../api/stock-search-api";

/** Long enough that a normal typist issues one request per word, short enough to feel live. */
export const STOCK_SEARCH_DEBOUNCE_MS = 250;

export type StockSearchStatus = "idle" | "loading" | "ready" | "error";

export type StockSearchState = {
  /** `idle` means the query is blank and no request has been or will be issued. */
  readonly status: StockSearchStatus;
  readonly results: readonly StockSearchResultResponse[];
  /** Re-issues the current query; the error state is only useful if the user can act on it. */
  readonly retry: () => void;
};

type SearchResultState = Omit<StockSearchState, "retry">;

const IDLE: SearchResultState = { status: "idle", results: [] };

/**
 * Debounced stock search for the global search surface.
 *
 * Two guarantees matter here and are covered by tests:
 * a blank query never reaches the network, and a slow response for an older query can never
 * overwrite a newer one — every request carries a sequence number and only the newest may commit.
 */
export function useStockSearch(
  query: string,
  debounceMs: number = STOCK_SEARCH_DEBOUNCE_MS,
): StockSearchState {
  const [state, setState] = useState<SearchResultState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    // Bumping on every query change also invalidates a request that is already in flight, so
    // clearing the input cannot be undone by its own late response.
    const requestId = ++latestRequestRef.current;
    const term = query.trim();

    if (term === "") {
      setState(IDLE);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Previous results stay on screen while the next ones load, so the dropdown does not blink
      // through an empty state on every keystroke.
      setState((current) => ({ status: "loading", results: current.results }));

      searchStocks(term, { signal: controller.signal })
        .then((results) => {
          if (requestId !== latestRequestRef.current) {
            return;
          }
          setState({ status: "ready", results });
        })
        .catch(() => {
          if (requestId !== latestRequestRef.current) {
            return;
          }
          setState({ status: "error", results: [] });
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, debounceMs, attempt]);

  return { ...state, retry };
}
