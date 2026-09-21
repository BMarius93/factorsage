import type {
  BacktestLiveSnapshotResponse,
  BacktestResultSummaryResponse,
} from "@intrinsic/contracts";

/**
 * The KPI row's view model, identical while a run is executing and after it completes.
 *
 * Every field is nullable on purpose: a metric that does not exist yet — a queued run, a benchmark
 * with no value at or before the run's first date — renders as a placeholder. A missing number is
 * never presented as zero, because zero is a real and very different result.
 */
export type BacktestMetricsView = {
  readonly portfolioReturnPercent: number | null;
  readonly benchmarkReturnPercent: number | null;
  readonly alphaPercent: number | null;
  readonly totalValue: number | null;
  readonly netProfit: number | null;
  readonly maxDrawdownPercent: number | null;
  readonly tradeCount: number | null;
  /**
   * Compound annual growth rate.
   *
   * It replaced "Open positions", which stopped being a result the moment a completed run began
   * liquidating everything it still held: a tile that can only ever read `0` describes nothing.
   * CAGR is already on the canonical summary and on every checkpoint, and it is the one figure that
   * makes a thirty-year total return comparable to a three-year one.
   */
  readonly portfolioCagrPercent: number | null;
};

/** Nothing measured yet: every tile is a placeholder. */
export const EMPTY_METRICS: BacktestMetricsView = {
  portfolioReturnPercent: null,
  benchmarkReturnPercent: null,
  alphaPercent: null,
  totalValue: null,
  netProfit: null,
  maxDrawdownPercent: null,
  tradeCount: null,
  portfolioCagrPercent: null,
};

/** The in-flight projection the running page renders between checkpoints. */
export function liveMetrics(
  live: BacktestLiveSnapshotResponse,
): BacktestMetricsView {
  return {
    portfolioReturnPercent: live.portfolioReturnPercent,
    benchmarkReturnPercent: live.benchmarkReturnPercent,
    alphaPercent: live.alphaPercent,
    totalValue: live.totalValue,
    netProfit: live.netProfit,
    maxDrawdownPercent: live.maxDrawdownPercent,
    tradeCount: live.tradeCount,
    portfolioCagrPercent: live.portfolioCagrPercent,
  };
}

/**
 * The completed run's durable summary.
 *
 * Same tiles, same order, same units — the page transitions in place rather than swapping to a
 * different result surface, so the user's eye stays where it was.
 */
export function resultMetrics(
  summary: BacktestResultSummaryResponse,
): BacktestMetricsView {
  return {
    portfolioReturnPercent: summary.portfolioReturnPercent,
    benchmarkReturnPercent: summary.benchmarkReturnPercent,
    alphaPercent: summary.alphaPercent,
    totalValue: summary.finalValue,
    netProfit: summary.netProfit,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    tradeCount: summary.totalTrades,
    portfolioCagrPercent: summary.portfolioCagrPercent,
  };
}
