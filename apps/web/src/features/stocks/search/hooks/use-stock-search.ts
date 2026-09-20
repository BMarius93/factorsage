"use client";

import type { StockSearchResultResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestFailureMessage } from "../../../../lib/api/entitlement-errors";
import {
  rateLimitWaitMessage,
  retryWaitMs,
} from "../../../../lib/api/rate-limit-errors";
import { searchStocks } from "../api/stock-search-api";

/** Long enough that a normal typist issues one request per word, short enough to feel live. */
export const STOCK_SEARCH_DEBOUNCE_MS = 250;

export type StockSearchStatus = "idle" | "loading" | "ready" | "error";

export type StockSearchState = {
  /** `idle` means the query is blank and no request has been or will be issued. */
  readonly status: StockSearchStatus;
  readonly results: readonly StockSearchResultResponse[];
  /**
   * What to tell the user when `status` is `error`.
   *
   * Carried rather than hard-coded in the dropdown because the failures are not interchangeable:
   * a throttled search has to say so and name the wait, or the user retries immediately and is
   * refused again. Everything else keeps the generic copy.
   */
  readonly errorMessage?: string;
  /**
   * Whether offering "Try again" is honest. `false` while a throttled search is still inside the
   * wait the server named: a 429 is not an invitation to retry, and a button that is guaranteed to
   * be refused again is the same dead end as no explanation at all. It turns `true` when the wait
   * has elapsed, without the user having to do anything.
   */
  readonly retryable: boolean;
  /** Re-issues the current query; the error state is only useful if the user can act on it. */
  readonly retry: () => void;
};

type SearchResultState = Omit<StockSearchState, "retry">;

const IDLE: SearchResultState = {
  status: "idle",
  results: [],
  retryable: false,
};

/** Shown for any failure the API did not explain. */
export const SEARCH_UNAVAILABLE = "Search is unavailable right now.";

/** Replaces the throttled copy once its wait is over, beside a "Try again" that will now work. */
export const SEARCH_AVAILABLE = "Search is available again.";

/**
 * Debounced stock search for the global search surface.
 *
 * Two guarantees matter here and are covered by tests:
 * a blank query never reaches the network, and a slow response for an older query can never
 * overwrite a newer one — every request carries a sequence number and only the newest may commit.
 *
 * A throttled answer also holds the search off: until the server's `Retry-After` has elapsed, a new
 * query says how long is left instead of sending a request that would only be refused again.
 */
export function useStockSearch(
  query: string,
  debounceMs: number = STOCK_SEARCH_DEBOUNCE_MS,
): StockSearchState {
  const [state, setState] = useState<SearchResultState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  // When the last throttled answer said the search may be used again (epoch ms); 0 when unthrottled.
  const blockedUntilRef = useRef(0);
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

    const remainingMs = blockedUntilRef.current - Date.now();
    if (remainingMs > 0) {
      setState({
        status: "error",
        results: [],
        errorMessage: rateLimitWaitMessage(Math.ceil(remainingMs / 1000)),
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Previous results stay on screen while the next ones load, so the dropdown does not blink
      // through an empty state on every keystroke.
      setState((current) => ({
        status: "loading",
        results: current.results,
        retryable: false,
      }));

      searchStocks(term, { signal: controller.signal })
        .then((results) => {
          if (requestId !== latestRequestRef.current) {
            return;
          }
          setState({ status: "ready", results, retryable: false });
        })
        .catch((error: unknown) => {
          if (requestId !== latestRequestRef.current) {
            return;
          }
          const waitMs = retryWaitMs(error);
          blockedUntilRef.current = waitMs > 0 ? Date.now() + waitMs : 0;
          setState({
            status: "error",
            results: [],
            errorMessage: requestFailureMessage(error, SEARCH_UNAVAILABLE),
            retryable: waitMs === 0,
          });
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, debounceMs, attempt]);

  // Offer the retry again the moment the named wait is over.
  const waiting = state.status === "error" && !state.retryable;
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setTimeout(
      () =>
        setState((current) =>
          current.status === "error"
            ? { ...current, retryable: true, errorMessage: SEARCH_AVAILABLE }
            : current,
        ),
      Math.max(0, blockedUntilRef.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [waiting]);

  return { ...state, retry };
}
