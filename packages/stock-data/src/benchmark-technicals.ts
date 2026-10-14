import {
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  MATERIALIZED_MOVING_AVERAGES,
  tradingSessionCloseInstant,
  type BenchmarkDailyPrice,
  type DailyMovingAverageField,
  type DailyOscillatorField,
  type DailyPrice,
  type DailyRelativeVolumeField,
  type DateRange,
  type LocalDate,
  type WeeklyMovingAverageField,
} from "@intrinsic/domain";
import { MARKET_OVERVIEW_HISTORY_FLOOR } from "@intrinsic/domain";
import type {
  BenchmarkHistory,
  BenchmarkRefreshState,
} from "./benchmark-ports.js";
import { addDays } from "./dates.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { aggregateCompletedWeeks } from "./weekly.js";

/**
 * ETF technicals for Strategy conditions: the read-only calculation adapter of
 * `docs/decisions/strategy-etf-conditions-v1.md` and
 * `ai/architecture/strategy-etf-conditions.md` §4–§5.
 *
 * A benchmark still owns **no derived series**: nothing here is persisted, cached under a new
 * namespace, or written anywhere. The adapter feeds a benchmark's stored OHLCV through the **same**
 * calculation path the stocks use — `buildDailyDerivedState` over `aggregateCompletedWeeks`, which
 * is `movingAverage`, `calculateWilderRsi` and `calculateRelativeVolume` under one composer — and
 * returns the result as in-memory columns for one backtest run or one Monitor cycle to read. One
 * methodology, two data sources; the values are the kernels' own doubles, the same convention the
 * Monitor's in-memory daily recomputation already established, with no second rounding rule.
 *
 * Three gates keep it historically honest:
 *
 * 1. **Finalized, synchronized sessions only.** The provider lists the in-progress session, and a
 *    provisional bar can be stored; a bar counts only once its session's NYSE close plus the
 *    publication delay has passed **and** the series' durable tail watermark proves a read happened
 *    at or after that instant — the `GET /market-overview` convention, which is evidence of an
 *    actual refresh, never a clock alone (owner decision 1, 2026-10-13).
 * 2. **A floor-anchored history only.** Every calculation is anchored at the earliest stored bar
 *    (the stock methodology's AUD-02 rule), so the anchor must be the fund's genuine first bar and
 *    must never move: durable coverage reaching back to `MARKET_OVERVIEW_HISTORY_FLOOR` — what the
 *    bootstrap establishes — proves pre-inception was asked and found empty. Without it the whole
 *    context is unavailable, with a reason, rather than computed from an unstable anchor
 *    (owner decision 7).
 * 3. **Exact sessions only.** The snapshot answers by exact date and nothing is ever carried
 *    forward onto a session the ETF has no bar for; a missing session reads NaN, which the
 *    evaluator's tri-state logic turns into `NOT_EVALUABLE`.
 */

/** Every field of the twenty ETF technical columns; `Price` is the bar's own close beside them. */
export type BenchmarkTechnicalField =
  | DailyMovingAverageField
  | WeeklyMovingAverageField
  | DailyOscillatorField
  | DailyRelativeVolumeField;

/** The twenty technical fields, in registry order: 14 moving averages, 3 RSI, 3 RVOL. */
export const BENCHMARK_TECHNICAL_FIELDS: readonly BenchmarkTechnicalField[] = [
  ...MATERIALIZED_MOVING_AVERAGES.map((entry) => entry.field),
  ...DAILY_OSCILLATORS.map((entry) => entry.field),
  ...DAILY_RELATIVE_VOLUMES.map((entry) => entry.field),
];

/**
 * One ETF's technicals over its finalized history: an immutable, in-memory column snapshot.
 *
 * `NaN` is the only representation of absence, exactly as in an `EvaluationFrame`: warm-up, a
 * pre-listing date and a provider gap all read NaN through {@link benchmarkTechnicalValueOn}.
 */
export type BenchmarkTechnicalSnapshot = {
  readonly seriesId: string;
  /** The price basis every bar below is on, recorded for reproducibility diagnostics. */
  readonly basisGeneration: number;
  /** Finalized, synchronized sessions with a stored bar, ascending. */
  readonly dates: readonly LocalDate[];
  /** The canonical close per session: the ETF's `Price` metric. */
  readonly closes: Float64Array;
  /** One column per technical field, aligned to `dates`; NaN = absent. */
  readonly columns: ReadonlyMap<BenchmarkTechnicalField, Float64Array>;
  readonly index: ReadonlyMap<LocalDate, number>;
  /** The newest session the snapshot holds, when it holds any. */
  readonly latestSession?: LocalDate;
};

/**
 * Why one ETF's technicals cannot be evaluated at all, or the snapshot when they can.
 *
 * The reasons are the aggregate, user-visible vocabulary of owner decision 9: they reach a
 * backtest's diagnostics and a Monitor's availability note rather than living only in logs.
 */
export type BenchmarkTechnicalContext =
  | { status: "READY"; snapshot: BenchmarkTechnicalSnapshot }
  /** Durable coverage does not reach the history floor: the series needs its bootstrap. */
  | { status: "NOT_ANCHORED"; missing: readonly Required<DateRange>[] }
  /** The series has never completed a tail read, so no stored bar is proven final. */
  | { status: "NOT_SYNCHRONIZED" }
  /** Anchored and synchronized, but no finalized session holds a bar yet. */
  | { status: "EMPTY"; basisGeneration: number };

/**
 * When a session's end-of-day bar is final: its regular 16:00 New York close plus the refresh's
 * own publication delay. The same arithmetic the market overview and the refresh child apply.
 */
export function benchmarkSessionFinalizedAt(
  session: LocalDate,
  publicationDelayMs: number,
): Date {
  return new Date(
    tradingSessionCloseInstant(session).getTime() + publicationDelayMs,
  );
}

/**
 * The newest session that is **finalized and synchronized** at `now`, or `undefined` when the
 * series has never completed a tail read.
 *
 * A session qualifies when its close plus the publication delay has passed, and the durable tail
 * watermark (`lastTailSyncAt`) proves the series was read at or after that instant. The clock alone
 * is deliberately insufficient — a stored bar whose session has closed may still be the provisional
 * mid-session reading the provider listed, until a later read replaced or confirmed it.
 *
 * A later session finalizes later, so "which sessions qualify" is one date: every session on or
 * before it does and none after it. It is found by walking back from the instant itself — a step
 * or two — rather than by converting every stored bar's date to its New York close, which for a
 * thirty-year history cost more than all twenty indicators together.
 */
export function latestFinalizedBenchmarkSession(input: {
  refreshState: BenchmarkRefreshState;
  now: Date;
  publicationDelayMs: number;
}): LocalDate | undefined {
  const syncedAt = input.refreshState.lastTailSyncAt;
  if (syncedAt === undefined) {
    return undefined;
  }
  const limit = Math.min(input.now.getTime(), Date.parse(syncedAt));
  if (!Number.isFinite(limit)) {
    return undefined;
  }
  // A session's close is on its own calendar date in New York, which is never earlier than the
  // same date in UTC, so no session after the limit's UTC date can have finalized by it.
  let session = addDays(new Date(limit).toISOString().slice(0, 10), 1);
  while (
    benchmarkSessionFinalizedAt(session, input.publicationDelayMs).getTime() >
    limit
  ) {
    session = addDays(session, -1);
  }
  return session;
}

/**
 * The bars that are **finalized and synchronized** at `now`: exactly those whose session is on or
 * before {@link latestFinalizedBenchmarkSession}. No bar is, before any tail read has completed.
 *
 * Bars arrive ascending from the reader and leave ascending; the input is never mutated.
 */
export function finalizedBenchmarkBars(input: {
  rows: readonly BenchmarkDailyPrice[];
  refreshState: BenchmarkRefreshState;
  now: Date;
  publicationDelayMs: number;
}): BenchmarkDailyPrice[] {
  const latest = latestFinalizedBenchmarkSession(input);
  if (latest === undefined) {
    return [];
  }
  return input.rows.filter((row) => row.date <= latest);
}

/** A benchmark bar as the one calculation path consumes it: the series id stands as the identity. */
function asDailyPrice(seriesId: string, bar: BenchmarkDailyPrice): DailyPrice {
  return {
    securityId: seriesId,
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

/**
 * Builds one ETF's technical context from reads the caller already made. Pure: the reads — the
 * full history, the refresh state and the floor-coverage answer — are parameters, so the gates are
 * testable without a database, a cache or a provider, and the function itself can never hydrate.
 *
 * The completed-week anchor is the **last finalized bar's own date**, never the caller's clock:
 * the ISO week containing it is not aggregated, because that week may still gain sessions the
 * synchronization has not proven yet. With a current watermark this is exactly the stock
 * materialization's behaviour — a week's values first appear once a bar of a later week exists —
 * and under a stalled watermark it is the behaviour the stock path gets from its freshness check:
 * no weekly close is ever fabricated from a week the data cannot prove is over. Per historical
 * session the carried-forward weekly value is governed by each completed week's own
 * `eligibleDate`, so the result is point-in-time correct for every date the snapshot answers.
 *
 * The weekly history context is `LISTING`: with coverage proven back to the floor — before every
 * fund in the universe listed — the earliest stored bar is the fund's genuine first session, so a
 * genuine mid-week listing week is kept, exactly as a stock's IPO week is. A series that cannot
 * prove that is `NOT_ANCHORED` and computes nothing, rather than computing values whose anchor a
 * later, deeper load would silently move.
 */
export function buildBenchmarkTechnicalContext(input: {
  seriesId: string;
  history: BenchmarkHistory;
  refreshState: BenchmarkRefreshState;
  /** `missingBenchmarkCoverage(series, { from: MARKET_OVERVIEW_HISTORY_FLOOR, to: <through> })`. */
  missingFromFloor: readonly Required<DateRange>[];
  now: Date;
  publicationDelayMs: number;
}): BenchmarkTechnicalContext {
  if (input.missingFromFloor.length > 0) {
    return { status: "NOT_ANCHORED", missing: input.missingFromFloor };
  }
  if (input.refreshState.lastTailSyncAt === undefined) {
    return { status: "NOT_SYNCHRONIZED" };
  }
  const bars = finalizedBenchmarkBars({
    rows: input.history.rows,
    refreshState: input.refreshState,
    now: input.now,
    publicationDelayMs: input.publicationDelayMs,
  });
  if (bars.length === 0) {
    return { status: "EMPTY", basisGeneration: input.history.basisGeneration };
  }

  const prices = bars.map((bar) => asDailyPrice(input.seriesId, bar));
  const firstBar = prices[0]!.date;
  const lastFinalized = prices[prices.length - 1]!.date;
  const rows = buildDailyDerivedState({
    prices,
    weeklyBars: aggregateCompletedWeeks(prices, lastFinalized, {
      historyStart: firstBar,
      historyStartOrigin: "LISTING",
    }),
  });

  const dates = rows.map((row) => row.date);
  const index = new Map<LocalDate, number>(
    dates.map((date, position) => [date, position]),
  );
  const closes = new Float64Array(prices.length);
  prices.forEach((price, position) => {
    closes[position] = price.close;
  });
  const columns = new Map<BenchmarkTechnicalField, Float64Array>(
    BENCHMARK_TECHNICAL_FIELDS.map((field) => {
      const column = new Float64Array(rows.length).fill(Number.NaN);
      rows.forEach((row, position) => {
        const value = row[field];
        if (typeof value === "number") {
          column[position] = value;
        }
      });
      return [field, column];
    }),
  );

  return {
    status: "READY",
    snapshot: {
      seriesId: input.seriesId,
      basisGeneration: input.history.basisGeneration,
      dates,
      closes,
      columns,
      index,
      latestSession: dates[dates.length - 1],
    },
  };
}

/**
 * The value of one field on one exact session, or NaN: no fall-forward, no nearest-session search.
 * A date the ETF has no finalized bar for — pre-listing, a holiday the stock traded through, a
 * provider gap, today before the ETF's close is final — is NaN, which the evaluator reports as
 * `NOT_EVALUABLE`, never as a stale reading.
 */
export function benchmarkTechnicalValueOn(
  snapshot: BenchmarkTechnicalSnapshot,
  date: LocalDate,
  field: BenchmarkTechnicalField | "close",
): number {
  const position = snapshot.index.get(date);
  if (position === undefined) {
    return Number.NaN;
  }
  if (field === "close") {
    return snapshot.closes[position] ?? Number.NaN;
  }
  return snapshot.columns.get(field)?.[position] ?? Number.NaN;
}

export { MARKET_OVERVIEW_HISTORY_FLOOR };
