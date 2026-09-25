import {
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  RELATIVE_VOLUME_PERIODS,
  SELECTABLE_SERIES_CATALOG,
  STRATEGY_METRIC_DEFINITIONS,
} from "@intrinsic/contracts";
import {
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  RELATIVE_VOLUME_PERIODS as DOMAIN_RELATIVE_VOLUME_PERIODS,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  MATERIALIZED_MOVING_AVERAGES,
  RSI_VALUE_RANGE,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";

/**
 * Drift guard between the product catalog and the backend identities it addresses.
 *
 * `@intrinsic/contracts` owns the selectable-series catalog because it is the only package the web
 * app may depend on. `@intrinsic/domain` owns the structured identities that are calculated and
 * persisted. This suite lives in the API, the closest package that depends on both, and fails the
 * moment one side gains, loses, renames or reorders a series without the other.
 */
describe("canonical selectable-series catalog", () => {
  it("addresses exactly the moving averages the domain materializes, in the same order", () => {
    expect(
      MOVING_AVERAGE_SERIES.map((entry) => {
        if (entry.source.kind !== "MOVING_AVERAGE") {
          throw new Error("unreachable");
        }
        return {
          type: entry.source.type,
          period: entry.source.period,
          timeframe: entry.source.timeframe,
          field: entry.source.field,
        };
      }),
    ).toEqual(
      MATERIALIZED_MOVING_AVERAGES.map((average) => ({
        type: average.type,
        period: average.period,
        timeframe: average.timeframe,
        field: average.field,
      })),
    );
  });

  it("addresses exactly the oscillators the domain materializes, in the same order", () => {
    expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
    expect(
      OSCILLATOR_SERIES.map((entry) => {
        if (entry.source.kind !== "OSCILLATOR") {
          throw new Error("unreachable");
        }
        return {
          type: entry.source.type,
          period: entry.source.period,
          timeframe: entry.source.timeframe,
          field: entry.source.field,
        };
      }),
    ).toEqual(
      DAILY_OSCILLATORS.map((oscillator) => ({
        type: oscillator.type,
        period: oscillator.period,
        timeframe: oscillator.timeframe,
        field: oscillator.field,
      })),
    );
  });

  it("offers exactly the Relative Volume periods the domain materializes", () => {
    // `@intrinsic/contracts` states the periods because it is the only package the web app may
    // depend on; `@intrinsic/domain` owns the columns they are calculated into. Neither may move
    // without the other — a period the Builder offers but nothing materializes would read as
    // permanent warm-up, and a column nothing offers would never be reachable.
    expect(DOMAIN_RELATIVE_VOLUME_PERIODS.length).toBeGreaterThan(0);
    expect([...RELATIVE_VOLUME_PERIODS]).toEqual([
      ...DOMAIN_RELATIVE_VOLUME_PERIODS,
    ]);
    expect(DAILY_RELATIVE_VOLUMES.map((entry) => entry.period)).toEqual([
      ...RELATIVE_VOLUME_PERIODS,
    ]);
  });

  it("keeps Relative Volume out of the selectable-series catalog", () => {
    // It is a Strategy metric and a Stock Details reading, never a chart overlay and never a
    // comparison Value, so it is deliberately not a catalog entry — the same choice `Price`,
    // `Gain` and `Loss` make. A catalog entry would put it into the Indicators picker.
    expect(
      SELECTABLE_SERIES_CATALOG.some((entry) =>
        entry.id.startsWith("RVOL"),
      ),
    ).toBe(false);
    expect(STRATEGY_METRIC_DEFINITIONS.RELATIVE_VOLUME.parameterSeriesIds).toBeUndefined();
  });

  it("carries the domain's RSI unit range on every RSI catalog entry", () => {
    // The 0-100 scale is domain truth (`RSI_VALUE_RANGE`); the catalog repeats it as structured
    // product metadata for the chart pane. This pins the two so they cannot drift.
    for (const entry of OSCILLATOR_SERIES) {
      if (entry.source.kind !== "OSCILLATOR") {
        throw new Error("unreachable");
      }
      expect(entry.source.range).toEqual(RSI_VALUE_RANGE);
    }
  });

  it("addresses exactly the domain intrinsic-value blends and models", () => {
    expect(
      INTRINSIC_VALUE_SERIES.flatMap((entry) =>
        entry.source.kind === "INTRINSIC_VALUE_BLEND"
          ? [entry.source.blendId]
          : [],
      ),
    ).toEqual([...INTRINSIC_VALUE_BLEND_IDS]);
    expect(
      INTRINSIC_VALUE_SERIES.flatMap((entry) =>
        entry.source.kind === "INTRINSIC_VALUE_MODEL"
          ? [entry.source.model]
          : [],
      ),
    ).toEqual([...INTRINSIC_VALUE_MODELS]);
  });

  it("keeps the catalog at exactly one entry per backend identity", () => {
    expect(SELECTABLE_SERIES_CATALOG).toHaveLength(
      MATERIALIZED_MOVING_AVERAGES.length +
        DAILY_OSCILLATORS.length +
        INTRINSIC_VALUE_MODELS.length +
        INTRINSIC_VALUE_BLEND_IDS.length,
    );
  });
});
