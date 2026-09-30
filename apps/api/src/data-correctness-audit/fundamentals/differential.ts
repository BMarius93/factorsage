import type { FinancialStatement } from "@intrinsic/domain";
import { materializeDailyFundamentals } from "@intrinsic/stock-data";
import {
  ORACLE_FUNDAMENTAL_METRICS,
  oracleFundamentalOutcomes,
  type OracleFundamentalMetricId,
  type OracleFundamentalOutcome,
} from "../oracle/fundamentals";
import type { GeneratedHistory } from "./generated-history";

/**
 * The materializer against the independent oracle, on every trading day of one history.
 *
 * The oracle evaluates each trading day from scratch — every revision eligible that day, no event
 * plan and no carry-forward — so agreement on every day proves the formulas, the point-in-time
 * selection, the event plan and the carry-forward (absence included) at once. The materializer's
 * output is read through the oracle's own literal column table, never through the production
 * registry, so a metric written into another metric's field cannot agree by construction.
 *
 * The oracle's arithmetic is exact; the production kernel's is exact sums followed by a few double
 * operations. `valueTolerance` is far below the storage quantum (1e-8) and far above the few units
 * in the last place those operations can cost, so a wrong field, window, sign or scale cannot pass
 * while rounding cannot fail. Availability has no tolerance.
 */

export const valueTolerance = (expected: number): number =>
  1e-9 + 1e-12 * Math.abs(expected);

export type MetricTally = {
  available: number;
  unavailable: number;
  mismatches: number;
};

export type DifferentialMismatch = {
  history: string;
  date: string;
  metricId: OracleFundamentalMetricId;
  expected: number | undefined;
  actual: unknown;
  oracleReason?: string;
};

export type DifferentialReport = {
  history: string;
  seed: number;
  tradingDays: number;
  firstTradingDay: string;
  lastTradingDay: string;
  statementRevisions: number;
  foreignRevisions: number;
  comparisons: number;
  available: number;
  unavailable: number;
  mismatches: number;
  /** Distinct eligible statement sets the oracle had to evaluate. */
  oracleEvaluations: number;
  byMetric: Record<OracleFundamentalMetricId, MetricTally>;
  unavailableReasons: Record<string, number>;
  /** Structural defects of the materialized axis itself (missing, extra or duplicated days). */
  axisDefects: string[];
  sampleMismatches: DifferentialMismatch[];
};

const ORACLE_COLUMNS = new Set<string>(
  ORACLE_FUNDAMENTAL_METRICS.map((metric) => metric.column),
);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Index of the first element greater than `date` in an ascending array: the eligible count. */
function upperBound(sorted: readonly string[], date: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as string) <= date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function emptyTallies(): Record<OracleFundamentalMetricId, MetricTally> {
  return Object.fromEntries(
    ORACLE_FUNDAMENTAL_METRICS.map((metric) => [
      metric.id,
      { available: 0, unavailable: 0, mismatches: 0 },
    ]),
  ) as Record<OracleFundamentalMetricId, MetricTally>;
}

/**
 * Runs one history through the production materializer and compares every trading day with the
 * oracle.
 *
 * The materializer receives the history's revisions mixed with another security's, frozen, with
 * the trading axis reversed: it must ignore the foreign revisions, normalize the axis, and never
 * mutate its input. The oracle receives this security's revisions only.
 *
 * `memoize` evaluates the oracle once per distinct eligible set (the number of revisions whose
 * `availableFromDate` is on or before the day). The oracle's result is a function of that set
 * alone, so memoizing changes cost, never an answer; `memoize: false` proves it.
 */
export function differentialAudit(
  history: GeneratedHistory,
  options: { memoize?: boolean; maxSamples?: number } = {},
): DifferentialReport {
  const memoize = options.memoize ?? true;
  const maxSamples = options.maxSamples ?? 25;
  const own = deepFreeze([
    ...history.statements,
  ]) as readonly FinancialStatement[];
  const foreign = deepFreeze([...history.foreignStatements]);
  const mixed: FinancialStatement[] = [];
  own.forEach((statement, index) => {
    mixed.push(statement);
    const other = foreign[index];
    if (other) {
      mixed.push(other);
    }
  });
  const axis = deepFreeze([...history.tradingDays].reverse());

  const rows = materializeDailyFundamentals({
    securityId: history.securityId,
    tradingDates: axis,
    statements: mixed,
  });

  const axisDefects: string[] = [];
  if (rows.length !== history.tradingDays.length) {
    axisDefects.push(
      `materialized ${rows.length} rows for ${history.tradingDays.length} trading days`,
    );
  }
  rows.forEach((row, index) => {
    if (row.date !== history.tradingDays[index]) {
      axisDefects.push(
        `row ${index} is ${row.date}, expected ${history.tradingDays[index]}`,
      );
    }
    for (const key of Object.keys(row)) {
      if (key !== "date" && !ORACLE_COLUMNS.has(key)) {
        axisDefects.push(`${row.date} carries unregistered field ${key}`);
      }
    }
  });

  const availability = own
    .map((statement) => statement.availableFromDate)
    .sort();
  const memo = new Map<
    number,
    Record<OracleFundamentalMetricId, OracleFundamentalOutcome>
  >();
  let oracleEvaluations = 0;
  const outcomesOn = (
    date: string,
  ): Record<OracleFundamentalMetricId, OracleFundamentalOutcome> => {
    if (!memoize) {
      oracleEvaluations += 1;
      return oracleFundamentalOutcomes(own, date);
    }
    const key = upperBound(availability, date);
    let outcomes = memo.get(key);
    if (!outcomes) {
      oracleEvaluations += 1;
      outcomes = oracleFundamentalOutcomes(own, date);
      memo.set(key, outcomes);
    }
    return outcomes;
  };

  const byMetric = emptyTallies();
  const unavailableReasons: Record<string, number> = {};
  const sampleMismatches: DifferentialMismatch[] = [];
  let comparisons = 0;
  let available = 0;
  let unavailable = 0;
  let mismatches = 0;

  for (const row of rows) {
    const outcomes = outcomesOn(row.date);
    const actualRow = row as unknown as Readonly<Record<string, unknown>>;
    for (const metric of ORACLE_FUNDAMENTAL_METRICS) {
      comparisons += 1;
      const expected = outcomes[metric.id];
      const actual = actualRow[metric.column];
      let agrees: boolean;
      if (expected.status === "UNAVAILABLE") {
        agrees = actual === undefined && !(metric.column in actualRow);
        if (agrees) {
          unavailable += 1;
          byMetric[metric.id].unavailable += 1;
          unavailableReasons[expected.reason] =
            (unavailableReasons[expected.reason] ?? 0) + 1;
        }
      } else {
        agrees =
          typeof actual === "number" &&
          Number.isFinite(actual) &&
          !Object.is(actual, -0) &&
          Math.abs(actual - expected.value) <= valueTolerance(expected.value);
        if (agrees) {
          available += 1;
          byMetric[metric.id].available += 1;
        }
      }
      if (!agrees) {
        mismatches += 1;
        byMetric[metric.id].mismatches += 1;
        if (sampleMismatches.length < maxSamples) {
          sampleMismatches.push({
            history: history.profile.name,
            date: row.date,
            metricId: metric.id,
            expected: expected.status === "VALUE" ? expected.value : undefined,
            actual,
            ...(expected.status === "UNAVAILABLE"
              ? { oracleReason: expected.reason }
              : {}),
          });
        }
      }
    }
  }

  return {
    history: history.profile.name,
    seed: history.profile.seed,
    tradingDays: history.tradingDays.length,
    firstTradingDay: history.tradingDays[0] ?? "",
    lastTradingDay: history.tradingDays.at(-1) ?? "",
    statementRevisions: own.length,
    foreignRevisions: foreign.length,
    comparisons,
    available,
    unavailable,
    mismatches,
    oracleEvaluations,
    byMetric,
    unavailableReasons,
    axisDefects,
    sampleMismatches,
  };
}
