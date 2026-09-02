import { describe, expect, it } from "vitest";
import {
  comparableMovingAverages,
  findSelectableSeries,
  INTRINSIC_VALUE_BLEND_OPTIONS,
  INTRINSIC_VALUE_MODEL_OPTIONS,
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
  SELECTABLE_SERIES_GROUPS,
  selectableSeriesShortLabel,
  type SelectableSeries,
} from "./selectable-series.js";

/**
 * The catalog widened to its declared type.
 *
 * `SELECTABLE_SERIES_CATALOG` is `as const`, so entries that declare no `shortLabel` have no such
 * property in their literal type at all. Reading the optional field needs the declared type.
 */
const CATALOG: readonly SelectableSeries[] = SELECTABLE_SERIES_CATALOG;

/**
 * The one deliberate catalog snapshot.
 *
 * The catalog is product state, so it is asserted against the literal table in
 * `docs/decisions/selectable-series-catalog.md` rather than against itself: stable id, canonical
 * order, group, label, compact label and the structured source metadata that addresses the backend
 * identity. Any change to any of those must be made in the decision and here at the same time.
 *
 * This snapshot is the only place in the suite that hardcodes the catalog's contents. Every other
 * assertion below derives its expectations from the catalog, so adding a series means editing this
 * table and nothing else here.
 */
const EXPECTED_CATALOG = [
  ["SMA_20D", "MOVING_AVERAGES_DAILY", "SMA 20D", "SMA 20D", "MOVING_AVERAGE:SMA:20:1D:sma20d"],
  ["SMA_50D", "MOVING_AVERAGES_DAILY", "SMA 50D", "SMA 50D", "MOVING_AVERAGE:SMA:50:1D:sma50d"],
  ["SMA_100D", "MOVING_AVERAGES_DAILY", "SMA 100D", "SMA 100D", "MOVING_AVERAGE:SMA:100:1D:sma100d"],
  ["SMA_200D", "MOVING_AVERAGES_DAILY", "SMA 200D", "SMA 200D", "MOVING_AVERAGE:SMA:200:1D:sma200d"],
  ["EMA_20D", "MOVING_AVERAGES_DAILY", "EMA 20D", "EMA 20D", "MOVING_AVERAGE:EMA:20:1D:ema20d"],
  ["EMA_50D", "MOVING_AVERAGES_DAILY", "EMA 50D", "EMA 50D", "MOVING_AVERAGE:EMA:50:1D:ema50d"],
  ["EMA_200D", "MOVING_AVERAGES_DAILY", "EMA 200D", "EMA 200D", "MOVING_AVERAGE:EMA:200:1D:ema200d"],
  ["SMA_20W", "MOVING_AVERAGES_WEEKLY", "SMA 20W", "SMA 20W", "MOVING_AVERAGE:SMA:20:1W:sma20w"],
  ["SMA_50W", "MOVING_AVERAGES_WEEKLY", "SMA 50W", "SMA 50W", "MOVING_AVERAGE:SMA:50:1W:sma50w"],
  ["SMA_100W", "MOVING_AVERAGES_WEEKLY", "SMA 100W", "SMA 100W", "MOVING_AVERAGE:SMA:100:1W:sma100w"],
  ["SMA_200W", "MOVING_AVERAGES_WEEKLY", "SMA 200W", "SMA 200W", "MOVING_AVERAGE:SMA:200:1W:sma200w"],
  ["EMA_20W", "MOVING_AVERAGES_WEEKLY", "EMA 20W", "EMA 20W", "MOVING_AVERAGE:EMA:20:1W:ema20w"],
  ["EMA_50W", "MOVING_AVERAGES_WEEKLY", "EMA 50W", "EMA 50W", "MOVING_AVERAGE:EMA:50:1W:ema50w"],
  ["EMA_200W", "MOVING_AVERAGES_WEEKLY", "EMA 200W", "EMA 200W", "MOVING_AVERAGE:EMA:200:1W:ema200w"],
  ["BALANCED", "INTRINSIC_VALUE_BLENDS", "Balanced", "Balanced", "INTRINSIC_VALUE_BLEND:BALANCED"],
  ["CONSERVATIVE", "INTRINSIC_VALUE_BLENDS", "Conservative", "Conservative", "INTRINSIC_VALUE_BLEND:CONSERVATIVE"],
  ["DIVIDEND", "INTRINSIC_VALUE_BLENDS", "Dividend", "Dividend", "INTRINSIC_VALUE_BLEND:DIVIDEND"],
  ["DCF_FCFF", "INTRINSIC_VALUE_MODELS", "DCF (FCFF)", "DCF (FCFF)", "INTRINSIC_VALUE_MODEL:DCF_FCFF"],
  ["RESIDUAL_INCOME", "INTRINSIC_VALUE_MODELS", "Residual Income", "Residual income", "INTRINSIC_VALUE_MODEL:RESIDUAL_INCOME"],
  ["DDM", "INTRINSIC_VALUE_MODELS", "Dividend Discount (DDM)", "Dividend discount", "INTRINSIC_VALUE_MODEL:DDM"],
  ["GRAHAM", "INTRINSIC_VALUE_MODELS", "Graham", "Graham", "INTRINSIC_VALUE_MODEL:GRAHAM"],
] as const;

/** Flattens a structured source into the snapshot's comparable form. */
function sourceKey(entry: (typeof SELECTABLE_SERIES_CATALOG)[number]): string {
  const source = entry.source;
  switch (source.kind) {
    case "MOVING_AVERAGE":
      return `MOVING_AVERAGE:${source.type}:${source.period}:${source.timeframe}:${source.field}`;
    case "INTRINSIC_VALUE_BLEND":
      return `INTRINSIC_VALUE_BLEND:${source.blendId}`;
    case "INTRINSIC_VALUE_MODEL":
      return `INTRINSIC_VALUE_MODEL:${source.model}`;
  }
}

/** Expected entries of one group, taken from the snapshot rather than restated as a count. */
function expectedIdsInGroup(group: string): string[] {
  return EXPECTED_CATALOG.filter((entry) => entry[1] === group).map(
    (entry) => entry[0],
  );
}

describe("selectable series catalog", () => {
  it("matches the canonical product snapshot exactly, in canonical order", () => {
    expect(
      SELECTABLE_SERIES_CATALOG.map((entry) => [
        entry.id,
        entry.group,
        entry.label,
        selectableSeriesShortLabel(entry),
        sourceKey(entry),
      ]),
    ).toEqual(EXPECTED_CATALOG.map((entry) => [...entry]));
  });

  it("splits into moving averages and intrinsic-value sources with nothing left over", () => {
    // Counts come from the catalog itself: a new series must not require editing this assertion.
    expect(MOVING_AVERAGE_SERIES.length + INTRINSIC_VALUE_SERIES.length).toBe(
      SELECTABLE_SERIES_CATALOG.length,
    );
    expect(MOVING_AVERAGE_SERIES).toHaveLength(
      SELECTABLE_SERIES_CATALOG.filter(
        (entry) => entry.source.kind === "MOVING_AVERAGE",
      ).length,
    );
    expect(INTRINSIC_VALUE_SERIES).toHaveLength(
      SELECTABLE_SERIES_CATALOG.filter(
        (entry) => entry.source.kind !== "MOVING_AVERAGE",
      ).length,
    );
  });

  it("orders the groups as the product decision requires", () => {
    expect(SELECTABLE_SERIES_GROUPS).toEqual([
      "MOVING_AVERAGES_DAILY",
      "MOVING_AVERAGES_WEEKLY",
      "INTRINSIC_VALUE_BLENDS",
      "INTRINSIC_VALUE_MODELS",
    ]);
    expect(SELECTABLE_SERIES_GROUPED.map((group) => group.label)).toEqual([
      "Moving averages — Daily",
      "Moving averages — Weekly",
      "Intrinsic Value — Blends",
      "Intrinsic Value — Models",
    ]);
    // Group membership is derived from the snapshot, not restated as fixed counts.
    expect(
      SELECTABLE_SERIES_GROUPED.map((group) => group.series.map((s) => s.id)),
    ).toEqual(SELECTABLE_SERIES_GROUPS.map((group) => expectedIdsInGroup(group)));
  });

  it("groups every entry exactly once and preserves flat ordering inside a group", () => {
    const grouped = SELECTABLE_SERIES_GROUPED.flatMap((group) =>
      group.series.map((entry) => entry.id),
    );
    expect(grouped).toEqual(SELECTABLE_SERIES_CATALOG.map((entry) => entry.id));
  });

  it("keeps ids, labels and technical fields unique", () => {
    const ids = SELECTABLE_SERIES_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const labels = SELECTABLE_SERIES_CATALOG.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);

    const fields = MOVING_AVERAGE_SERIES.map((entry) =>
      entry.source.kind === "MOVING_AVERAGE" ? entry.source.field : "",
    );
    expect(new Set(fields).size).toBe(MOVING_AVERAGE_SERIES.length);
  });

  it("treats a daily and a weekly moving average of the same period as distinct identities", () => {
    for (const period of [20, 50, 200]) {
      for (const type of ["SMA", "EMA"] as const) {
        const matching = MOVING_AVERAGE_SERIES.filter(
          (entry) =>
            entry.source.kind === "MOVING_AVERAGE" &&
            entry.source.period === period &&
            entry.source.type === type,
        );
        expect(matching).toHaveLength(2);
        expect(
          matching.map((entry) =>
            entry.source.kind === "MOVING_AVERAGE"
              ? entry.source.timeframe
              : "",
          ),
        ).toEqual(["1D", "1W"]);
        expect(matching[0]?.id).not.toBe(matching[1]?.id);
      }
    }
  });

  it("derives every moving-average field from its own type, period and timeframe", () => {
    for (const entry of MOVING_AVERAGE_SERIES) {
      if (entry.source.kind !== "MOVING_AVERAGE") {
        throw new Error("unreachable");
      }
      const suffix = entry.source.timeframe === "1D" ? "d" : "w";
      expect(entry.source.field).toBe(
        `${entry.source.type.toLowerCase()}${entry.source.period}${suffix}`,
      );
      expect(entry.id).toBe(
        `${entry.source.type}_${entry.source.period}${suffix.toUpperCase()}`,
      );
    }
  });

  it("keeps intrinsic entries addressed by their canonical model and blend ids", () => {
    expect(
      INTRINSIC_VALUE_SERIES.filter(
        (entry) => entry.source.kind === "INTRINSIC_VALUE_BLEND",
      ).map((entry) => entry.id),
    ).toEqual(["BALANCED", "CONSERVATIVE", "DIVIDEND"]);
    expect(
      INTRINSIC_VALUE_SERIES.filter(
        (entry) => entry.source.kind === "INTRINSIC_VALUE_MODEL",
      ).map((entry) => entry.id),
    ).toEqual(["DCF_FCFF", "RESIDUAL_INCOME", "DDM", "GRAHAM"]);
  });

  it("does not offer price as a selectable entry", () => {
    // Price is the chart's always-visible base series, never an option in the picker.
    const ids: readonly string[] = SELECTABLE_SERIES_CATALOG.map(
      (entry) => entry.id,
    );
    expect(ids).not.toContain("PRICE");
    expect(ids).not.toContain("CLOSE");
    expect(
      SELECTABLE_SERIES_CATALOG.some((entry) =>
        entry.label.toLowerCase().includes("price"),
      ),
    ).toBe(false);
  });

  it("resolves and validates identifiers", () => {
    expect(findSelectableSeries("SMA_200W")?.label).toBe("SMA 200W");
    // Unknown, near-miss and wrong-case identifiers all fail to resolve: this lookup is the single
    // validation entry point the API rejects a `series=` filter with.
    expect(findSelectableSeries("SMA_200")).toBeUndefined();
    expect(findSelectableSeries("EMA_100W")).toBeUndefined();
    expect(findSelectableSeries("ema_50w")).toBeUndefined();
    expect(findSelectableSeries("")).toBeUndefined();
  });

  it("projects blend and model options in catalog order with their compact labels", () => {
    // These projections are what keeps a consumer of the intrinsic endpoints — which speak
    // blendId/model rather than catalog id — from keeping its own ordered label list.
    expect(INTRINSIC_VALUE_BLEND_OPTIONS.map((option) => option.blendId)).toEqual(
      SELECTABLE_SERIES_CATALOG.flatMap((entry) =>
        entry.source.kind === "INTRINSIC_VALUE_BLEND" ? [entry.source.blendId] : [],
      ),
    );
    expect(INTRINSIC_VALUE_MODEL_OPTIONS.map((option) => option.model)).toEqual(
      SELECTABLE_SERIES_CATALOG.flatMap((entry) =>
        entry.source.kind === "INTRINSIC_VALUE_MODEL" ? [entry.source.model] : [],
      ),
    );
    expect(
      [...INTRINSIC_VALUE_BLEND_OPTIONS, ...INTRINSIC_VALUE_MODEL_OPTIONS].map(
        (option) => option.label,
      ),
    ).toEqual(
      INTRINSIC_VALUE_SERIES.map((entry) => selectableSeriesShortLabel(entry)),
    );
  });

  it("falls back to the full label when a series declares no compact label", () => {
    for (const entry of CATALOG) {
      expect(selectableSeriesShortLabel(entry)).toBe(
        entry.shortLabel ?? entry.label,
      );
      expect(selectableSeriesShortLabel(entry)).not.toBe("");
    }
    // Only the entries the snapshot marks as differing may carry a compact label at all.
    expect(
      CATALOG.filter((entry) => entry.shortLabel !== undefined).map(
        (entry) => entry.id,
      ),
    ).toEqual(
      EXPECTED_CATALOG.filter((entry) => entry[2] !== entry[3]).map(
        (entry) => entry[0],
      ),
    );
  });

  it("filters moving-average comparisons to the same timeframe and excludes the identity", () => {
    const dailyCount = MOVING_AVERAGE_SERIES.filter(
      (entry) =>
        entry.source.kind === "MOVING_AVERAGE" && entry.source.timeframe === "1D",
    ).length;
    const weeklyCount = MOVING_AVERAGE_SERIES.filter(
      (entry) =>
        entry.source.kind === "MOVING_AVERAGE" && entry.source.timeframe === "1W",
    ).length;

    const daily = comparableMovingAverages("SMA_50D");
    expect(daily).toHaveLength(dailyCount - 1);
    expect(daily.map((entry) => entry.id)).not.toContain("SMA_50D");
    expect(
      daily.every(
        (entry) =>
          entry.source.kind === "MOVING_AVERAGE" &&
          entry.source.timeframe === "1D",
      ),
    ).toBe(true);

    const weekly = comparableMovingAverages("EMA_200W");
    expect(weekly).toHaveLength(weeklyCount - 1);
    expect(
      weekly.every(
        (entry) =>
          entry.source.kind === "MOVING_AVERAGE" &&
          entry.source.timeframe === "1W",
      ),
    ).toBe(true);

    expect(comparableMovingAverages("BALANCED")).toEqual([]);
  });
});
