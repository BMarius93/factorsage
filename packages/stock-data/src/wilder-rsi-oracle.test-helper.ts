/**
 * Independent reference implementation of the product's Wilder RSI.
 *
 * Deliberately not the production recurrence: comparing `calculateWilderRsi` with itself would
 * lock in whatever it does. Wilder smoothing `avg' = (avg * (N - 1) + x) / N` unrolls into a
 * closed-form geometrically weighted sum, and this oracle computes that sum from scratch for every
 * index — `Math.pow` weights instead of an iterated recurrence, re-walked per index instead of
 * carried state. The two implementations therefore agree on the mathematics without sharing a
 * summation order, which is why callers compare with `toBeCloseTo` rather than exact equality.
 *
 * Same conventions as the documented methodology: the seed average is the simple mean of the first
 * `period` changes, the first value appears once `period + 1` closes exist, and a window whose
 * average gain and average loss are both zero reads 50.
 *
 * This file is test support, not product code. It is deliberately not exported from `index.ts`
 * and the `.test-helper` suffix keeps Vitest from collecting it as a suite of its own.
 */
export function referenceWilderRsi(
  closes: readonly number[],
  period: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = closes.map(() => undefined);
  if (closes.length < period + 1) {
    return out;
  }

  const gains: number[] = [];
  const losses: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gains[index] = Math.max(change, 0);
    losses[index] = Math.max(-change, 0);
  }

  const decay = (period - 1) / period;
  for (let index = period; index < closes.length; index += 1) {
    let seedGain = 0;
    let seedLoss = 0;
    for (let change = 1; change <= period; change += 1) {
      seedGain += gains[change]!;
      seedLoss += losses[change]!;
    }
    let avgGain = (seedGain / period) * Math.pow(decay, index - period);
    let avgLoss = (seedLoss / period) * Math.pow(decay, index - period);
    for (let change = period + 1; change <= index; change += 1) {
      avgGain += (gains[change]! / period) * Math.pow(decay, index - change);
      avgLoss += (losses[change]! / period) * Math.pow(decay, index - change);
    }
    out[index] =
      avgGain === 0 && avgLoss === 0
        ? 50
        : (100 * avgGain) / (avgGain + avgLoss);
  }
  return out;
}
