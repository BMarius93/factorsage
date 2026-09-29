/**
 * The numeric contract of every calculated daily series stored on `DailyDerivedState`: one nullable
 * `DECIMAL(20,8)` column per series
 * (`docs/decisions/retain-wide-column-calculated-series-storage.md`).
 *
 * Twenty significant digits of which eight are fractional leave twelve integer digits, so the
 * largest magnitude a column holds is 999,999,999,999.99999999. PostgreSQL rounds a value to eight
 * decimals on insert — that quantization belongs to storage, never to a calculation — and refuses
 * a value whose rounded magnitude would need a thirteenth integer digit.
 *
 * This is the one statement of that range in code. A PostgreSQL-backed test pins it against the
 * live columns, so a calculation cannot guard against a different range than the one it is stored
 * in.
 */
export const CALCULATED_SERIES_DECIMAL = { precision: 20, scale: 8 } as const;

/** Exclusive magnitude bound of a storable calculated-series value: `10^12`. */
export const CALCULATED_SERIES_MAGNITUDE_LIMIT =
  10 ** (CALCULATED_SERIES_DECIMAL.precision - CALCULATED_SERIES_DECIMAL.scale);

/**
 * Whether a calculated value can be stored as it is: finite, and of a magnitude inside the column's
 * range.
 *
 * For a double this is exactly `|value| < 10^12`. No double lies between the largest one below
 * `10^12` (999,999,999,999.9998779…) and `10^12` itself, so no representable input can round up
 * into a thirteenth integer digit. Nothing is clamped or saturated here: a value outside the range
 * is simply not storable.
 */
export function isRepresentableCalculatedSeriesValue(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value) < CALCULATED_SERIES_MAGNITUDE_LIMIT
  );
}
