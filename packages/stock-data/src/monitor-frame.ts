import {
  findSelectableSeries,
  type SelectableSeries,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import {
  DAILY_MOVING_AVERAGES,
  DAILY_OSCILLATORS,
  type DailyDerivedState,
  type DailyPrice,
  type Instant,
  type LocalDate,
  type Security,
} from "@intrinsic/domain";
import { operandSeriesId, type EvaluationFrame, type OperandKey } from "@intrinsic/strategy";
import {
  calculateDailyOscillators,
  type DailyOscillatorSubset,
} from "./oscillators.js";
import { calculateDailyTechnicals, type DailyMovingAverageSubset } from "./technicals.js";
import { projectEvaluationFrame } from "./evaluation-frame.js";
import { isWeekend } from "./trading-calendar.js";

/**
 * Building the frame a Monitor evaluates: persisted closed daily history plus the current live
 * price as the provisional current-day observation.
 *
 * `ai/product/monitors.md` fixes the shape:
 *
 * ```text
 * persisted closed daily history
 * + current live FMP price as the provisional current daily observation
 * ```
 *
 * Everything here is pure. It takes rows and a quote and returns a frame; the reads that produce
 * those rows live in `CanonicalStockDataService`, and the evaluation that consumes the frame lives
 * in `@intrinsic/strategy`. No formula, operator, provenance rule or Margin-of-Safety calculation is
 * reimplemented: the frame is produced by the canonical {@link projectEvaluationFrame}, which is
 * also what applies the intrinsic-value provenance gate.
 */

/**
 * Relative influence the recursive series' seed may still have on the newest value.
 *
 * `EMA` and Wilder `RSI` are recursive: each value carries an exponentially decaying share of the
 * value that seeded the series. The canonical materialized series is seeded from the security's
 * whole history, so a bounded window reproduces it only up to that residual share. This is the
 * bound the window is sized to make negligible — at `1e-6`, a $200 EMA differs by $0.0002, far
 * below a price tick and below the eighth decimal the column stores.
 *
 * It is a numerical tolerance, not a product rule. Nothing branches on it.
 */
const SEED_INFLUENCE_BOUND = 1e-6;

/**
 * Observations needed before a recursively smoothed series has forgotten its seed to within
 * {@link SEED_INFLUENCE_BOUND}.
 *
 * After `k` steps the seed retains `(1 - alpha)^k` of its weight, so the bound is reached at
 * `k = ln(bound) / ln(1 - alpha)`.
 */
function convergenceObservations(alpha: number): number {
  if (!(alpha > 0) || alpha >= 1) {
    return 0;
  }
  return Math.ceil(Math.log(SEED_INFLUENCE_BOUND) / Math.log(1 - alpha));
}

/**
 * Trading observations one daily series needs behind its newest value to equal the canonical
 * materialized series to within {@link SEED_INFLUENCE_BOUND}.
 *
 * - `SMA(p)` is a plain window: `p` observations and it is exact.
 * - `EMA(p)` seeds from the first complete-window SMA, then smooths with `alpha = 2 / (p + 1)`.
 * - Wilder `RSI(p)` seeds from the mean of the first `p` changes, then smooths with `alpha = 1 / p`.
 *   Its first value needs `p + 1` closes, because `p` changes need `p + 1` observations.
 *
 * Derived from the canonical registry entry rather than from a table of periods, so registering a
 * longer series widens the window automatically — the same rule `DERIVED_SERIES_WARMUP_DAYS`
 * follows, and the reason `ai/architecture/monitor-engine.md` asks for a derived requirement rather
 * than a hard-coded `300`.
 */
export function dailySeriesWarmupObservations(
  series:
    | { kind: "MOVING_AVERAGE"; type: "SMA" | "EMA"; period: number }
    | { kind: "OSCILLATOR"; period: number },
): number {
  if (series.kind === "OSCILLATOR") {
    return series.period + 1 + convergenceObservations(1 / series.period);
  }
  if (series.type === "SMA") {
    return series.period;
  }
  return series.period + convergenceObservations(2 / (series.period + 1));
}

/** The daily registry entries a set of operand keys actually references. */
export type RequiredDailySeries = {
  movingAverages: DailyMovingAverageSubset;
  oscillators: DailyOscillatorSubset;
};

/**
 * Resolves which **daily** catalog series the requested operands reference.
 *
 * Only daily moving averages and daily oscillators are returned, because only those can be
 * recalculated against a provisional current observation from a bounded daily window. Weekly
 * moving averages and intrinsic values are not: a weekly series counts completed weeks, and an
 * intrinsic value is a point-in-time valuation of fundamentals. Both are read from the persisted
 * canonical state and carried forward instead — see {@link projectMonitorEvaluationFrame}.
 *
 * Identity comes from the canonical catalog, never from parsing an operand key apart beyond its
 * one documented prefix, and never from re-deriving a field name from an id.
 */
export function requiredDailySeries(
  operands: readonly OperandKey[],
): RequiredDailySeries {
  // The key encoding belongs to `@intrinsic/strategy`, so it is decoded through that module rather
  // than sliced apart here; identity then comes from the canonical catalog, never from the id text.
  const sources = operands
    .map(operandSeriesId)
    .filter((id): id is SelectableSeriesId => id !== null)
    .map((id) => findSelectableSeries(id))
    .filter((series): series is SelectableSeries => series !== undefined)
    .map((series) => series.source);

  const fields = new Set(
    sources
      .filter(
        (source) =>
          source.kind === "MOVING_AVERAGE" || source.kind === "OSCILLATOR",
      )
      .map((source) => (source as { field: string }).field),
  );

  return {
    movingAverages: DAILY_MOVING_AVERAGES.filter((average) =>
      fields.has(average.field),
    ),
    oscillators: DAILY_OSCILLATORS.filter((oscillator) =>
      fields.has(oscillator.field),
    ),
  };
}

/**
 * Trading observations of closed history a Monitor must load behind the provisional observation.
 *
 * The widest requirement of the series actually required wins, plus the provisional row itself.
 * A Monitor that names only `RSI 14D` loads a few hundred rows; one that names `EMA 200D` loads
 * several thousand, because that is genuinely what the series needs to agree with its canonical
 * materialized values. A Monitor that names no daily series at all — `Price is below DCF`, say —
 * still needs the previous closed row so a Trigger has its `t - 1` value.
 */
export function monitorWindowObservations(
  required: RequiredDailySeries,
): number {
  let observations = 2;
  for (const average of required.movingAverages) {
    observations = Math.max(
      observations,
      dailySeriesWarmupObservations({
        kind: "MOVING_AVERAGE",
        type: average.type,
        period: average.period,
      }) + 1,
    );
  }
  for (const oscillator of required.oscillators) {
    observations = Math.max(
      observations,
      dailySeriesWarmupObservations({
        kind: "OSCILLATOR",
        period: oscillator.period,
      }) + 1,
    );
  }
  return observations;
}

/**
 * Trading sessions a year yields, after weekends and public holidays.
 *
 * Converting a window at the five-weekdays-per-week ratio is what a short lookback can get away
 * with and a long one cannot: holidays remove about nine sessions a year, so a window asked for at
 * 7/5 comes back short — in proportion to its length. At the ~1,580 sessions an `EMA 200D` needs to
 * match its canonical value, 7/5 under-asks by more than thirty sessions, silently shortening
 * exactly the warm-up the window exists to guarantee.
 */
const TRADING_DAYS_PER_YEAR = 252;
const CALENDAR_DAYS_PER_YEAR = 365.25;

/**
 * Calendar days added on top of the converted window.
 *
 * The conversion is an average; a particular stretch of calendar can still run short of it. This is
 * a fixed floor for that, not the holiday allowance — {@link TRADING_DAYS_PER_YEAR} is.
 */
const MONITOR_WINDOW_MARGIN_CALENDAR_DAYS = 30;

/**
 * Calendar days a durable read must span to yield `observations` trading sessions.
 *
 * The caller trims the projection to the exact observation count, so a range that yields too few
 * sessions does not fail — it quietly hands the calculators a shorter warm-up than they were sized
 * for, which is why the conversion is deliberately generous.
 */
export function monitorWindowCalendarDays(observations: number): number {
  return (
    Math.ceil((observations * CALENDAR_DAYS_PER_YEAR) / TRADING_DAYS_PER_YEAR) +
    MONITOR_WINDOW_MARGIN_CALENDAR_DAYS
  );
}

/** The current market observation a provisional trading day is built from. */
export type CurrentObservation = {
  /** Current traded price. Must be finite and positive; a caller filters anything else out. */
  price: number;
  open?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  /** When the provider last updated the quote, when it reported it. */
  quotedAt?: Instant;
};

export type MonitorEvaluationFrame = {
  frame: EvaluationFrame;
  /** The index the Monitor evaluates. Always the last row: the provisional observation. */
  observationIndex: number;
  observationDate: LocalDate;
  /** The live price the observation index carries. */
  observationPrice: number;
  /** Closed trading days behind the observation, for observability. */
  closedObservations: number;
};

/**
 * Projects the frame one Monitor evaluation cycle reads for one security.
 *
 * The frame's **last** row is the observation a Monitor evaluates and its previous row is the last
 * closed trading day, which is exactly the pair a canonical Trigger needs. That is deliberate and
 * load-bearing: `evaluateMarketTrigger` takes its `t - 1` from `index - 1` of the same frame, so a
 * crossing is decided from durable persisted history rather than from a remembered previous scan.
 * A process restart or a flushed cache therefore cannot fabricate one.
 *
 * Three rules produce the provisional row:
 *
 * 1. **The daily columns are recomputed for every row of the window from one price array.** The
 *    alternative — persisted values at `t - 1` and a freshly computed value at `t` — mixes two
 *    methodologies across the exact pair a Trigger compares, and a seed difference of a fraction of
 *    a cent would then read as a genuine crossing. Computing both ends the same way makes that
 *    impossible by construction rather than unlikely.
 * 2. **Weekly and intrinsic values are carried forward from the last closed derived row.** Neither
 *    can change intraday: `aggregateCompletedWeeks` excludes the in-progress ISO week, so no new
 *    week can complete today, and an intrinsic value changes only when a newly eligible
 *    `FinancialStatement` revision takes effect — which the canonical materializer applies when the
 *    day closes. Carrying forward is the canonical rule for both, and it is also what stops an
 *    expensive valuation from being rerun merely because the live price moved.
 * 3. **Margin of Safety falls out.** `projectEvaluationFrame` computes it from the derived row's
 *    gated intrinsic value and the row's own close, so the provisional close recomputes only the
 *    price-dependent half. There is no second Margin-of-Safety implementation here.
 *
 * **The observation must belong to a session.** Its date is the provider's own quote date, so an
 * ordinary weekend quote still carries Friday's date and supersedes Friday's persisted row rather
 * than opening a new day. A weekend date is refused here; a fully closed exchange holiday is
 * refused by the caller, which resolves the venue's schedule first so this stays pure.
 *
 * **A current observation is required.** Without a usable one this returns `null` and the caller
 * reports `NOT_EVALUABLE`; it deliberately does *not* fall back to evaluating the last closed day.
 * That fallback looks harmless and is not: it silently swaps the observation a Monitor is defined
 * to evaluate for a different one, so a provider outage would resolve a live match and re-emit it
 * on recovery — an infrastructure hiccup manufacturing a Signal. Reporting "not decidable" keeps
 * the durable latch untouched, which is what makes an outage invisible instead of destructive.
 */
export function projectMonitorEvaluationFrame(input: {
  security: Security;
  /** Ascending closed daily history, already bounded to the monitor window. */
  prices: readonly DailyPrice[];
  /** Persisted derived state for (at least) the newest closed trading day. */
  derived: readonly DailyDerivedState[];
  operands: readonly OperandKey[];
  /** The current observation, or null when none is usable this cycle. */
  observation: CurrentObservation | null;
  /** The trading date the observation belongs to. Must not precede the newest closed date. */
  observationDate: LocalDate;
}): MonitorEvaluationFrame | null {
  const { security, operands, observation, observationDate } = input;

  const closed = [...input.prices].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  const newestClosed = closed[closed.length - 1];
  if (!newestClosed) {
    // No persisted history at all. A frame with only a fabricated row would let a Condition match
    // on a price with nothing to compare it against, so the security has no observation instead.
    return null;
  }

  const required = requiredDailySeries(operands);

  if (
    !observation ||
    !Number.isFinite(observation.price) ||
    observation.price <= 0 ||
    // A quote older than the newest persisted close is not a current observation, and back-dating
    // the frame to accept it would be worse than having none.
    observationDate < newestClosed.date ||
    // A bar on a day no session ran is a fabricated observation: it lengthens every rolling window
    // by one and can move an indicator past a price that never moved, which reads as a crossing.
    // Weekends are refused here because they need no provider knowledge. A fully closed exchange
    // *holiday* is refused by the caller, which resolves the venue's schedule before asking for a
    // frame — this projector stays pure and does no I/O.
    (observationDate > newestClosed.date && isWeekend(observationDate))
  ) {
    return null;
  }

  const provisional = provisionalBar(security.id, observationDate, observation);
  const rows: DailyPrice[] =
    observationDate === newestClosed.date
      ? // The provider has repriced a day already persisted. The live observation supersedes it
        // rather than sitting beside it: two rows for one trading day would break the frame's
        // strictly-ascending invariant and give a Trigger a same-day `t - 1`.
        [...closed.slice(0, -1), provisional]
      : [...closed, provisional];

  const observationRow = rows[rows.length - 1] as DailyPrice;

  // One computation over one price array, so every row's daily columns share a methodology.
  const dailyByDate = new Map<LocalDate, DailyDerivedState>();
  for (const row of calculateDailyTechnicals(rows, required.movingAverages)) {
    dailyByDate.set(row.date, row);
  }
  if (required.oscillators.length > 0) {
    for (const row of calculateDailyOscillators(rows, required.oscillators)) {
      const existing = dailyByDate.get(row.date);
      dailyByDate.set(row.date, existing ? { ...existing, ...row } : row);
    }
  }

  const persistedByDate = new Map<LocalDate, DailyDerivedState>();
  for (const row of input.derived) {
    persistedByDate.set(row.date, row);
  }
  const newestPersisted = [...input.derived]
    .sort((left, right) => (left.date < right.date ? -1 : 1))
    .at(-1);

  const derived: DailyDerivedState[] = rows.map((price) => {
    const carried =
      persistedByDate.get(price.date) ??
      // Only the provisional row has no persisted counterpart. It inherits the newest closed row's
      // weekly and intrinsic state, which is what "carried forward" already means for both.
      (price.date === observationRow.date ? newestPersisted : undefined);
    const recomputed = dailyByDate.get(price.date);
    return {
      ...(carried ?? { securityId: security.id, date: price.date }),
      securityId: security.id,
      date: price.date,
      // The recomputed daily family replaces the persisted one for every row, including warm-up
      // absences: a field this window cannot produce must read absent, never a persisted value the
      // rest of the frame's daily columns do not agree with.
      ...blankDailyFields(required),
      ...(recomputed ? dailyFieldsOf(recomputed, required) : {}),
    };
  });

  const projection = projectEvaluationFrame({
    security,
    prices: rows,
    derived,
    operands,
    periodStart: observationRow.date,
  });

  return {
    frame: projection.frame,
    observationIndex: rows.length - 1,
    observationDate: observationRow.date,
    observationPrice: observationRow.close,
    // The superseded day is no longer a closed observation in this frame.
    closedObservations: rows.length - 1,
  };
}

/**
 * The provisional bar for the current trading day.
 *
 * `close` is the current traded price — that is the whole point of a provisional observation, and
 * it is the only field any Strategy predicate reads. The OHLC fields are filled from the quote
 * where the provider supplied them and fall back to the current price rather than to the previous
 * close, so the bar is internally consistent; `vwap` is deliberately never invented.
 */
function provisionalBar(
  securityId: string,
  date: LocalDate,
  observation: CurrentObservation,
): DailyPrice {
  const price = observation.price;
  const open = finiteOr(observation.open, price);
  return {
    securityId,
    date,
    open,
    high: finiteOr(observation.dayHigh, Math.max(open, price)),
    low: finiteOr(observation.dayLow, Math.min(open, price)),
    close: price,
    volume: finiteOr(observation.volume, 0),
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Every required daily field set to absent, so a merge cannot leave a stale persisted value. */
function blankDailyFields(
  required: RequiredDailySeries,
): Record<string, undefined> {
  const blank: Record<string, undefined> = {};
  for (const average of required.movingAverages) {
    blank[average.field] = undefined;
  }
  for (const oscillator of required.oscillators) {
    blank[oscillator.field] = undefined;
  }
  return blank;
}

/** Only the required daily fields of a recomputed row, absent ones omitted. */
function dailyFieldsOf(
  row: DailyDerivedState,
  required: RequiredDailySeries,
): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const average of required.movingAverages) {
    const value = row[average.field];
    if (value !== undefined) {
      fields[average.field] = value;
    }
  }
  for (const oscillator of required.oscillators) {
    const value = row[oscillator.field];
    if (value !== undefined) {
      fields[oscillator.field] = value;
    }
  }
  return fields;
}
