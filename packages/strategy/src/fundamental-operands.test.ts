import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { operandAlternativeDataMetric } from "./alternative-data.js";
import {
  fundamentalMetricOperand,
  marginOfSafetyOperand,
  operandFundamentalMetricId,
  operandRelativeVolumePeriod,
  operandSeriesId,
  PRICE_OPERAND,
  relativeVolumeOperand,
  seriesOperand,
} from "./operands.js";

/**
 * The Fundamental Metric operand family: one canonical encoding, owned by `operands.ts`, with its
 * inverse beside it. Nothing else in the repository builds or slices one of these keys.
 */
describe("the fundamental metric operand family", () => {
  it("keys each metric by its stable identity, deterministically", () => {
    expect(fundamentalMetricOperand("ROIC_TTM")).toBe("fundamental:ROIC_TTM");
    expect(fundamentalMetricOperand("REVENUE_GROWTH_TTM_YOY")).toBe(
      "fundamental:REVENUE_GROWTH_TTM_YOY",
    );
    expect(fundamentalMetricOperand("DEBT_TO_EQUITY")).toBe(
      "fundamental:DEBT_TO_EQUITY",
    );
    // The same identity always gives the same key, so two runs request identical projections.
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(fundamentalMetricOperand(id)).toBe(fundamentalMetricOperand(id));
    }
  });

  it("gives fifteen metrics fifteen distinct keys", () => {
    const keys = FUNDAMENTAL_METRIC_IDS.map(fundamentalMetricOperand);
    expect(keys).toHaveLength(15);
    expect(new Set(keys).size).toBe(15);
  });

  it("decodes every key it builds back to the same identity", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(operandFundamentalMetricId(fundamentalMetricOperand(id))).toBe(id);
    }
  });

  it("never encodes a label or a storage field", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const key = fundamentalMetricOperand(entry.id);
      expect(key).not.toContain(entry.label);
      expect(key).toBe(`fundamental:${entry.id}`);
    }
  });

  it("decodes nothing that is not one of the catalog's identities", () => {
    for (const key of [
      "fundamental:PE_TTM",
      "fundamental:roic_ttm",
      "fundamental:Roic_Ttm",
      "fundamental:ROIC TTM",
      "fundamental:roicTtm",
      "fundamental:ROIC",
      "fundamental: ROIC_TTM",
      "fundamental:ROIC_TTM ",
      "fundamental:",
      "fundamental",
      "Fundamental:ROIC_TTM",
      "FUNDAMENTAL:ROIC_TTM",
      "fundamentals:ROIC_TTM",
      "ROIC_TTM",
      "",
    ]) {
      expect(operandFundamentalMetricId(key), key).toBeNull();
    }
  });

  it("is disjoint from every other operand family", () => {
    const others = [
      PRICE_OPERAND,
      seriesOperand("SMA_200D"),
      seriesOperand("BALANCED"),
      relativeVolumeOperand(20),
      marginOfSafetyOperand("DCF_FCFF"),
    ];
    for (const key of others) {
      expect(operandFundamentalMetricId(key), key).toBeNull();
    }
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      const key = fundamentalMetricOperand(id);
      expect(operandSeriesId(key), key).toBeNull();
      expect(operandRelativeVolumePeriod(key), key).toBeNull();
      expect(operandAlternativeDataMetric(key), key).toBeNull();
      expect(key).not.toBe(PRICE_OPERAND);
    }
  });
});
