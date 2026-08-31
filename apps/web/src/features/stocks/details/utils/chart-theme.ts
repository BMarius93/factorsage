/**
 * Central chart palette for Stock Details.
 *
 * Lightweight Charts paints onto a canvas and cannot read CSS custom properties, so the token
 * values are mirrored here as literals. Series hues are semantically stable: price stays the brand
 * blue, intrinsic value stays the positive/value green, and the two moving averages keep distinct
 * hues that remain distinguishable next to both.
 */
export const CHART_COLORS = {
  price: "#4882ff",
  priceAreaTop: "rgba(72, 130, 255, 0.14)",
  priceAreaBottom: "rgba(72, 130, 255, 0)",
  sma50: "#e78634",
  sma200: "#7e6ce0",
  intrinsic: "#1e9e78",
  grid: "#eff2fa",
  axisBorder: "#e6eaf5",
  crosshair: "#b9c6e8",
  text: "#667085",
} as const;
