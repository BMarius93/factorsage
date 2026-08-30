import {
  INTRINSIC_VALUE_BLENDS,
  type IntrinsicValueBlendDefinition,
} from "@intrinsic/domain";

/**
 * Blend definitions are versioned so a weight change is an explicit product decision, but only the
 * current definition is ever materialized into `DailyDerivedState`. A weight change rebuilds the
 * affected daily rows; blend versions must not coexist per trading day, and blends must never be
 * reconstructed from sparse valuation events at read time.
 */
export function validateBlendDefinition(
  definition: IntrinsicValueBlendDefinition,
): void {
  const total = definition.components.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  if (Math.abs(total - 1) > 1e-10) {
    throw new Error(
      `Blend ${definition.id} v${definition.version} weights must sum to 1`,
    );
  }
  if (definition.components.some((component) => component.weight <= 0)) {
    throw new Error("Blend weights must be positive");
  }
}

for (const definition of Object.values(INTRINSIC_VALUE_BLENDS)) {
  validateBlendDefinition(definition);
}
