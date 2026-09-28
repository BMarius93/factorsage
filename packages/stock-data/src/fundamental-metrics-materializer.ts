import type {
  FinancialStatement,
  FundamentalMetricSnapshot,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import { isFiscalQuarterPeriod } from "./fiscal-quarters.js";
import { evaluateFundamentalMetrics } from "./fundamental-metrics.js";
import {
  normalizeTradingDates,
  planStatementEvaluationDates,
} from "./statement-events.js";

/**
 * Fundamental-only projection of one trading day's derived state: the fifteen metrics effective on
 * `date`. `buildDailyDerivedState` merges it onto the unified row by exact trading date.
 *
 * An absent field means the metric is unavailable that day — never zero, never back-filled, and
 * never a value carried through a later invalidation.
 */
export type DailyFundamentalState = {
  date: LocalDate;
} & FundamentalMetricSnapshot;

export type DailyFundamentalMaterializationRequest = {
  securityId: SecurityId;
  /** The canonical trading-day axis: the security's persisted `DailyPrice` dates. */
  tradingDates: readonly LocalDate[];
  /** Every retained statement revision, each with its own `availableFromDate`. */
  statements: readonly FinancialStatement[];
};

const MATERIALIZATION = "fundamental materialization";

/**
 * The only statements any fundamental metric reads: this security's standalone quarterly rows.
 *
 * Every V1 formula is built from `Q1`-`Q4` statements, so an `FY` revision can never change a
 * fundamental snapshot and is not an event for it.
 */
function fundamentalSourceStatements(
  request: DailyFundamentalMaterializationRequest,
): FinancialStatement[] {
  return request.statements.filter(
    (statement) =>
      statement.securityId === request.securityId &&
      isFiscalQuarterPeriod(statement.period),
  );
}

/**
 * Trading days on which the fundamental snapshot is re-evaluated: the first trading day, plus the
 * first trading day on or after each quarterly revision's `availableFromDate`. Weekend and holiday
 * availability lands on the next actual trading day; revisions landing together are one event.
 */
export function planFundamentalEvaluationDates(
  request: DailyFundamentalMaterializationRequest,
): LocalDate[] {
  return planStatementEvaluationDates(
    {
      securityId: request.securityId,
      tradingDates: request.tradingDates,
      statements: fundamentalSourceStatements(request),
    },
    MATERIALIZATION,
  );
}

/**
 * Materializes the fifteen Fundamental Metrics onto every supplied trading day.
 *
 * All fifteen are evaluated only on statement events — once per event, from the complete
 * point-in-time statement set of that trading day — and the resulting snapshot is carried forward
 * unchanged until the next event. Carry-forward includes absence: a metric a newer revision
 * invalidates is absent from that event's trading day onward, and a later event can restore it.
 *
 * The cost is one evaluation per event plus one copy per trading day, never a statement scan per
 * trading day. No row is produced for a date absent from `tradingDates`, so a weekend or holiday
 * never gains a synthetic observation. Deterministic and stateless: no clock, provider, database or
 * cache, and the caller's arrays are never reordered or mutated.
 */
export function materializeDailyFundamentals(
  request: DailyFundamentalMaterializationRequest,
): DailyFundamentalState[] {
  const sortedDates = normalizeTradingDates(
    request.tradingDates,
    MATERIALIZATION,
  );
  if (sortedDates.length === 0) {
    return [];
  }
  const statements = fundamentalSourceStatements(request);
  const evaluationDates = new Set(
    planStatementEvaluationDates(
      {
        securityId: request.securityId,
        tradingDates: sortedDates,
        statements,
      },
      MATERIALIZATION,
    ),
  );

  let snapshot: FundamentalMetricSnapshot = {};
  return sortedDates.map((date) => {
    if (evaluationDates.has(date)) {
      snapshot = evaluateFundamentalMetrics({
        securityId: request.securityId,
        date,
        statements,
      });
    }
    return { date, ...snapshot };
  });
}
