"use client";

import {
  BACKTEST_RUN_DEFAULT_SORT,
  BACKTEST_RUN_QUERY_MAX_LENGTH,
  BACKTEST_RUN_SORTS,
  BACKTEST_RUN_STATUS_FILTERS,
  BACKTEST_RUNS_PAGE_SIZE,
  isTerminalBacktestStatus,
  type BacktestRunPageResponse,
  type BacktestRunSort,
  type BacktestRunStatusFilter,
} from "@intrinsic/contracts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLLECTION_PAGE_SIZES } from "../../../components/ui/CollectionFooter";
import {
  fetchBacktestRunPage,
  type BacktestRunPageQuery,
} from "../api/backtests-api";
import { BACKTEST_COLLECTION_POLL_INTERVAL_MS } from "./use-backtest-runs";

/** The query parameters the collection's view lives in, on `/backtests`. */
export const RUNS_PAGE_PARAM = "page";
export const RUNS_PAGE_SIZE_PARAM = "pageSize";
export const RUNS_QUERY_PARAM = "q";
export const RUNS_STATUS_PARAM = "status";
export const RUNS_SORT_PARAM = "sort";

const RUNS_PARAMS: ReadonlySet<string> = new Set([
  RUNS_PAGE_PARAM,
  RUNS_PAGE_SIZE_PARAM,
  RUNS_QUERY_PARAM,
  RUNS_STATUS_PARAM,
  RUNS_SORT_PARAM,
]);

/** What the reader is looking at: everything the address bar says about the collection. */
export type BacktestRunView = {
  readonly page: number;
  readonly pageSize: number;
  readonly q: string | null;
  readonly status: BacktestRunStatusFilter | null;
  readonly sort: BacktestRunSort;
};

export type BacktestRunPageStatus = "loading" | "ready" | "error";

export type BacktestRunPageState = {
  /** `error` only when there is nothing to show; a failed later read keeps the rows. */
  readonly status: BacktestRunPageStatus;
  readonly result: BacktestRunPageResponse | null;
  readonly view: BacktestRunView;
  /** A read for the view in the address bar is on its way; the rows shown are the last view's. */
  readonly loading: boolean;
  /** The last read of the view failed while older rows stayed on screen; `retry` asks again. */
  readonly failed: boolean;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (pageSize: number) => void;
  readonly setQuery: (q: string | null) => void;
  readonly setStatus: (status: BacktestRunStatusFilter | null) => void;
  readonly setSort: (sort: BacktestRunSort) => void;
  readonly clearFilters: () => void;
  readonly retry: () => void;
};

function positiveInteger(raw: string | null): number | undefined {
  const value = Number(raw);
  return raw !== null && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

/**
 * The view a URL names. A value the collection does not offer is no value at all — every status,
 * newest first, 25 rows — so a stale or hand-edited link always lands on a real view, and a page
 * size the footer cannot show never pages the table behind a control that claims another.
 */
export function viewOf(params: URLSearchParams): BacktestRunView {
  const pageSize = positiveInteger(params.get(RUNS_PAGE_SIZE_PARAM));
  const q = params.get(RUNS_QUERY_PARAM)?.trim() ?? "";
  const status = params.get(RUNS_STATUS_PARAM);
  const sort = params.get(RUNS_SORT_PARAM);
  return {
    page: positiveInteger(params.get(RUNS_PAGE_PARAM)) ?? 1,
    pageSize:
      pageSize !== undefined &&
      (COLLECTION_PAGE_SIZES as readonly number[]).includes(pageSize)
        ? pageSize
        : BACKTEST_RUNS_PAGE_SIZE,
    q: q === "" || q.length > BACKTEST_RUN_QUERY_MAX_LENGTH ? null : q,
    status: (
      BACKTEST_RUN_STATUS_FILTERS as readonly (string | null)[]
    ).includes(status)
      ? (status as BacktestRunStatusFilter)
      : null,
    sort: (BACKTEST_RUN_SORTS as readonly (string | null)[]).includes(sort)
      ? (sort as BacktestRunSort)
      : BACKTEST_RUN_DEFAULT_SORT,
  };
}

function queryOf(view: BacktestRunView): BacktestRunPageQuery {
  return {
    page: view.page,
    pageSize: view.pageSize,
    ...(view.q === null ? {} : { q: view.q }),
    ...(view.status === null ? {} : { status: view.status }),
    sort: view.sort,
  };
}

/**
 * The run history, one page at a time, searched, filtered and ordered by the API, with the whole
 * view in the URL.
 *
 * The URL is the state, as on the trade log: a link to failed runs, oldest first, page 3 opens
 * exactly that, a reload keeps the reader where they were, and Back and Forward move between the
 * views they looked at — a **push** for a page, an order or a filter, and a **replace** for a search
 * being typed, which would otherwise leave one history entry per keystroke. Any change other than
 * the page itself returns to the first page, because the old page number described another list.
 *
 * One read at a time wins: a slower answer for a view the reader has left is dropped. While a read
 * is on its way the rows of the last view stay on screen; a failed read keeps them and says so.
 *
 * While the page on screen shows a run that is still queued or executing it is read again every few
 * seconds (UI-048) — **that page**, never the history — and the polling stops once every run on it
 * is finished, or the reader moves elsewhere.
 */
export function useBacktestRunPage(): BacktestRunPageState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const view = useMemo(() => viewOf(new URLSearchParams(search)), [search]);
  const key = JSON.stringify(view);

  const [result, setResult] = useState<BacktestRunPageResponse | null>(null);
  const [status, setStatus] = useState<BacktestRunPageStatus>("loading");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    setLoading(true);
    fetchBacktestRunPage(queryOf(view), { signal: controller.signal })
      .then((page) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setResult(page);
        setStatus("ready");
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setLoading(false);
        setFailed(true);
        // With rows on screen a failed read is a notice, not a replaced page.
        setStatus((current) => (current === "ready" ? "ready" : "error"));
      });
    return () => controller.abort();
    // `key` is `view`, serialized: the effect follows what the view says, not its identity.
  }, [key, attempt]);

  const inFlight =
    result?.runs.some((run) => !isTerminalBacktestStatus(run.status)) ?? false;

  useEffect(() => {
    if (status !== "ready" || loading || failed || !inFlight) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const requestId = ++latestRequestRef.current;
      // A background read of the page on screen: its rows stay until the new ones arrive, and a
      // failed read keeps them.
      fetchBacktestRunPage(queryOf(view), { signal: controller.signal })
        .then((page) => {
          if (requestId === latestRequestRef.current) {
            setResult(page);
          }
        })
        .catch(() => undefined);
    }, BACKTEST_COLLECTION_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [status, loading, failed, inFlight, result, key]);

  const navigate = useCallback(
    (next: Partial<BacktestRunView>, mode: "push" | "replace" = "push") => {
      const merged: BacktestRunView = { ...view, page: 1, ...next };
      // The collection's own parameters in one fixed order, so one view is always one address;
      // anything else in the URL is kept as it was, after them.
      const params = new URLSearchParams();
      const write = (name: string, value: string | null) => {
        if (value !== null) {
          params.set(name, value);
        }
      };
      write(RUNS_PAGE_PARAM, merged.page <= 1 ? null : String(merged.page));
      write(
        RUNS_PAGE_SIZE_PARAM,
        merged.pageSize === BACKTEST_RUNS_PAGE_SIZE
          ? null
          : String(merged.pageSize),
      );
      write(RUNS_QUERY_PARAM, merged.q);
      write(RUNS_STATUS_PARAM, merged.status);
      write(
        RUNS_SORT_PARAM,
        merged.sort === BACKTEST_RUN_DEFAULT_SORT ? null : merged.sort,
      );
      for (const [name, value] of new URLSearchParams(search)) {
        if (!RUNS_PARAMS.has(name)) {
          params.append(name, value);
        }
      }
      const query = params.toString();
      const url = query ? `${pathname}?${query}` : pathname;
      if (mode === "replace") {
        router.replace(url, { scroll: false });
      } else {
        router.push(url, { scroll: false });
      }
    },
    [pathname, router, search, view],
  );

  return {
    status,
    result,
    view,
    loading,
    failed,
    setPage: useCallback((page: number) => navigate({ page }), [navigate]),
    setPageSize: useCallback(
      (pageSize: number) => navigate({ pageSize }),
      [navigate],
    ),
    setQuery: useCallback(
      (q: string | null) => {
        const trimmed = q?.trim() ?? "";
        navigate({ q: trimmed === "" ? null : trimmed }, "replace");
      },
      [navigate],
    ),
    setStatus: useCallback(
      (next: BacktestRunStatusFilter | null) => navigate({ status: next }),
      [navigate],
    ),
    setSort: useCallback(
      (sort: BacktestRunSort) => navigate({ sort }),
      [navigate],
    ),
    clearFilters: useCallback(
      () => navigate({ q: null, status: null }),
      [navigate],
    ),
    retry: useCallback(() => setAttempt((current) => current + 1), []),
  };
}
