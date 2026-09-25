import {
  asAlternativeDataMetric,
  parseAlternativeDataMetricSignature,
  alternativeDataMeasureDefinition,
  alternativeDataMetricSignature,
  type AlternativeDataAggregation,
  type AlternativeDataFactFilter,
  type AlternativeDataMetric,
  type StrategyMetric,
} from "@intrinsic/contracts";
import type { LocalDate } from "@intrinsic/domain";
import type { OperandKey } from "./operands.js";

/**
 * Evaluating the alternative-data metrics: the operand key that addresses one, and the pure
 * projection of normalized disclosures into the column the evaluator reads.
 *
 * Nothing here does I/O, and nothing here knows a provider or a database. It takes a date axis, a
 * coverage interval and a list of already-scoped observations, and returns one number per session.
 * `@intrinsic/stock-data` is what produces those observations; that is also where the actor scope is
 * resolved, because a group's membership is either a database read or a frozen backtest snapshot and
 * a pure evaluator must not be able to tell the difference.
 *
 * ## The point-in-time rule, in one sentence
 *
 * An observation belongs to the session window `(dates[i - lookback], dates[i]]` **by its
 * availability date**, never by the date of the underlying trade or report period. The window is
 * expressed in the frame's own session dates, so weekends and exchange holidays are handled by the
 * axis rather than by a calendar this module would have to know: a filing published on a Saturday,
 * or on Thanksgiving, first counts on the next session the frame actually has.
 */

const ALTERNATIVE_DATA_PREFIX = "alt:";

/**
 * The frame column one configured alternative-data metric reads.
 *
 * Keyed by the metric's canonical signature, so two strategies naming the same configured metric
 * share one projected column and one loader read. Two that differ in lookback, scope or a filter are
 * different columns, because they are different numbers.
 */
export function alternativeDataOperand(metric: AlternativeDataMetric): OperandKey {
  return `${ALTERNATIVE_DATA_PREFIX}${alternativeDataMetricSignature(metric)}`;
}

/**
 * The configured metric a key addresses, or null when it addresses something else.
 *
 * The inverse of {@link alternativeDataOperand}, and it lives here for the same reason
 * `operandSeriesId` lives beside `seriesOperand`: the prefix is this module's, and the signature
 * inside it belongs to `@intrinsic/contracts`. A caller that needs the configuration behind a column
 * asks; nothing slices the string apart itself.
 */
export function operandAlternativeDataMetric(
  key: OperandKey,
): AlternativeDataMetric | null {
  if (!key.startsWith(ALTERNATIVE_DATA_PREFIX)) {
    return null;
  }
  return (
    parseAlternativeDataMetricSignature(
      key.slice(ALTERNATIVE_DATA_PREFIX.length),
    ) ?? null
  );
}

/** The operand key for a Strategy Metric when it is an alternative-data one, else null. */
export function alternativeDataMetricOperand(
  metric: StrategyMetric,
): OperandKey | null {
  const alternative = asAlternativeDataMetric(metric);
  return alternative ? alternativeDataOperand(alternative) : null;
}

/**
 * Trading sessions of context a frame must carry **before** the evaluated period for a set of
 * operands to be decidable on its first date.
 *
 * The longest alternative-data lookback wins, and zero is the answer when no operand names one. It is
 * the same rule `monitorWindowObservations` follows for a recursive moving average, and it exists for
 * the same reason: a window the frame does not physically contain cannot be counted, and silently
 * counting a short one would understate every early session of a backtest — and, because execution
 * reads one calendar year at a time, of every year after the first.
 */
export function requiredAlternativeDataLeadingSessions(
  operands: readonly OperandKey[],
): number {
  let sessions = 0;
  for (const key of operands) {
    const metric = operandAlternativeDataMetric(key);
    if (metric) {
      sessions = Math.max(sessions, metric.lookback);
    }
  }
  return sessions;
}

/** Every configured alternative-data metric a set of operand keys addresses, in key order. */
export function alternativeDataRequests(
  operands: readonly OperandKey[],
): { key: OperandKey; metric: AlternativeDataMetric }[] {
  const requests: { key: OperandKey; metric: AlternativeDataMetric }[] = [];
  for (const key of operands) {
    const metric = operandAlternativeDataMetric(key);
    if (metric) {
      requests.push({ key, metric });
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

/**
 * One normalized disclosure, reduced to what an aggregation needs.
 *
 * `observableFrom` is the availability date — the day after publication — and is the only date this
 * module ever reads. The transaction date and the report period are preserved in storage and
 * reported by the product; they are deliberately absent here, so no aggregation can accidentally
 * window on one.
 */
export type AlternativeDataObservation = {
  observableFrom: LocalDate;
  /** Stable actor identity: a reporting CIK, a bioguide id, a manager CIK. Never a display name. */
  actorKey: string;
  /** The amount a `SUM_AMOUNT` measure adds. Absent where the source states none. */
  amount?: number;
  /** Shares held now and previously, for `SHARE_WEIGHTED_CHANGE_PERCENT`. */
  shares?: number;
  previousShares?: number;
};

/**
 * The interval a column may report a number for.
 *
 * `from` is the earliest date the ingested history can vouch for and `to` the last date it was
 * refreshed through. Outside it the column is absent, never zero: "this product holds no disclosure
 * history here" and "no insider bought" are different statements, and reporting the first as the
 * second would make `Insider sellers is at most 0` true across every year the data does not reach.
 */
export type AlternativeDataCoverage = {
  from: LocalDate;
  to: LocalDate;
};

/**
 * One security's answer for one configured metric: the observations inside the read window, and what
 * the ingested history covers.
 *
 * `observations` are already scoped and filtered — by actor, group, chamber, owner, role and
 * transaction category — because resolving a group means reading membership, and that is the loader's
 * job. Ordering is not assumed.
 */
export type AlternativeDataFacts = {
  coverage: AlternativeDataCoverage | null;
  observations: readonly AlternativeDataObservation[];
};

/**
 * The aggregation and window one column is built with, resolved from the metric's registry entry.
 */
export type AlternativeDataColumnRequest = {
  lookbackSessions: number;
  aggregation: AlternativeDataAggregation;
};

export function alternativeDataColumnRequest(
  metric: AlternativeDataMetric,
): AlternativeDataColumnRequest {
  return {
    lookbackSessions: metric.lookback,
    aggregation: alternativeDataMeasureDefinition(metric).aggregation,
  };
}

/** The fact family a metric reads, for a loader deciding which table to query. */
export function alternativeDataFactFilter(
  metric: AlternativeDataMetric,
): AlternativeDataFactFilter {
  return alternativeDataMeasureDefinition(metric).filter;
}

/**
 * Projects one configured alternative-data metric into a column aligned with `dates`.
 *
 * `NaN` is the frame's one representation of absence and is what makes a session NOT_EVALUABLE. It is
 * produced in exactly three situations, and never as a substitute for zero:
 *
 * 1. **No coverage at all.** Nothing has been ingested for this security and domain.
 * 2. **The window is not inside coverage.** Either the session precedes the history the product
 *    holds, follows the last refresh, or the window reaches back before the first date coverage
 *    vouches for. A partially covered window would understate every count in it.
 * 3. **The window is not inside the frame.** The first `lookback - 1` sessions of the frame have no
 *    complete window to count. Callers widen the frame by
 *    {@link requiredAlternativeDataLeadingSessions} so this does not reach the evaluated period.
 *
 * Everywhere else a count of zero is a real reading: nobody bought, and a rule may act on that.
 */
export function buildAlternativeDataColumn(input: {
  dates: readonly LocalDate[];
  request: AlternativeDataColumnRequest;
  facts: AlternativeDataFacts;
}): Float64Array {
  const { dates, request, facts } = input;
  const column = new Float64Array(dates.length).fill(Number.NaN);
  const lookback = Math.max(1, Math.trunc(request.lookbackSessions));
  const coverage = facts.coverage;
  if (!coverage || dates.length === 0) {
    return column;
  }

  // Each observation is placed on the first session of the frame that is on or after its availability
  // date: the session a reader could first have acted on it. An observation that became available
  // after the frame's last session has no session here and is dropped, and one that became available
  // before the frame's first session belongs to a session the frame does not contain — it is dropped
  // too rather than being pulled forward onto index 0, which would count it inside windows it was
  // never in.
  const placed: { index: number; observation: AlternativeDataObservation }[] = [];
  for (const observation of facts.observations) {
    const index = firstSessionAtOrAfter(dates, observation.observableFrom);
    if (index === -1) {
      continue;
    }
    if (observation.observableFrom < (dates[0] as LocalDate)) {
      continue;
    }
    placed.push({ index, observation });
  }
  placed.sort((left, right) => left.index - right.index);

  const actorCounts = new Map<string, number>();
  let events = 0;
  let amountTotal = 0;
  let sharesTotal = 0;
  let previousSharesTotal = 0;
  let nextToEnter = 0;
  let nextToLeave = 0;

  const enter = (observation: AlternativeDataObservation): void => {
    actorCounts.set(
      observation.actorKey,
      (actorCounts.get(observation.actorKey) ?? 0) + 1,
    );
    events += 1;
    if (observation.amount !== undefined && Number.isFinite(observation.amount)) {
      amountTotal += observation.amount;
    }
    if (observation.shares !== undefined && Number.isFinite(observation.shares)) {
      sharesTotal += observation.shares;
    }
    if (
      observation.previousShares !== undefined &&
      Number.isFinite(observation.previousShares)
    ) {
      previousSharesTotal += observation.previousShares;
    }
  };

  const leave = (observation: AlternativeDataObservation): void => {
    const count = (actorCounts.get(observation.actorKey) ?? 0) - 1;
    if (count <= 0) {
      actorCounts.delete(observation.actorKey);
    } else {
      actorCounts.set(observation.actorKey, count);
    }
    events -= 1;
    if (observation.amount !== undefined && Number.isFinite(observation.amount)) {
      amountTotal -= observation.amount;
    }
    if (observation.shares !== undefined && Number.isFinite(observation.shares)) {
      sharesTotal -= observation.shares;
    }
    if (
      observation.previousShares !== undefined &&
      Number.isFinite(observation.previousShares)
    ) {
      previousSharesTotal -= observation.previousShares;
    }
  };

  for (let index = 0; index < dates.length; index += 1) {
    const windowStart = index - lookback + 1;
    // One pass over the placed observations: everything observable by this session enters the window,
    // everything older than its start leaves. Both pointers only move forwards, so the whole column
    // costs one traversal rather than one scan per session.
    while (
      nextToEnter < placed.length &&
      (placed[nextToEnter] as { index: number }).index <= index
    ) {
      enter(
        (placed[nextToEnter] as { observation: AlternativeDataObservation })
          .observation,
      );
      nextToEnter += 1;
    }
    while (
      nextToLeave < nextToEnter &&
      (placed[nextToLeave] as { index: number }).index < windowStart
    ) {
      leave(
        (placed[nextToLeave] as { observation: AlternativeDataObservation })
          .observation,
      );
      nextToLeave += 1;
    }

    if (windowStart < 0) {
      continue;
    }
    const date = dates[index] as LocalDate;
    const windowStartDate = dates[windowStart] as LocalDate;
    if (date > coverage.to || windowStartDate < coverage.from) {
      continue;
    }

    switch (request.aggregation) {
      case "DISTINCT_ACTORS":
        column[index] = actorCounts.size;
        break;
      case "EVENT_COUNT":
        column[index] = events;
        break;
      case "SUM_AMOUNT":
        column[index] = amountTotal;
        break;
      case "SHARE_WEIGHTED_CHANGE_PERCENT":
        // The denominator is the shares the in-scope managers previously held. With no prior holding
        // there is no percentage to report — a set of purely new positions has no base, and neither
        // does an empty window — so it stays NOT_EVALUABLE rather than becoming a zero change or an
        // infinite one.
        column[index] =
          previousSharesTotal > 0
            ? ((sharesTotal - previousSharesTotal) / previousSharesTotal) * 100
            : Number.NaN;
        break;
    }
  }

  return column;
}

/**
 * Index of the first session on or after `date`, or -1 when every session precedes it.
 *
 * A binary search over the frame's ascending axis, which is what makes the observable session the
 * *next trading session* without this module knowing a holiday calendar: the axis holds exactly the
 * sessions the security traded.
 */
function firstSessionAtOrAfter(
  dates: readonly LocalDate[],
  date: LocalDate,
): number {
  let low = 0;
  let high = dates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((dates[middle] as LocalDate) >= date) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}
