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
 * How a JS float ratio lands in a `numeric(p, scale)` column through Prisma 6.
 *
 * Measured, not assumed (audit finding AUD-01): Prisma converts a `number` bound to a Decimal
 * field to **16 significant digits** before PostgreSQL rounds it half away from zero at the column
 * scale. The model matched 289,728 of 289,728 persisted ratios in the first 40 matrix runs; the
 * float's own correctly-rounded value matched 289,474. The difference — a double rounding — is at
 * most one unit in the column's last place.
 */
export function storedAtScale(value: number, scale: number): string {
  return new D(value.toPrecision(16))
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .toFixed(scale);
}

/** The float correctly rounded at `scale` (what a string-bound write would store). */
export function correctlyRoundedAtScale(value: number, scale: number): string {
  return new D(value)
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .toFixed(scale);
}
