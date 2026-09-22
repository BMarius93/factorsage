import Decimal from "decimal.js";

/**
 * Exact decimal arithmetic for the audit oracle.
 *
 * `decimal.js` is an arithmetic primitive, not FactorSage business logic, so using it keeps the
 * oracle independent: every rounding decision below is written here from the documented ledger
 * scales (`ai/architecture/backtest-execution.md`, `docs/development/qa-matrix-runner.md`), never
 * imported from `@intrinsic/strategy`.
 *
 * Documented scales:
 * - money   numeric(24,6), rounded half away from zero (PostgreSQL `numeric` semantics);
 * - prices  Decimal(20,8), rounded half away from zero;
 * - shares  Decimal(28,10), always truncated toward zero (a purchase may never cost more than the
 *           cash that paid for it).
 */
export const D = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

export type Dec = InstanceType<typeof D>;

export const ZERO: Dec = new D(0);

export function dec(value: number | string | Dec): Dec {
  return new D(value);
}

export function money(value: number | string | Dec): Dec {
  return new D(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

export function price(value: number | string | Dec): Dec {
  return new D(value).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
}

export function sharesDown(value: number | string | Dec): Dec {
  return new D(value).toDecimalPlaces(10, Decimal.ROUND_DOWN);
}

/** One unit in the last place of a share quantity. */
export const SHARE_STEP: Dec = new D("0.0000000001");

export function moneyText(value: Dec): string {
  return value.toFixed(6);
}

export function priceText(value: Dec): string {
  return value.toFixed(8);
}

export function sharesText(value: Dec): string {
  return value.toFixed(10);
}

/**
 * How a JS float ratio lands in a `numeric(p, scale)` column.
 *
 * The write path renders a ratio as a decimal literal at the column's scale, so PostgreSQL rounds
 * it exactly once — the float's own correctly rounded value. That is the model the comparisons use.
 *
 * It was not always so, which is why the second model below still exists. Audit finding AUD-01
 * measured the previous binding: Prisma 6 converted a bound `number` to **16 significant digits**
 * and PostgreSQL rounded *that* at the column scale. The two-step model matched 289,728 of 289,728
 * persisted ratios sampled in the first 40 matrix runs, and single rounding matched 289,474 of
 * them — the 254 that differed did so by one unit in the last place.
 */
export function storedAtScale(value: number, scale: number): string {
  return correctlyRoundedAtScale(value, scale);
}

/**
 * The float correctly rounded at `scale`.
 *
 * The float is expanded to 100 decimals first, which is its exact binary value at these magnitudes
 * rather than the shortest decimal that round-trips to it. The distinction is the whole point: the
 * shortest form of one audited ratio is `8.84411177645`, which rounds *up* at ten places, while the
 * double it names is below that midpoint and rounds down. A model built on the shortest form would
 * disagree with PostgreSQL on exactly the values this function exists to check.
 */
export function correctlyRoundedAtScale(value: number, scale: number): string {
  return new D(value.toFixed(100))
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .toFixed(scale);
}

/**
 * What the pre-AUD-01 float binding stored: 16 significant digits, then the column's scale.
 *
 * Kept so the audit can still say how many rows the old path would have stored differently, and so
 * a forensic archive produced before the fix can be read with the model that was true for it.
 */
export function prismaFloatBoundAtScale(value: number, scale: number): string {
  return new D(value.toPrecision(16))
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .toFixed(scale);
}
