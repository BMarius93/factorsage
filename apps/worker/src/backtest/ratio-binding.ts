/**
 * How a ratio reaches its `numeric` column.
 *
 * Money and share quantities leave the engine as canonical decimal strings already
 * (`BacktestTrade.shares` in `@intrinsic/strategy` explains why). Ratios — growth indices and
 * percentages — are `number`, which is the right type for them: they are derived quantities, not
 * ledger values, and nothing reconciles them against an identity.
 *
 * Binding that number straight to a Decimal column rounds it **twice**, though. Prisma 6 renders a
 * JS `number` at 16 significant digits, and PostgreSQL then rounds that at the column's scale, so a
 * value whose 16-digit form crosses the scale's midpoint is stored one unit in the last place away
 * from the float's own correctly-rounded value. The audit measured it (AUD-01): 5,817 stored
 * `returnIndex` values across the matrix differed by 1e-10 from the correctly rounded value, which
 * is at most 2.9e-8 percentage points in an annual return — invisible, and still wrong.
 *
 * Rendering the ratio at the column's scale here removes the intermediate rounding: PostgreSQL
 * receives a decimal literal that is already at the stored scale and stores it unchanged. Nothing
 * about the engine's arithmetic changes, and no precision is invented — the value is exactly the
 * float, rounded once.
 */

/** `Decimal(20, 10)`: `returnIndex` and `benchmarkIndex`, growth indices based at 1.0. */
export const INDEX_SCALE = 10;

/** `Decimal(20, 8)`: every persisted percentage. */
export const PERCENT_SCALE = 8;

/**
 * The ratio as a decimal literal at `scale`, rounded once.
 *
 * `toFixed` rounds from the double's exact binary value, so the result is the correctly rounded
 * decimal; an exact tie (only reachable when the double is exactly a midpoint at `scale`) goes away
 * from zero, which is what PostgreSQL `numeric` would have done with it anyway.
 */
export function ratioAtScale(value: number, scale: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `A backtest ratio must be finite to be stored; received ${value}.`,
    );
  }
  if (Math.abs(value) >= 1e21) {
    // `toFixed` switches to exponential notation there, which is not a `numeric` literal. No ratio
    // this product computes comes close, so this is a guard rather than a case to handle.
    throw new Error(`A backtest ratio of ${value} is out of storable range.`);
  }
  return value.toFixed(scale);
}

/** {@link ratioAtScale}, passing a null through. */
export function ratioAtScaleOrNull(
  value: number | null,
  scale: number,
): string | null {
  return value === null ? null : ratioAtScale(value, scale);
}
