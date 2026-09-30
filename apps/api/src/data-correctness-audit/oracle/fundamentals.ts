/**
 * Reference Fundamental Metrics V1, written from `docs/decisions/fundamental-metrics-v1.md` alone.
 *
 * Nothing here is imported from, or was written by reading, the product's fundamentals code: an
 * oracle that shared the engine's reasoning would agree with every bug it exists to find
 * (`docs/data-correctness-audit/README.md`, "Independence rule"). Revision semantics come from
 * `docs/decisions/fundamentals-loader.md` ("Revisions and restatements", "Read selection
 * semantics") and the exact-quarter TTM semantics from `docs/decisions/intrinsic-value-engine.md`,
 * the two decisions the ADR builds on without reinterpreting.
 *
 * One observation — one security on calendar date `date` — is decided in this order, and an
 * unavailable metric reports the first rule that failed (`ORACLE_FUNDAMENTAL_UNAVAILABLE_REASONS`):
 *
 * 1. **Point in time** (ADR "Shared point-in-time rules" 1-4, 10 and 13). A revision is visible
 *    only when `availableFromDate <= date`; the date the loader assigned is never second-guessed.
 *    Only standalone `Q1`-`Q4` rows are read: an `FY` row never anchors, fills or contributes to a
 *    window, a balance-sheet state or a currency check. Each fiscal quarter — statement type,
 *    fiscal year, period — is represented by exactly one revision, the latest by
 *    `availableFromDate`, then `observedAt`, then (between rows one observation delivered) the
 *    later `fiscalDate`, then the greater `contentHash`. A moved period end is therefore the same
 *    quarter again, never a second one, whichever way it moved.
 * 2. **Windows** ("Window anchors"). Quarters are ordered by fiscal identity,
 *    `fiscalYear * 4 + quarter`, never by calendar position, so Q4 of fiscal year N is followed by
 *    Q1 of N + 1 under any fiscal calendar (rule 9). "Latest" is the greatest fiscal identity a
 *    family holds. A window is anchored there and is never moved to an older complete one (rule 11).
 * 3. **Currency** (rule 12), across every statement the observation reads.
 * 4. **Line items** (rule 6 and each formula's required fields).
 * 5. **Doubles**: a flow sum or a balance-sheet sum/average must be one the product's doubles can
 *    hold.
 * 6. **Sign rules**, in the order each formula lists its `require` lines.
 * 7. **Storage range** ("Unavailability and numeric safety").
 *
 * Numeric model — the audit's decisions where the ADR leaves arithmetic implicit:
 *
 * - A line item is present only as a finite JS number; `undefined`, `null`, `NaN`, `±Infinity`,
 *   strings and anything else are missing, never zero. A reported `0` is a real zero.
 * - A line item is the exact decimal its shortest round-trip text (`String(value)`) denotes — the
 *   figure the provider's JSON carried — so `0.1` is exactly 1/10. Every operation is exact
 *   rational arithmetic over `bigint`, and no floating-point value takes part in any decision. The
 *   ROIC tax rate is exactly 21/100.
 * - A result is reported as its exact rational and as the double nearest to it (ties to even);
 *   zero is always `0`, never `-0`.
 * - `|exact| >= 10^12` does not fit `DECIMAL(20,8)`: the metric is unavailable, never clamped.
 * - The product computes in doubles, so a sum or average whose exact magnitude exceeds
 *   `Number.MAX_VALUE` would be non-finite there: that metric is unavailable.
 *
 * Every call is evaluated from scratch. Nothing is carried between dates, so a later revision that
 * invalidates an input simply yields a different answer from its `availableFromDate` on (rule 7).
 */

// ---------------------------------------------------------------------------------------------
// Catalog and public shapes
// ---------------------------------------------------------------------------------------------

/**
 * The fifteen metrics, in the order of the ADR's Scope table, with its storage field and product
 * unit. The identities are the ones `fundamental-metrics-storage-and-evaluation.md` names
 * ("Fundamental metric identity"). Percent metrics are in percentage points (ADR "Units").
 */
export const ORACLE_FUNDAMENTAL_METRICS = [
  {
    id: "REVENUE_GROWTH_TTM_YOY",
    column: "revenueGrowthTtmYoy",
    unit: "PERCENT",
  },
  { id: "EPS_GROWTH_TTM_YOY", column: "epsGrowthTtmYoy", unit: "PERCENT" },
  { id: "FCF_GROWTH_TTM_YOY", column: "fcfGrowthTtmYoy", unit: "PERCENT" },
  { id: "GROSS_MARGIN_TTM", column: "grossMarginTtm", unit: "PERCENT" },
  {
    id: "OPERATING_MARGIN_TTM",
    column: "operatingMarginTtm",
    unit: "PERCENT",
  },
  { id: "NET_MARGIN_TTM", column: "netMarginTtm", unit: "PERCENT" },
  { id: "FCF_MARGIN_TTM", column: "fcfMarginTtm", unit: "PERCENT" },
  { id: "ROIC_TTM", column: "roicTtm", unit: "PERCENT" },
  { id: "ROE_TTM", column: "roeTtm", unit: "PERCENT" },
  { id: "ROA_TTM", column: "roaTtm", unit: "PERCENT" },
  { id: "DEBT_TO_EQUITY", column: "debtToEquity", unit: "MULTIPLE" },
  { id: "CURRENT_RATIO", column: "currentRatio", unit: "MULTIPLE" },
  {
    id: "NET_DEBT_TO_EBITDA_TTM",
    column: "netDebtToEbitdaTtm",
    unit: "MULTIPLE",
  },
  {
    id: "INTEREST_COVERAGE_TTM",
    column: "interestCoverageTtm",
    unit: "MULTIPLE",
  },
  { id: "ASSET_TURNOVER_TTM", column: "assetTurnoverTtm", unit: "MULTIPLE" },
] as const;

export type OracleFundamentalMetricId =
  (typeof ORACLE_FUNDAMENTAL_METRICS)[number]["id"];

export type OracleFundamentalStatement = {
  securityId?: string;
  statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  /** YYYY-MM-DD fiscal period end. */
  fiscalDate: string;
  fiscalYear: number;
  /** Q1-Q4 are standalone quarters; FY is annual. */
  period: "FY" | "Q1" | "Q2" | "Q3" | "Q4";
  reportedCurrency: string;
  filingDate?: string;
  /** YYYY-MM-DD: the first calendar date this revision may be used, as the loader assigned it. */
  availableFromDate: string;
  /** ISO-8601 instant this revision was first observed (fixed format: lexicographic == chronological). */
  observedAt: string;
  contentHash: string;
  /** Line items, e.g. revenue, epsDiluted, operatingCashFlow. */
  values: Readonly<Record<string, unknown>>;
};

/** An exact rational: reduced, with a positive denominator. */
export type OracleRational = {
  readonly numerator: bigint;
  readonly denominator: bigint;
};

export type OracleFundamentalOutcome =
  | {
      readonly status: "VALUE";
      readonly exact: OracleRational;
      readonly value: number;
    }
  | { readonly status: "UNAVAILABLE"; readonly reason: string };

/**
 * Why a metric is unavailable: the first rule that failed, in the order the module comment lists.
 *
 * - `NO_QUARTERLY_STATEMENT` — no family the flow window is anchored on holds a PIT-eligible
 *   quarterly row, so there is no `Q[0]` at all. An FY-only history lands here.
 * - `MISSING_QUARTER` — a fiscal quarter the anchored window needs (`Q[-3]..Q[0]`, or
 *   `Q[-7]..Q[0]` for a TTM YoY metric) is absent from a required family.
 * - `MISSING_BALANCE_SHEET` — an averaged-state metric's opening (`Q[-4]`) or ending (`Q[0]`)
 *   balance sheet is absent. Neither a newer nor an interior balance sheet substitutes.
 * - `NO_BALANCE_SHEET` — a latest-state input finds no PIT-eligible quarterly balance sheet.
 * - `MISSING_CURRENCY` — a contributing statement's `reportedCurrency` is empty or blank.
 * - `CURRENCY_MISMATCH` — contributing statements report different currency codes.
 * - `MISSING_FIELD` — a required line item is not a finite number.
 * - `NON_FINITE_INTERMEDIATE` — a flow sum (a window total or a quarter's FCF) or a balance-sheet
 *   sum (invested capital, opening + ending) exceeds `Number.MAX_VALUE` in magnitude.
 * - `NON_POSITIVE_TTM` — a TTM total the formula requires to be positive, and which is not the
 *   ratio's denominator, is not: a growth metric's current window, Asset Turnover's revenue.
 * - `NON_POSITIVE_DENOMINATOR` — the ratio's denominator fails its `> 0` requirement.
 * - `OUT_OF_STORAGE_RANGE` — `|result| >= 10^12`, which `DECIMAL(20,8)` cannot hold.
 */
export const ORACLE_FUNDAMENTAL_UNAVAILABLE_REASONS = [
  "NO_QUARTERLY_STATEMENT",
  "MISSING_QUARTER",
  "MISSING_BALANCE_SHEET",
  "NO_BALANCE_SHEET",
  "MISSING_CURRENCY",
  "CURRENCY_MISMATCH",
  "MISSING_FIELD",
  "NON_FINITE_INTERMEDIATE",
  "NON_POSITIVE_TTM",
  "NON_POSITIVE_DENOMINATOR",
  "OUT_OF_STORAGE_RANGE",
] as const;

export type OracleFundamentalUnavailableReason =
  (typeof ORACLE_FUNDAMENTAL_UNAVAILABLE_REASONS)[number];

/** Raised inside a formula to stop at the first failed rule; never escapes this module. */
class Unavailable extends Error {
  constructor(readonly reason: OracleFundamentalUnavailableReason) {
    super(reason);
  }
}

// ---------------------------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------------------------

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  return a;
}

function rational(numerator: bigint, denominator: bigint): OracleRational {
  if (denominator === 0n) {
    throw new Error("fundamental-metrics oracle: division by zero");
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  const sign = denominator < 0n ? -1n : 1n;
  return {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  };
}

function add(left: OracleRational, right: OracleRational): OracleRational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: OracleRational, right: OracleRational): OracleRational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left: OracleRational, right: OracleRational): OracleRational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function divide(left: OracleRational, right: OracleRational): OracleRational {
  return rational(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

/** `|value|` compared with a positive `bound`: negative below, zero equal, positive above. */
function compareMagnitude(
  value: OracleRational,
  bound: OracleRational,
): number {
  const magnitude = value.numerator < 0n ? -value.numerator : value.numerator;
  const left = magnitude * bound.denominator;
  const right = bound.numerator * value.denominator;
  return left === right ? 0 : left > right ? 1 : -1;
}

const ZERO = rational(0n, 1n);
const ONE = rational(1n, 1n);
const TWO = rational(2n, 1n);
const HUNDRED = rational(100n, 1n);

/** `FUNDAMENTAL_ROIC_TAX_RATE = 0.21` ("8. ROIC TTM"), exactly 21/100. */
export const ORACLE_ROIC_TAX_RATE: OracleRational = rational(21n, 100n);

/** `DECIMAL(20,8)` holds `|value| < 10^12` ("Out of storage range is unavailable"). */
const STORAGE_LIMIT = rational(10n ** 12n, 1n);

/** `Number.MAX_VALUE`, exactly: `(2^53 - 1) * 2^971`. */
const LARGEST_DOUBLE = rational(((1n << 53n) - 1n) << 971n, 1n);

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * A line item as an exact rational, or `undefined` when it is missing.
 *
 * Present only as a finite JS number (rule 6: missing is never zero). The value is the exact
 * decimal `String(value)` denotes — the shortest text that round-trips to the double, i.e. the
 * decimal figure the provider's JSON carried — so `0.1` is 1/10 and `1e21` is 10^21.
 */
export function oracleLineItem(value: unknown): OracleRational | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const text = String(value);
  const match = NUMBER_TEXT.exec(text);
  if (match === null) {
    throw new Error(
      `fundamental-metrics oracle: unexpected number text ${text}`,
    );
  }
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2] ?? ""}${fraction}`);
  const signed = match[1] === "-" ? -digits : digits;
  const exponent = Number(match[4] ?? "0") - fraction.length;
  return exponent >= 0
    ? rational(signed * 10n ** BigInt(exponent), 1n)
    : rational(signed, 10n ** BigInt(-exponent));
}

const SMALLEST_EXPONENT = -1074;

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

/**
 * The IEEE-754 double nearest to an exact rational, ties to even — what a correctly rounded
 * computation of the exact result would produce. Zero is `0`, never `-0`.
 *
 * Built from the bits rather than from `Number(text)`, whose rounding the language guarantees only
 * up to twenty significant digits: the rational is scaled to a 53-bit significand, rounded once on
 * its exact remainder, and packed. Below 2^-1022 the exponent stops at -1074 and the significand
 * shrinks (subnormals); past `Number.MAX_VALUE` the result is infinite.
 */
export function oracleNearestDouble(value: OracleRational): number {
  const { numerator, denominator } = value;
  if (numerator === 0n) {
    return 0;
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const scaled = (power: number): [bigint, bigint] =>
    power >= 0
      ? [magnitude, denominator << BigInt(power)]
      : [magnitude << BigInt(-power), denominator];

  // magnitude / denominator = (top / bottom) * 2^exponent with top / bottom in [2^52, 2^53).
  let exponent = bitLength(magnitude) - bitLength(denominator) - 53;
  let [top, bottom] = scaled(exponent);
  if (top >= bottom << 53n) {
    exponent += 1;
    [top, bottom] = scaled(exponent);
  }
  if (exponent < SMALLEST_EXPONENT) {
    exponent = SMALLEST_EXPONENT;
    [top, bottom] = scaled(exponent);
  }

  let significand = top / bottom;
  const twiceRemainder = 2n * (top - significand * bottom);
  if (
    twiceRemainder > bottom ||
    (twiceRemainder === bottom && significand % 2n === 1n)
  ) {
    significand += 1n;
  }
  if (significand === 0n) {
    return 0;
  }
  if (significand === 1n << 53n) {
    significand = 1n << 52n;
    exponent += 1;
  }

  let bits: bigint;
  if (significand >= 1n << 52n) {
    const biasedExponent = exponent + 1075;
    if (biasedExponent >= 2047) {
      return negative ? -Infinity : Infinity;
    }
    bits = (BigInt(biasedExponent) << 52n) | (significand - (1n << 52n));
  } else {
    bits = significand;
  }
  if (negative) {
    bits |= 1n << 63n;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

// ---------------------------------------------------------------------------------------------
// Point in time: one representing revision per fiscal quarter
// ---------------------------------------------------------------------------------------------

type Statement = OracleFundamentalStatement;
type Family = Statement["statementType"];
type Quarters = ReadonlyMap<number, Statement>;
type QuarterBook = Readonly<Record<Family, Quarters>>;

const FAMILIES: readonly string[] = ["INCOME", "BALANCE_SHEET", "CASH_FLOW"];
const PERIODS: readonly string[] = ["FY", "Q1", "Q2", "Q3", "Q4"];
const QUARTERS: readonly string[] = ["Q1", "Q2", "Q3", "Q4"];
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Refuses input the rules below could only misread (a malformed date would compare wrongly). */
function assertWellFormed(
  statement: Statement,
  securityId: string | undefined,
): void {
  const wellFormed =
    FAMILIES.includes(statement.statementType) &&
    PERIODS.includes(statement.period) &&
    Number.isInteger(statement.fiscalYear) &&
    CALENDAR_DAY.test(statement.availableFromDate) &&
    typeof statement.fiscalDate === "string" &&
    typeof statement.observedAt === "string" &&
    typeof statement.contentHash === "string" &&
    typeof statement.values === "object" &&
    statement.values !== null;
  if (!wellFormed) {
    throw new Error(
      `fundamental-metrics oracle: malformed statement ${statement.statementType} ${statement.fiscalYear} ${statement.period}`,
    );
  }
  if (
    securityId !== undefined &&
    statement.securityId !== undefined &&
    statement.securityId !== securityId
  ) {
    throw new Error(
      "fundamental-metrics oracle: statements of more than one security",
    );
  }
}

/**
 * A quarter's position on the fiscal line (rule 9): `fiscalYear * 4 + (quarter - 1)`, so Q4 of
 * fiscal year N and Q1 of N + 1 are adjacent whatever calendar months they cover. `undefined` for
 * an `FY` row, which no quarterly calculation reads (rules 3 and 4).
 */
function fiscalQuarter(statement: Statement): number | undefined {
  const index = QUARTERS.indexOf(statement.period);
  return index === -1 ? undefined : statement.fiscalYear * 4 + index;
}

/**
 * Whether `candidate` is a later revision of its fiscal quarter than `held` (rules 2 and 13, and
 * `fundamentals-loader.md` "Revisions and restatements"): later `availableFromDate`, then later
 * `observedAt`; the later `fiscalDate` decides only between rows one observation delivered (the
 * same `observedAt`), then the greater `contentHash`.
 *
 * Rule 2 picks the latest revision of each logical identity (which includes `fiscalDate`) and
 * rule 13 then the latest identity of each fiscal quarter. Within one identity `fiscalDate` is
 * constant, so the two steps are this one ordering applied once per fiscal quarter.
 */
function laterRevision(candidate: Statement, held: Statement): boolean {
  if (candidate.availableFromDate !== held.availableFromDate) {
    return candidate.availableFromDate > held.availableFromDate;
  }
  if (candidate.observedAt !== held.observedAt) {
    return candidate.observedAt > held.observedAt;
  }
  if (candidate.fiscalDate !== held.fiscalDate) {
    return candidate.fiscalDate > held.fiscalDate;
  }
  return candidate.contentHash > held.contentHash;
}

/** Every family's representing quarterly revisions visible on `date` (rules 1-3 and 13). */
function pointInTimeQuarters(
  statements: readonly Statement[],
  date: string,
): QuarterBook {
  const book: Record<Family, Map<number, Statement>> = {
    INCOME: new Map(),
    BALANCE_SHEET: new Map(),
    CASH_FLOW: new Map(),
  };
  const securityId = statements.find(
    (statement) => statement.securityId !== undefined,
  )?.securityId;
  for (const statement of statements) {
    assertWellFormed(statement, securityId);
    if (statement.availableFromDate > date) {
      continue;
    }
    const quarter = fiscalQuarter(statement);
    if (quarter === undefined) {
      continue;
    }
    const family = book[statement.statementType];
    const held = family.get(quarter);
    if (held === undefined || laterRevision(statement, held)) {
      family.set(quarter, statement);
    }
  }
  return book;
}

// ---------------------------------------------------------------------------------------------
// Windows and states ("Shared TTM helpers", "Window anchors")
// ---------------------------------------------------------------------------------------------

function newestQuarter(quarters: Quarters): number | undefined {
  let newest: number | undefined;
  for (const quarter of quarters.keys()) {
    if (newest === undefined || quarter > newest) {
      newest = quarter;
    }
  }
  return newest;
}

/** `Q[-(length - 1)]..Q[0]` ending at `anchor`, oldest first. Every identity must exist. */
function exactChain(
  quarters: Quarters,
  anchor: number,
  length: number,
): Statement[] {
  const rows: Statement[] = [];
  for (let quarter = anchor - length + 1; quarter <= anchor; quarter += 1) {
    const row = quarters.get(quarter);
    if (row === undefined) {
      throw new Unavailable("MISSING_QUARTER");
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Single-family flow window: `Q[0]` is the family's latest PIT-eligible quarter and the exact
 * predecessor chain must exist in full. There is no search backward for an older complete window.
 */
function anchoredWindow(
  quarters: Quarters,
  length: number,
): { anchor: number; rows: Statement[] } {
  const anchor = newestQuarter(quarters);
  if (anchor === undefined) {
    throw new Unavailable("NO_QUARTERLY_STATEMENT");
  }
  return { anchor, rows: exactChain(quarters, anchor, length) };
}

/**
 * Cross-family flow window (FCF Margin): `Q[0]` is the newest quarter held by any required family,
 * and every family must hold exactly `Q[-3]..Q[0]`. A lagging or silent family makes the metric
 * unavailable; an older window the families happen to share is never used.
 */
function alignedWindows(families: readonly Quarters[]): Statement[][] {
  let anchor: number | undefined;
  for (const family of families) {
    const newest = newestQuarter(family);
    if (newest !== undefined && (anchor === undefined || newest > anchor)) {
      anchor = newest;
    }
  }
  if (anchor === undefined) {
    throw new Unavailable("NO_QUARTERLY_STATEMENT");
  }
  const start = anchor;
  return families.map((family) => exactChain(family, start, 4));
}

/**
 * Averaged-state inputs (ROIC, ROE, ROA, Asset Turnover): the Income window `Q[-3]..Q[0]` anchored
 * at the latest Income quarter, the opening balance sheet of the quarter immediately before
 * `Q[-3]` and the ending balance sheet of `Q[0]`. Interior balance sheets are neither read nor
 * required, and a newer balance sheet never replaces the ending state.
 */
function averagedState(book: QuarterBook): {
  rows: Statement[];
  opening: Statement;
  ending: Statement;
} {
  const { anchor, rows } = anchoredWindow(book.INCOME, 4);
  const opening = book.BALANCE_SHEET.get(anchor - 4);
  const ending = book.BALANCE_SHEET.get(anchor);
  if (opening === undefined || ending === undefined) {
    throw new Unavailable("MISSING_BALANCE_SHEET");
  }
  return { rows, opening, ending };
}

/** Latest-state input: the newest PIT-eligible quarterly balance sheet, whatever the flow window. */
function latestBalanceSheet(book: QuarterBook): Statement {
  const newest = newestQuarter(book.BALANCE_SHEET);
  const sheet =
    newest === undefined ? undefined : book.BALANCE_SHEET.get(newest);
  if (sheet === undefined) {
    throw new Unavailable("NO_BALANCE_SHEET");
  }
  return sheet;
}

// ---------------------------------------------------------------------------------------------
// Currency, line items, sums and sign rules
// ---------------------------------------------------------------------------------------------

function carriesCurrency(statement: Statement): boolean {
  return (
    typeof statement.reportedCurrency === "string" &&
    statement.reportedCurrency.trim() !== ""
  );
}

/**
 * Rule 12: every statement contributing to one observation reports the same non-empty currency.
 * Codes are compared exactly — no two codes are equivalent and nothing is converted.
 */
function oneCurrency(statements: readonly Statement[]): void {
  if (!statements.every(carriesCurrency)) {
    throw new Unavailable("MISSING_CURRENCY");
  }
  const currency = statements[0]?.reportedCurrency;
  if (statements.some((statement) => statement.reportedCurrency !== currency)) {
    throw new Unavailable("CURRENCY_MISMATCH");
  }
}

function lineItem(statement: Statement, field: string): OracleRational {
  const value = oracleLineItem(statement.values[field]);
  if (value === undefined) {
    throw new Unavailable("MISSING_FIELD");
  }
  return value;
}

/** ROIC cash: `cashAndShortTermInvestments`, falling back only when it is missing (a 0 is cash). */
function cash(sheet: Statement): OracleRational {
  return (
    oracleLineItem(sheet.values["cashAndShortTermInvestments"]) ??
    lineItem(sheet, "cashAndCashEquivalents")
  );
}

/** A sum the product holds in a double: unavailable when its magnitude passes `MAX_VALUE`. */
function representable(value: OracleRational): OracleRational {
  if (compareMagnitude(value, LARGEST_DOUBLE) > 0) {
    throw new Unavailable("NON_FINITE_INTERMEDIATE");
  }
  return value;
}

function windowTotal(values: readonly OracleRational[]): OracleRational {
  return representable(values.reduce(add, ZERO));
}

/** `(opening + ending) / 2`; the sum is checked, and a representable sum has a representable half. */
function average(
  opening: OracleRational,
  ending: OracleRational,
): OracleRational {
  return divide(representable(add(opening, ending)), TWO);
}

/**
 * "Free cash flow convention": `FCF_q = operatingCashFlow_q + capitalExpenditure_q`, both required
 * in every quarter. Provider `freeCashFlow` is never read. All components are read before any sum.
 */
function freeCashFlows(rows: readonly Statement[]): OracleRational[] {
  const components = rows.map(
    (row) =>
      [
        lineItem(row, "operatingCashFlow"),
        lineItem(row, "capitalExpenditure"),
      ] as const,
  );
  return components.map(([operating, capital]) =>
    representable(add(operating, capital)),
  );
}

function requirePositive(
  value: OracleRational,
  reason: "NON_POSITIVE_TTM" | "NON_POSITIVE_DENOMINATOR",
): void {
  if (value.numerator <= 0n) {
    throw new Unavailable(reason);
  }
}

function percent(ratio: OracleRational): OracleRational {
  return multiply(ratio, HUNDRED);
}

// ---------------------------------------------------------------------------------------------
// The fifteen formulas ("Metric formulas")
// ---------------------------------------------------------------------------------------------

type Formula = (book: QuarterBook) => OracleRational;

/**
 * 1-3. TTM YoY growth: eight consecutive quarters of one family, anchored at its latest quarter.
 * `require current > 0`, `require previous > 0`, then `(current / previous - 1) * 100`. Crossing
 * zero in either direction, or two non-positive windows, is unavailable.
 */
function ttmYoyGrowth(
  quarters: Quarters,
  perQuarter: (rows: readonly Statement[]) => OracleRational[],
): OracleRational {
  const { rows } = anchoredWindow(quarters, 8);
  oneCurrency(rows);
  const figures = perQuarter(rows);
  const previous = windowTotal(figures.slice(0, 4));
  const current = windowTotal(figures.slice(4));
  requirePositive(current, "NON_POSITIVE_TTM");
  requirePositive(previous, "NON_POSITIVE_DENOMINATOR");
  return percent(subtract(divide(current, previous), ONE));
}

function lineItems(
  field: string,
): (rows: readonly Statement[]) => OracleRational[] {
  return (rows) => rows.map((row) => lineItem(row, field));
}

/**
 * 4-6. Income margins over one exact four-quarter Income window: `require Revenue_TTM > 0`, then
 * `part_TTM / Revenue_TTM * 100`. A negative margin is valid.
 */
function incomeMargin(field: string): Formula {
  return (book) => {
    const { rows } = anchoredWindow(book.INCOME, 4);
    oneCurrency(rows);
    const revenue = rows.map((row) => lineItem(row, "revenue"));
    const part = rows.map((row) => lineItem(row, field));
    const revenueTtm = windowTotal(revenue);
    const partTtm = windowTotal(part);
    requirePositive(revenueTtm, "NON_POSITIVE_DENOMINATOR");
    return percent(divide(partTtm, revenueTtm));
  };
}

/** 7. FCF Margin TTM over one Income + Cash Flow window aligned on the newest quarter either holds. */
function fcfMargin(book: QuarterBook): OracleRational {
  const [income = [], cashFlow = []] = alignedWindows([
    book.INCOME,
    book.CASH_FLOW,
  ]);
  oneCurrency([...income, ...cashFlow]);
  const revenue = income.map((row) => lineItem(row, "revenue"));
  const freeCashFlow = freeCashFlows(cashFlow);
  const revenueTtm = windowTotal(revenue);
  const freeCashFlowTtm = windowTotal(freeCashFlow);
  requirePositive(revenueTtm, "NON_POSITIVE_DENOMINATOR");
  return percent(divide(freeCashFlowTtm, revenueTtm));
}

/**
 * 8. ROIC TTM: `NOPAT = OperatingIncome_TTM * (1 - 0.21)` over the averaged-state window, and
 * `investedCapital = totalDebt + totalStockholdersEquity - cash` at the opening and the ending
 * state. `require AverageInvestedCapital > 0`. No fallback to `totalEquity`. Negative ROIC is valid.
 */
function roic(book: QuarterBook): OracleRational {
  const { rows, opening, ending } = averagedState(book);
  oneCurrency([...rows, opening, ending]);
  const operatingIncome = rows.map((row) => lineItem(row, "operatingIncome"));
  const states = [opening, ending].map(
    (sheet) =>
      [
        lineItem(sheet, "totalDebt"),
        lineItem(sheet, "totalStockholdersEquity"),
        cash(sheet),
      ] as const,
  );
  const operatingIncomeTtm = windowTotal(operatingIncome);
  const [openingCapital = ZERO, endingCapital = ZERO] = states.map(
    ([debt, equity, cashHeld]) =>
      representable(subtract(add(debt, equity), cashHeld)),
  );
  const averageInvestedCapital = average(openingCapital, endingCapital);
  const nopat = multiply(
    operatingIncomeTtm,
    subtract(ONE, ORACLE_ROIC_TAX_RATE),
  );
  requirePositive(averageInvestedCapital, "NON_POSITIVE_DENOMINATOR");
  return percent(divide(nopat, averageInvestedCapital));
}

/**
 * 9-10. ROE and ROA TTM: `NetIncome_TTM / average(state) * 100` over the averaged-state window,
 * the state being `totalStockholdersEquity` or `totalAssets`. `require average > 0`: zero or
 * negative equity is unavailable rather than sign-inverted.
 */
function averagedReturn(stateField: string): Formula {
  return (book) => {
    const { rows, opening, ending } = averagedState(book);
    oneCurrency([...rows, opening, ending]);
    const netIncome = rows.map((row) => lineItem(row, "netIncome"));
    const openingState = lineItem(opening, stateField);
    const endingState = lineItem(ending, stateField);
    const netIncomeTtm = windowTotal(netIncome);
    const averageState = average(openingState, endingState);
    requirePositive(averageState, "NON_POSITIVE_DENOMINATOR");
    return percent(divide(netIncomeTtm, averageState));
  };
}

/** 11. Debt / Equity on the latest balance sheet: `require totalStockholdersEquity > 0`. */
function debtToEquity(book: QuarterBook): OracleRational {
  const sheet = latestBalanceSheet(book);
  oneCurrency([sheet]);
  const debt = lineItem(sheet, "totalDebt");
  const equity = lineItem(sheet, "totalStockholdersEquity");
  requirePositive(equity, "NON_POSITIVE_DENOMINATOR");
  return divide(debt, equity);
}

/** 12. Current Ratio on the latest balance sheet: `require totalCurrentLiabilities > 0`. */
function currentRatio(book: QuarterBook): OracleRational {
  const sheet = latestBalanceSheet(book);
  oneCurrency([sheet]);
  const assets = lineItem(sheet, "totalCurrentAssets");
  const liabilities = lineItem(sheet, "totalCurrentLiabilities");
  requirePositive(liabilities, "NON_POSITIVE_DENOMINATOR");
  return divide(assets, liabilities);
}

/**
 * 13. Net Debt / EBITDA TTM: EBITDA over the latest Income window, `netDebt` from the latest
 * balance sheet independently of that window (it may be newer or older than `Q[0]`).
 * `require EBITDA_TTM > 0`, `require netDebt is present`; `netDebt` is never reconstructed. A
 * negative multiple (net cash) is valid.
 */
function netDebtToEbitda(book: QuarterBook): OracleRational {
  const { rows } = anchoredWindow(book.INCOME, 4);
  const sheet = latestBalanceSheet(book);
  oneCurrency([...rows, sheet]);
  const ebitda = rows.map((row) => lineItem(row, "ebitda"));
  const netDebt = lineItem(sheet, "netDebt");
  const ebitdaTtm = windowTotal(ebitda);
  requirePositive(ebitdaTtm, "NON_POSITIVE_DENOMINATOR");
  return divide(netDebt, ebitdaTtm);
}

/**
 * 14. Interest Coverage TTM: `EBIT_TTM / InterestExpense_TTM` over one Income window,
 * `require InterestExpense_TTM > 0`. An explicit zero interest expense is a real zero and makes
 * the ratio unbounded, so unavailable; a missing one is missing, never zero.
 */
function interestCoverage(book: QuarterBook): OracleRational {
  const { rows } = anchoredWindow(book.INCOME, 4);
  oneCurrency(rows);
  const ebit = rows.map((row) => lineItem(row, "ebit"));
  const interestExpense = rows.map((row) => lineItem(row, "interestExpense"));
  const ebitTtm = windowTotal(ebit);
  const interestExpenseTtm = windowTotal(interestExpense);
  requirePositive(interestExpenseTtm, "NON_POSITIVE_DENOMINATOR");
  return divide(ebitTtm, interestExpenseTtm);
}

/**
 * 15. Asset Turnover TTM: `Revenue_TTM / AverageAssets` over the averaged-state window.
 * `require Revenue_TTM > 0` (not the denominator: `NON_POSITIVE_TTM`), then
 * `require AverageAssets > 0`.
 */
function assetTurnover(book: QuarterBook): OracleRational {
  const { rows, opening, ending } = averagedState(book);
  oneCurrency([...rows, opening, ending]);
  const revenue = rows.map((row) => lineItem(row, "revenue"));
  const openingAssets = lineItem(opening, "totalAssets");
  const endingAssets = lineItem(ending, "totalAssets");
  const revenueTtm = windowTotal(revenue);
  const averageAssets = average(openingAssets, endingAssets);
  requirePositive(revenueTtm, "NON_POSITIVE_TTM");
  requirePositive(averageAssets, "NON_POSITIVE_DENOMINATOR");
  return divide(revenueTtm, averageAssets);
}

const FORMULAS: Readonly<Record<OracleFundamentalMetricId, Formula>> = {
  REVENUE_GROWTH_TTM_YOY: (book) =>
    ttmYoyGrowth(book.INCOME, lineItems("revenue")),
  EPS_GROWTH_TTM_YOY: (book) =>
    ttmYoyGrowth(book.INCOME, lineItems("epsDiluted")),
  FCF_GROWTH_TTM_YOY: (book) => ttmYoyGrowth(book.CASH_FLOW, freeCashFlows),
  GROSS_MARGIN_TTM: incomeMargin("grossProfit"),
  OPERATING_MARGIN_TTM: incomeMargin("operatingIncome"),
  NET_MARGIN_TTM: incomeMargin("netIncome"),
  FCF_MARGIN_TTM: fcfMargin,
  ROIC_TTM: roic,
  ROE_TTM: averagedReturn("totalStockholdersEquity"),
  ROA_TTM: averagedReturn("totalAssets"),
  DEBT_TO_EQUITY: debtToEquity,
  CURRENT_RATIO: currentRatio,
  NET_DEBT_TO_EBITDA_TTM: netDebtToEbitda,
  INTEREST_COVERAGE_TTM: interestCoverage,
  ASSET_TURNOVER_TTM: assetTurnover,
};

/** One formula's outcome, with the storage range applied to its exact result. */
function observe(
  formula: Formula,
  book: QuarterBook,
): OracleFundamentalOutcome {
  let exact: OracleRational;
  try {
    exact = formula(book);
  } catch (error) {
    if (error instanceof Unavailable) {
      return { status: "UNAVAILABLE", reason: error.reason };
    }
    throw error;
  }
  // The bound is applied to the exact value, the engine applies it to its double. The two can only
  // disagree within one double's spacing of 1e12 (and the per-quarter `representable` checks above
  // only near 1.8e308) — inputs the audit never generates — and a disagreement there would show as
  // a mismatch, never as a false pass.
  if (compareMagnitude(exact, STORAGE_LIMIT) >= 0) {
    return { status: "UNAVAILABLE", reason: "OUT_OF_STORAGE_RANGE" };
  }
  return { status: "VALUE", exact, value: oracleNearestDouble(exact) };
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/**
 * All fifteen outcomes for one security on calendar date `date` (the statements all belong to
 * one security). `date` is only the point-in-time cutoff, `availableFromDate <= date`; mapping an
 * eligibility date to a trading session is the materializer's concern, not the formula's.
 */
export function oracleFundamentalOutcomes(
  statements: readonly OracleFundamentalStatement[],
  date: string,
): Record<OracleFundamentalMetricId, OracleFundamentalOutcome> {
  if (!CALENDAR_DAY.test(date)) {
    throw new Error(
      `fundamental-metrics oracle: date must be YYYY-MM-DD, got ${date}`,
    );
  }
  const book = pointInTimeQuarters(statements, date);
  const outcomes = {} as Record<
    OracleFundamentalMetricId,
    OracleFundamentalOutcome
  >;
  for (const { id } of ORACLE_FUNDAMENTAL_METRICS) {
    outcomes[id] = observe(FORMULAS[id], book);
  }
  return outcomes;
}

/** Convenience: only the available metrics, as their nearest double. */
export function oracleFundamentalMetrics(
  statements: readonly OracleFundamentalStatement[],
  date: string,
): Partial<Record<OracleFundamentalMetricId, number>> {
  const metrics: Partial<Record<OracleFundamentalMetricId, number>> = {};
  const outcomes = oracleFundamentalOutcomes(statements, date);
  for (const { id } of ORACLE_FUNDAMENTAL_METRICS) {
    const outcome = outcomes[id];
    if (outcome.status === "VALUE") {
      metrics[id] = outcome.value;
    }
  }
  return metrics;
}
