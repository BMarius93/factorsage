/**
 * A double as the stock path stores it: written to a PostgreSQL `numeric(20, 8)` column and read back.
 *
 * A stock's derived values reach every reader through that column, which rounds the binary residue of
 * a running computation away — a 200-day mean of cents computed as `14.690000000000033` is stored and
 * read back as `14.69`, so `Price is below SMA 200D` is FALSE on a session whose close is exactly its
 * mean. An ETF's technicals are computed at evaluation time and never stored, so without this they
 * kept the residue and an exact tie was decided by float noise (pre-release audit FIN-12: 45 of 47
 * exact ETF ties read as strictly above or below, while 81 of 81 stock ties read as ties). Applying
 * the one rounding the stock path applies makes a stock and an ETF decide identical bars identically;
 * it changes no stored value.
 *
 * The rounding is exactly the write path's, measured rather than assumed
 * (`stored-decimal.integration.test.ts`, a real `numeric(20, 8)` round trip): the double is bound
 * with **sixteen significant digits** — not its shortest round-trip form, so `33.758710584999996`
 * arrives as `33.75871058500000` — PostgreSQL then rounds half away from zero to `scale` places, and
 * the read path parses the stored decimal back to the nearest double. Both roundings are reproduced
 * here, in that order.
 */
const BOUND_SIGNIFICANT_DIGITS = 16;
export const STORED_DECIMAL_SCALE = 8;

export function quantizeToStoredDecimal(
  value: number,
  scale: number = STORED_DECIMAL_SCALE,
): number {
  if (!Number.isFinite(value) || value === 0) {
    return value;
  }
  const parsed = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(
    value.toPrecision(BOUND_SIGNIFICANT_DIGITS),
  );
  if (!parsed) {
    throw new Error(`Cannot read ${value} as a decimal`);
  }
  const negative = parsed[1] === "-";
  const fraction = parsed[3] ?? "";
  const mantissa = BigInt(`${parsed[2]}${fraction}`);
  // value = mantissa × 10^exponent, exactly as the bound decimal reads.
  const exponent = Number(parsed[4] ?? "0") - fraction.length;
  const shift = exponent + scale;
  let units: bigint;
  if (shift >= 0) {
    units = mantissa * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    units = mantissa / divisor;
    // Half away from zero, on the magnitude: PostgreSQL's `numeric` rounding.
    if ((mantissa % divisor) * 2n >= divisor) {
      units += 1n;
    }
  }
  if (units === 0n) {
    return negative ? -0 : 0;
  }
  return Number(`${negative ? "-" : ""}${units}e-${scale}`);
}
