"use client";

import {
  BACKTEST_TRADES_PAGE_SIZE,
  type BacktestTradePageResponse,
} from "@intrinsic/contracts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBacktestTrades } from "../api/backtests-api";

/**
 * The query parameter the trade log's page lives in.
 *
 * Deliberately specific rather than `?page=`: the result page may grow another paged section, and
 * two of them sharing one parameter would move both at once.
 */
export const TRADES_PAGE_PARAM = "tradesPage";
export const TRADES_PAGE_SIZE_PARAM = "tradesPageSize";

export type BacktestTradesState = {
  readonly page: BacktestTradePageResponse | null;
  readonly loading: boolean;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (pageSize: number) => void;
};

function positiveIntegerParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const raw = Number(params.get(key));
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : fallback;
}

/**
 * One page of a completed run's trade log, with the page number in the URL.
 *
 * The page is URL state: a link to page 3 opens page 3, a reload keeps the reader where they were,
 * and Back and Forward move between the pages they actually looked at. It is a **push**, because
 * "go back" meaning "the previous page of trades" is what a reader expects from a paginator whose
 * position is in the address bar; the cost is that a long browse leaves a long history, which is
 * the ordinary price of addressable pagination.
 *
 * `scroll: false` is not cosmetic: the trade log sits at the bottom of a long result, and paging it
 * must not fling the reader back to the page header.
 *
 * `enabled` is what keeps a queued, running or failed run from asking for a log it has not got.
 */
export function useBacktestTrades(
  runId: string,
  enabled: boolean,
): BacktestTradesState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = positiveIntegerParam(searchParams, TRADES_PAGE_PARAM, 1);
  const pageSize = positiveIntegerParam(
    searchParams,
    TRADES_PAGE_SIZE_PARAM,
    BACKTEST_TRADES_PAGE_SIZE,
  );

  const [result, setResult] = useState<BacktestTradePageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // The newest request wins: a slow page 2 must never overwrite a page 3 the reader has moved on
  // to, exactly as the run's own polling drops a response that lost a race.
  const latestRequestRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    setLoading(true);
    fetchBacktestTrades(
      runId,
      { page, pageSize },
      { signal: controller.signal },
    )
      .then((response) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setResult(response);
        setLoading(false);
      })
      .catch(() => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        // The rendered page keeps what it has: a lost request is not an empty trade log.
        setLoading(false);
      });
    return () => controller.abort();
  }, [runId, enabled, page, pageSize]);

  const navigate = useCallback(
    (next: { page?: number; pageSize?: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextPage = next.page ?? 1;
      const nextPageSize = next.pageSize ?? pageSize;
      if (nextPage <= 1) {
        params.delete(TRADES_PAGE_PARAM);
      } else {
        params.set(TRADES_PAGE_PARAM, String(nextPage));
      }
      if (nextPageSize === BACKTEST_TRADES_PAGE_SIZE) {
        params.delete(TRADES_PAGE_SIZE_PARAM);
      } else {
        params.set(TRADES_PAGE_SIZE_PARAM, String(nextPageSize));
      }
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, pageSize, router, searchParams],
  );

  return {
    page: result,
    loading,
    setPage: useCallback(
      (next: number) => navigate({ page: next }),
      [navigate],
    ),
    // A different page size makes the current page number meaningless, so it returns to the first.
    setPageSize: useCallback(
      (next: number) => navigate({ pageSize: next }),
      [navigate],
    ),
  };
}
