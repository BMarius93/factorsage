/**
 * The text of the Strategy Builder's numeric Value field, and the number it means.
 *
 * The field keeps what the user typed and the draft keeps a number, so the two need one exact
 * translation in each direction. No rounding and no domain rule lives here: bounds and precision are
 * the canonical validator's (`@intrinsic/contracts`), which reports a value it refuses rather than a
 * control quietly changing it.
 */

/**
 * The number a field's text means: `NaN` for nothing typed or a half-typed entry.
 *
 * A number input reports `-`, `0.` and `-0.` as an empty string, so they arrive here as `""` and
 * mean no number yet. Text the input does pass through is a valid floating-point literal.
 */
export function parseNumericValueText(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** The text a stored number is shown as when the field has nothing of its own to show. */
export function numericValueText(value: number): string {
  return Number.isNaN(value) ? "" : String(value);
}

/**
 * Whether two values are the same number for the field's purposes: `NaN` equals `NaN` (both "no
 * number"), and `-0` is not `0`, so a typed `-0` is kept as typed.
 */
export function sameNumericValue(left: number, right: number): boolean {
  return Object.is(left, right);
}
