import { Decimal } from "decimal.js";

/**
 * The alternative-data metrics, written from the product decision alone.
 *
 * `docs/alternative-data-signals.md` and `AGENTS.md` invariant 23 are the specification. The whole
 * slice turns on one sentence — *a lookback is measured in trading sessions on the session a
 * disclosure became observable* — and this file is what checks the engine actually does that, by
 * deriving every column a second way: it places each disclosure on a session by scanning the axis,
 * then re-reduces the explicit window at every index. The engine keeps two monotone pointers and
 * incrementally maintains a per-actor multiset across one traversal. Those are different algorithms,
 * which is the point: a pointer that leaves the window one session late, or an actor count that
 * fails to drop to zero, is invisible to an oracle that slides the same way.
 *
 * ## Availability, in two steps that must not be collapsed
 *
 * 1. `availableFrom = publicationDate + 1 calendar day`. The provider gives a filing or disclosure
 *    *date* and no time, so nothing proves the document was public before that session's close. It
 *    is the same convention `statementPublicAvailabilityDate` applies to a financial statement.
 * 2. The **observable session** is the first session on the security's own date axis at or after
 *    that date. That is what makes a Saturday filing, a Thanksgiving filing and a filing on a day
 *    the security was halted all land on the next session the security actually traded — without
 *    this file knowing a holiday calendar, which it deliberately does not.
 *
 * A disclosure whose observable session is before the frame's first date belongs to a window this
 * frame does not contain and is dropped, never pulled forward onto index 0: counting it there would
 * place it inside windows it was never in.
 *
 * ## Coverage, and why absence is not zero
 *
 * A session reports a number only when its **whole** window lies inside ingested coverage. Outside
 * it the column is absent. "The provider had no filing" and "the dataset does not reach that far"
 * are indistinguishable from the payload, so reporting the second as the first would make
 * `Insider sellers 20D is at most 0` true across every year the data does not reach. A partially
 * covered window is refused for the same reason a half-warmed moving average is.
 */

/** One normalized disclosure, reduced to what an aggregation reads. */
export type OracleObservation = {
  /** The availability date: publication + 1 day. Never the transaction or report date. */
  availableFrom: string;
  /** Stable actor identity — a reporting CIK, a canonical actor id. Never a display name. */
  actorKey: string;
  /** The amount a value measure adds. `null` where the source states none. */
  amount: number | null;
};

export type OracleAggregation = "DISTINCT_ACTORS" | "EVENT_COUNT" | "SUM_AMOUNT";

export type OracleCoverage = { from: string; to: string } | null;

/** `publicationDate + 1 calendar day`, in UTC, with no knowledge of sessions. */
export function oracleAvailabilityDate(publicationDate: string): string {
  const [year, month, day] = publicationDate
    .split("-")
    .map((part) => Number(part));
  const next = new Date(
    Date.UTC(year as number, (month as number) - 1, (day as number) + 1),
  );
  return next.toISOString().slice(0, 10);
}

/**
 * The index of the first session at or after `date`, or -1 when the axis ends before it.
 *
 * A forward scan rather than a binary search, again deliberately: the engine binary-searches, and a
 * boundary error in a binary search is exactly the kind of thing a second binary search reproduces.
 */
export function oracleObservableSession(
  dates: readonly string[],
  date: string,
): number {
  for (let index = 0; index < dates.length; index += 1) {
    if ((dates[index] as string) >= date) {
      return index;
    }
  }
  return -1;
}

/**
 * The column one configured alternative-data metric reads, aligned with `dates`.
 *
 * `null` is absence and is never a substitute for zero. It is produced in exactly three situations:
 * no coverage at all; a window that is not wholly inside coverage; and a window the frame does not
 * physically contain, which is the first `lookback - 1` sessions of any frame.
 */
export function oracleAlternativeDataColumn(input: {
  dates: readonly string[];
  lookback: number;
  aggregation: OracleAggregation;
  coverage: OracleCoverage;
  observations: readonly OracleObservation[];
}): (Decimal | null)[] {
  const { dates, lookback, aggregation, coverage, observations } = input;
  const column: (Decimal | null)[] = dates.map(() => null);
  if (!coverage || dates.length === 0 || lookback < 1) {
    return column;
  }

  // Each disclosure is placed on the session a reader could first have acted on it. One that became
  // observable after the axis ends has no session here; one that became observable before the axis
  // begins belongs to a session the axis does not hold.
  const placed: { index: number; observation: OracleObservation }[] = [];
  for (const observation of observations) {
    const index = oracleObservableSession(dates, observation.availableFrom);
    if (index === -1) {
      continue;
    }
    if (observation.availableFrom < (dates[0] as string)) {
      continue;
    }
    placed.push({ index, observation });
  }

  for (let index = 0; index < dates.length; index += 1) {
    const windowStart = index - lookback + 1;
    if (windowStart < 0) {
      continue;
    }
    const date = dates[index] as string;
    const windowStartDate = dates[windowStart] as string;
    if (date > coverage.to || windowStartDate < coverage.from) {
      continue;
    }
    // The explicit window, re-derived at every index from the whole placement list.
    const inWindow = placed
      .filter((entry) => entry.index >= windowStart && entry.index <= index)
      .map((entry) => entry.observation);

    switch (aggregation) {
      case "DISTINCT_ACTORS":
        column[index] = new Decimal(
          new Set(inWindow.map((entry) => entry.actorKey)).size,
        );
        break;
      case "EVENT_COUNT":
        column[index] = new Decimal(inWindow.length);
        break;
      case "SUM_AMOUNT":
        column[index] = inWindow.reduce(
          (sum, entry) =>
            entry.amount === null || !Number.isFinite(entry.amount)
              ? sum
              : sum.plus(new Decimal(entry.amount)),
          new Decimal(0),
        );
        break;
    }
  }
  return column;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What one Form 4 line was, from the SEC transaction code alone.
 *
 * Only `P` and `S` are discretionary open-market trades. An award, a gift, an option exercise or a
 * withholding is not a decision to buy or sell at the market price, and counting one as a purchase
 * is the single most common way an insider signal is made meaningless. Every other code — including
 * every code the SEC may add — is `OTHER`, because a category this product invented must never be
 * mistaken for a statement the filing made.
 */
export function oracleInsiderCategory(providerTransactionType: string): string {
  const code = /^([A-Z])(?:-|$)/.exec(providerTransactionType.trim().toUpperCase())?.[1];
  switch (code) {
    case "P":
      return "OPEN_MARKET_PURCHASE";
    case "S":
      return "OPEN_MARKET_SALE";
    case "A":
      return "AWARD";
    case "G":
      return "GIFT";
    case "M":
    case "X":
      return "OPTION_EXERCISE";
    case "C":
      return "CONVERSION";
    case "D":
    case "F":
      return "DISPOSITION_TO_ISSUER";
    default:
      return "OTHER";
  }
}

/**
 * The transacted value of one Form 4 line, or `null` when the filing does not state both factors.
 *
 * A zero or absent price is **not** a $0 trade: it is an award, a gift or an exercise whose price
 * the form does not state. Reporting `0` would make a purchase-value metric read as a real, tiny
 * purchase, and would drag a `is at least $X` rule's denominator nowhere while quietly adding rows.
 */
export function oracleInsiderTransactionValue(input: {
  securitiesTransacted: number | null;
  price: number | null;
}): Decimal | null {
  const { securitiesTransacted, price } = input;
  if (
    securitiesTransacted === null ||
    price === null ||
    !Number.isFinite(securitiesTransacted) ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }
  return new Decimal(Math.abs(securitiesTransacted)).times(new Decimal(price));
}

/**
 * The bounds of a disclosed amount band. No midpoint is ever produced.
 *
 * The filings write `"$1,001 - $15,000"`, `"Over $50,000,000"`, `"$50,000,001 +"` and occasionally a
 * bare figure. A band with no readable number has no bounds at all rather than bounds of zero, so an
 * unparsed band can never read as a $0 trade.
 */
export function oracleDisclosedAmount(raw: string | null): {
  lower: number | null;
  upper: number | null;
} {
  const text = (raw ?? "").trim();
  const numbers = [...text.matchAll(/\$?\s*([\d][\d,]*(?:\.\d+)?)/g)]
    .map((match) => Number((match[1] ?? "").replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return { lower: null, upper: null };
  }
  const openEnded =
    /over|more than|\+|and\s+(?:over|above)|or\s+more/i.test(text) ||
    numbers.length === 1;
  if (openEnded) {
    return { lower: numbers[0] as number, upper: null };
  }
  const [first, second] = numbers as [number, number];
  return { lower: Math.min(first, second), upper: Math.max(first, second) };
}

/** Whether a normalized disclosure may feed a V1 metric: exactly common stock. */
export function oracleCongressEligible(assetClass: string): boolean {
  return assetClass === "STOCK";
}

/** The transaction kind a disclosure's provider `type` states. */
export function oracleCongressKind(providerType: string): string {
  const text = providerType.trim().toLowerCase();
  if (text.startsWith("purchase")) {
    return "PURCHASE";
  }
  if (text.startsWith("sale") || text.startsWith("sell")) {
    return "SALE";
  }
  if (text.startsWith("exchange")) {
    return "EXCHANGE";
  }
  return "OTHER";
}
