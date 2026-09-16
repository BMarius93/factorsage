/**
 * The three-valued result of one Strategy predicate on one eligible trading date.
 *
 * `ai/product/strategies.md` defines the states: a predicate is TRUE, FALSE, or NOT_EVALUABLE when
 * the market data, derived data, previous trigger value or position state it needs is unavailable.
 * `NOT_EVALUABLE` never produces a trading signal and is never silently converted to zero.
 *
 * The numeric encoding exists so a whole level can be precomputed into a `Uint8Array` gate; nothing
 * outside this module may depend on the specific numbers.
 */
export const Evaluability = {
  NOT_EVALUABLE: 0,
  FALSE: 1,
  TRUE: 2,
} as const;

export type Evaluability = (typeof Evaluability)[keyof typeof Evaluability];

/**
 * Kleene strong AND with FALSE absorbing.
 *
 * `ai/architecture/strategy-evaluation.md` §2.4: under either strong or strict AND a signal fires
 * only when every part is TRUE, so no trading behaviour differs. Strong AND is chosen for
 * diagnostic honesty — on a day where one Condition is definitively FALSE the signal cannot fire
 * whatever the missing operand was, and reporting NOT_EVALUABLE there would overstate the gap.
 */
export function evaluabilityAnd(
  a: Evaluability,
  b: Evaluability,
): Evaluability {
  if (a === Evaluability.FALSE || b === Evaluability.FALSE) {
    return Evaluability.FALSE;
  }
  if (a === Evaluability.NOT_EVALUABLE || b === Evaluability.NOT_EVALUABLE) {
    return Evaluability.NOT_EVALUABLE;
  }
  return Evaluability.TRUE;
}

/** An empty conjunction is TRUE: a Signal whose only predicate is position-dependent is vacuously true here. */
export function evaluabilityAll(values: Iterable<Evaluability>): Evaluability {
  let result: Evaluability = Evaluability.TRUE;
  for (const value of values) {
    result = evaluabilityAnd(result, value);
    if (result === Evaluability.FALSE) {
      return result;
    }
  }
  return result;
}

/**
 * Kleene strong OR with TRUE absorbing.
 *
 * The mirror of {@link evaluabilityAnd}, and chosen for the same diagnostic honesty: on a day when
 * one FINAL EXIT Exit Rule is definitively TRUE the action occurs whatever the other rules' missing
 * operands would have been, so reporting NOT_EVALUABLE there would understate a decision the data
 * fully supports. When nothing is TRUE and something is undecidable the result stays
 * NOT_EVALUABLE — never a silent FALSE.
 */
export function evaluabilityOr(a: Evaluability, b: Evaluability): Evaluability {
  if (a === Evaluability.TRUE || b === Evaluability.TRUE) {
    return Evaluability.TRUE;
  }
  if (a === Evaluability.NOT_EVALUABLE || b === Evaluability.NOT_EVALUABLE) {
    return Evaluability.NOT_EVALUABLE;
  }
  return Evaluability.FALSE;
}

/** An empty disjunction is FALSE: no alternative matched, because there was none to match. */
export function evaluabilityAny(values: Iterable<Evaluability>): Evaluability {
  let result: Evaluability = Evaluability.FALSE;
  for (const value of values) {
    result = evaluabilityOr(result, value);
    if (result === Evaluability.TRUE) {
      return result;
    }
  }
  return result;
}

export function fromBoolean(value: boolean): Evaluability {
  return value ? Evaluability.TRUE : Evaluability.FALSE;
}
