import { Decimal } from "decimal.js";

/**
 * Relative Volume, written from the product methodology alone.
 *
 * The rule, as `ai/product/strategies.md` and the `DAILY_RELATIVE_VOLUMES` registry state it:
 *
 * ```text
 * RVOL(p)(t) = volume(t) / mean( volume(t - p) … volume(t - 1) )
 * ```
 *
 * Four properties come with it, and each is a thing an implementation can get wrong:
 *
 * 1. **The measured session is never in its own baseline.** The denominator is the `p` sessions
 *    strictly before `t`. An implementation that included `t` would damp every spike by roughly
 *    `1/(p+1)` and would still look plausible on a chart.
 * 2. **The full lookback is required.** The first value is at index `p`, so `p + 1` observations
 *    exist before any value does. A shorter baseline is never substituted, and a warm-up index is
 *    *absent* rather than zero — zero is a real reading, a session that traded nothing.
 * 3. **Sessions are counted, not calendar days.** The input is the security's own trading history,
 *    so a gap between two bars carries no meaning here.
 * 4. **A zero baseline yields no value.** The ratio is undefined there, and an infinity would
 *    compare as "above" every threshold a Strategy could name.
 *
 * Deliberately a different algorithm from the engine's. The engine slides one rolling sum and a
 * rolling count of unusable observations across the series in a single pass; this re-reduces the
 * explicit `p`-session slice at every index, in exact decimal arithmetic. An oracle that reproduced
 * the sliding window would agree with an off-by-one in it, which is the only kind of bug a rolling
 * accumulator really has.
 */
export function oracleRelativeVolume(
  volumes: readonly (number | null)[],
  period: number,
): (Decimal | null)[] {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`Relative volume period must be a positive integer`);
  }
  const usable = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(value);

  return volumes.map((current, index) => {
    if (index < period) {
      return null;
    }
    if (!usable(current)) {
      return null;
    }
    const baseline = volumes.slice(index - period, index);
    if (baseline.length !== period || !baseline.every(usable)) {
      return null;
    }
    const total = baseline.reduce(
      (sum, value) => sum.plus(new Decimal(value)),
      new Decimal(0),
    );
    const mean = total.dividedBy(period);
    if (mean.lessThanOrEqualTo(0)) {
      return null;
    }
    return new Decimal(current).dividedBy(mean);
  });
}

/** The three periods the product materializes, with the column each is stored in. */
export const ORACLE_RELATIVE_VOLUMES: readonly {
  column: "rvol10" | "rvol20" | "rvol50";
  period: number;
}[] = [
  { column: "rvol10", period: 10 },
  { column: "rvol20", period: 20 },
  { column: "rvol50", period: 50 },
];

export type OracleRelativeVolumeColumn =
  (typeof ORACLE_RELATIVE_VOLUMES)[number]["column"];
