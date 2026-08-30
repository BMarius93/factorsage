import {
  calculated,
  isFiniteNumber,
  notApplicable,
  VALUATION_BLEND_IDS,
  type ValuationBlendId,
  type ValuationModelId,
  type ValuationResult,
} from "./types.js";

export type BlendComponent = {
  model: ValuationModelId;
  /** Decimal fraction; the components of a blend must sum to 1. */
  weight: number;
};

/**
 * V1 blend weights. These restate the product definitions owned by `INTRINSIC_VALUE_BLENDS` in
 * `@intrinsic/domain`; a weight change is a product decision that must update both.
 */
export const VALUATION_BLEND_COMPONENTS = {
  BALANCED: [
    { model: "DCF_FCFF", weight: 0.5 },
    { model: "RESIDUAL_INCOME", weight: 0.3 },
    { model: "GRAHAM", weight: 0.2 },
  ],
  CONSERVATIVE: [
    { model: "DCF_FCFF", weight: 0.4 },
    { model: "RESIDUAL_INCOME", weight: 0.3 },
    { model: "GRAHAM", weight: 0.3 },
  ],
  DIVIDEND: [
    { model: "DCF_FCFF", weight: 0.4 },
    { model: "DDM", weight: 0.4 },
    { model: "RESIDUAL_INCOME", weight: 0.2 },
  ],
} as const satisfies Record<ValuationBlendId, readonly BlendComponent[]>;

for (const blendId of VALUATION_BLEND_IDS) {
  const total = VALUATION_BLEND_COMPONENTS[blendId].reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  if (Math.abs(total - 1) > 1e-10) {
    throw new Error(`Blend ${blendId} weights must sum to 1`);
  }
}

/** Per-model value per share. An absent model is a model that produced no value. */
export type BlendComponentValues = Partial<Record<ValuationModelId, number>>;

export type BlendValuation = {
  blendId: ValuationBlendId;
  valuePerShare: number;
};

export function blendComponents(
  blendId: ValuationBlendId,
): readonly BlendComponent[] {
  return VALUATION_BLEND_COMPONENTS[blendId];
}

/**
 * Weighted sum of the blend's required components.
 *
 * Every required component must be present and finite. A missing component makes the blend
 * unavailable: weights are never renormalized and no model is ever substituted. Provenance and
 * currency are orchestration concerns and play no part here.
 */
export function calculateBlend(
  blendId: ValuationBlendId,
  components: BlendComponentValues,
): ValuationResult<BlendValuation> {
  let valuePerShare = 0;
  for (const component of blendComponents(blendId)) {
    const componentValue = components[component.model];
    if (componentValue === undefined) {
      return notApplicable("MISSING_COMPONENT");
    }
    if (!isFiniteNumber(componentValue)) {
      return notApplicable("NON_FINITE_INPUT");
    }
    valuePerShare += componentValue * component.weight;
  }

  if (!isFiniteNumber(valuePerShare)) {
    return notApplicable("NON_FINITE_RESULT");
  }

  return calculated({ blendId, valuePerShare });
}
