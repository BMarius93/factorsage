"use client";

import {
  BACKTEST_TRADE_ACTIONS,
  BACKTEST_TRADE_DEFAULT_ORDER,
  BACKTEST_TRADES_PAGE_SIZE,
  backtestTradesExportFilename,
  type BacktestTradeAction,
  type BacktestTradeLogQuery,
  type BacktestTradeOrder,
  type BacktestTradePageResponse,
} from "@intrinsic/contracts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import {
  fetchBacktestTrades,
  fetchBacktestTradesCsv,
} from "../api/backtests-api";

/**
 * The query parameter the trade log's page lives in.
 *
 * Deliberately specific rather than `?page=`: the result page may grow another paged section, and
 * two of them sharing one parameter would move both at once. The filter and the order follow the
 * same rule.
 */
export const TRADES_PAGE_PARAM = "tradesPage";
export const TRADES_PAGE_SIZE_PARAM = "tradesPageSize";
export const TRADES_SYMBOL_PARAM = "tradesSymbol";
export const TRADES_ACTION_PARAM = "tradesAction";
export const TRADES_ORDER_PARAM = "tradesOrder";

/** What the export says when it fails for a reason the API did not explain. */
const EXPORT_FAILED_MESSAGE =
  "The trades could not be exported. Try again in a moment.";

/**
 * The trade log's filter, order and export, for the completed run's log.
 *
 * Kept apart from the page itself so the running page's recent-trades list — the same component
 * without any of this — cannot grow a control by accident.
 */
export type BacktestTradeLogControls = {
  readonly symbol: string | null;
  readonly action: BacktestTradeAction | null;
  readonly order: BacktestTradeOrder;
  /** Every stock the run traded, sorted; empty until the first page arrives. */
  readonly symbols: readonly string[];
  /** Every trade the run executed, whatever the filter; null until the first page arrives. */
  readonly unfilteredCount: number | null;
  readonly setSymbol: (symbol: string | null) => void;
  readonly setAction: (action: BacktestTradeAction | null) => void;
  readonly setOrder: (order: BacktestTradeOrder) => void;
  readonly clearFilters: () => void;
  readonly exportCsv: () => void;
  readonly exporting: boolean;
  readonly exportError: string | null;
};

export type BacktestTradesState = {
  readonly page: BacktestTradePageResponse | null;
  readonly loading: boolean;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (pageSize: number) => void;
  readonly controls: BacktestTradeLogControls;
};

function positiveIntegerParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const raw = Number(params.get(key));
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : fallback;
}

/** The filter and order a URL names. A value the log does not offer is no filter at all. */
function tradeLogQueryOf(params: URLSearchParams): {
  symbol: string | null;
  action: BacktestTradeAction | null;
  order: BacktestTradeOrder;
} {
  const symbol = params.get(TRADES_SYMBOL_PARAM)?.trim() ?? "";
  const action = params.get(TRADES_ACTION_PARAM);
  return {
    symbol: symbol === "" ? null : symbol,
    action: (BACKTEST_TRADE_ACTIONS as readonly (string | null)[]).includes(
      action,
    )
      ? (action as BacktestTradeAction)
      : null,
    order: params.get(TRADES_ORDER_PARAM) === "asc" ? "asc" : "desc",
  };
}

/** Saves a file the browser already holds, under the name the export is known by. */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * One page of a completed run's trade log, with the page, the filter and the order in the URL.
 *
 * All of it is URL state: a link to Sells of AAPL, oldest first, page 3 opens exactly that, a
 * reload keeps the reader where they were, and Back and Forward move between the views they
 * actually looked at. It is a **push**, because "go back" meaning "the previous page of trades" is
 * what a reader expects from a paginator whose position is in the address bar; the cost is that a
 * long browse leaves a long history, which is the ordinary price of addressable pagination.
 * Changing the filter or the order returns to the first page, because the old page number
 * described a different list.
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
  const { symbol, action, order } = tradeLogQueryOf(searchParams);
  // Only what differs from the defaults is sent, so an unfiltered request is unchanged.
  const query = useMemo<BacktestTradeLogQuery>(
    () => ({
      ...(symbol === null ? {} : { symbol }),
      ...(action === null ? {} : { action }),
      ...(order === BACKTEST_TRADE_DEFAULT_ORDER ? {} : { order }),
    }),
    [symbol, action, order],
  );

  const [result, setResult] = useState<BacktestTradePageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // The newest request wins: a slow page 2 must never overwrite a page 3 the reader has moved on
  // to, exactly as the run's own polling drops a response that lost a race.
  const latestRequestRef = useRef(0);
  const exportingRef = useRef(false);

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
      { page, pageSize, ...query },
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
  }, [runId, enabled, page, pageSize, query]);

  // A failed export described the filter it was asked for; once the filter moves on, so does it.
  useEffect(() => {
    setExportError(null);
  }, [query]);

  const navigate = useCallback(
    (next: {
      page?: number;
      pageSize?: number;
      symbol?: string | null;
      action?: BacktestTradeAction | null;
      order?: BacktestTradeOrder;
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextPage = next.page ?? 1;
      const nextPageSize = next.pageSize ?? pageSize;
      const nextSymbol = next.symbol === undefined ? symbol : next.symbol;
      const nextAction = next.action === undefined ? action : next.action;
      const nextOrder = next.order ?? order;
      const write = (key: string, value: string | null) => {
        if (value === null) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      };
      write(TRADES_PAGE_PARAM, nextPage <= 1 ? null : String(nextPage));
      write(
        TRADES_PAGE_SIZE_PARAM,
        nextPageSize === BACKTEST_TRADES_PAGE_SIZE
          ? null
          : String(nextPageSize),
      );
      write(TRADES_SYMBOL_PARAM, nextSymbol);
      write(TRADES_ACTION_PARAM, nextAction);
      write(
        TRADES_ORDER_PARAM,
        nextOrder === BACKTEST_TRADE_DEFAULT_ORDER ? null : nextOrder,
      );
      const search = params.toString();
      router.push(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [action, order, pathname, pageSize, router, searchParams, symbol],
  );

  const exportCsv = useCallback(() => {
    // One download at a time: a second click while the first is still being written would only
    // produce the same file twice.
    if (exportingRef.current) {
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    fetchBacktestTradesCsv(runId, query)
      .then((blob) => {
        saveFile(
          blob,
          backtestTradesExportFilename(runId, {
            ...query,
            order: query.order ?? BACKTEST_TRADE_DEFAULT_ORDER,
          }),
        );
      })
      .catch((error: unknown) => {
        setExportError(requestFailureMessage(error, EXPORT_FAILED_MESSAGE));
      })
      .finally(() => {
        exportingRef.current = false;
        setExporting(false);
      });
  }, [runId, query]);

  const controls: BacktestTradeLogControls = {
    symbol,
    action,
    order,
    symbols: result?.symbols ?? [],
    unfilteredCount: result?.unfilteredCount ?? null,
    // A different filter or order makes the current page number meaningless: each returns to the
    // first page.
    setSymbol: useCallback(
      (next: string | null) => navigate({ symbol: next }),
      [navigate],
    ),
    setAction: useCallback(
      (next: BacktestTradeAction | null) => navigate({ action: next }),
      [navigate],
    ),
    setOrder: useCallback(
      (next: BacktestTradeOrder) => navigate({ order: next }),
      [navigate],
    ),
    clearFilters: useCallback(
      () => navigate({ symbol: null, action: null }),
      [navigate],
    ),
    exportCsv,
    exporting,
    exportError,
  };

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
    controls,
  };
}
