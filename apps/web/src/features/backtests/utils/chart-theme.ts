/**
 * Chart palette for the backtest comparison curve.
 *
 * Lightweight Charts paints onto a canvas and cannot read CSS custom properties, so the token
 * values are mirrored here as literals — the same reason Stock Details keeps its own copy.
 *
 * Two series, one hierarchy: the portfolio takes the brand blue because it is the result under
 * examination, and the benchmark takes a neutral cool grey because it is the reference the result
 * is read against. Deliberately not green/red — the colours must not imply an outcome before the
 * numbers do.
 */
export const BACKTEST_CHART_COLORS = {
  portfolio: "#4882ff",
  benchmark: "#8a94ad",
  grid: "#eff2fa",
  axisBorder: "#e6eaf5",
  crosshair: "#b9c6e8",
  text: "#667085",
  /** Break-even: both series are percentage growth from the run's first simulated date. */
  baseline: "#b9c6e8",
} as const;
