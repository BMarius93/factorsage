import type {
  FinancialStatement,
  Instant,
  IntrinsicValueBlendId,
  IntrinsicValueModel,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import { evaluateIntrinsicValues } from "./intrinsic-value-evaluator.js";
import {
  INTRINSIC_MODEL_SOURCE_FIELDS,
  type IntrinsicModelSourceField,
} from "./intrinsic-values.js";
import {
  normalizeTradingDates,
  planStatementEvaluationDates,
} from "./statement-events.js";

/**
 * Intrinsic-only projection of one trading day's derived state.
 *
 * It deliberately holds just the intrinsic fields of `DailyDerivedState`; the unified row is
 * assembled by `buildDailyDerivedState`, which merges this by exact trading date. An absent value
 * means the model is unavailable that day — storage never distinguishes "not yet eligible" from
 * "not applicable", and a value is never zero-filled or back-filled.
 *
 * Blend provenance is not present by design: it stays derived from the component models' own
 * provenance at read time.
 */
export type DailyIntrinsicState = {
  date: LocalDate;
  intrinsicValues?: Partial<Record<IntrinsicValueModel, number>>;
  intrinsicValueBlends?: Partial<Record<IntrinsicValueBlendId, number>>;
  dcfFcffSourceAsOf?: Instant;
  residualIncomeSourceAsOf?: Instant;
  ddmSourceAsOf?: Instant;
  grahamSourceAsOf?: Instant;
  intrinsicCurrency?: string;
};

export type DailyIntrinsicMaterializationRequest = {
  securityId: SecurityId;
  /** Actual trading days for this security. Non-trading days are never invented. */
  tradingDates: readonly LocalDate[];
  statements: readonly FinancialStatement[];
};

/** The carried-forward intrinsic snapshot, i.e. a `DailyIntrinsicState` without its date. */
type IntrinsicSnapshot = Omit<DailyIntrinsicState, "date">;

const EMPTY_SNAPSHOT: IntrinsicSnapshot = {};

const MATERIALIZATION = "intrinsic materialization";

/**
 * Trading days on which the intrinsic snapshot must be re-evaluated.
 *
 * The first supplied trading day plus the effective trading day of each later statement revision,
 * decided by the shared {@link planStatementEvaluationDates} so intrinsic values and Fundamental
 * Metrics change on exactly the same day for the same revision. A revision available on a
 * weekend or holiday takes effect on the first supplied trading day on or after it, and several
 * revisions landing on one trading day cause a single evaluation. Which model a statement affects
 * is deliberately not guessed: every event re-evaluates all four models.
 */
export function planIntrinsicEvaluationDates(
  request: DailyIntrinsicMaterializationRequest,
): LocalDate[] {
  return planStatementEvaluationDates(request, MATERIALIZATION);
}

/**
 * Converts one evaluation into the snapshot carried forward until the next event.
 *
 * A `CONFLICT` between the currencies of independently calculated models is a data-consistency
 * failure, so nothing intrinsic is materialized for that day: no model values, no provenance, no
 * blends and no currency. No majority currency is chosen and no prior value survives the event.
 */
function toSnapshot(
  evaluation: ReturnType<typeof evaluateIntrinsicValues>,
): IntrinsicSnapshot {
  if (evaluation.currencyConsistency.status !== "CONSISTENT") {
    return EMPTY_SNAPSHOT;
  }

  const intrinsicValues: Partial<Record<IntrinsicValueModel, number>> = {};
  const provenance: Partial<Record<IntrinsicModelSourceField, Instant>> = {};
  for (const [model, evaluated] of Object.entries(evaluation.models) as [
    IntrinsicValueModel,
    (typeof evaluation.models)[IntrinsicValueModel],
  ][]) {
    if (evaluated.status !== "CALCULATED") {
      continue;
    }
    intrinsicValues[model] = evaluated.valuePerShare;
    // Each model's provenance goes to its own column, never another model's.
    provenance[INTRINSIC_MODEL_SOURCE_FIELDS[model]] = evaluated.sourceDataAsOf;
  }

  const intrinsicValueBlends: Partial<Record<IntrinsicValueBlendId, number>> =
    {};
  for (const [blendId, blend] of Object.entries(evaluation.blends) as [
    IntrinsicValueBlendId,
    (typeof evaluation.blends)[IntrinsicValueBlendId],
  ][]) {
    if (blend.status === "CALCULATED") {
      intrinsicValueBlends[blendId] = blend.valuePerShare;
    }
  }

  return {
    ...(Object.keys(intrinsicValues).length === 0 ? {} : { intrinsicValues }),
    ...(Object.keys(intrinsicValueBlends).length === 0
      ? {}
      : { intrinsicValueBlends }),
    ...provenance,
    intrinsicCurrency: evaluation.currencyConsistency.currency,
  };
}

/**
 * Materializes the daily intrinsic state for every supplied trading day.
 *
 * The evaluator runs only on evaluation events; between them the entire latest snapshot is carried
 * forward, which is why an unchanged valuation repeats across trading days. Carry-forward applies
 * to unavailability too: a model that becomes unavailable at an event is absent from that trading
 * day onward, and its stale value and provenance are never carried through the invalidation. A
 * later event can restore it.
 *
 * The function is deterministic and stateless: no clock, no provider, no database and no cache.
 */
export function materializeDailyIntrinsicValues(
  request: DailyIntrinsicMaterializationRequest,
): DailyIntrinsicState[] {
  const sortedDates = normalizeTradingDates(
    request.tradingDates,
    MATERIALIZATION,
  );
  if (sortedDates.length === 0) {
    return [];
  }
  const evaluationDates = new Set(planIntrinsicEvaluationDates(request));

  let snapshot: IntrinsicSnapshot = EMPTY_SNAPSHOT;
  return sortedDates.map((date) => {
    if (evaluationDates.has(date)) {
      snapshot = toSnapshot(
        evaluateIntrinsicValues({
          securityId: request.securityId,
          valuationDate: date,
          statements: request.statements,
        }),
      );
    }
    return { date, ...snapshot };
  });
}
