import {
  DAILY_MOVING_AVERAGES,
  type DailyDerivedState,
  type DailyMovingAverageField,
  type DailyPrice,
  type MovingAverageType,
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
 * Daily moving-average values of one trading day, keyed by their materialization field.
 *
 * A field is absent while the indicator has not warmed up. Absent never means zero: a security
 * with only sixty trading days behind it legitimately has `sma50d` and no `sma100d`. This mirrors
 * `WeeklyTechnicalValues` so both timeframes carry the same shape.
 */
export type DailyTechnicalValues = Partial<
  Record<DailyMovingAverageField, number>
>;

/**
 * Calculates the daily technical portion of `DailyDerivedState` for every supplied trading day.
 *
 * Every daily moving average registered in `DAILY_MOVING_AVERAGES` is calculated, so a period
 * added to that registry is materialized here without editing this function. Iteration follows
 * registry order, which is also the order the fields are written onto the row.
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
  const calculated = DAILY_MOVING_AVERAGES.map((average) => ({
    field: average.field,
    values: movingAverage(closes, average.type, average.period),
  }));

  return ascending.map((price, index) => {
    const values: DailyTechnicalValues = {};
    for (const average of calculated) {
      const value = average.values[index];
      if (value !== undefined) {
        values[average.field] = value;
      }
    }
    return { securityId: price.securityId, date: price.date, ...values };
  });
}
