import {
  BACKTEST_TRADE_DEFAULT_ORDER,
  type BacktestProgressResponse,
  type BacktestRunDetailResponse,
  type BacktestRunSummaryResponse,
  type BacktestTradeLogQuery,
  type BacktestTradePageResponse,
  type BenchmarkResponse,
  type CreateBacktestRunRequest,
} from "@intrinsic/contracts";
import { apiGet, apiGetBlob, apiPost } from "../../../lib/api/client";

/** The selectable benchmark catalog. The browser never names a provider symbol. */
export function fetchBenchmarks(options: { signal?: AbortSignal } = {}) {
  return apiGet<BenchmarkResponse[]>("/benchmarks", options);
}

export function fetchBacktestRuns(options: { signal?: AbortSignal } = {}) {
  return apiGet<BacktestRunSummaryResponse[]>("/backtests", options);
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
