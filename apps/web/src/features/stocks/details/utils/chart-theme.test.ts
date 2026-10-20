import {
  INTRINSIC_VALUE_SERIES,
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  CHART_COLORS,
  OVERLAY_PALETTE,
  overlayColors,
  seriesColor,
} from "./chart-theme";

const ALL_IDS = SELECTABLE_SERIES_CATALOG.map((series) => series.id);

function idsOf(group: string): SelectableSeriesId[] {
  return (
    SELECTABLE_SERIES_GROUPED.find((entry) => entry.id === group)?.series ?? []
  ).map((series) => series.id);
}

function distinct(ids: readonly SelectableSeriesId[]): boolean {
  return new Set(ids.map(seriesColor)).size === ids.length;
}

describe("overlay colours", () => {
  it("gives every catalog series a palette hue, never the price blue", () => {
    for (const id of ALL_IDS) {
      expect(OVERLAY_PALETTE as readonly string[]).toContain(seriesColor(id));
      expect(seriesColor(id)).not.toBe(CHART_COLORS.price);
    }
    // Every hue is used, and none more than twice: twice as many series as hues.
    const owners = new Map<string, number>();
    for (const id of ALL_IDS) {
      owners.set(seriesColor(id), (owners.get(seriesColor(id)) ?? 0) + 1);
    }
    expect(owners.size).toBe(OVERLAY_PALETTE.length);
    expect(Math.max(...owners.values())).toBeLessThanOrEqual(
      Math.ceil(ALL_IDS.length / OVERLAY_PALETTE.length),
    );
  });

  it("keeps a series' colour whatever else is selected, and in whatever order", () => {
    // Regression (SD-3): colour used to follow the position in the enabled set, so Balanced was
    // green on its own and turned orange once RSI 14D — earlier in the catalog — was switched on.
    const balanced = seriesColor("BALANCED");
    expect(overlayColors(["BALANCED"]).get("BALANCED")).toBe(balanced);
    expect(overlayColors(["RSI_14D", "BALANCED"]).get("BALANCED")).toBe(
      balanced,
    );
    expect(overlayColors(["BALANCED", "RSI_14D"]).get("BALANCED")).toBe(
      balanced,
    );
    expect(
      overlayColors([
        "SMA_50D",
        "SMA_200D",
        "RSI_14D",
        "BALANCED",
        "DCF_FCFF",
      ]).get("BALANCED"),
    ).toBe(balanced);
    expect(overlayColors(["RSI_14D"]).get("RSI_14D")).toBe(
      overlayColors(["RSI_14D", "SMA_200D", "BALANCED"]).get("RSI_14D"),
    );
  });

  it("keeps the default selection's colour: Balanced wears the palette's first hue", () => {
    expect(seriesColor("BALANCED")).toBe(OVERLAY_PALETTE[0]);
  });

  it("never pairs the series most often drawn together on one hue", () => {
    // The blends, the daily averages and RSI 14D: every one distinct from every other.
    expect(
      distinct([
        ...idsOf("INTRINSIC_VALUE_BLENDS"),
        ...idsOf("MOVING_AVERAGES_DAILY"),
        "RSI_14D",
      ]),
    ).toBe(true);
    // All seven intrinsic-value sources, compared side by side.
    expect(distinct(INTRINSIC_VALUE_SERIES.map((series) => series.id))).toBe(
      true,
    );
    // The three oscillators share one pane.
    expect(distinct(idsOf("OSCILLATORS"))).toBe(true);
  });

  it("keeps the lines drawn together distinct, borrowing a free hue only for a shared one", () => {
    // SMA 100W owns Balanced's hue. Balanced, dealt first, keeps it; SMA 100W borrows the first
    // hue no drawn series owns, and goes back to its own once Balanced is off.
    expect(seriesColor("SMA_100W")).toBe(seriesColor("BALANCED"));
    const together = overlayColors(["SMA_100W", "BALANCED", "CONSERVATIVE"]);
    expect(together.get("BALANCED")).toBe(seriesColor("BALANCED"));
    expect(together.get("CONSERVATIVE")).toBe(seriesColor("CONSERVATIVE"));
    expect(together.get("SMA_100W")).not.toBe(seriesColor("BALANCED"));
    expect(together.get("SMA_100W")).not.toBe(seriesColor("CONSERVATIVE"));
    expect(overlayColors(["SMA_100W"]).get("SMA_100W")).toBe(
      seriesColor("SMA_100W"),
    );
  });

  it("paints as many drawn series as there are hues all differently", () => {
    // Two of these own a hue another of them owns too: SMA 100W Balanced's, RSI 7D EMA 200D's.
    const twelve: SelectableSeriesId[] = [
      ...idsOf("INTRINSIC_VALUE_BLENDS"),
      ...idsOf("MOVING_AVERAGES_DAILY"),
      "SMA_100W",
      "RSI_7D",
    ];
    expect(twelve).toHaveLength(OVERLAY_PALETTE.length);
    expect(distinct(twelve)).toBe(false);
    const colors = overlayColors(twelve);
    expect(colors.size).toBe(twelve.length);
    expect(new Set(colors.values()).size).toBe(OVERLAY_PALETTE.length);
    // Every series still gets a colour once there are more than hues; repeats are then unavoidable.
    expect(overlayColors(ALL_IDS).size).toBe(ALL_IDS.length);
  });
});
