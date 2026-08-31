import type {
  FinancialStatement,
  Instant,
  IntrinsicValueBlendDefinition,
  IntrinsicValueBlendId,
  IntrinsicValueModel,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_BLENDS,
} from "@intrinsic/domain";
import {
  calculateBlend,
  calculateDcfFcff,
  calculateDdm,
  calculateGraham,
  calculateResidualIncome,
  type ValuationNotApplicableReason,
  type ValuationResult,
} from "@intrinsic/valuation";
import {
  assembleIntrinsicValueInputs,
  type AssembledModelInput,
  type IntrinsicValueAssemblyReason,
} from "./intrinsic-value-inputs.js";

/**
 * Where a model became unavailable.
 *
 * `ASSEMBLY` means point-in-time statement selection could not produce inputs; `VALUATION` means
 * the inputs existed but the pure formula rejected them on financial grounds. Keeping the phases
 * and their own reason vocabularies apart is what lets a later reader tell "we lack data" from
 * "the company does not support this model".
 */
export type EvaluatedIntrinsicModel =
  | {
      status: "CALCULATED";
      valuePerShare: number;
      sourceDataAsOf: Instant;
      currency: string;
    }
  | {
      status: "NOT_APPLICABLE";
      phase: "ASSEMBLY";
      reason: IntrinsicValueAssemblyReason;
    }
  | {
      status: "NOT_APPLICABLE";
      phase: "VALUATION";
      reason: ValuationNotApplicableReason;
    };

/** Blend-level unavailability: the pure calculator's reasons plus a blend currency conflict. */
export type EvaluatedIntrinsicBlendReason =
  | ValuationNotApplicableReason
  | "CURRENCY_MISMATCH";

export type EvaluatedIntrinsicBlend =
  | {
      status: "CALCULATED";
      valuePerShare: number;
      sourceDataAsOf: Instant;
      currency: string;
    }
  | { status: "NOT_APPLICABLE"; reason: EvaluatedIntrinsicBlendReason };

/**
 * Row-level currency assessment over the CALCULATED models only.
 *
 * This slice never discards a model result. It reports the assessment so the later materializer
 * can apply the `DailyDerivedState` rule (a `CONFLICT` materializes no intrinsic values for that
 * trading day) without reinventing it. No majority or priority currency is ever chosen.
 */
export type IntrinsicCurrencyConsistency =
  | { status: "CONSISTENT"; currency: string }
  | { status: "NO_VALUES" }
  | { status: "CONFLICT"; currencies: readonly string[] };

export type EvaluatedIntrinsicValues = {
  securityId: SecurityId;
  valuationDate: LocalDate;
  models: Record<IntrinsicValueModel, EvaluatedIntrinsicModel>;
  blends: Record<IntrinsicValueBlendId, EvaluatedIntrinsicBlend>;
  currencyConsistency: IntrinsicCurrencyConsistency;
};

export type IntrinsicValueEvaluationRequest = {
  securityId: SecurityId;
  valuationDate: LocalDate;
  statements: readonly FinancialStatement[];
};

/** Canonical availability instants share one UTC-midnight encoding, so they order lexically. */
function laterInstant(left: Instant, right: Instant): Instant {
  return left > right ? left : right;
}

/**
 * Runs one model: assembly first, then the pure formula only if inputs exist.
 *
 * Provenance and currency come from the assembly result unchanged — the formula neither knows nor
 * recomputes them — and only `valuePerShare` crosses this boundary. Formula intermediates stay
 * inside the calculation and are never treated as persistence state.
 */
function evaluateModel<Input>(
  assembled: AssembledModelInput<Input>,
  calculate: (input: Input) => ValuationResult<{ valuePerShare: number }>,
): EvaluatedIntrinsicModel {
  if (assembled.status === "NOT_APPLICABLE") {
    return {
      status: "NOT_APPLICABLE",
      phase: "ASSEMBLY",
      reason: assembled.reason,
    };
  }

  const result = calculate(assembled.input);
  if (result.status === "NOT_APPLICABLE") {
    return {
      status: "NOT_APPLICABLE",
      phase: "VALUATION",
      reason: result.reason,
    };
  }

  return {
    status: "CALCULATED",
    valuePerShare: result.value.valuePerShare,
    sourceDataAsOf: assembled.sourceDataAsOf,
    currency: assembled.currency,
  };
}

/**
 * Combines one canonical blend definition with the evaluated models.
 *
 * Only the models the definition names take part: a non-component model contributes neither value,
 * provenance nor currency, and its unavailability never makes the blend unavailable. The weighted
 * sum itself stays in `@intrinsic/valuation`, so weights are never restated here and are never
 * renormalized around a missing component.
 */
export function combineBlendComponents(
  definition: IntrinsicValueBlendDefinition,
  models: Record<IntrinsicValueModel, EvaluatedIntrinsicModel>,
): EvaluatedIntrinsicBlend {
  const values: Partial<Record<IntrinsicValueModel, number>> = {};
  for (const component of definition.components) {
    const model = models[component.model];
    if (model.status === "CALCULATED") {
      values[component.model] = model.valuePerShare;
    }
  }

  const blend = calculateBlend(definition, values);
  if (blend.status === "NOT_APPLICABLE") {
    return { status: "NOT_APPLICABLE", reason: blend.reason };
  }

  // Every required component calculated, so provenance and currency come from exactly those.
  let sourceDataAsOf: Instant | undefined;
  let currency: string | undefined;
  for (const component of definition.components) {
    const model = models[component.model];
    if (model.status !== "CALCULATED") {
      continue;
    }
    sourceDataAsOf =
      sourceDataAsOf === undefined
        ? model.sourceDataAsOf
        : laterInstant(sourceDataAsOf, model.sourceDataAsOf);
    if (currency === undefined) {
      currency = model.currency;
    } else if (currency !== model.currency) {
      // No FX conversion and no currency is preferred over another.
      return { status: "NOT_APPLICABLE", reason: "CURRENCY_MISMATCH" };
    }
  }

  if (sourceDataAsOf === undefined || currency === undefined) {
    return { status: "NOT_APPLICABLE", reason: "MISSING_COMPONENT" };
  }

  return {
    status: "CALCULATED",
    valuePerShare: blend.value.valuePerShare,
    sourceDataAsOf,
    currency,
  };
}

function assessCurrencyConsistency(
  models: Record<IntrinsicValueModel, EvaluatedIntrinsicModel>,
): IntrinsicCurrencyConsistency {
  const currencies = new Set<string>();
  for (const model of Object.values(models)) {
    if (model.status === "CALCULATED") {
      currencies.add(model.currency);
    }
  }
  if (currencies.size === 0) {
    return { status: "NO_VALUES" };
  }
  const [only] = [...currencies];
  if (currencies.size === 1 && only !== undefined) {
    return { status: "CONSISTENT", currency: only };
  }
  return { status: "CONFLICT", currencies: [...currencies].sort() };
}

/**
 * Evaluates every canonical intrinsic-value model and blend for one security on one trading day.
 *
 * The function is a stateless snapshot of `valuationDate`: it assembles point-in-time inputs once,
 * runs the pure formulas, and reports what that day's eligible statements support. It never
 * remembers or looks up a previously calculated value, so a newer eligible revision that
 * invalidates a model yields `NOT_APPLICABLE` here rather than a stale value. Carry-forward and
 * the persistence consequences of an invalidation belong to the materializer.
 */
export function evaluateIntrinsicValues(
  request: IntrinsicValueEvaluationRequest,
): EvaluatedIntrinsicValues {
  const assembled = assembleIntrinsicValueInputs(request);

  const models: Record<IntrinsicValueModel, EvaluatedIntrinsicModel> = {
    DCF_FCFF: evaluateModel(assembled.DCF_FCFF, calculateDcfFcff),
    RESIDUAL_INCOME: evaluateModel(
      assembled.RESIDUAL_INCOME,
      calculateResidualIncome,
    ),
    DDM: evaluateModel(assembled.DDM, calculateDdm),
    GRAHAM: evaluateModel(assembled.GRAHAM, calculateGraham),
  };

  const blends = Object.fromEntries(
    INTRINSIC_VALUE_BLEND_IDS.map((blendId) => [
      blendId,
      combineBlendComponents(INTRINSIC_VALUE_BLENDS[blendId], models),
    ]),
  ) as Record<IntrinsicValueBlendId, EvaluatedIntrinsicBlend>;

  return {
    securityId: request.securityId,
    valuationDate: request.valuationDate,
    models,
    blends,
    currencyConsistency: assessCurrencyConsistency(models),
  };
}
