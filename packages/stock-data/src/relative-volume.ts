import {
  DAILY_RELATIVE_VOLUMES,
  type DailyDerivedState,
  type DailyPrice,
  type DailyRelativeVolumeField,
} from "@intrinsic/domain";

/**
 * Relative Volume over an ascending session-volume series. One parameterized implementation serves
 * every registered period; there is deliberately no per-period variant.
 *
 * Methodology, locked by `relative-volume.test.ts`:
 * - `RVOL(p)(t) = volume(t) / mean(volume(t - p) … volume(t - 1))`;
 * - **the session being measured is never part of its own baseline**, so the denominator is the
 *   `p` sessions strictly before `t`;
 * - the full lookback is required: the first value appears at index `p`, never sooner, and a
 *   shorter period is never substituted for a longer one that has not warmed up;
 * - a session whose volume is not a finite number is not a valid observation: it has no value of
 *   its own, and every later session whose baseline window contains it has none either;
 * - a baseline mean of zero leaves the value absent — the ratio has no meaning there, and an
 *   infinity would compare as "above" every threshold a Strategy could name.
 *
 * Warm-up indices stay `undefined` — absent, never zero. Zero is a real reading: a session that
 * traded nothing against a baseline that did. The input is treated as the time order and is never
 * reordered or mutated; callers own calendar semantics, so gaps between sessions carry no meaning
 * here — **trading observations are counted, not calendar days**.
 *
 * Linear in the series length for each period: one rolling sum plus a rolling count of the
 * non-finite observations inside the window, so nothing re-reduces a slice per observation.
 */
export function calculateRelativeVolume(
  volumes: readonly number[],
  period: number,
): Array<number | undefined> {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error("Relative volume period must be a positive integer");
  }
  const result: Array<number | undefined> = Array.from(
    { length: volumes.length },
    () => undefined,
  );
  if (volumes.length <= period) {
    return result;
  }

  // The window is [index - period, index - 1]: `sum` and `invalid` describe exactly that span, so
  // the current session can never leak into its own denominator.
  let sum = 0;
  let invalid = 0;
  for (let index = 0; index < period; index += 1) {
    const value = volumes[index] as number;
    if (Number.isFinite(value)) {
      sum += value;
    } else {
      invalid += 1;
    }
  }

  for (let index = period; index < volumes.length; index += 1) {
    const current = volumes[index] as number;
    if (invalid === 0 && Number.isFinite(current)) {
      const baseline = sum / period;
      // A zero baseline is not a small baseline: the ratio is undefined, not enormous.
      if (baseline > 0) {
        result[index] = current / baseline;
      }
    }
    // Slide the window forward one session: `index` enters it, `index - period` leaves.
    if (Number.isFinite(current)) {
      sum += current;
    } else {
      invalid += 1;
    }
    const leaving = volumes[index - period] as number;
    if (Number.isFinite(leaving)) {
      sum -= leaving;
    } else {
      invalid -= 1;
    }
  }
  return result;
}

/**
 * Relative Volume values of one trading day, keyed by their materialization field.
 *
 * A field is absent while the period has not warmed up, or while its baseline is unusable. Absent
 * never means zero, exactly as it does not for the moving averages and oscillators.
 */
export type DailyRelativeVolumeValues = Partial<
  Record<DailyRelativeVolumeField, number>
>;

/**
 * A subset of the canonical Relative Volume registry, typed as entries *of that registry* so a
 * caller cannot pass a period the product does not materialize.
 */
export type DailyRelativeVolumeSubset =
  readonly (typeof DAILY_RELATIVE_VOLUMES)[number][];

/**
 * Calculates the Relative Volume portion of `DailyDerivedState` for every supplied trading day.
 *
 * Every period registered in `DAILY_RELATIVE_VOLUMES` is calculated over the same canonical daily
 * bars the moving averages and oscillators consume — the volume column of the very same
 * `DailyPrice` rows — so a period added to that registry is materialized here without editing this
 * function. Iteration follows registry order, which is also the order the fields are written onto
 * the row.
 *
 * One row per trading day is produced. Warm-up gaps leave individual periods absent; they are
 * never zeroed. Callers merge these rows with the other derived families before persisting.
 *
 * `periods` narrows the calculation to a subset of that same registry, for the same reason and
 * with the same rule as `calculateDailyTechnicals`: a caller that has derived which series are
 * actually required must be able to compute only those. It changes which fields are produced,
 * never how any of them is calculated.
 */
export function calculateDailyRelativeVolumes(
  prices: readonly DailyPrice[],
  periods: DailyRelativeVolumeSubset = DAILY_RELATIVE_VOLUMES,
): DailyDerivedState[] {
  const ascending = [...prices].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const volumes = ascending.map((price) => price.volume);
  const calculated = periods.map((entry) => ({
    field: entry.field,
    values: calculateRelativeVolume(volumes, entry.period),
  }));

  return ascending.map((price, index) => {
    const values: DailyRelativeVolumeValues = {};
    for (const entry of calculated) {
      const value = entry.values[index];
      if (value !== undefined) {
        values[entry.field] = value;
      }
    }
    return { securityId: price.securityId, date: price.date, ...values };
  });
}
