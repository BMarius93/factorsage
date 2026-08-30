/**
 * Model and blend identities mirror the canonical domain identities. This package deliberately
 * stays dependency-free, so the identities are restated rather than imported; they must not
 * diverge from `INTRINSIC_VALUE_MODELS` / `INTRINSIC_VALUE_BLEND_IDS` in `@intrinsic/domain`.
 */
export const VALUATION_MODELS = [
  "DCF_FCFF",
  "RESIDUAL_INCOME",
  "DDM",
  "GRAHAM",
] as const;
export type ValuationModelId = (typeof VALUATION_MODELS)[number];

export const VALUATION_BLEND_IDS = [
  "BALANCED",
  "CONSERVATIVE",
  "DIVIDEND",
] as const;
export type ValuationBlendId = (typeof VALUATION_BLEND_IDS)[number];

/**
 * Why a model produced no value.
 *
 * Reasons are input/financial oriented and intentionally few, so callers can log or aggregate them
 * without coupling to formula internals. Ordinary inapplicability is never an exception; only
 * programming errors throw.
 */
export const VALUATION_NOT_APPLICABLE_REASONS = [
  "NON_FINITE_INPUT",
  "NON_POSITIVE_SHARES",
  "NON_POSITIVE_FCFF",
  "NON_POSITIVE_BOOK_VALUE",
  "NON_POSITIVE_EQUITY_VALUE",
  "NON_POSITIVE_DIVIDEND",
  "NON_POSITIVE_EPS",
  "NON_POSITIVE_MULTIPLIER",
  "NON_POSITIVE_TERMINAL_SPREAD",
  "NON_POSITIVE_VALUE_PER_SHARE",
  "NON_FINITE_RESULT",
  "MISSING_COMPONENT",
] as const;
export type ValuationNotApplicableReason =
  (typeof VALUATION_NOT_APPLICABLE_REASONS)[number];

/**
 * Explicit result union. A calculated value is always finite; `NaN`/`Infinity` never escape as a
 * result, and absence is never signalled by `null` or a sentinel number.
 */
export type ValuationResult<T> =
  | { status: "CALCULATED"; value: T }
  | { status: "NOT_APPLICABLE"; reason: ValuationNotApplicableReason };

export function calculated<T>(value: T): ValuationResult<T> {
  return { status: "CALCULATED", value };
}

export function notApplicable<T>(
  reason: ValuationNotApplicableReason,
): ValuationResult<T> {
  return { status: "NOT_APPLICABLE", reason };
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
