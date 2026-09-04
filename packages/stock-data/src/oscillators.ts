import {
  DAILY_OSCILLATORS,
  type DailyDerivedState,
  type DailyOscillatorField,
  type DailyPrice,
} from "@intrinsic/domain";

/**
 * Wilder RSI over an ascending close series. One parameterized implementation serves every
 * registered period; there is deliberately no per-period variant.
 *
 * Methodology, locked by `daily-oscillators.test.ts`:
 * - consecutive close changes; `gain = max(change, 0)`, `loss = max(-change, 0)`;
 * - the first value appears once `period + 1` closes exist — `period` observed changes;
 * - the seed average gain/loss is the simple mean of the first `period` changes;
 * - every later value applies Wilder smoothing: `avg' = (avg * (period - 1) + current) / period`;
 * - `RSI = 100 * avgGain / (avgGain + avgLoss)`, algebraically `100 - 100 / (1 + RS)`;
 * - an only-gains window reads exactly 100, an only-losses window exactly 0, and a completely
 *   flat window (both averages zero) reads 50;
 * - every value lies in `RSI_VALUE_RANGE` ([0, 100]) because both averages are non-negative.
 *
 * Warm-up indices stay `undefined` — absent, never zero. The input is treated as the time order
 * and is never reordered or mutated; callers own calendar semantics, so gaps between closes
 * (weekends, holidays) carry no meaning here: observations are counted, not calendar days.
 */
export function calculateWilderRsi(
  closes: readonly number[],
  period: number,
): Array<number | undefined> {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error("RSI period must be a positive integer");
  }
  for (const value of closes) {
    if (!Number.isFinite(value)) {
      throw new Error("RSI inputs must be finite numbers");
    }
  }
  const result: Array<number | undefined> = Array.from(
    { length: closes.length },
    () => undefined,
  );
  if (closes.length < period + 1) {
    return result;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = rsiOf(avgGain, avgLoss);

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiOf(avgGain, avgLoss);
  }
  return result;
}

function rsiOf(avgGain: number, avgLoss: number): number {
  // Both averages zero means a completely flat window history: neither overbought nor oversold.
  if (avgGain === 0 && avgLoss === 0) {
    return 50;
  }
  return (100 * avgGain) / (avgGain + avgLoss);
}

/**
 * Daily oscillator values of one trading day, keyed by their materialization field.
 *
 * A field is absent while the oscillator has not warmed up. Absent never means zero: a security
 * with ten trading days behind it legitimately has `rsi7d` and no `rsi14d`. This mirrors
 * `DailyTechnicalValues` so both daily families carry the same shape.
 */
export type DailyOscillatorValues = Partial<
  Record<DailyOscillatorField, number>
>;

/**
 * Calculates the daily oscillator portion of `DailyDerivedState` for every supplied trading day.
 *
 * Every oscillator registered in `DAILY_OSCILLATORS` is calculated over the same canonical
 * completed daily closes the daily moving averages consume, so a period added to that registry is
 * materialized here without editing this function. Iteration follows registry order, which is also
 * the order the fields are written onto the row.
 *
 * One row per trading day is produced. Warm-up gaps leave individual oscillators absent; they are
 * never zeroed. Callers merge these rows with the other derived families before persisting.
 */
export function calculateDailyOscillators(
  prices: readonly DailyPrice[],
): DailyDerivedState[] {
  const ascending = [...prices].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const closes = ascending.map((price) => price.close);
  const calculated = DAILY_OSCILLATORS.map((oscillator) => ({
    field: oscillator.field,
    values: calculateWilderRsi(closes, oscillator.period),
  }));

  return ascending.map((price, index) => {
    const values: DailyOscillatorValues = {};
    for (const oscillator of calculated) {
      const value = oscillator.values[index];
      if (value !== undefined) {
        values[oscillator.field] = value;
      }
    }
    return { securityId: price.securityId, date: price.date, ...values };
  });
}
