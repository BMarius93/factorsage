/**
 * An independent oracle for the technical values an ETF-sourced Strategy Condition reads.
 *
 * The validator's rule applies here as everywhere in the matrix: a check that asked the production
 * code the same question would agree with every bug it exists to find. So nothing below imports the
 * stock-data kernels (`movingAverage`, `calculateWilderRsi`, `calculateRelativeVolume`,
 * `aggregateCompletedWeeks`, `buildBenchmarkTechnicalContext`). Each value is re-derived from the
 * fund's **stored bars** by a second, deliberately plain implementation of the documented
 * methodology:
 *
 * - **SMA n** — the arithmetic mean of the last `n` closes, defined from the `n`-th bar.
 * - **EMA n** — seeded with the SMA of the first `n` closes, then `prev + (close − prev)·2/(n+1)`.
 * - **RSI n** (Wilder) — the seed averages are the simple means of the first `n` close changes,
 *   smoothed as `(avg·(n−1) + current)/n`; `100·gain/(gain+loss)`, and `50` for a flat window.
 * - **RVOL n** — the session's volume over the mean volume of the `n` sessions strictly before it,
 *   absent when that baseline is zero.
 * - **Weekly** — ISO weeks of the fund's own bars (open of the first, close of the last), each
 *   visible from its last **scheduled** session: the last bar when that is the week's Friday or
 *   later; otherwise the latest weekday after the last bar that the venue schedule says was a
 *   session, else the last bar itself (a holiday-shortened week); and, for a year the schedule cannot
 *   answer, the Friday. The schedule is the **pinned** provider answer the sweep replayed, read here
 *   independently of `CachedTradingCalendar`.
 *
 * Values are exact-date only: a session the fund printed no bar for is absent (NOT_EVALUABLE), never
 * carried forward — the same contract `benchmarkTechnicalValueOn` documents, verified rather than
 * reused.
 *
 * Floating point is the oracle's one concession: an independent summation order can differ from the
 * kernel's in the last few bits, so a comparison whose two sides lie within {@link AMBIGUITY} of each
 * other is reported as ambiguous rather than as a pass or a failure.
 */

export type OracleBar = {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
};

/** Full-closure dates per `YEAR`, or `null` for a year the venue schedule could not answer. */
export type OracleVenueSchedule = (year: string) => ReadonlySet<string> | null;

/** Relative width inside which two independently summed doubles are not told apart. */
export const AMBIGUITY = 1e-9;

export type OracleSeriesId =
  | `SMA_${number}D`
  | `EMA_${number}D`
  | `SMA_${number}W`
  | `EMA_${number}W`
  | `RSI_${number}D`;

export type OracleColumns = {
  readonly dates: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  readonly close: Float64Array;
  /** By catalog series id (`SMA_50D`, `EMA_20W`, `RSI_14D`) and `RVOL_<n>`. */
  column(field: string): Float64Array;
};

const DAY_MS = 86_400_000;

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday of the ISO week holding `date`. */
export function isoWeekStart(date: string): string {
  const ms = utcDay(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return isoDate(ms - weekday * DAY_MS);
}

function sma(values: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  for (let end = period - 1; end < values.length; end += 1) {
    let sum = 0;
    for (let index = end - period + 1; index <= end; index += 1) {
      sum += values[index] as number;
    }
    out[end] = sum / period;
  }
  return out;
}

function ema(values: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (values.length < period) {
    return out;
  }
  let seed = 0;
  for (let index = 0; index < period; index += 1) {
    seed += values[index] as number;
  }
  let previous = seed / period;
  out[period - 1] = previous;
  const k = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    previous = previous + ((values[index] as number) - previous) * k;
    out[index] = previous;
  }
  return out;
}

function wilderRsi(closes: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(closes.length).fill(Number.NaN);
  if (closes.length < period + 1) {
    return out;
  }
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = (closes[index] as number) - (closes[index - 1] as number);
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  const rsi = (g: number, l: number): number =>
    g === 0 && l === 0 ? 50 : (100 * g) / (g + l);
  out[period] = rsi(gain, loss);
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = (closes[index] as number) - (closes[index - 1] as number);
    gain = (gain * (period - 1) + (change > 0 ? change : 0)) / period;
    loss = (loss * (period - 1) + (change < 0 ? -change : 0)) / period;
    out[index] = rsi(gain, loss);
  }
  return out;
}

function relativeVolume(
  volumes: ArrayLike<number>,
  period: number,
): Float64Array {
  const out = new Float64Array(volumes.length).fill(Number.NaN);
  for (let index = period; index < volumes.length; index += 1) {
    let sum = 0;
    for (let back = index - period; back < index; back += 1) {
      sum += volumes[back] as number;
    }
    const baseline = sum / period;
    if (baseline > 0) {
      out[index] = (volumes[index] as number) / baseline;
    }
  }
  return out;
}

/**
 * The session a week's values become visible on, by the documented rule (module comment).
 * `lastBar` is the latest bar the fund printed in the week.
 */
export function weekVisibleFrom(
  weekStart: string,
  lastBar: string,
  schedule: OracleVenueSchedule,
): string {
  const friday = isoDate(utcDay(weekStart) + 4 * DAY_MS);
  if (lastBar >= friday) {
    return lastBar;
  }
  for (let day = friday; day > lastBar; day = isoDate(utcDay(day) - DAY_MS)) {
    const closures = schedule(day.slice(0, 4));
    if (closures === null) {
      return friday;
    }
    if (!closures.has(day)) {
      return day;
    }
  }
  return lastBar;
}

const DAILY_AVERAGES = [20, 50, 100, 200] as const;
const DAILY_EMAS = [20, 50, 200] as const;
const WEEKLY_AVERAGES = [20, 50, 100, 200] as const;
const WEEKLY_EMAS = [20, 50, 200] as const;
const RSI_PERIODS = [7, 14, 21] as const;
const RVOL_PERIODS = [10, 20, 50] as const;

/**
 * Every technical column the ETF metric menu offers, over the fund's own bars (ascending, one per
 * session). Built once per fund per sweep and shared by every run that reads it.
 */
export function buildOracleColumns(
  bars: readonly OracleBar[],
  schedule: OracleVenueSchedule,
): OracleColumns {
  const dates = bars.map((bar) => bar.date);
  const index = new Map(dates.map((date, position) => [date, position]));
  const close = Float64Array.from(bars.map((bar) => bar.close));
  const volume = Float64Array.from(bars.map((bar) => bar.volume));
  const columns = new Map<string, Float64Array>();

  for (const period of DAILY_AVERAGES) {
    columns.set(`SMA_${period}D`, sma(close, period));
  }
  for (const period of DAILY_EMAS) {
    columns.set(`EMA_${period}D`, ema(close, period));
  }
  for (const period of RSI_PERIODS) {
    columns.set(`RSI_${period}D`, wilderRsi(close, period));
  }
  for (const period of RVOL_PERIODS) {
    columns.set(`RVOL_${period}`, relativeVolume(volume, period));
  }

  // Weekly bars from the fund's own sessions, and the session each becomes visible on.
  type Week = { start: string; close: number; visibleFrom: string };
  const weeks: Week[] = [];
  for (let position = 0; position < bars.length; position += 1) {
    const bar = bars[position] as OracleBar;
    const start = isoWeekStart(bar.date);
    const current = weeks.at(-1);
    if (current && current.start === start) {
      current.close = bar.close;
      current.visibleFrom = bar.date; // provisional: the last bar so far
    } else {
      weeks.push({ start, close: bar.close, visibleFrom: bar.date });
    }
  }
  for (const week of weeks) {
    week.visibleFrom = weekVisibleFrom(week.start, week.visibleFrom, schedule);
  }
  const weeklyCloses = weeks.map((week) => week.close);
  const weeklyColumns = new Map<string, Float64Array>();
  for (const period of WEEKLY_AVERAGES) {
    weeklyColumns.set(`SMA_${period}W`, sma(weeklyCloses, period));
  }
  for (const period of WEEKLY_EMAS) {
    weeklyColumns.set(`EMA_${period}W`, ema(weeklyCloses, period));
  }
  // Each session reads the newest week visible on it. Weeks are in time order and so are their
  // visibility dates, so one forward pointer suffices.
  for (const [field, weekly] of weeklyColumns) {
    const daily = new Float64Array(dates.length).fill(Number.NaN);
    let visible = -1;
    for (let position = 0; position < dates.length; position += 1) {
      const date = dates[position] as string;
      while (
        visible + 1 < weeks.length &&
        (weeks[visible + 1] as Week).visibleFrom <= date
      ) {
        visible += 1;
      }
      if (visible >= 0) {
        daily[position] = weekly[visible] as number;
      }
    }
    columns.set(field, daily);
  }

  return {
    dates,
    index,
    close,
    column(field: string): Float64Array {
      const found = columns.get(field);
      if (!found) {
        throw new Error(`The ETF oracle has no column \`${field}\``);
      }
      return found;
    },
  };
}

export type OracleTruth = "TRUE" | "FALSE" | "NOT_EVALUABLE" | "AMBIGUOUS";

/** The operand a condition's Metric or SERIES Value reads, as an oracle column key. */
export type OracleOperand =
  | { readonly kind: "CLOSE" }
  | { readonly kind: "COLUMN"; readonly field: string }
  | { readonly kind: "CONSTANT"; readonly value: number };

function operandValue(
  columns: OracleColumns,
  position: number,
  operand: OracleOperand,
): number {
  switch (operand.kind) {
    case "CLOSE":
      return columns.close[position] as number;
    case "COLUMN":
      return columns.column(operand.field)[position] as number;
    case "CONSTANT":
      return operand.value;
  }
}

/** `is close to`'s fixed tolerance, restated from the product decision rather than imported. */
const CLOSE_TO_TOLERANCE = 0.02;

/**
 * One ETF Condition on one session: `TRUE`, `FALSE`, `NOT_EVALUABLE` (the fund printed no bar that
 * session, or an operand has not warmed up), or `AMBIGUOUS` (the two sides are within
 * {@link AMBIGUITY} of each other or of the `is close to` boundary).
 */
export function oracleConditionTruth(
  columns: OracleColumns,
  date: string,
  metric: OracleOperand,
  operator: "IS_ABOVE" | "IS_BELOW" | "IS_CLOSE_TO",
  value: OracleOperand,
): OracleTruth {
  const position = columns.index.get(date);
  if (position === undefined) {
    return "NOT_EVALUABLE";
  }
  const left = operandValue(columns, position, metric);
  const right = operandValue(columns, position, value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return "NOT_EVALUABLE";
  }
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  switch (operator) {
    case "IS_ABOVE":
    case "IS_BELOW": {
      if (Math.abs(left - right) <= AMBIGUITY * scale) {
        return "AMBIGUOUS";
      }
      const above = left > right;
      return (operator === "IS_ABOVE") === above ? "TRUE" : "FALSE";
    }
    case "IS_CLOSE_TO": {
      if (right === 0) {
        return "NOT_EVALUABLE";
      }
      const distance =
        Math.abs(left - right) - CLOSE_TO_TOLERANCE * Math.abs(right);
      if (Math.abs(distance) <= AMBIGUITY * scale) {
        return "AMBIGUOUS";
      }
      return distance <= 0 ? "TRUE" : "FALSE";
    }
  }
}
