import {
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPS,
  type SelectableSeriesGroupId,
  type SelectableSeriesId,
} from "@intrinsic/contracts";

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
  /**
   * The 30/50/70 reference levels of the oscillator pane. Deliberately muted: the levels orient
   * the reading without competing with the data lines.
   */
  oscillatorReference: "#b9c6e8",
  /**
   * The daily volume histogram. A desaturated slate rather than the brand blue or a financial
   * state colour: volume is context for the price, and colouring bars by the session's direction
   * would state a correlation the product does not claim.
   */
  volume: "#c3cbdd",
  /**
   * The segment that would otherwise bridge a gap in an overlay.
   *
   * Lightweight Charts drops whitespace rows before rendering a line, so whitespace alone extends
   * the time scale but does not break the line — the points on either side of an unavailable
   * interval are still joined. A data point's own colour styles the segment that *leaves* it, so
   * painting the last point before a gap in a fully transparent colour is what actually removes
   * the bridge, and only that one segment.
   */
  overlayGap: "rgba(0, 0, 0, 0)",
  /**
   * The Fundamental Metric step line, alone in its own pane. The dark contrast neutral
   * (`--color-surface-contrast`) rather than a palette hue: there is only ever one fundamental on
   * the chart, it never shares a scale with an overlay, and a fixed colour keeps it from changing
   * whenever an unrelated overlay is toggled.
   */
  fundamental: "#1f2937",
  /**
   * The valuation ratio line, alone in its own pane. The primary ink blue (`--color-primary-ink`):
   * a ratio of the market capitalisation moves with the price, and the ink tone ties it to the
   * price's blue without ever being mistaken for it — it never shares the price pane. Fixed, and
   * distinct from the fundamental's neutral, so the two lower panes read apart in the legend.
   */
  valuation: "#3b5ccc",
} as const;

/**
 * Overlay hues, ordered so neighbouring entries stay distinguishable.
 *
 * This palette is the single owner of overlay colour; it avoids the brand blue so an overlay is
 * never mistaken for price. Which series wears which hue is `overlayColors` below.
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
 * The order the palette is dealt to the catalog's families, for colour and nothing else: each
 * family takes the next hues in its own catalog order, wrapping around the palette. Nothing shows
 * this order — every surface lists series in the catalog's own order.
 *
 * There are twice as many series as hues, so every hue has two owners, and this order decides the
 * pairs. Dealt in it, the series most often drawn together never share one: the three blends,
 * the seven daily averages and RSI 14D are all distinct; so are all seven intrinsic-value sources;
 * and `Balanced`, the default selection, keeps the palette's first hue and shares it with only
 * `SMA 100W`. The catalog's own order would pair `SMA 200D` with `RSI 14D` and `EMA 50D` with
 * `Balanced`. A record rather than a list, so a new catalog family cannot go undealt.
 */
const COLOR_DEALING_RANK: Readonly<Record<SelectableSeriesGroupId, number>> = {
  INTRINSIC_VALUE_BLENDS: 0,
  MOVING_AVERAGES_DAILY: 1,
  MOVING_AVERAGES_WEEKLY: 2,
  INTRINSIC_VALUE_MODELS: 3,
  OSCILLATORS: 4,
};

/** Every catalog series with its own hue, in dealing order — which is also the order of claim. */
const DEALT_SERIES: readonly {
  readonly id: SelectableSeriesId;
  readonly slot: number;
}[] = [...SELECTABLE_SERIES_GROUPS]
  .sort((left, right) => COLOR_DEALING_RANK[left] - COLOR_DEALING_RANK[right])
  .flatMap((group) =>
    SELECTABLE_SERIES_CATALOG.filter((series) => series.group === group),
  )
  .map((series, position) => ({
    id: series.id,
    slot: position % OVERLAY_PALETTE.length,
  }));

const OWN_SLOT = new Map(DEALT_SERIES.map((entry) => [entry.id, entry.slot]));

/** The hue a series always wears unless the one it shares it with is drawn too. */
export function seriesColor(id: SelectableSeriesId): string {
  return OVERLAY_PALETTE[OWN_SLOT.get(id) ?? 0] as string;
}

/**
 * Deterministic overlay colour policy: colour belongs to the series, not to the selection.
 *
 * Every drawn series wears its own hue (`seriesColor`), so turning another series on or off, in
 * any order, never repaints it. The one exception keeps lines that are on screen together
 * distinguishable: when two drawn series own the same hue, the one dealt first keeps it and the
 * other borrows the first hue no drawn series owns. Only more drawn series than hues can repeat
 * one. Callers pass what is drawn; they never invent a hue.
 */
export function overlayColors(
  drawn: Iterable<SelectableSeriesId>,
): Map<SelectableSeriesId, string> {
  const wanted = new Set(drawn);
  const claimants = DEALT_SERIES.filter((entry) => wanted.has(entry.id));
  const taken = new Set<number>();
  const slots = new Map<SelectableSeriesId, number>();
  const contested: typeof claimants = [];
  for (const entry of claimants) {
    if (taken.has(entry.slot)) {
      contested.push(entry);
    } else {
      taken.add(entry.slot);
      slots.set(entry.id, entry.slot);
    }
  }
  // Only once every drawn series has claimed its own hue, so a borrowed hue is never one that a
  // series drawn alongside owns.
  for (const entry of contested) {
    const free = OVERLAY_PALETTE.findIndex((_hue, slot) => !taken.has(slot));
    const slot = free === -1 ? entry.slot : free;
    taken.add(slot);
    slots.set(entry.id, slot);
  }
  return new Map(
    [...slots].map(([id, slot]) => [id, OVERLAY_PALETTE[slot] as string]),
  );
}
