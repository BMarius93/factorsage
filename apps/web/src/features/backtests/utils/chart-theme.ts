/**
 * Chart palette for the backtest comparison curve.
 *
 * Lightweight Charts paints onto a canvas and cannot read CSS custom properties, so the token
 * values are mirrored here as literals — the same reason Stock Details keeps its own copy.
 *
 * Three scenarios, one hierarchy. The Strategy takes the brand blue because it is the result under
 * examination; the benchmark takes a neutral cool grey because it is the reference the result is
 * read against; Cash takes a lighter, quieter grey because it is the floor both are measured over,
 * not a competitor. Deliberately not green/red — the colours must not imply an outcome before the
 * numbers do.
 */
export const BACKTEST_CHART_COLORS = {
  strategy: "#4882ff",
  benchmark: "#8a94ad",
  cash: "#b9c6e8",
  grid: "#eff2fa",
  axisBorder: "#e6eaf5",
  crosshair: "#b9c6e8",
  text: "#667085",
} as const;
