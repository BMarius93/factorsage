import {
  SELECTABLE_SERIES_CATALOG,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { OVERLAY_PALETTE, overlayColorAt } from "./chart-theme";
import {
  alignToTradingDays,
  availableSeriesIds,
  buildOverlays,
  DEFAULT_SELECTED_SERIES,
  INDICATOR_GROUPS,
  seriesPoints,
  type SeriesSource,
} from "./series-catalog";

const SOURCE: SeriesSource = {
  technicals: [
    // rsi14d and rsi21d stay in warm-up: availability must be answered per period.
    { date: "2026-08-27", sma50d: 219, sma20w: 215, rsi7d: 41.2 },
    { date: "2026-08-28", sma50d: 220, sma20w: 216, rsi7d: 66.8 },
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


/** The chart's trading-day axis for `SOURCE`: the close series' own dates. */
const TRADING_DAYS = ["2026-08-27", "2026-08-28"];

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

  it("reads an oscillator from its own contract field and routes it off the price scale", () => {
    expect(seriesPoints(SOURCE, series("RSI_7D"))).toEqual([
      { date: "2026-08-27", value: 41.2 },
      { date: "2026-08-28", value: 66.8 },
    ]);
    // Warm-up periods stay empty; a shorter period never stands in for a longer one.
    expect(seriesPoints(SOURCE, series("RSI_14D"))).toEqual([]);
    expect(seriesPoints(SOURCE, series("RSI_21D"))).toEqual([]);

    const overlays = buildOverlays(
      SOURCE,
      new Set<SelectableSeriesId>(["RSI_7D", "SMA_50D"]),
      TRADING_DAYS,
    );
    expect(overlays.map((overlay) => [overlay.id, overlay.placement])).toEqual([
      ["SMA_50D", "PRICE_OVERLAY"],
      ["RSI_7D", "OSCILLATOR_PANE"],
    ]);
    // The pane's fixed scale is the catalog's structured 0-100 range, not a hardcoded copy.
    expect(overlays[1]?.scale).toEqual({ min: 0, max: 100 });
    expect(overlays[0]?.scale).toBeUndefined();
    // Colour positions span both panes, so simultaneously enabled series stay distinct.
    expect(overlays.map((overlay) => overlay.color)).toEqual([
      overlayColorAt(0),
      overlayColorAt(1),
    ]);
  });

  it("answers oscillator availability independently per period", () => {
    const available = availableSeriesIds(SOURCE);
    expect(available.has("RSI_7D")).toBe(true);
    expect(available.has("RSI_14D")).toBe(false);
    expect(available.has("RSI_21D")).toBe(false);
  });

  it("keeps a series available when only later points are evaluable", () => {
    // A long response begins inside the warm-up: the leading rows carry nothing, later rows do.
    // Availability must come from the whole window, not from the first row.
    const partialWarmup: SeriesSource = {
      technicals: [
        { date: "2026-08-24" },
        { date: "2026-08-25" },
        { date: "2026-08-26", rsi14d: 55.5 },
        { date: "2026-08-27", rsi14d: 58.1 },
      ],
      blends: [],
      intrinsicValues: [],
    };
    expect(availableSeriesIds(partialWarmup).has("RSI_14D")).toBe(true);
    expect(seriesPoints(partialWarmup, series("RSI_14D"))).toEqual([
      { date: "2026-08-26", value: 55.5 },
      { date: "2026-08-27", value: 58.1 },
    ]);
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
      "RSI_7D",
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
      TRADING_DAYS,
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

  it("drops a selected series the loaded history cannot draw", () => {
    const overlays = buildOverlays(
      { ...SOURCE, blends: [] },
      new Set<SelectableSeriesId>(["SMA_50D", "BALANCED"]),
      TRADING_DAYS,
    );

    expect(overlays.map((overlay) => overlay.id)).toEqual(["SMA_50D"]);
  });

  describe("genuine unavailability stays a gap", () => {
    // Regression: intrinsic models and blends are materialized onto *every* trading day by
    // carry-forward, so a trading day the response does not cover is the backend stating the
    // model was not calculable that day. Handing Lightweight Charts only the covered days made it
    // join them with a straight segment — AMZN's Balanced blend was drawn as one diagonal across
    // the 442 trading days its DCF component was unavailable, and AAPL's DDM as a fifteen-year
    // diagonal across the 1996-2012 dividend suspension. Whitespace is what breaks the line.
    const axis = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];

    it("marks an interior unavailable day as whitespace rather than joining across it", () => {
      expect(
        alignToTradingDays(
          [
            { date: "2026-01-02", value: 100 },
            { date: "2026-01-05", value: 100 },
            { date: "2026-01-08", value: 60 },
          ],
          axis,
        ),
      ).toEqual([
        { date: "2026-01-02", value: 100 },
        { date: "2026-01-05", value: 100 },
        { date: "2026-01-06" },
        { date: "2026-01-07" },
        { date: "2026-01-08", value: 60 },
      ]);
    });

    it("leaves a continuous series untouched, so a moving average never becomes stepped", () => {
      const continuous = axis.map((date, index) => ({ date, value: 10 + index }));
      expect(alignToTradingDays(continuous, axis)).toEqual(continuous);
    });

    it("adds no whitespace for warm-up before the first value or absence after the last", () => {
      // Leading absence is warm-up or pre-eligibility and trailing absence is a source that has
      // become unavailable. Neither draws anything, so neither needs a marker — and padding them
      // would make every series as long as the whole axis for no visual difference.
      expect(
        alignToTradingDays(
          [
            { date: "2026-01-05", value: 5 },
            { date: "2026-01-06", value: 6 },
          ],
          axis,
        ),
      ).toEqual([
        { date: "2026-01-05", value: 5 },
        { date: "2026-01-06", value: 6 },
      ]);
    });

    it("keeps an observation the price axis does not carry instead of dropping it", () => {
      expect(
        alignToTradingDays(
          [
            { date: "2026-01-02", value: 1 },
            { date: "2026-01-03", value: 2 },
            { date: "2026-01-05", value: 3 },
          ],
          axis,
        ),
      ).toEqual([
        { date: "2026-01-02", value: 1 },
        { date: "2026-01-03", value: 2 },
        { date: "2026-01-05", value: 3 },
      ]);
    });

    it("aligns every catalog family the same way, with no per-family special case", () => {
      // The whole catalog, enumerated at runtime: a new entry is covered without editing this.
      const gapped: SeriesSource = {
        technicals: [
          { date: "2026-01-02", sma50d: 1, sma20w: 1, rsi7d: 50 },
          { date: "2026-01-08", sma50d: 2, sma20w: 2, rsi7d: 60 },
        ],
        blends: ["BALANCED", "CONSERVATIVE", "DIVIDEND"].flatMap((blendId) =>
          ["2026-01-02", "2026-01-08"].map((valuationDate) => ({
            valuationDate,
            sourceDataAsOf: "2026-01-01T22:00:00.000Z",
            blendId: blendId as never,
            valuePerShare: 10,
            currency: "USD",
          })),
        ),
        intrinsicValues: ["DCF_FCFF", "RESIDUAL_INCOME", "DDM", "GRAHAM"].flatMap(
          (model) =>
            ["2026-01-02", "2026-01-08"].map((valuationDate) => ({
              valuationDate,
              sourceDataAsOf: "2026-01-01T22:00:00.000Z",
              model: model as never,
              valuePerShare: 20,
              currency: "USD",
            })),
        ),
      };
      const drawable = SELECTABLE_SERIES_CATALOG.filter(
        (entry) => seriesPoints(gapped, entry).length > 0,
      );
      // Every family of the catalog is represented, so this is not a one-family assertion.
      expect(
        new Set(drawable.map((entry) => entry.source.kind)),
      ).toEqual(
        new Set([
          "MOVING_AVERAGE",
          "OSCILLATOR",
          "INTRINSIC_VALUE_BLEND",
          "INTRINSIC_VALUE_MODEL",
        ]),
      );
      const overlays = buildOverlays(
        gapped,
        new Set(drawable.map((entry) => entry.id)),
        axis,
      );
      expect(overlays).toHaveLength(drawable.length);
      for (const overlay of overlays) {
        expect(
          overlay.points.filter((point) => point.value === undefined),
        ).toEqual([
          { date: "2026-01-05" },
          { date: "2026-01-06" },
          { date: "2026-01-07" },
        ]);
      }
    });
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
