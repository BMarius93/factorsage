import {
  SELECTABLE_SERIES_CATALOG,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { OVERLAY_PALETTE, overlayColorAt } from "./chart-theme";
import {
  availableSeriesIds,
  buildOverlays,
  DEFAULT_SELECTED_SERIES,
  INDICATOR_GROUPS,
  seriesPoints,
  type SeriesSource,
} from "./series-catalog";

const SOURCE: SeriesSource = {
  technicals: [
    { date: "2026-08-27", sma50d: 219, sma20w: 215 },
    { date: "2026-08-28", sma50d: 220, sma20w: 216 },
  ],
  blends: [
    {
      valuationDate: "2026-08-28",
      sourceDataAsOf: "2026-08-27T22:00:00.000Z",
      blendId: "BALANCED",
      valuePerShare: 290,
      currency: "USD",
    },
  ],
  intrinsicValues: [
    {
      valuationDate: "2026-08-28",
      sourceDataAsOf: "2026-08-27T22:00:00.000Z",
      model: "DCF_FCFF",
      valuePerShare: 260,
      currency: "USD",
    },
  ],
};

const identity = (points: { date: string; value: number }[]) => points;

function series(id: SelectableSeriesId) {
  return SELECTABLE_SERIES_CATALOG.find((entry) => entry.id === id)!;
}

describe("series catalog projection", () => {
  it("renders the catalog's own groups and ordering", () => {
    expect(INDICATOR_GROUPS.flatMap((group) => group.series)).toEqual([
      ...SELECTABLE_SERIES_CATALOG,
    ]);
  });

  it("starts with Balanced enabled and nothing else", () => {
    expect(DEFAULT_SELECTED_SERIES).toEqual(["BALANCED"]);
  });

  it("reads a daily, a weekly, a blend and a model from their own contract fields", () => {
    expect(seriesPoints(SOURCE, series("SMA_50D"))).toEqual([
      { date: "2026-08-27", value: 219 },
      { date: "2026-08-28", value: 220 },
    ]);
    expect(seriesPoints(SOURCE, series("SMA_20W"))).toEqual([
      { date: "2026-08-27", value: 215 },
      { date: "2026-08-28", value: 216 },
    ]);
    expect(seriesPoints(SOURCE, series("BALANCED"))).toEqual([
      { date: "2026-08-28", value: 290 },
    ]);
    expect(seriesPoints(SOURCE, series("DCF_FCFF"))).toEqual([
      { date: "2026-08-28", value: 260 },
    ]);
  });

  it("never substitutes a neighbouring period or model for an absent one", () => {
    expect(seriesPoints(SOURCE, series("SMA_20D"))).toEqual([]);
    expect(seriesPoints(SOURCE, series("SMA_50W"))).toEqual([]);
    expect(seriesPoints(SOURCE, series("GRAHAM"))).toEqual([]);
    expect(seriesPoints(SOURCE, series("CONSERVATIVE"))).toEqual([]);
  });

  it("reports availability from the loaded payload only", () => {
    expect([...availableSeriesIds(SOURCE)].sort()).toEqual([
      "BALANCED",
      "DCF_FCFF",
      "SMA_20W",
      "SMA_50D",
    ]);
    expect(
      availableSeriesIds({ technicals: [], blends: [], intrinsicValues: [] })
        .size,
    ).toBe(0);
  });

  it("orders overlays canonically and assigns colours by position, not by identity", () => {
    const overlays = buildOverlays(
      SOURCE,
      new Set<SelectableSeriesId>(["DCF_FCFF", "SMA_20W", "SMA_50D"]),
      identity,
    );

    expect(overlays.map((overlay) => overlay.id)).toEqual([
      "SMA_50D",
      "SMA_20W",
      "DCF_FCFF",
    ]);
    expect(overlays.map((overlay) => overlay.label)).toEqual([
      "SMA 50D",
      "SMA 20W",
      "DCF (FCFF)",
    ]);
    expect(overlays.map((overlay) => overlay.color)).toEqual([
      overlayColorAt(0),
      overlayColorAt(1),
      overlayColorAt(2),
    ]);
    expect(new Set(overlays.map((overlay) => overlay.color)).size).toBe(3);
  });

  it("drops a selected series with no point in the visible range", () => {
    const overlays = buildOverlays(
      SOURCE,
      new Set<SelectableSeriesId>(["SMA_50D", "BALANCED"]),
      (points) => points.filter((point) => point.date === "2026-08-27"),
    );

    expect(overlays.map((overlay) => overlay.id)).toEqual(["SMA_50D"]);
  });

  it("keeps a full palette of distinct hues for simultaneous overlays", () => {
    expect(new Set(OVERLAY_PALETTE).size).toBe(OVERLAY_PALETTE.length);
    expect(OVERLAY_PALETTE.length).toBeGreaterThanOrEqual(12);
    // Deterministic and total: any position resolves to a palette colour.
    expect(overlayColorAt(0)).toBe(OVERLAY_PALETTE[0]);
    expect(overlayColorAt(OVERLAY_PALETTE.length)).toBe(OVERLAY_PALETTE[0]);
    expect(OVERLAY_PALETTE as readonly string[]).not.toContain("#4882ff");
  });
});
