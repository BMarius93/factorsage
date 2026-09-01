/**
 * Central chart palette for Stock Details.
 *
 * Lightweight Charts paints onto a canvas and cannot read CSS custom properties, so the token
 * values are mirrored here as literals. Price keeps the brand blue as the always-visible base
 * series; overlay hues come from `OVERLAY_PALETTE` below.
 */
export const CHART_COLORS = {
  price: "#4882ff",
  priceAreaTop: "rgba(72, 130, 255, 0.14)",
  priceAreaBottom: "rgba(72, 130, 255, 0)",
  grid: "#eff2fa",
  axisBorder: "#e6eaf5",
  crosshair: "#b9c6e8",
  text: "#667085",
} as const;

/**
 * Overlay hues, ordered so neighbouring entries stay distinguishable.
 *
 * The catalog offers 21 selectable series and no chart can carry 21 permanently distinct, legible
 * hues, so colour is deliberately not a per-series identity. This palette is the single owner of
 * overlay colour; it avoids the brand blue so an overlay is never mistaken for price.
 */
export const OVERLAY_PALETTE = [
  "#1e9e78",
  "#e78634",
  "#7e6ce0",
  "#d1435b",
  "#0f8fb0",
  "#b8860b",
  "#c2489b",
  "#3f7f3f",
  "#8a5a2b",
  "#5566c9",
  "#a03a3a",
  "#2a9d8f",
] as const;

/**
 * Deterministic overlay colour policy.
 *
 * Colour is assigned by an enabled series' position within the currently enabled set, taken in
 * canonical catalog order, so the same selection always paints the same way and the first twelve
 * simultaneous overlays are always distinct. Callers pass the position; they never invent a hue.
 */
export function overlayColorAt(position: number): string {
  const palette = OVERLAY_PALETTE;
  return palette[
    ((position % palette.length) + palette.length) % palette.length
  ] as string;
}
