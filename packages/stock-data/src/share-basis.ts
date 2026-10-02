import type {
  FinancialStatement,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import { selectFinancialStatements } from "@intrinsic/domain";
import {
  indexFiscalQuarters,
  isFiscalQuarterPeriod,
  latestFiscalQuarterStatement,
} from "./fiscal-quarters.js";
import type { DailyIntrinsicState } from "./intrinsic-value-materializer.js";
import { basisFactorAt, type PriceBasisEvent } from "./price-basis.js";
import {
  normalizeTradingDates,
  planStatementEvaluationDates,
} from "./statement-events.js";

const SHARE_BASIS = "share basis";

/**
 * The share-count revision of each trading day: the latest point-in-time quarterly Income
 * statement, whose `weightedAverageShsOutDil` is the share basis (`intrinsic-value-engine.md`;
 * `historical-price-basis-v1.md`, §3).
 *
 * Its observation is what fixes the units of every per-share figure the day uses, so it is what the
 * basis factor is measured against. It changes only when a quarterly Income revision becomes
 * eligible, so it is evaluated on those days and carried forward, like every statement-derived value.
 */
export function shareRevisionsByDate(input: {
  securityId: SecurityId;
  tradingDates: readonly LocalDate[];
  statements: readonly FinancialStatement[];
}): Map<LocalDate, FinancialStatement | undefined> {
  const dates = normalizeTradingDates(input.tradingDates, SHARE_BASIS);
  const income = input.statements.filter(
    (statement) =>
      statement.securityId === input.securityId &&
      statement.statementType === "INCOME" &&
      isFiscalQuarterPeriod(statement.period),
  );
  const events = new Set(
    planStatementEvaluationDates(
      { securityId: input.securityId, tradingDates: dates, statements: income },
      SHARE_BASIS,
    ),
  );
  const result = new Map<LocalDate, FinancialStatement | undefined>();
  let current: FinancialStatement | undefined;
  for (const date of dates) {
    if (events.has(date)) {
      current = latestFiscalQuarterStatement(
        indexFiscalQuarters(
          selectFinancialStatements(income, {
            asOf: date,
            cadence: "QUARTERLY",
          }),
          "INCOME",
        ),
      );
    }
    result.set(date, current);
  }
  return result;
}

/**
 * Puts each day's intrinsic values on the research scale of the stored closes after a measured
 * re-base (`historical-price-basis-v1.md`, §10).
 *
 * An intrinsic value is a per-share figure in the units its statements were observed in. A re-base
 * the loader measured later rescales the stored closes before it, so the value is divided by the
 * basis factor `K` of its share revision, which restores exactly the comparison Margin of Safety and
 * every price-to-value series made before the re-base. Where `K` is withheld, the day keeps no
 * intrinsic value, no blend and no provenance: absent, never a value in unknown units.
 *
 * With no measured re-base this returns the states unchanged, which is every security today.
 */
export function applyPriceBasisToIntrinsicStates(
  states: readonly DailyIntrinsicState[],
  input: {
    securityId: SecurityId;
    statements: readonly FinancialStatement[];
    events: readonly PriceBasisEvent[];
  },
): DailyIntrinsicState[] {
  if (input.events.length === 0 || states.length === 0) {
    return [...states];
  }
  const revisions = shareRevisionsByDate({
    securityId: input.securityId,
    tradingDates: states.map((state) => state.date),
    statements: input.statements,
  });
  return states.map((state) => {
    if (!carriesIntrinsicValue(state)) {
      return state;
    }
    const revision = revisions.get(state.date);
    if (!revision) {
      // A value with no share revision behind it has units nothing can vouch for after a re-base.
      return { date: state.date };
    }
    const basis = basisFactorAt({
      session: state.date,
      observedAt: revision.observedAt,
      events: input.events,
    });
    if (basis.kind === "WITHHELD") {
      return { date: state.date };
    }
    return basis.factor === 1 ? state : scaled(state, 1 / basis.factor);
  });
}

function carriesIntrinsicValue(state: DailyIntrinsicState): boolean {
  return (
    Object.keys(state.intrinsicValues ?? {}).length > 0 ||
    Object.keys(state.intrinsicValueBlends ?? {}).length > 0
  );
}

/** Every per-share value multiplied by `by`; provenance and currency unchanged. */
function scaled(state: DailyIntrinsicState, by: number): DailyIntrinsicState {
  const scale = <K extends string>(
    values: Partial<Record<K, number>> | undefined,
  ): Partial<Record<K, number>> | undefined => {
    if (!values) {
      return undefined;
    }
    const result: Partial<Record<K, number>> = {};
    for (const [key, value] of Object.entries(values) as [K, number][]) {
      result[key] = value * by;
    }
    return result;
  };
  const intrinsicValues = scale(state.intrinsicValues);
  const intrinsicValueBlends = scale(state.intrinsicValueBlends);
  return {
    ...state,
    ...(intrinsicValues ? { intrinsicValues } : {}),
    ...(intrinsicValueBlends ? { intrinsicValueBlends } : {}),
  };
}
