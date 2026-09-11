import Decimal from "decimal.js";

/**
 * The canonical monetary representation of a backtest result.
 *
 * A backtest's numbers are float64 while they are being decided and exact decimal while they are
 * being recorded, and the boundary between those two worlds is this module.
 *
 * **Why not float64 all the way.** The engine's own arithmetic is fine in float64 — a portfolio
 * value that decides a BUY target does not need to be exact to the last digit. What is not fine is
 * *recording* the outcome in float64 and then persisting it at a decimal scale, because the
 * ledger's identities are equalities and float64 cannot hold them across the range this product
 * supports. That range is not `[1, 1e9]`: a `C08` configuration starts at the contract maximum of
 * one billion and compounds for thirty years, and the validation matrix observed a portfolio of
 * $334,310,721,745.96 and a single trade of $2,611,478,558.52. At $334 bn one float64 ULP is
 * 6.1e-5, so the sixth decimal place does not exist; at $2.4 bn shares, a `Decimal(28,10)` share
 * count is already 17 significant digits against float64's ~15.95.
 *
 * **Why not `Math.round(x * 1e6) / 1e6`.** It is unsound above $9,007,199,254.74, where
 * `x * 1e6` exceeds `Number.MAX_SAFE_INTEGER` — and it fails silently: `Math.round` of a non-safe
 * integer returns its argument, so the normalizer quietly becomes the identity function exactly
 * where normalization matters most.
 *
 * **Why the boundary carries strings.** A canonical decimal string is the only representation that
 * survives every hop — engine to worker, worker to Prisma, run to forensic archive — without a
 * decimal library at each end and without a float64 round trip in the middle. A `Decimal` ledger
 * that emitted `number` was measured to break the same identities it exists to guarantee at C08
 * magnitudes; a string boundary was exact in every case tested.
 *
 * Everything here is pure: no I/O, no clock, no `process.env`, and deliberately no dependency on
 * Prisma or `@intrinsic/database`. `@intrinsic/strategy` stays a package that can be reasoned about
 * without a database, so `decimal.js` is depended on directly rather than borrowed from the ORM.
 */

/**
 * A monetary amount, as the database stores it: a decimal string with exactly {@link MONEY_SCALE}
 * fractional digits.
 *
 * It is a string rather than a number because it has to be *exact*, and rather than a `Decimal`
 * because it has to be plain data. Prisma accepts it directly for a `numeric` column, `JSON.stringify`
 * round-trips it, and a consumer that only displays it needs no arithmetic library at all.
 */
export type MoneyString = string;

/** A share quantity in the same canonical form, at {@link SHARES_SCALE}. */
export type SharesString = string;

/**
 * Deliberately **unbranded**, and what enforces the distinction instead.
 *
 * A branded alias would make `moneyString(x)` unassignable where a `SharesString` is expected, and
 * would also demand a cast at every boundary these cross — Prisma reads, `JSON.parse`, the archive
 * reader, and every fixture in every suite — because none of those can produce a branded value. The
 * mistake it would catch is a real one: the scales differ, decimal comparison ignores trailing
 * zeros, so writing an eight-decimal price where six decimals are stored is invisible until
 * PostgreSQL rounds two digits away.
 *
 * That property is asserted directly instead, over a real simulation, in
 * `simulate.test.ts` → "persisted scales": every string the engine emits is checked to carry its
 * own declared scale and no other. One place, no casts, and it fails on the value rather than on
 * the type — which is where the damage actually happens.
 */

/**
 * Fractional digits of persisted money: `numeric(24,6)`.
 *
 * Six is the largest scale that is still *meaningful* at the contract maximum initial capital and
 * at the largest transaction the matrix observed — at $1e9 a float64 ULP is 1.19e-7, and at
 * $2.6 bn it is 4.77e-7, so both support six decimal places and no more. Below that, at the $1
 * contract minimum, six decimals resolve a 2.5-cent BUY and a sub-half-cent profit exactly, which
 * is the whole point: `Decimal(20,2)` rounded a real 0.025 spend to 0.03 and a real profit to 0.00.
 *
 * Above roughly $1e11 a *derived* portfolio aggregate carries digits float64 could not have
 * produced. That is a property of the arithmetic, not of the scale, and it is why
 * {@link moneyBudget} exists rather than being pretended away.
 */
export const MONEY_SCALE = 6;

/** Fractional digits of persisted share quantities: `Decimal(28,10)`, unchanged. */
export const SHARES_SCALE = 10;

/** Fractional digits of persisted prices and per-share costs: `Decimal(20,8)`, unchanged. */
export const PRICE_SCALE = 8;

/**
 * `ROUND_HALF_UP` — round half away from zero, which is what PostgreSQL `numeric` does.
 *
 * The engine and the database must agree bit for bit about what rounding means, or a value written
 * by one and read back by the other is not the same value. Pinned here so there is one answer.
 */
const ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * A private `Decimal` constructor.
 *
 * `decimal.js` keeps precision and rounding on the constructor, so configuration is global state
 * that any other package in the process could change. Cloning gives the ledger settings nothing
 * else can reach; 50 significant digits is far beyond a thirty-year run's needs and keeps
 * intermediate division from being the binding constraint.
 */
export const Money = Decimal.clone({
  precision: 50,
  rounding: ROUNDING,
  toExpNeg: -30,
  toExpPos: 40,
});

export type MoneyValue = InstanceType<typeof Money>;

/** A `Decimal` from anything the engine holds — a float, a canonical string, another `Decimal`. */
export function decimal(value: number | string | MoneyValue): MoneyValue {
  return new Money(value);
}

/** Quantizes to the money scale. The single rounding step; nothing else rounds money. */
export function quantizeMoney(value: number | string | MoneyValue): MoneyValue {
  return new Money(value).toDecimalPlaces(MONEY_SCALE, ROUNDING);
}

/** Quantizes to the price scale, for per-share costs and execution prices. */
export function quantizePrice(value: number | string | MoneyValue): MoneyValue {
  return new Money(value).toDecimalPlaces(PRICE_SCALE, ROUNDING);
}

/**
 * Quantizes a share quantity **downwards**, always.
 *
 * Rounding direction is a correctness rule here, not a preference: shares are derived by dividing a
 * spend by a price, and rounding the quotient up would make `shares x price` exceed the cash that
 * paid for it. Truncating guarantees `amount <= spend` before any cash check is even reached.
 */
export function quantizeSharesDown(
  value: number | string | MoneyValue,
): MoneyValue {
  return new Money(value).toDecimalPlaces(SHARES_SCALE, Decimal.ROUND_DOWN);
}

/** One unit in the last place of a share quantity; the step a cash-guard retreat takes. */
export const SHARES_ULP: MoneyValue = new Money(10).pow(-SHARES_SCALE);

/** The canonical string for persistence: fixed scale, so `1` and `1.0` are the same value. */
export function moneyString(value: MoneyValue): MoneyString {
  return value.toFixed(MONEY_SCALE);
}

/** The canonical share string, at the shares scale. */
export function sharesString(value: MoneyValue): SharesString {
  return value.toFixed(SHARES_SCALE);
}

/** The canonical price string, at the price scale. */
export function priceString(value: MoneyValue): string {
  return value.toFixed(PRICE_SCALE);
}

/**
 * A canonical value as a JS number, for the places that legitimately want one.
 *
 * Return percentages, drawdowns, alpha and the progress projection are ratios and display
 * quantities: they are not ledger values, they are never reconciled against anything, and carrying
 * them as decimals would cost precision nothing and speed a great deal. Persisted money must never
 * come back through here on its way to the database — that is the round trip {@link MoneyString}
 * exists to prevent.
 */
export function toNumber(value: MoneyValue | MoneyString): number {
  return typeof value === "string" ? Number(value) : value.toNumber();
}

export const MONEY_ZERO: MoneyValue = new Money(0);

/**
 * The cash side of a trade, with the trade's own cost included.
 *
 * V1 charges zero fees, so every one of these is the identity today — which is exactly why they
 * exist as named functions rather than as inline arithmetic. `applyBuy` already folds `fees` into
 * the position's cost total and `applySell` already subtracts them from realized P&L, so half the
 * seam was implemented and half was not: cash moved by the amount alone. A reader adding a fee
 * would see it threaded through the position helpers and reasonably conclude the seam was
 * finished, and the ledger would then disagree with itself — a cost basis that paid a fee, and a
 * cash balance that did not.
 *
 * Fees are **additional** to the amount, matching how `applyBuy` accumulates cost, so a purchase
 * takes `amount + fees` out of cash and the shares have to be sized against what is left after the
 * fee is reserved.
 *
 * Introducing a non-zero fee is still a methodology change: `zero-fees/zero-slippage@1` says what
 * V1 charges, and changing it must bump that version. These make the arithmetic correct when it
 * happens; they do not make it happen.
 */
export function buyCashOutflow(
  amount: MoneyValue,
  fees: MoneyValue,
): MoneyValue {
  return quantizeMoney(amount.plus(fees));
}

/** What an exit puts back into cash: the proceeds, less the cost of placing the trade. */
export function exitCashInflow(
  proceeds: MoneyValue,
  fees: MoneyValue,
): MoneyValue {
  return quantizeMoney(proceeds.minus(fees));
}

/**
 * What may be spent on shares once this trade's own fee is reserved, never below zero.
 *
 * Without the reservation a purchase sized to the whole balance would overdraw by exactly the fee.
 */
export function spendableAfterFees(
  cash: MoneyValue,
  fees: MoneyValue,
): MoneyValue {
  const spendable = cash.minus(fees);
  return spendable.gt(MONEY_ZERO) ? quantizeMoney(spendable) : MONEY_ZERO;
}

/**
 * How far a re-derived quantity may sit from a persisted one, in the *validator's* terms.
 *
 * Identities the ledger computes are exact and are asserted as equalities. This is for the other
 * direction — a reader reconstructing a value from operands at *different* scales, where the
 * arithmetic cannot land on the stored digit exactly:
 *
 * - one unit in the last place of stored money, because the result was quantized;
 * - the stored price scale amplified by the share count, because `shares x price` multiplies a
 *   value known only to 1e-8 by a quantity as large as 2.4e9;
 * - a relative term, because a reader that passes the value through float64 — as the API does —
 *   cannot do better than 2^-53 of its magnitude.
 *
 * Every term is a consequence of a declared scale. None of it is slack chosen to make a case pass.
 */
export function moneyBudget(magnitude: number, shares = 0): number {
  const quantization = Math.pow(10, -MONEY_SCALE);
  const priceTerm = Math.abs(shares) * Math.pow(10, -PRICE_SCALE);
  const floatTerm = Math.abs(magnitude) * Number.EPSILON;
  return quantization + priceTerm + floatTerm;
}
