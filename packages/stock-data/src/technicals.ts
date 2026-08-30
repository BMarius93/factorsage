import type {
  DailyDerivedState,
  DailyPrice,
  MovingAverageType,
} from "@intrinsic/domain";

export function movingAverage(
  values: readonly number[],
  type: MovingAverageType,
  period: number,
): Array<number | undefined> {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error("Moving-average period must be a positive integer");
  }
  const result: Array<number | undefined> = Array.from(
    { length: values.length },
    () => undefined,
  );
  if (values.length < period) {
    return result;
  }

  let windowSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error("Moving-average inputs must be finite numbers");
    }
    windowSum += value;
    if (index >= period) {
      windowSum -= values[index - period] ?? 0;
    }
    if (index >= period - 1) {
      result[index] = windowSum / period;
    }
  }

  if (type === "EMA") {
    const multiplier = 2 / (period + 1);
    let previous = result[period - 1];
    for (let index = period; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined || previous === undefined) {
        throw new Error("EMA seed calculation failed");
      }
      previous = (value - previous) * multiplier + previous;
      result[index] = previous;
    }
  }

  return result;
}

/**
 * Calculates the daily technical portion of `DailyDerivedState` for every supplied trading day.
 *
 * One row per trading day is produced. Warm-up gaps leave individual indicators absent; they are
 * never zeroed. Callers merge these rows with the other derived families before persisting.
 */
export function calculateDailyTechnicals(
  prices: readonly DailyPrice[],
): DailyDerivedState[] {
  const ascending = [...prices].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const closes = ascending.map((price) => price.close);
  const sma20d = movingAverage(closes, "SMA", 20);
  const sma50d = movingAverage(closes, "SMA", 50);
  const sma100d = movingAverage(closes, "SMA", 100);
  const sma200d = movingAverage(closes, "SMA", 200);
  const ema20d = movingAverage(closes, "EMA", 20);
  const ema50d = movingAverage(closes, "EMA", 50);
  const ema200d = movingAverage(closes, "EMA", 200);

  return ascending.map((price, index) => ({
    securityId: price.securityId,
    date: price.date,
    ...(sma20d[index] === undefined ? {} : { sma20d: sma20d[index] }),
    ...(sma50d[index] === undefined ? {} : { sma50d: sma50d[index] }),
    ...(sma100d[index] === undefined ? {} : { sma100d: sma100d[index] }),
    ...(sma200d[index] === undefined ? {} : { sma200d: sma200d[index] }),
    ...(ema20d[index] === undefined ? {} : { ema20d: ema20d[index] }),
    ...(ema50d[index] === undefined ? {} : { ema50d: ema50d[index] }),
    ...(ema200d[index] === undefined ? {} : { ema200d: ema200d[index] }),
  }));
}
