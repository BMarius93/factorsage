/**
 * The exact sum of reported decimal values, correctly rounded once to a double.
 *
 * Statement line items are decimals as the provider reported them — `epsDiluted` of `0.1`, `0.2`
 * and `-0.3` — and a formula's `sum(...)` means their mathematical sum. Adding the binary doubles
 * one by one does not compute it: `0.1 + 0.2 + -0.3` is `5.55e-17`, not zero. That residue is
 * harmless in a value but decisive in a rule, because Fundamental Metrics branch on the sign of a
 * sum (`require EPS_TTM_previous > 0`): a four-quarter EPS that nets to exactly zero would read as
 * a positive denominator and turn a flat company into a growth rate in the quintillions.
 *
 * Each value is taken at its shortest round-trip decimal form — the text the provider supplied and
 * the JSON payload stores — summed exactly in integer arithmetic, and converted once. So a sum's
 * sign is exact, the result is the double nearest the true sum, and summation order cannot change a
 * single bit. It is arithmetic precision, not a methodology: nothing is rounded to a coarser grid.
 */
export function exactDecimalSum(values: readonly number[]): number {
  const parts = values.map(decimalParts);
  let exponent = 0;
  for (const part of parts) {
    exponent = Math.min(exponent, part.exponent);
  }
  let total = 0n;
  for (const part of parts) {
    total += part.coefficient * 10n ** BigInt(part.exponent - exponent);
  }
  return Number(`${total}e${exponent}`);
}

/** A finite double as `coefficient × 10^exponent`, from its shortest round-trip decimal form. */
function decimalParts(value: number): {
  coefficient: bigint;
  exponent: number;
} {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot sum a non-finite value: ${value}`);
  }
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Unexpected numeric form: ${text}`);
  }
  const [, sign = "", integer = "", fraction = "", power = "0"] = match;
  return {
    coefficient: BigInt(`${sign}${integer}${fraction}`),
    exponent: Number(power) - fraction.length,
  };
}
