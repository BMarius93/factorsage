import type { MovingAverageType } from "@intrinsic/domain";

/**
 * Independent reference implementation of the product's moving averages.
 *
 * Deliberately naive and written from the documented convention rather than reusing
 * `movingAverage`: comparing the production function with itself would lock in whatever it does.
 * Each window is re-summed from scratch instead of sliding a running total, so the two
 * implementations agree on the mathematics without sharing a summation order — which is why
 * callers compare with `toBeCloseTo` rather than exact equality.
 *
 * The EMA seed is the simple average of the first `period` values, matching the convention the
 * daily and weekly indicators were locked to.
 *
 * This file is test support, not product code. It is deliberately not exported from `index.ts`
 * and the `.test-helper` suffix keeps Vitest from collecting it as a suite of its own.
 */
export function referenceMovingAverage(
  values: readonly number[],
  type: MovingAverageType,
  period: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = values.map(() => undefined);
  for (let index = period - 1; index < values.length; index += 1) {
    let sum = 0;
    for (let back = 0; back < period; back += 1) {
      sum += values[index - back]!;
    }
    out[index] = sum / period;
  }
  if (type === "SMA") {
    return out;
  }
  const multiplier = 2 / (period + 1);
  let previous = out[period - 1];
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index]! - previous!) * multiplier + previous!;
    out[index] = previous;
  }
  return out;
}
