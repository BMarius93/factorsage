/**
 * Reference technical indicators, written from the documented definitions
 * (`docs/decisions/selectable-series-catalog.md`, `ai/architecture/calculated-series.md`).
 *
 * Deliberately naive: every SMA window is re-summed from scratch, every value is computed from the
 * close sequence alone, and nothing is shared with `@intrinsic/stock-data`.
 *
 * - Price is the canonical end-of-day close; indicators count trading observations, not days.
 * - SMA(n) at i = mean(close[i-n+1..i]); absent before n closes exist.
 * - EMA(n) is seeded at i = n-1 with SMA(n), then ema = prev + α (close - prev), α = 2 / (n + 1).
 * - RSI(n), Wilder: changes c_k = close[k] - close[k-1]; the first value at i = n uses the simple
 *   means of the first n gains and losses; afterwards avg = (avg (n-1) + current) / n;
 *   RSI = 100 g / (g + l), and 50 when both averages are zero.
 * - Weekly bars aggregate ISO weeks (Monday start); a week's close is its last observed close and it
 *   becomes effective on that last trading day's row. The week containing the as-of date is still
 *   in progress and excluded. Weekly averages are computed over weekly closes and carried forward
 *   onto every daily row until a newer completed week replaces them.
 */

export type Series = (number | null)[];

export function simpleMovingAverage(
  closes: readonly number[],
  period: number,
): Series {
  return closes.map((_, index) => {
    if (index < period - 1) {
      return null;
    }
    let sum = 0;
    for (let offset = index - period + 1; offset <= index; offset += 1) {
      sum += closes[offset]!;
    }
    return sum / period;
  });
}

export function exponentialMovingAverage(
  closes: readonly number[],
  period: number,
): Series {
  const result: Series = closes.map(() => null);
  if (closes.length < period) {
    return result;
  }
  let seed = 0;
  for (let index = 0; index < period; index += 1) {
    seed += closes[index]!;
  }
  let value = seed / period;
  result[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let index = period; index < closes.length; index += 1) {
    value = value + alpha * (closes[index]! - value);
    result[index] = value;
  }
  return result;
}

export function wilderRsi(closes: readonly number[], period: number): Series {
  const result: Series = closes.map(() => null);
  if (closes.length <= period) {
    return result;
  }
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gain += change > 0 ? change : 0;
    loss += change < 0 ? -change : 0;
  }
  gain /= period;
  loss /= period;
  const rsi = (g: number, l: number): number =>
    g === 0 && l === 0 ? 50 : (100 * g) / (g + l);
  result[period] = rsi(gain, loss);
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gain = (gain * (period - 1) + (change > 0 ? change : 0)) / period;
    loss = (loss * (period - 1) + (change < 0 ? -change : 0)) / period;
    result[index] = rsi(gain, loss);
  }
  return result;
}

/** Monday of the ISO week containing `date` (YYYY-MM-DD). */
export function isoWeekStart(date: string): string {
  const time = Date.UTC(
    +date.slice(0, 4),
    +date.slice(5, 7) - 1,
    +date.slice(8, 10),
  );
  const weekday = new Date(time).getUTCDay(); // 0 = Sunday
  const back = weekday === 0 ? 6 : weekday - 1;
  return new Date(time - back * 86_400_000).toISOString().slice(0, 10);
}

export type WeeklyBar = { weekStart: string; lastDate: string; close: number };

/**
 * Completed ISO weeks from ascending daily rows.
 *
 * `asOf` excludes its own (in-progress) week. `dropFirstWeek` removes a first week that the stored
 * history truncates rather than a genuine listing week (see the audit report for why this is a
 * parameter rather than a derived fact).
 */
export function weeklyBars(
  rows: readonly { date: string; close: number }[],
  asOf: string,
  dropFirstWeek: string | null,
): WeeklyBar[] {
  const current = isoWeekStart(asOf);
  const bars: WeeklyBar[] = [];
  for (const row of rows) {
    const week = isoWeekStart(row.date);
    if (week >= current || week === dropFirstWeek) {
      continue;
    }
    const last = bars[bars.length - 1];
    if (last && last.weekStart === week) {
      last.lastDate = row.date;
      last.close = row.close;
    } else {
      bars.push({ weekStart: week, lastDate: row.date, close: row.close });
    }
  }
  return bars;
}

export type IndicatorColumn =
  | "sma20d"
  | "sma50d"
  | "sma100d"
  | "sma200d"
  | "ema20d"
  | "ema50d"
  | "ema200d"
  | "sma20w"
  | "sma50w"
  | "sma100w"
  | "sma200w"
  | "ema20w"
  | "ema50w"
  | "ema200w"
  | "rsi7d"
  | "rsi14d"
  | "rsi21d";

/** The catalog, as `docs/decisions/selectable-series-catalog.md` lists it. */
export const INDICATORS: readonly {
  column: IndicatorColumn;
  seriesId: string;
  kind: "SMA" | "EMA" | "RSI";
  period: number;
  timeframe: "D" | "W";
}[] = [
  {
    column: "sma20d",
    seriesId: "SMA_20D",
    kind: "SMA",
    period: 20,
    timeframe: "D",
  },
  {
    column: "sma50d",
    seriesId: "SMA_50D",
    kind: "SMA",
    period: 50,
    timeframe: "D",
  },
  {
    column: "sma100d",
    seriesId: "SMA_100D",
    kind: "SMA",
    period: 100,
    timeframe: "D",
  },
  {
    column: "sma200d",
    seriesId: "SMA_200D",
    kind: "SMA",
    period: 200,
    timeframe: "D",
  },
  {
    column: "ema20d",
    seriesId: "EMA_20D",
    kind: "EMA",
    period: 20,
    timeframe: "D",
  },
  {
    column: "ema50d",
    seriesId: "EMA_50D",
    kind: "EMA",
    period: 50,
    timeframe: "D",
  },
  {
    column: "ema200d",
    seriesId: "EMA_200D",
    kind: "EMA",
    period: 200,
    timeframe: "D",
  },
  {
    column: "sma20w",
    seriesId: "SMA_20W",
    kind: "SMA",
    period: 20,
    timeframe: "W",
  },
  {
    column: "sma50w",
    seriesId: "SMA_50W",
    kind: "SMA",
    period: 50,
    timeframe: "W",
  },
  {
    column: "sma100w",
    seriesId: "SMA_100W",
    kind: "SMA",
    period: 100,
    timeframe: "W",
  },
  {
    column: "sma200w",
    seriesId: "SMA_200W",
    kind: "SMA",
    period: 200,
    timeframe: "W",
  },
  {
    column: "ema20w",
    seriesId: "EMA_20W",
    kind: "EMA",
    period: 20,
    timeframe: "W",
  },
  {
    column: "ema50w",
    seriesId: "EMA_50W",
    kind: "EMA",
    period: 50,
    timeframe: "W",
  },
  {
    column: "ema200w",
    seriesId: "EMA_200W",
    kind: "EMA",
    period: 200,
    timeframe: "W",
  },
  {
    column: "rsi7d",
    seriesId: "RSI_7D",
    kind: "RSI",
    period: 7,
    timeframe: "D",
  },
  {
    column: "rsi14d",
    seriesId: "RSI_14D",
    kind: "RSI",
    period: 14,
    timeframe: "D",
  },
  {
    column: "rsi21d",
    seriesId: "RSI_21D",
    kind: "RSI",
    period: 21,
    timeframe: "D",
  },
];

function kernel(
  kind: "SMA" | "EMA" | "RSI",
  closes: readonly number[],
  period: number,
): Series {
  return kind === "SMA"
    ? simpleMovingAverage(closes, period)
    : kind === "EMA"
      ? exponentialMovingAverage(closes, period)
      : wilderRsi(closes, period);
}

/**
 * Every catalog indicator for every daily row, plus the effective week start.
 */
export function referenceIndicators(
  rows: readonly { date: string; close: number }[],
  options: { asOf: string; dropFirstWeek: string | null },
): { values: Map<IndicatorColumn, Series>; weekStart: (string | null)[] } {
  const closes = rows.map((row) => row.close);
  const values = new Map<IndicatorColumn, Series>();
  const bars = weeklyBars(rows, options.asOf, options.dropFirstWeek);
  const weeklyCloses = bars.map((bar) => bar.close);
  // For each daily row, the newest completed week whose last trading day is on or before it.
  const effective: number[] = [];
  let cursor = -1;
  for (const row of rows) {
    while (cursor + 1 < bars.length && bars[cursor + 1]!.lastDate <= row.date) {
      cursor += 1;
    }
    effective.push(cursor);
  }
  for (const indicator of INDICATORS) {
    if (indicator.timeframe === "D") {
      values.set(
        indicator.column,
        kernel(indicator.kind, closes, indicator.period),
      );
    } else {
      const weekly = kernel(indicator.kind, weeklyCloses, indicator.period);
      values.set(
        indicator.column,
        effective.map((index) => (index < 0 ? null : weekly[index]!)),
      );
    }
  }
  return {
    values,
    weekStart: effective.map((index) =>
      index < 0 ? null : bars[index]!.weekStart,
    ),
  };
}
