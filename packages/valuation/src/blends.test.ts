import { describe, expect, it } from "vitest";
import {
  blendComponents,
  calculateBlend,
  VALUATION_BLEND_COMPONENTS,
} from "./blends.js";
import { VALUATION_BLEND_IDS } from "./types.js";

const ALL_MODELS = {
  DCF_FCFF: 100,
  RESIDUAL_INCOME: 100,
  DDM: 100,
  GRAHAM: 100,
} as const;

describe("blends", () => {
  it("keeps the locked V1 weights", () => {
    expect(VALUATION_BLEND_COMPONENTS.BALANCED).toEqual([
      { model: "DCF_FCFF", weight: 0.5 },
      { model: "RESIDUAL_INCOME", weight: 0.3 },
      { model: "GRAHAM", weight: 0.2 },
    ]);
    expect(VALUATION_BLEND_COMPONENTS.CONSERVATIVE).toEqual([
      { model: "DCF_FCFF", weight: 0.4 },
      { model: "RESIDUAL_INCOME", weight: 0.3 },
      { model: "GRAHAM", weight: 0.3 },
    ]);
    expect(VALUATION_BLEND_COMPONENTS.DIVIDEND).toEqual([
      { model: "DCF_FCFF", weight: 0.4 },
      { model: "DDM", weight: 0.4 },
      { model: "RESIDUAL_INCOME", weight: 0.2 },
    ]);
  });

  it("requires every component of every blend", () => {
    for (const blendId of VALUATION_BLEND_IDS) {
      for (const component of blendComponents(blendId)) {
        const withoutOne = { ...ALL_MODELS, [component.model]: undefined };
        expect(calculateBlend(blendId, withoutOne)).toEqual({
          status: "NOT_APPLICABLE",
          reason: "MISSING_COMPONENT",
        });
      }
      expect(calculateBlend(blendId, {})).toEqual({
        status: "NOT_APPLICABLE",
        reason: "MISSING_COMPONENT",
      });
    }
  });

  it("does not renormalize weights around a zero-valued component", () => {
    // Renormalizing over the non-zero components would yield 100; the locked weights yield 80.
    const result = calculateBlend("BALANCED", {
      DCF_FCFF: 100,
      RESIDUAL_INCOME: 100,
      GRAHAM: 0,
    });

    expect(result).toEqual({
      status: "CALCULATED",
      value: { blendId: "BALANCED", valuePerShare: 80 },
    });
  });

  it("ignores models that are not components of the blend", () => {
    // DDM is not part of BALANCED, so its presence or absence changes nothing.
    const withDdm = calculateBlend("BALANCED", ALL_MODELS);
    const withoutDdm = calculateBlend("BALANCED", {
      DCF_FCFF: 100,
      RESIDUAL_INCOME: 100,
      GRAHAM: 100,
    });

    expect(withDdm).toEqual(withoutDdm);
    expect(withDdm.status === "CALCULATED" && withDdm.value.valuePerShare).toBe(
      100,
    );
  });

  it("never calculates from a non-finite component", () => {
    expect(
      calculateBlend("CONSERVATIVE", {
        ...ALL_MODELS,
        RESIDUAL_INCOME: Number.NaN,
      }),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "NON_FINITE_INPUT" });
    expect(
      calculateBlend("DIVIDEND", {
        ...ALL_MODELS,
        DDM: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "NON_FINITE_INPUT" });
  });
});
