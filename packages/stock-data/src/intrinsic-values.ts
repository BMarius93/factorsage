import {
  INTRINSIC_VALUE_BLENDS,
  type DailyDerivedState,
  type Instant,
  type IntrinsicValueBlendDefinition,
  type IntrinsicValueBlendId,
  type IntrinsicValueModel,
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

/**
 * Point-in-time provenance is per intrinsic-value model.
 *
 * Models may consume different financial-statement families/revisions, so each carries its own
 * source instant on the daily derived row. Reads resolve a model through this map and must never
 * substitute another model's instant or the newest instant on the row.
 */
export const INTRINSIC_MODEL_SOURCE_FIELDS = {
  DCF_FCFF: "dcfFcffSourceAsOf",
  RESIDUAL_INCOME: "residualIncomeSourceAsOf",
  DDM: "ddmSourceAsOf",
  GRAHAM: "grahamSourceAsOf",
} as const satisfies Record<IntrinsicValueModel, keyof DailyDerivedState>;

/** The daily-row provenance field that belongs to one model; never reuse another model's. */
export type IntrinsicModelSourceField =
  (typeof INTRINSIC_MODEL_SOURCE_FIELDS)[IntrinsicValueModel];

/** That model's own provenance instant, or `undefined` when it has none on this trading day. */
export function intrinsicModelSourceAsOf(
  row: DailyDerivedState,
  model: IntrinsicValueModel,
): Instant | undefined {
  return row[INTRINSIC_MODEL_SOURCE_FIELDS[model]];
}

/** Models that must all be present for the blend to exist; weights are never renormalized. */
export function blendComponentModels(
  blendId: IntrinsicValueBlendId,
): readonly IntrinsicValueModel[] {
  return INTRINSIC_VALUE_BLENDS[blendId].components.map(
    (component) => component.model,
  );
}

/**
 * Blend provenance derived from the models that actually compose the blend.
 *
 * It is the maximum provenance instant of the required components, and it is only defined when
 * every required component value AND every required component provenance instant is present. A
 * missing component makes the blend unavailable; it never renormalizes weights, substitutes
 * another model, or falls back to a row-level instant.
 */
export function blendSourceDataAsOf(
  row: DailyDerivedState,
  blendId: IntrinsicValueBlendId,
): Instant | undefined {
  let latest: Instant | undefined;
  for (const model of blendComponentModels(blendId)) {
    const sourceAsOf = intrinsicModelSourceAsOf(row, model);
    if (row.intrinsicValues?.[model] === undefined || sourceAsOf === undefined) {
      return undefined;
    }
    if (latest === undefined || sourceAsOf > latest) {
      latest = sourceAsOf;
    }
  }
  return latest;
}
