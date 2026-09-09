import type {
  BacktestProgressResponse,
  BacktestRunDetailResponse,
  BacktestRunSummaryResponse,
  BenchmarkResponse,
  CreateBacktestRunRequest,
} from "@intrinsic/contracts";
import { apiGet, apiPost } from "../../../lib/api/client";

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
