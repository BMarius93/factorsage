/**
 * Reference Valuation Ratios V1 — a clean-room oracle written from the accepted decisions alone:
 *
 * - `docs/decisions/valuation-ratios-v1.md` — the five formulas, the input rules, and the
 *   price-basis rules 0–8;
 * - `docs/decisions/historical-price-basis-v1.md` §7–§10 — the measured re-base, its undated
 *   interval, the plain-share-change predicate and the basis factor `K`;
 * - `docs/decisions/fundamental-metrics-v1.md` ("Shared point-in-time rules", "Window anchors",
 *   "Free cash flow convention", "Unavailability and numeric safety") and
 *   `docs/decisions/fundamentals-loader.md` ("Revisions and restatements", "Read selection
 *   semantics") — the point-in-time selection the ratios inherit unchanged.
 *
 * Nothing here is imported from, or was written by reading, the product's valuation, price-basis,
 * share-basis or statement-selection code (`docs/data-correctness-audit/README.md`, "Independence
 * rule"; the ESLint block over this directory forbids the imports). Where a decision leaves a
 * detail open, the reading chosen is stated beside the code as **Reading:** so that a difference
 * from the product can be judged against the text rather than against either implementation.
 *
 * Every observation is evaluated from scratch: the statement-level part is a pure function of the
 * set of revisions eligible on the statement date (memoized by that set, never carried between
 * dates), and the session-level part of the session date. Nothing a later session knows reaches
 * an earlier one.
 *
 * Numeric model:
 * - A statement line item is present only as a finite JS number; anything else is missing, never
 *   zero. It is the exact decimal its shortest round-trip text denotes (the figure the provider's
 *   JSON carried). A close, a measured price ratio and a split ratio are the exact decimals their
 *   stored text denotes.
 * - All arithmetic is exact rational arithmetic over `bigint`; no floating-point value takes part
 *   in any decision. A result is reported as its exact rational, with the double nearest to it.
 * - A result with `|value| >= 10^12` is not representable as a calculated-series value
 *   (`DECIMAL(20,8)`, as for Fundamental Metrics) and is unavailable; so is any quantity the
 *   product's doubles could not hold (`|x| > Number.MAX_VALUE`): a window sum, the market
 *   capitalisation or the enterprise value.
 */

// ---------------------------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------------------------

/** An exact rational, always reduced, with a positive denominator. */
export type OracleRational = { readonly n: bigint; readonly d: bigint };

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function oracleRational(n: bigint, d: bigint = 1n): OracleRational {
  if (d === 0n) {
    throw new Error("oracleRational: zero denominator");
  }
  if (n === 0n) {
    return { n: 0n, d: 1n };
  }
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d);
  return { n: (sign * n) / divisor, d: (sign * d) / divisor };
}

const ZERO = oracleRational(0n);
const ONE = oracleRational(1n);

function add(a: OracleRational, b: OracleRational): OracleRational {
  return oracleRational(a.n * b.d + b.n * a.d, a.d * b.d);
}

function subtract(a: OracleRational, b: OracleRational): OracleRational {
  return oracleRational(a.n * b.d - b.n * a.d, a.d * b.d);
}

function multiply(a: OracleRational, b: OracleRational): OracleRational {
  return oracleRational(a.n * b.n, a.d * b.d);
}

function divide(a: OracleRational, b: OracleRational): OracleRational {
  if (b.n === 0n) {
    throw new Error("oracle divide by zero");
  }
  return oracleRational(a.n * b.d, a.d * b.n);
}

function absolute(a: OracleRational): OracleRational {
  return a.n < 0n ? { n: -a.n, d: a.d } : a;
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
export function oracleCompare(a: OracleRational, b: OracleRational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

function positive(a: OracleRational): boolean {
  return a.n > 0n;
}

/** `|a - b| <= tolerance × |reference|`, exactly. */
function within(
  a: OracleRational,
  b: OracleRational,
  tolerance: OracleRational,
  reference: OracleRational,
): boolean {
  return (
    oracleCompare(
      absolute(subtract(a, b)),
      multiply(tolerance, absolute(reference)),
    ) <= 0
  );
}

const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** The exact value of a decimal text (`"12.34000000"`, `"-1.5e-7"`), or `undefined`. */
export function oracleDecimal(text: string): OracleRational | undefined {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, sign, whole = "", fraction = "", exponentText] = match;
  if (whole.length === 0 && fraction.length === 0) {
    return undefined;
  }
  const digits = BigInt(`${whole}${fraction}` || "0");
  const exponent = Number(exponentText ?? "0") - fraction.length;
  const signed = sign === "-" ? -digits : digits;
  return exponent >= 0
    ? oracleRational(signed * 10n ** BigInt(exponent))
    : oracleRational(signed, 10n ** BigInt(-exponent));
}

/**
 * A provider line item: present only as a finite JS number, valued at the decimal its shortest
 * round-trip text denotes. A reported `0` is a real zero; `null`, a string or `NaN` is missing.
 */
export function oracleLineItem(value: unknown): OracleRational | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return oracleDecimal(String(value));
}

/** A stored decimal (a close, a price ratio, a split ratio), as text or as a number. */
function storedDecimal(
  value: string | number | null | undefined,
): OracleRational | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return oracleLineItem(value);
  }
  return oracleDecimal(value);
}

/** The exact value of a double (every finite double is a dyadic rational). */
export function oracleExactDouble(value: number): OracleRational {
  if (!Number.isFinite(value)) {
    throw new Error(`oracleExactDouble: ${value} is not finite`);
  }
  if (value === 0) {
    return ZERO;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  const signed = negative ? -mantissa : mantissa;
  return exponent >= 0
    ? oracleRational(signed << BigInt(exponent))
    : oracleRational(signed, 1n << BigInt(-exponent));
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** The double nearest to an exact rational, ties to even; `±Infinity` beyond the double range. */
export function oracleNearestDouble(value: OracleRational): number {
  if (value.n === 0n) {
    return 0;
  }
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  const d = value.d;
  // Choose e so the integer quotient n / (d · 2^e) has 53 significant bits, or e = -1074 for a
  // subnormal.
  let e = Math.max(bitLength(n) - bitLength(d) - 53, -1074);
  const quotient = (exponent: number): [bigint, bigint, bigint] => {
    const numerator = exponent >= 0 ? n : n << BigInt(-exponent);
    const denominator = exponent >= 0 ? d << BigInt(exponent) : d;
    return [numerator / denominator, numerator % denominator, denominator];
  };
  let [m, remainder, denominator] = quotient(e);
  while (m >= 1n << 53n) {
    e += 1;
    [m, remainder, denominator] = quotient(e);
  }
  while (m < 1n << 52n && e > -1074) {
    e -= 1;
    [m, remainder, denominator] = quotient(e);
  }
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && (m & 1n) === 1n)) {
    m += 1n;
    if (m === 1n << 53n) {
      m = 1n << 52n;
      e += 1;
    }
  }
  if (e > 971) {
    return negative ? -Infinity : Infinity;
  }
  const magnitude = Number(m) * 2 ** e;
  return negative ? -magnitude : magnitude;
}

/** The largest finite double, exactly: (2^53 − 1) · 2^971. */
const LARGEST_DOUBLE = oracleRational(((1n << 53n) - 1n) << 971n);
/** `DECIMAL(20,8)`: a magnitude at or beyond 10^12 cannot be a calculated-series value. */
const STORAGE_LIMIT = oracleRational(10n ** 12n);

function doubleHoldable(value: OracleRational): boolean {
  return oracleCompare(absolute(value), LARGEST_DOUBLE) <= 0;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days since 1970-01-01 of a calendar date, refusing anything that is not a real day. */
function dayNumber(date: string): number {
  if (!CALENDAR_DAY.test(date)) {
    throw new Error(`oracle: ${date} is not a calendar date`);
  }
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`oracle: ${date} is not a real day`);
  }
  return ms / DAY_MS;
}

function instantMs(instant: string): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) {
    throw new Error(`oracle: ${instant} is not an instant`);
  }
  return ms;
}

/** The UTC calendar day an instant falls on, as a day number. */
function instantDay(instant: string): number {
  return Math.floor(instantMs(instant) / DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

export type OracleValuationRatioId =
  | "PRICE_TO_EARNINGS_TTM"
  | "PRICE_TO_SALES_TTM"
  | "PRICE_TO_BOOK"
  | "PRICE_TO_FCF_TTM"
  | "EV_TO_EBITDA_TTM";

type Family = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

type Denominator =
  "NET_INCOME_TTM" | "REVENUE_TTM" | "EQUITY" | "FCF_TTM" | "EBITDA_TTM";

/**
 * The five ratios exactly as the decision's "Definitions" write them, with the statement families
 * its rules say each reads ("The statement families: P/E and P/S read Income; P/B reads Income and
 * Balance Sheet; P/FCF reads Income and Cash Flow; EV/EBITDA reads Income and Balance Sheet").
 * The identities are the stable ones the decision's catalog uses; nothing here reads that catalog.
 */
export const ORACLE_VALUATION_RATIOS: readonly {
  id: OracleValuationRatioId;
  denominator: Denominator;
  families: readonly Family[];
  /** EV/EBITDA adds net debt to the market capitalisation. */
  addsNetDebt: boolean;
}[] = [
  {
    id: "PRICE_TO_EARNINGS_TTM",
    denominator: "NET_INCOME_TTM",
    families: ["INCOME"],
    addsNetDebt: false,
  },
  {
    id: "PRICE_TO_SALES_TTM",
    denominator: "REVENUE_TTM",
    families: ["INCOME"],
    addsNetDebt: false,
  },
  {
    id: "PRICE_TO_BOOK",
    denominator: "EQUITY",
    families: ["INCOME", "BALANCE_SHEET"],
    addsNetDebt: false,
  },
  {
    id: "PRICE_TO_FCF_TTM",
    denominator: "FCF_TTM",
    families: ["INCOME", "CASH_FLOW"],
    addsNetDebt: false,
  },
  {
    id: "EV_TO_EBITDA_TTM",
    denominator: "EBITDA_TTM",
    families: ["INCOME", "BALANCE_SHEET"],
    addsNetDebt: true,
  },
];

export const ORACLE_VALUATION_RATIO_IDS: readonly OracleValuationRatioId[] =
  ORACLE_VALUATION_RATIOS.map((ratio) => ratio.id);

/** One stored statement revision, as the loader keeps it. */
export type OracleValuationStatement = {
  statementType: Family;
  fiscalDate: string;
  fiscalYear: number;
  period: "FY" | "Q1" | "Q2" | "Q3" | "Q4";
  reportedCurrency: string;
  availableFromDate: string;
  observedAt: string;
  contentHash: string;
  values: Readonly<Record<string, unknown>>;
};

/** One measured re-base (`PriceBasisEvent`), as stored. */
export type OracleValuationEvent = {
  kind: "MEASURED" | "UNEXPLAINED";
  effectiveDate?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /** Stored close over new close of the rows before the event; absent when unexplained. */
  priceRatio?: string | number | null;
  detectedAt: string;
};

/** One entry of the provider's split list (`StockSplit`), as stored. */
export type OracleSplitEntry = {
  date: string;
  numerator: string | number;
  denominator: string | number;
  label: string | null;
};

export type OracleValuationSecurity = {
  /** `Security.currency`, the trading currency. */
  currency: string;
  statements: readonly OracleValuationStatement[];
  /** `SecurityPriceBasis.verifiedAt`, or `null` while the history is unverified. */
  verifiedAt: string | null;
  events: readonly OracleValuationEvent[];
  splits: readonly OracleSplitEntry[];
};

/**
 * Why a ratio is unavailable, in the order a primary reason is chosen. Audit-only: the product
 * exposes no reason, and these names are this oracle's.
 */
export const ORACLE_VALUATION_REASONS = [
  /** Rule 0: the stored price history has not been verified. */
  "UNVERIFIED_PRICE_BASIS",
  /** The session has no positive close: there is no market price to value. */
  "INVALID_CLOSE",
  /** No point-in-time Income quarter, or its `weightedAverageShsOutDil` is missing. */
  "MISSING_SHARE_COUNT",
  /** The share count is zero or negative. */
  "NON_POSITIVE_SHARE_COUNT",
  /** A flow window is not exactly four consecutive eligible quarters, or no balance sheet. */
  "INCOMPLETE_WINDOW",
  /** A required line item is missing. */
  "MISSING_INPUT",
  /** A statement read reports no currency or another one than the trading currency. */
  "CURRENCY_MISMATCH",
  /** Net income, revenue, equity, free cash flow or EBITDA is zero or negative. */
  "NON_POSITIVE_DENOMINATOR",
  /** Rule 2: the share count is not at an accepted level. */
  "SHARE_LEVEL_UNSAFE",
  /** Rule 3: the share count was restated by more than 2 % with no measured re-base explaining it. */
  "SHARE_RESTATEMENT_UNEXPLAINED",
  /** Rule 4.1: a non-plain provider entry in history whose statements do not yet cover it. */
  "HISTORICAL_DISTRIBUTION_ENTRY",
  /** Rule 4.2: the share count was observed before a provider entry folded into the history. */
  "COUNT_PREDATES_HISTORICAL_ENTRY",
  /** Rule 5: the share count was observed within 30 days after an event, for a quarter before it. */
  "EVENT_SETTLING",
  /** Rule 6: the basis factor is withheld on this session for this share count. */
  "BASIS_WITHHELD",
  /** Rule 7: on or after a measured non-plain re-base whose statements do not yet cover it. */
  "POST_DISTRIBUTION_STATEMENTS_STALE",
  /** Rule 8: within 30 days from a listed upcoming event not yet measured. */
  "FORWARD_EVENT_UNMEASURED",
  /** The result is not finite or not representable. */
  "UNREPRESENTABLE_RESULT",
] as const;

export type OracleValuationReason = (typeof ORACLE_VALUATION_REASONS)[number];

/** The exact terms of an available reading, for an error bound on the product's doubles. */
export type OracleValuationTerms = {
  close: OracleRational;
  /** The basis factor `K`. */
  basisFactor: OracleRational;
  /** How many measured ratios `K` multiplies together. */
  basisFactorCount: number;
  shares: OracleRational;
  marketCapitalisation: OracleRational;
  /** Net debt for EV/EBITDA; zero for the others. */
  addend: OracleRational;
  denominator: OracleRational;
  /** The sum of the magnitudes of the quarterly values summed into the denominator. */
  denominatorMagnitude: OracleRational;
};

export type OracleValuationOutcome =
  | {
      available: true;
      value: OracleRational;
      double: number;
      terms: OracleValuationTerms;
    }
  | {
      available: false;
      /** The first failing rule in `ORACLE_VALUATION_REASONS` order. */
      reason: OracleValuationReason;
      /** Every rule this observation fails, in that order. */
      failing: readonly OracleValuationReason[];
    };

export type OracleValuationReading = Record<
  OracleValuationRatioId,
  OracleValuationOutcome
>;

// ---------------------------------------------------------------------------------------------
// The plain-share-change predicate (valuation-ratios-v1.md "Corporate-action events";
// historical-price-basis-v1.md "Terminology")
// ---------------------------------------------------------------------------------------------

/** 3:2, 5:4, 4:3, 5:2 and 5:3, either way, besides k:1 and 1:k. */
const PLAIN_FRACTIONS: readonly [bigint, bigint][] = [
  [3n, 2n],
  [5n, 4n],
  [4n, 3n],
  [5n, 2n],
  [5n, 3n],
  [2n, 3n],
  [4n, 5n],
  [3n, 4n],
  [2n, 5n],
  [3n, 5n],
];

/** A provider entry: plain only when labelled `stock-split` with exactly one of the ratios. */
function plainProviderEntry(entry: SplitEntry): boolean {
  if (entry.label !== "stock-split" || entry.ratio === undefined) {
    return false;
  }
  const { n, d } = entry.ratio;
  if (n <= 0n) {
    return false;
  }
  if ((d === 1n && n >= 2n) || (n === 1n && d >= 2n)) {
    return true;
  }
  return PLAIN_FRACTIONS.some(([p, q]) => n === p && d === q);
}

const HALF_PERCENT = oracleRational(5n, 1000n);

/**
 * A measured ratio: plain when within 0.5 % of one of the plain ratios.
 *
 * **Reading:** "within 0.5 %" is measured relative to the plain ratio it is near,
 * `|ρ − p| <= 0.005 · p`.
 */
function plainMeasuredRatio(ratio: OracleRational): boolean {
  if (!positive(ratio)) {
    return false;
  }
  const candidates: OracleRational[] = PLAIN_FRACTIONS.map(([p, q]) =>
    oracleRational(p, q),
  );
  // k:1 for the whole numbers around ρ, and 1:k for those around 1/ρ.
  const integerNear = (value: OracleRational): bigint[] => {
    const floor = value.n / value.d;
    return [floor - 1n, floor, floor + 1n, floor + 2n].filter((k) => k >= 2n);
  };
  for (const k of integerNear(ratio)) {
    candidates.push(oracleRational(k));
  }
  for (const k of integerNear(divide(ONE, ratio))) {
    candidates.push(oracleRational(1n, k));
  }
  return candidates.some((plain) => within(ratio, plain, HALF_PERCENT, plain));
}

// ---------------------------------------------------------------------------------------------
// Normalized inputs
// ---------------------------------------------------------------------------------------------

type Statement = OracleValuationStatement & {
  /** Fiscal identity: `fiscalYear · 4 + quarter`, so adjacency is fiscal, never calendar. */
  quarter: number;
  availableDay: number;
  fiscalDay: number;
  observedMs: number;
  observedDay: number;
};

type SplitEntry = {
  day: number;
  ratio: OracleRational | undefined;
  label: string | null;
};

type MeasuredEvent = {
  kind: "MEASURED";
  /** Earliest calendar day the event's first session can be. */
  earliest: number;
  /** Latest calendar day it can be; `Infinity` for an open interval. */
  latest: number;
  ratio: OracleRational | undefined;
  plain: boolean;
  detectedMs: number;
};

type UnexplainedEvent = {
  kind: "UNEXPLAINED";
  /** First changed session, or `undefined` when the change reaches the earliest compared one. */
  from: number | undefined;
  /** Last changed session; `Infinity` when absent. */
  to: number;
  detectedMs: number;
};

const QUARTER_INDEX: Readonly<Record<string, number>> = {
  Q1: 0,
  Q2: 1,
  Q3: 2,
  Q4: 3,
};

function normalizeStatement(
  statement: OracleValuationStatement,
): Statement | undefined {
  const index = QUARTER_INDEX[statement.period];
  // Rule: standalone quarters only — an FY row never anchors, fills or contributes.
  if (index === undefined) {
    return undefined;
  }
  return {
    ...statement,
    quarter: statement.fiscalYear * 4 + index,
    availableDay: dayNumber(statement.availableFromDate),
    fiscalDay: dayNumber(statement.fiscalDate),
    observedMs: instantMs(statement.observedAt),
    observedDay: instantDay(statement.observedAt),
  };
}

/**
 * The order in which revisions of one fiscal quarter supersede each other: later
 * `availableFromDate`, then later `observedAt`; the later `fiscalDate` only between rows one
 * observation delivered; then the greater `contentHash` (fundamental-metrics-v1.md rule 13,
 * fundamentals-loader.md "Revisions and restatements").
 */
function revisionOrder(a: Statement, b: Statement): number {
  if (a.availableDay !== b.availableDay) {
    return a.availableDay - b.availableDay;
  }
  if (a.observedMs !== b.observedMs) {
    return a.observedMs - b.observedMs;
  }
  if (a.fiscalDay !== b.fiscalDay) {
    return a.fiscalDay - b.fiscalDay;
  }
  return a.contentHash < b.contentHash
    ? -1
    : a.contentHash > b.contentHash
      ? 1
      : 0;
}

function normalizeEvent(
  event: OracleValuationEvent,
): MeasuredEvent | UnexplainedEvent {
  const detectedMs = instantMs(event.detectedAt);
  if (event.kind === "UNEXPLAINED") {
    return {
      kind: "UNEXPLAINED",
      from: event.effectiveFrom ? dayNumber(event.effectiveFrom) : undefined,
      to: event.effectiveTo ? dayNumber(event.effectiveTo) : Infinity,
      detectedMs,
    };
  }
  const ratio = storedDecimal(event.priceRatio);
  // Dated: the first session of the new basis. Undated: after `effectiveFrom`, no later than
  // `effectiveTo` ("The interval's last session is on the new basis"), open when absent.
  const earliest = event.effectiveDate
    ? dayNumber(event.effectiveDate)
    : event.effectiveFrom
      ? dayNumber(event.effectiveFrom) + 1
      : -Infinity;
  const latest = event.effectiveDate
    ? dayNumber(event.effectiveDate)
    : event.effectiveTo
      ? dayNumber(event.effectiveTo)
      : Infinity;
  return {
    kind: "MEASURED",
    earliest,
    latest,
    ratio,
    plain: ratio !== undefined && plainMeasuredRatio(ratio),
    detectedMs,
  };
}

function normalizeSplit(entry: OracleSplitEntry): SplitEntry {
  const numerator = storedDecimal(entry.numerator);
  const denominator = storedDecimal(entry.denominator);
  const ratio =
    numerator !== undefined && denominator !== undefined && denominator.n !== 0n
      ? divide(numerator, denominator)
      : undefined;
  return { day: dayNumber(entry.date), ratio, label: entry.label };
}

// ---------------------------------------------------------------------------------------------
// Statement level: everything decided by the set of revisions eligible on the statement date
// ---------------------------------------------------------------------------------------------

type Book = Record<Family, Map<number, Statement>>;

type RatioInputs = {
  failing: OracleValuationReason[];
  denominator?: OracleRational;
  denominatorMagnitude?: OracleRational;
  addend?: OracleRational;
  /** Per family the ratio reads, the period end of its latest point-in-time quarter. */
  coverage: (number | undefined)[];
};

type StatementLevel = {
  /** `R`: the latest point-in-time Income quarter's representing revision. */
  shareRevision?: Statement;
  shares?: OracleRational;
  /** Statement-level failures every ratio shares (share count and rules 2–5 on `R`). */
  shared: OracleValuationReason[];
  ratios: Record<OracleValuationRatioId, RatioInputs>;
};

const TWENTY_FIVE_PERCENT = oracleRational(1n, 4n);
const TWO_PERCENT = oracleRational(2n, 100n);

function usableCount(
  statement: Statement | undefined,
):
  | { kind: "missing" }
  | { kind: "non-positive" }
  | { kind: "usable"; count: OracleRational } {
  const count = oracleLineItem(statement?.values.weightedAverageShsOutDil);
  if (count === undefined) {
    return { kind: "missing" };
  }
  return positive(count) ? { kind: "usable", count } : { kind: "non-positive" };
}

/**
 * Rule 2, the share level: whether the newest quarter of the walk is accepted.
 *
 * "Walking the point-in-time Income quarters in order, a count within 25 % of the last accepted
 * count is accepted. A count outside it is accepted as a new level only on the third consecutive
 * quarter that agrees with it within 25 %; until then the quarter is withheld, with no fallback.
 * Consecutive means consecutive fiscal quarters, each with a usable count: a missing quarter or
 * count starts the agreement again."
 *
 * **Reading:**
 * - The first usable count of the walk is accepted: there is no earlier level to hold.
 * - "Within 25 %" of a reference `x` is `|c − x| <= 0.25 · x`, inclusive.
 * - Every accepted count becomes the level, so the level follows the counts it accepts.
 * - The agreement is with the count that first left the level ("agrees with it"), and runs only
 *   while consecutive quarters stay outside the level; a quarter accepted inside the level ends
 *   it. The quarter that left counts as the first of the three.
 */
function shareLevelAccepted(incomeQuarters: readonly Statement[]): boolean {
  let level: OracleRational | undefined;
  let candidate: OracleRational | undefined;
  let run = 0;
  let previousQuarter: number | undefined;
  let accepted = false;
  for (const statement of incomeQuarters) {
    const contiguous =
      previousQuarter !== undefined &&
      statement.quarter === previousQuarter + 1;
    previousQuarter = statement.quarter;
    if (!contiguous) {
      candidate = undefined;
      run = 0;
    }
    const count = usableCount(statement);
    if (count.kind !== "usable") {
      candidate = undefined;
      run = 0;
      accepted = false;
      continue;
    }
    const c = count.count;
    if (level === undefined || within(c, level, TWENTY_FIVE_PERCENT, level)) {
      level = c;
      candidate = undefined;
      run = 0;
      accepted = true;
      continue;
    }
    if (
      candidate !== undefined &&
      within(c, candidate, TWENTY_FIVE_PERCENT, candidate)
    ) {
      run += 1;
    } else {
      candidate = c;
      run = 1;
    }
    if (run >= 3) {
      level = c;
      candidate = undefined;
      run = 0;
      accepted = true;
    } else {
      accepted = false;
    }
  }
  return accepted;
}

/**
 * Rule 3: whether `R`'s count is an unexplained restatement of the previous revision of its quarter.
 *
 * **Reading:**
 * - The previous revision is the one `R` superseded in the revision order. Rule 3 applies only when
 *   both carry a usable count; "differs by more than 2 %" is `|c_R − c_P| > 0.02 · c_P`.
 * - A measured re-base explains it when `|(c_R / c_P) − ρ| <= 0.02 · ρ`, it is new to the previous
 *   revision (detected after `P.observedAt`, or dated after `P`'s observation day), it is dated less
 *   than 30 days before `P`'s observation day, and it was detected no later than `R.observedAt`.
 *   An undated re-base is dated at the latest date it may have, for every date condition here.
 */
function restatementUnexplained(
  revision: Statement,
  previous: Statement | undefined,
  events: readonly MeasuredEvent[],
): boolean {
  if (previous === undefined) {
    return false;
  }
  const current = usableCount(revision);
  const prior = usableCount(previous);
  if (current.kind !== "usable" || prior.kind !== "usable") {
    return false;
  }
  if (within(current.count, prior.count, TWO_PERCENT, prior.count)) {
    return false;
  }
  const restated = divide(current.count, prior.count);
  return !events.some((event) => {
    if (event.ratio === undefined || !positive(event.ratio)) {
      return false;
    }
    const newToPrevious =
      event.detectedMs > previous.observedMs ||
      event.latest > previous.observedDay;
    const recentEnough = event.latest > previous.observedDay - 30;
    const knownByRevision = event.detectedMs <= revision.observedMs;
    return (
      within(restated, event.ratio, TWO_PERCENT, event.ratio) &&
      newToPrevious &&
      recentEnough &&
      knownByRevision
    );
  });
}

/** The exact sum of one field over the four window quarters, or why it cannot be formed. */
type WindowSum =
  | { ok: true; sum: OracleRational; magnitude: OracleRational }
  | { ok: false; reason: OracleValuationReason };

/**
 * A family's window: exactly the four consecutive quarters ending at its latest point-in-time
 * quarter, never an older complete one (fundamental-metrics-v1.md rules 4 and 11).
 */
function familyWindow(
  quarters: Map<number, Statement>,
): Statement[] | undefined {
  if (quarters.size === 0) {
    return undefined;
  }
  const latest = Math.max(...quarters.keys());
  const window: Statement[] = [];
  for (let quarter = latest - 3; quarter <= latest; quarter += 1) {
    const statement = quarters.get(quarter);
    if (statement === undefined) {
      return undefined;
    }
    window.push(statement);
  }
  return window;
}

function latestQuarter(
  quarters: Map<number, Statement>,
): Statement | undefined {
  if (quarters.size === 0) {
    return undefined;
  }
  return quarters.get(Math.max(...quarters.keys()));
}

function sumOver(
  window: readonly Statement[],
  perQuarter: (statement: Statement) => OracleRational | undefined,
): WindowSum {
  let sum = ZERO;
  let magnitude = ZERO;
  for (const statement of window) {
    const value = perQuarter(statement);
    if (value === undefined) {
      return { ok: false, reason: "MISSING_INPUT" };
    }
    sum = add(sum, value);
    magnitude = add(magnitude, absolute(value));
  }
  return { ok: true, sum, magnitude };
}

function field(
  name: string,
): (statement: Statement) => OracleRational | undefined {
  return (statement) => oracleLineItem(statement.values[name]);
}

/** FCF_q = operatingCashFlow_q + capitalExpenditure_q; both required; never `freeCashFlow`. */
function freeCashFlow(statement: Statement): OracleRational | undefined {
  const operating = oracleLineItem(statement.values.operatingCashFlow);
  const capital = oracleLineItem(statement.values.capitalExpenditure);
  return operating === undefined || capital === undefined
    ? undefined
    : add(operating, capital);
}

/** Every statement read (that exists: a missing one is reported as missing) is in `currency`. */
function inTradingCurrency(
  statements: readonly (Statement | undefined)[],
  currency: string,
): boolean {
  return statements.every(
    (statement) =>
      statement === undefined ||
      (statement.reportedCurrency.length > 0 &&
        statement.reportedCurrency === currency),
  );
}

function ratioInputs(
  ratio: (typeof ORACLE_VALUATION_RATIOS)[number],
  book: Book,
  shareRevision: Statement | undefined,
  currency: string,
): RatioInputs {
  const failing: OracleValuationReason[] = [];
  const coverage = ratio.families.map(
    (family) => latestQuarter(book[family])?.fiscalDay,
  );
  // The statements this ratio reads, for the currency rule.
  const read: (Statement | undefined)[] = [shareRevision];
  let sum: WindowSum;
  let addend: OracleRational | undefined;
  if (ratio.denominator === "EQUITY" || ratio.addsNetDebt) {
    const sheet = latestQuarter(book.BALANCE_SHEET);
    read.push(sheet);
    if (sheet === undefined) {
      failing.push("INCOMPLETE_WINDOW");
    } else if (ratio.addsNetDebt) {
      addend = oracleLineItem(sheet.values.netDebt);
      if (addend === undefined) {
        failing.push("MISSING_INPUT");
      }
    }
  }
  if (ratio.denominator === "EQUITY") {
    const sheet = latestQuarter(book.BALANCE_SHEET);
    const equity =
      sheet === undefined
        ? undefined
        : oracleLineItem(sheet.values.totalStockholdersEquity);
    sum =
      sheet === undefined
        ? { ok: false, reason: "INCOMPLETE_WINDOW" }
        : equity === undefined
          ? { ok: false, reason: "MISSING_INPUT" }
          : { ok: true, sum: equity, magnitude: absolute(equity) };
  } else {
    const family: Family =
      ratio.denominator === "FCF_TTM" ? "CASH_FLOW" : "INCOME";
    const window = familyWindow(book[family]);
    if (window === undefined) {
      sum = { ok: false, reason: "INCOMPLETE_WINDOW" };
    } else {
      read.push(...window);
      sum = sumOver(
        window,
        ratio.denominator === "NET_INCOME_TTM"
          ? field("netIncome")
          : ratio.denominator === "REVENUE_TTM"
            ? field("revenue")
            : ratio.denominator === "EBITDA_TTM"
              ? field("ebitda")
              : freeCashFlow,
      );
    }
  }
  if (!sum.ok) {
    failing.push(sum.reason);
  }
  if (!inTradingCurrency(read, currency)) {
    failing.push("CURRENCY_MISMATCH");
  }
  if (sum.ok && !positive(sum.sum)) {
    failing.push("NON_POSITIVE_DENOMINATOR");
  }
  if (
    (sum.ok && (!doubleHoldable(sum.sum) || !doubleHoldable(sum.magnitude))) ||
    (addend !== undefined && !doubleHoldable(addend))
  ) {
    failing.push("UNREPRESENTABLE_RESULT");
  }
  return {
    failing,
    coverage,
    ...(sum.ok
      ? { denominator: sum.sum, denominatorMagnitude: sum.magnitude }
      : {}),
    ...(addend !== undefined ? { addend } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------

export type OracleValuationOracle = {
  /**
   * The five readings on `session` at `close` (its exact stored text, or a number).
   *
   * `statementDate` is the date whose statements the observation reads when it is not the
   * session's own: a Monitor's provisional observation reads the newest closed session's
   * ("The Monitor evaluates its provisional observation with the live quote as the close and the
   * inputs of the newest closed session"). Every price-basis rule that names a session — the basis
   * factor (6), the window after a distribution (7) and a listed upcoming event (8) — is read on
   * `session` itself.
   */
  reading(
    session: string,
    close: string | number,
    options?: { statementDate?: string },
  ): OracleValuationReading;
};

export function createValuationOracle(
  security: OracleValuationSecurity,
): OracleValuationOracle {
  const statements = security.statements
    .map(normalizeStatement)
    .filter((statement): statement is Statement => statement !== undefined)
    .sort((a, b) => a.availableDay - b.availableDay);
  const availableDays = statements.map((statement) => statement.availableDay);
  const events = security.events.map(normalizeEvent);
  const measured = events.filter(
    (event): event is MeasuredEvent => event.kind === "MEASURED",
  );
  const unexplained = events.filter(
    (event): event is UnexplainedEvent => event.kind === "UNEXPLAINED",
  );
  const splits = security.splits.map(normalizeSplit);
  const verifiedDay =
    security.verifiedAt === null ? undefined : instantDay(security.verifiedAt);

  /**
   * "Not superseded by a measured re-base within seven calendar days" (rules 4 and 8).
   *
   * **Reading:** an undated re-base is within seven days when any day it may lie on is.
   */
  const matched = (entry: SplitEntry): boolean =>
    measured.some(
      (event) =>
        event.earliest <= entry.day + 7 && event.latest >= entry.day - 7,
    );
  // Rule 4: entries dated on or before `verifiedAt`; rule 8: after it.
  const history =
    verifiedDay === undefined
      ? []
      : splits.filter((entry) => entry.day <= verifiedDay && !matched(entry));
  const forward =
    verifiedDay === undefined
      ? []
      : splits.filter((entry) => entry.day > verifiedDay && !matched(entry));
  // Rule 7: measured re-bases that may have been distributions.
  const distributions = measured.filter((event) => !event.plain);

  const statementLevelMemo = new Map<number, StatementLevel>();

  function statementLevel(statementDay: number): StatementLevel {
    // The eligible set is every revision with availableFromDate <= statementDay.
    let low = 0;
    let high = availableDays.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((availableDays[middle] as number) <= statementDay) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const eligibleCount = low;
    const memoized = statementLevelMemo.get(eligibleCount);
    if (memoized !== undefined) {
      return memoized;
    }
    const level = computeStatementLevel(statements.slice(0, eligibleCount));
    statementLevelMemo.set(eligibleCount, level);
    return level;
  }

  function computeStatementLevel(
    eligible: readonly Statement[],
  ): StatementLevel {
    const book: Book = {
      INCOME: new Map(),
      BALANCE_SHEET: new Map(),
      CASH_FLOW: new Map(),
    };
    /** Every eligible revision of each Income quarter, in revision order, for rule 3. */
    const incomeRevisions = new Map<number, Statement[]>();
    for (const statement of eligible) {
      const quarters = book[statement.statementType];
      const held = quarters.get(statement.quarter);
      if (held === undefined || revisionOrder(statement, held) > 0) {
        quarters.set(statement.quarter, statement);
      }
      if (statement.statementType === "INCOME") {
        const list = incomeRevisions.get(statement.quarter) ?? [];
        list.push(statement);
        incomeRevisions.set(statement.quarter, list);
      }
    }
    const shared: OracleValuationReason[] = [];
    const shareRevision = latestQuarter(book.INCOME);
    const count = usableCount(shareRevision);
    if (shareRevision === undefined || count.kind === "missing") {
      shared.push("MISSING_SHARE_COUNT");
    } else if (count.kind === "non-positive") {
      shared.push("NON_POSITIVE_SHARE_COUNT");
    }
    if (shareRevision !== undefined) {
      const walk = [...book.INCOME.values()].sort(
        (a, b) => a.quarter - b.quarter,
      );
      // Rule 2.
      if (count.kind === "usable" && !shareLevelAccepted(walk)) {
        shared.push("SHARE_LEVEL_UNSAFE");
      }
      // Rule 3.
      const revisions = [
        ...(incomeRevisions.get(shareRevision.quarter) ?? []),
      ].sort(revisionOrder);
      const position = revisions.indexOf(shareRevision);
      const previous = position > 0 ? revisions[position - 1] : undefined;
      if (restatementUnexplained(shareRevision, previous, measured)) {
        shared.push("SHARE_RESTATEMENT_UNEXPLAINED");
      }
    }
    const ratios = {} as Record<OracleValuationRatioId, RatioInputs>;
    for (const ratio of ORACLE_VALUATION_RATIOS) {
      const inputs = ratioInputs(ratio, book, shareRevision, security.currency);
      if (shareRevision !== undefined) {
        // Rule 4.1: a non-plain history entry at E holds until every family the ratio reads has
        // a latest quarter whose period ends on or after E.
        const uncovered = history.some(
          (entry) =>
            !plainProviderEntry(entry) &&
            inputs.coverage.some(
              (periodEnd) => periodEnd === undefined || periodEnd < entry.day,
            ),
        );
        if (uncovered) {
          inputs.failing.push("HISTORICAL_DISTRIBUTION_ENTRY");
        }
        // Rule 4.2: any history entry at E with R.observedAt < E.
        if (history.some((entry) => shareRevision.observedDay < entry.day)) {
          inputs.failing.push("COUNT_PREDATES_HISTORICAL_ENTRY");
        }
        // Rule 5: E <= R.observedAt < E + 30 days and R's quarter ended before E, for any event:
        // a provider entry or a measured re-base.
        //
        // **Reading:** every provider entry (history or forward, matched or not) and every
        // measured re-base is an event; an undated one fires when any day it may lie on does.
        const observed = shareRevision.observedDay;
        const fiscal = shareRevision.fiscalDay;
        const settling =
          splits.some(
            (entry) =>
              entry.day <= observed &&
              observed < entry.day + 30 &&
              fiscal < entry.day,
          ) ||
          measured.some((event) => {
            const from = Math.max(event.earliest, observed - 29, fiscal + 1);
            const to = Math.min(event.latest, observed);
            return from <= to;
          });
        if (settling) {
          inputs.failing.push("EVENT_SETTLING");
        }
      }
      ratios[ratio.id] = inputs;
    }
    return {
      ...(shareRevision !== undefined ? { shareRevision } : {}),
      ...(count.kind === "usable" ? { shares: count.count } : {}),
      shared,
      ratios,
    };
  }

  /**
   * Rule 6, the basis factor `K(t, R)` of historical-price-basis-v1.md §10, or `undefined` where
   * it is withheld.
   *
   * For each measured re-base, by when `R` was observed:
   * - before the event, and before its detection: a session before the event takes its ratio; a
   *   session on or after it, or inside its undated interval, is withheld;
   * - on or after the event's date (any date it may have, when undated) and before its detection:
   *   withheld;
   * - at or after its detection: nothing on or after the event; before it, or inside its interval,
   *   nothing for a plain share change and withheld for any other.
   *
   * For an unexplained change, for a revision observed before its detection: a bounded change
   * withholds the sessions it changed, and one that reaches the earliest compared session withholds
   * every session.
   *
   * **Reading:** "observed before the event" compares `R`'s observation day with the event's first
   * session; "before its detection" is `observedAt < detectedAt`, so a revision observed at the
   * detection instant is after it (rule 3 likewise counts a re-base detected at `R.observedAt` as
   * known to `R`).
   *
   * **Reading (revised during the audit, before the first differential run):** an unexplained change
   * withholds nothing for a revision observed at or after its detection. §10 frames every clause
   * "by when R was observed", §13 says an unbounded change withholds "everything for older
   * revisions", the schema says the units "of anything observed before it cannot be restored", and a
   * revision observed after the replacement is on the replaced history's basis, which is all `K`
   * restores. The first draft withheld a bounded change's sessions for every revision, which reads
   * the bounded clause outside that frame; see the audit report's interpretation log.
   */
  function basisFactor(
    sessionDay: number,
    revision: Statement,
  ): { factor: OracleRational; count: number } | undefined {
    let factor = ONE;
    let count = 0;
    for (const event of measured) {
      const beforeDetection = revision.observedMs < event.detectedMs;
      if (beforeDetection) {
        if (revision.observedDay < event.earliest) {
          if (sessionDay < event.earliest) {
            if (event.ratio === undefined || !positive(event.ratio)) {
              return undefined;
            }
            factor = multiply(factor, event.ratio);
            count += 1;
          } else {
            return undefined;
          }
        } else {
          return undefined;
        }
      } else if (sessionDay < event.latest && !event.plain) {
        return undefined;
      }
    }
    for (const event of unexplained) {
      if (revision.observedMs >= event.detectedMs) {
        continue;
      }
      if (
        event.from === undefined ||
        (sessionDay >= event.from && sessionDay <= event.to)
      ) {
        return undefined;
      }
    }
    return { factor, count };
  }

  function reading(
    session: string,
    close: string | number,
    options?: { statementDate?: string },
  ): OracleValuationReading {
    const sessionDay = dayNumber(session);
    const statementDay = dayNumber(options?.statementDate ?? session);
    const closeValue = storedDecimal(close);
    const result = {} as OracleValuationReading;
    const level = statementLevel(statementDay);
    const revision = level.shareRevision;
    const basis =
      revision === undefined ? undefined : basisFactor(sessionDay, revision);
    const forwardHeld = forward.some(
      (entry) => sessionDay >= entry.day && sessionDay <= entry.day + 30,
    );
    for (const ratio of ORACLE_VALUATION_RATIOS) {
      const inputs = level.ratios[ratio.id];
      const failing = new Set<OracleValuationReason>([
        ...level.shared,
        ...inputs.failing,
      ]);
      if (verifiedDay === undefined) {
        failing.add("UNVERIFIED_PRICE_BASIS");
      }
      if (closeValue === undefined || !positive(closeValue)) {
        failing.add("INVALID_CLOSE");
      }
      if (revision !== undefined && basis === undefined) {
        failing.add("BASIS_WITHHELD");
      }
      // Rule 7: on or after a measured non-plain re-base, until the statements cover it.
      //
      // **Reading:** an undated re-base holds from the earliest session it may be and needs
      // statements covering the latest date it may have.
      if (
        distributions.some(
          (event) =>
            sessionDay >= event.earliest &&
            inputs.coverage.some(
              (periodEnd) =>
                periodEnd === undefined || periodEnd < event.latest,
            ),
        )
      ) {
        failing.add("POST_DISTRIBUTION_STATEMENTS_STALE");
      }
      // Rule 8: from a listed upcoming event's date through the next 30 calendar days.
      if (forwardHeld) {
        failing.add("FORWARD_EVENT_UNMEASURED");
      }
      let outcome: OracleValuationOutcome | undefined;
      if (
        failing.size === 0 &&
        closeValue !== undefined &&
        level.shares !== undefined &&
        basis !== undefined &&
        inputs.denominator !== undefined &&
        inputs.denominatorMagnitude !== undefined
      ) {
        const marketCapitalisation = multiply(
          multiply(closeValue, basis.factor),
          level.shares,
        );
        const addend = inputs.addend ?? ZERO;
        const numerator = add(marketCapitalisation, addend);
        const value = divide(numerator, inputs.denominator);
        if (
          !doubleHoldable(marketCapitalisation) ||
          !doubleHoldable(numerator) ||
          oracleCompare(absolute(value), STORAGE_LIMIT) >= 0
        ) {
          failing.add("UNREPRESENTABLE_RESULT");
        } else {
          outcome = {
            available: true,
            value,
            double: oracleNearestDouble(value),
            terms: {
              close: closeValue,
              basisFactor: basis.factor,
              basisFactorCount: basis.count,
              shares: level.shares,
              marketCapitalisation,
              addend,
              denominator: inputs.denominator,
              denominatorMagnitude: inputs.denominatorMagnitude,
            },
          };
        }
      }
      if (outcome === undefined) {
        const ordered = ORACLE_VALUATION_REASONS.filter((reason) =>
          failing.has(reason),
        );
        outcome = {
          available: false,
          reason: ordered[0] ?? "MISSING_SHARE_COUNT",
          failing: ordered,
        };
      }
      result[ratio.id] = outcome;
    }
    return result;
  }

  return { reading };
}
