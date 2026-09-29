import type {
  FinancialStatement,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";

/**
 * When statement-derived daily state has to be re-evaluated on the canonical trading-day axis.
 *
 * Intrinsic values and Fundamental Metrics both change only when newly eligible point-in-time
 * information arrives, and both must change on the same trading day for the same revision. This
 * is the one definition of that day, so the two materializers cannot drift apart on a weekend,
 * a holiday or a pair of revisions landing together.
 */
export type StatementEvaluationRequest = {
  securityId: SecurityId;
  /** Actual trading days for this security. Non-trading days are never invented. */
  tradingDates: readonly LocalDate[];
  statements: readonly FinancialStatement[];
};

/**
 * Ascending, duplicate-free trading dates.
 *
 * Unsorted input is normalized rather than rejected, because ordering carries no information. A
 * duplicated trading date is rejected: it violates the one-row-per-trading-day identity and is a
 * caller/data defect, not a financial outcome. The caller's array is never reordered.
 */
export function normalizeTradingDates(
  tradingDates: readonly LocalDate[],
  purpose: string,
): LocalDate[] {
  const sorted = [...tradingDates].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const [index, date] of sorted.entries()) {
    if (index > 0 && date === sorted[index - 1]) {
      throw new Error(
        `Trading dates must be unique; duplicate ${date} supplied for ${purpose}`,
      );
    }
  }
  return sorted;
}

/** First supplied trading date on or after `date`, or `undefined` when the range ends first. */
export function firstTradingDateOnOrAfter(
  sortedDates: readonly LocalDate[],
  date: LocalDate,
): LocalDate | undefined {
  let low = 0;
  let high = sortedDates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sortedDates[middle] as LocalDate) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return sortedDates[low];
}

/**
 * Trading days on which statement-derived state must be re-evaluated.
 *
 * A result can only change when newly eligible point-in-time information arrives, so the first
 * supplied trading day (which establishes the opening state from everything already eligible) plus
 * the effective day of each later statement revision is sufficient. A revision that becomes
 * available on a weekend, a holiday, or any other non-supplied date takes effect on the first
 * supplied trading day on or after it, and several revisions landing on the same trading day cause
 * a single evaluation.
 *
 * `observedAt` plays no part; a later revision of the same fiscal identity is an event in its own
 * right through its own `availableFromDate`. Which result a statement affects is deliberately not
 * guessed here: every event re-evaluates the caller's whole snapshot. A fiscal period end is never
 * an event — information changes only when a revision becomes eligible.
 */
export function planStatementEvaluationDates(
  request: StatementEvaluationRequest,
  purpose: string,
): LocalDate[] {
  const sortedDates = normalizeTradingDates(request.tradingDates, purpose);
  const first = sortedDates[0];
  const last = sortedDates.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }

  const events = new Set<LocalDate>([first]);
  for (const statement of request.statements) {
    if (statement.securityId !== request.securityId) {
      continue;
    }
    const availableFrom = statement.availableFromDate;
    // Already reflected in the opening evaluation, or beyond the requested range.
    if (availableFrom <= first || availableFrom > last) {
      continue;
    }
    const effective = firstTradingDateOnOrAfter(sortedDates, availableFrom);
    if (effective !== undefined) {
      events.add(effective);
    }
  }
  return [...events].sort((left, right) => left.localeCompare(right));
}
