import {
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  SELECTABLE_SERIES_CATALOG,
} from "@intrinsic/contracts";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  MATERIALIZED_MOVING_AVERAGES,
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
        INTRINSIC_VALUE_MODELS.length +
        INTRINSIC_VALUE_BLEND_IDS.length,
    );
  });
});
