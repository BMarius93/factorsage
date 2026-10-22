import {
  BACKTEST_RUN_DEFAULT_SORT,
  BACKTEST_TRADE_DEFAULT_ORDER,
  type BacktestProgressResponse,
  type BacktestRunDetailResponse,
  type BacktestRunPageResponse,
  type BacktestRunSort,
  type BacktestRunStatusFilter,
  type BacktestRunSummaryResponse,
  type BacktestShareResponse,
  type BacktestTradeLogQuery,
  type BacktestTradePageResponse,
  type BenchmarkResponse,
  type CreateBacktestRunRequest,
} from "@intrinsic/contracts";
import {
  apiDelete,
  apiGet,
  apiGetBlob,
  apiPost,
  apiPut,
} from "../../../lib/api/client";

/** The selectable benchmark catalog. The browser never names a provider symbol. */
export function fetchBenchmarks(options: { signal?: AbortSignal } = {}) {
  return apiGet<BenchmarkResponse[]>("/benchmarks", options);
}

/**
 * The runs still queued or executing — the ones holding a concurrency slot — as a plain list. What
 * the New backtest form reads to show the limit before anything is submitted; never the history.
 */
export function fetchActiveBacktestRuns(
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<BacktestRunSummaryResponse[]>(
    "/backtests?status=ACTIVE",
    options,
  );
}

export type BacktestRunPageQuery = {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  readonly status?: BacktestRunStatusFilter;
  readonly sort?: BacktestRunSort;
};

/**
 * One page of the run history, searched, filtered and ordered by the API — so every page and every
 * count describe the whole history, and the browser never holds more than the page on screen.
 */
export function fetchBacktestRunPage(
  query: BacktestRunPageQuery,
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q !== undefined) {
    params.set("q", query.q);
  }
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  if (query.sort !== undefined && query.sort !== BACKTEST_RUN_DEFAULT_SORT) {
    params.set("sort", query.sort);
  }
  return apiGet<BacktestRunPageResponse>(
    `/backtests?${params.toString()}`,
    options,
  );
}

export async function createBacktestRun(
  input: CreateBacktestRunRequest,
): Promise<BacktestRunDetailResponse> {
  return (await apiPost<BacktestRunDetailResponse>(
    "/backtests",
    input,
  )) as BacktestRunDetailResponse;
}

export function fetchBacktestRun(
  runId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<BacktestRunDetailResponse>(`/backtests/${runId}`, options);
}

/**
 * The polling payload.
 *
 * Deliberately separate from the run detail: the running page fetches this about once a second
 * and must not re-download the immutable configuration or a completed result on every tick.
 */
export function fetchBacktestProgress(
  runId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<BacktestProgressResponse>(
    `/backtests/${runId}/progress`,
    options,
  );
}

/**
 * The filter and order as query parameters. A default is left out rather than spelled, so an
 * unfiltered request stays the request it always was.
 */
function tradeLogParams(query: BacktestTradeLogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.symbol !== undefined) {
    params.set("symbol", query.symbol);
  }
  if (query.action !== undefined) {
    params.set("action", query.action);
  }
  if (
    query.order !== undefined &&
    query.order !== BACKTEST_TRADE_DEFAULT_ORDER
  ) {
    params.set("order", query.order);
  }
  return params;
}

/**
 * One page of a completed run's trade log, optionally narrowed to one stock and one action.
 *
 * Its own request, because the log is paged in the database: a thirty-year run can hold tens of
 * thousands of trades and the page on screen is fifty of them. The filter is applied there too, so
 * the counts and every page describe the filtered log as a whole.
 */
export function fetchBacktestTrades(
  runId: string,
  request: BacktestTradeLogQuery & { page: number; pageSize: number },
  options: { signal?: AbortSignal } = {},
) {
  const query = new URLSearchParams({
    page: String(request.page),
    pageSize: String(request.pageSize),
  });
  for (const [key, value] of tradeLogParams(request)) {
    query.set(key, value);
  }
  return apiGet<BacktestTradePageResponse>(
    `/backtests/${runId}/trades?${query.toString()}`,
    options,
  );
}

/**
 * The trade log as a CSV file: every trade the filter selects, in the order asked for — the whole
 * filtered log, not the page on screen. Built by the API, so the browser never loads the log to
 * write it.
 */
export function fetchBacktestTradesCsv(
  runId: string,
  query: BacktestTradeLogQuery,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const params = tradeLogParams(query).toString();
  return apiGetBlob(
    `/backtests/${runId}/trades/export${params ? `?${params}` : ""}`,
    options,
  );
}

/** Whether the caller's run is shared, and its public link (`docs/decisions/backtest-sharing-v1.md`). */
export function fetchBacktestShare(
  runId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<BacktestShareResponse>(`/backtests/${runId}/share`, options);
}

/** Shares a completed run, or returns the link it already has. Idempotent. */
export async function enableBacktestShare(
  runId: string,
): Promise<BacktestShareResponse> {
  return (await apiPut<BacktestShareResponse>(
    `/backtests/${runId}/share`,
    undefined,
  )) as BacktestShareResponse;
}

/** Stops sharing: the link stops working at once and is never revived. */
export async function revokeBacktestShare(runId: string): Promise<void> {
  await apiDelete(`/backtests/${runId}/share`);
}
