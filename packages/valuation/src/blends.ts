import {
  calculated,
  isFiniteNumber,
  notApplicable,
  type ValuationResult,
} from "./types.js";

/**
 * Structural blend definition supplied by the caller.
 *
 * This package holds no product blend identities or weights: those belong to
 * `INTRINSIC_VALUE_BLENDS` in `@intrinsic/domain`, and orchestration passes the chosen definition
 * in. `Model` is any string identity the caller uses to key its component values.
 */
export type BlendComponent<Model extends string> = {
  model: Model;
  /** Decimal fraction; a definition's weights must be positive and sum to 1. */
  weight: number;
};

export type BlendDefinition<Model extends string> = {
  components: readonly BlendComponent<Model>[];
};

/** Per-model value per share. An absent model is a model that produced no value. */
export type BlendComponentValues<Model extends string> = Partial<
  Record<Model, number>
>;

export type BlendValuation = {
  valuePerShare: number;
};

const WEIGHT_SUM_TOLERANCE = 1e-10;

/**
 * A malformed definition is a programming/configuration error, not ordinary financial
 * inapplicability, so it throws instead of returning `NOT_APPLICABLE`.
 */
function assertValidDefinition<Model extends string>(
  definition: BlendDefinition<Model>,
): void {
  if (definition.components.length === 0) {
    throw new Error("Blend definition must have at least one component");
  }
  let total = 0;
  for (const component of definition.components) {
    if (!isFiniteNumber(component.weight) || component.weight <= 0) {
      throw new Error(
        `Blend component ${component.model} must have a positive finite weight`,
      );
    }
    total += component.weight;
  }
  if (Math.abs(total - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error("Blend definition weights must sum to 1");
  }
}

/**
 * Weighted sum of the definition's components.
 *
 * Every component the definition requires must be present and finite. A missing component makes
 * the blend unavailable: weights are never renormalized and no model is ever substituted. Values
 * the definition does not reference are ignored. Provenance and currency are orchestration
 * concerns and play no part here.
 */
export function calculateBlend<Model extends string>(
  definition: BlendDefinition<Model>,
  values: BlendComponentValues<Model>,
): ValuationResult<BlendValuation> {
  assertValidDefinition(definition);

  let valuePerShare = 0;
  for (const component of definition.components) {
    const componentValue = values[component.model];
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

  return calculated({ valuePerShare });
}
