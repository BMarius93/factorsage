import { describe, expect, it } from "vitest";
import {
  comparableMovingAverages,
  findSelectableSeries,
  INTRINSIC_VALUE_SERIES,
  isSelectableSeriesId,
  MOVING_AVERAGE_SERIES,
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
  SELECTABLE_SERIES_GROUPS,
  selectableSeriesOrder,
} from "./selectable-series.js";

/**
 * The catalog is product state, so it is asserted against the literal table in
 * `docs/decisions/selectable-series-catalog.md` rather than against itself. Any change to an id,
 * label, group or ordering must be made in the decision and here at the same time.
 */
const EXPECTED_CATALOG = [
  ["SMA_20D", "MOVING_AVERAGES_DAILY", "SMA 20D"],
  ["SMA_50D", "MOVING_AVERAGES_DAILY", "SMA 50D"],
  ["SMA_100D", "MOVING_AVERAGES_DAILY", "SMA 100D"],
  ["SMA_200D", "MOVING_AVERAGES_DAILY", "SMA 200D"],
  ["EMA_20D", "MOVING_AVERAGES_DAILY", "EMA 20D"],
  ["EMA_50D", "MOVING_AVERAGES_DAILY", "EMA 50D"],
  ["EMA_200D", "MOVING_AVERAGES_DAILY", "EMA 200D"],
  ["SMA_20W", "MOVING_AVERAGES_WEEKLY", "SMA 20W"],
  ["SMA_50W", "MOVING_AVERAGES_WEEKLY", "SMA 50W"],
  ["SMA_100W", "MOVING_AVERAGES_WEEKLY", "SMA 100W"],
  ["SMA_200W", "MOVING_AVERAGES_WEEKLY", "SMA 200W"],
  ["EMA_20W", "MOVING_AVERAGES_WEEKLY", "EMA 20W"],
  ["EMA_50W", "MOVING_AVERAGES_WEEKLY", "EMA 50W"],
  ["EMA_200W", "MOVING_AVERAGES_WEEKLY", "EMA 200W"],
  ["BALANCED", "INTRINSIC_VALUE_BLENDS", "Balanced"],
  ["CONSERVATIVE", "INTRINSIC_VALUE_BLENDS", "Conservative"],
  ["DIVIDEND", "INTRINSIC_VALUE_BLENDS", "Dividend"],
  ["DCF_FCFF", "INTRINSIC_VALUE_MODELS", "DCF (FCFF)"],
  ["RESIDUAL_INCOME", "INTRINSIC_VALUE_MODELS", "Residual Income"],
  ["DDM", "INTRINSIC_VALUE_MODELS", "Dividend Discount (DDM)"],
  ["GRAHAM", "INTRINSIC_VALUE_MODELS", "Graham"],
] as const;

describe("selectable series catalog", () => {
  it("contains exactly the 21 canonical entries in canonical order", () => {
    expect(
      SELECTABLE_SERIES_CATALOG.map((entry) => [
        entry.id,
        entry.group,
        entry.label,
      ]),
    ).toEqual(EXPECTED_CATALOG.map((entry) => [...entry]));
    expect(SELECTABLE_SERIES_CATALOG).toHaveLength(21);
  });

  it("splits into 14 moving averages and 7 intrinsic-value sources", () => {
    expect(MOVING_AVERAGE_SERIES).toHaveLength(14);
    expect(INTRINSIC_VALUE_SERIES).toHaveLength(7);
    expect(MOVING_AVERAGE_SERIES.length + INTRINSIC_VALUE_SERIES.length).toBe(
      SELECTABLE_SERIES_CATALOG.length,
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
    expect(
      SELECTABLE_SERIES_GROUPED.map((group) => group.series.length),
    ).toEqual([7, 7, 3, 4]);
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
    expect(new Set(fields).size).toBe(14);
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
    expect(findSelectableSeries("SMA_200")).toBeUndefined();
    expect(isSelectableSeriesId("EMA_50W")).toBe(true);
    expect(isSelectableSeriesId("EMA_100W")).toBe(false);
    expect(isSelectableSeriesId("ema_50w")).toBe(false);
    expect(selectableSeriesOrder("SMA_20D")).toBe(0);
    expect(selectableSeriesOrder("GRAHAM")).toBe(20);
  });

  it("filters moving-average comparisons to the same timeframe and excludes the identity", () => {
    const daily = comparableMovingAverages("SMA_50D");
    expect(daily).toHaveLength(6);
    expect(daily.map((entry) => entry.id)).not.toContain("SMA_50D");
    expect(
      daily.every(
        (entry) =>
          entry.source.kind === "MOVING_AVERAGE" &&
          entry.source.timeframe === "1D",
      ),
    ).toBe(true);

    const weekly = comparableMovingAverages("EMA_200W");
    expect(weekly).toHaveLength(6);
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
