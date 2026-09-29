import type { FinancialStatement } from "@intrinsic/domain";

/**
 * Independent reference implementation of the fifteen Fundamental Metrics V1 formulas.
 *
 * Deliberately shares nothing with production but the statement type. It is written straight from
 * `docs/decisions/fundamental-metrics-v1.md` and differs structurally on purpose:
 *
 * - point-in-time selection is its own scan (latest `availableFromDate`, then `observedAt`, then
 *   `contentHash` per fiscal identity), not the domain selector;
 * - quarters are walked backwards one `previousQuarter` step at a time, not ranked;
 * - every quantity is an exact rational over `bigint`, so a positivity rule is decided on the
 *   exact value and the only rounding is the final conversion to a double.
 *
 * It evaluates each trading day from scratch and never carries anything forward, which is what
 * lets a comparison against the materializer prove the event plan and the carry-forward too.
 *
 * Fixtures fed to it must give each fiscal quarter a single `fiscalDate` across its revisions;
 * production's rule for two period ends of one quarter is pinned separately.
 *
 * Test support, not product code: not exported from `index.ts`, and the `.test-helper` suffix
 * keeps Vitest from collecting it as a suite.
 */

class Rational {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den === 0n) {
      throw new Error("Rational with a zero denominator");
    }
    const sign = den < 0n ? -1n : 1n;
    const divisor = gcd(abs(num), abs(den));
    this.num = (sign * num) / divisor;
    this.den = (sign * den) / divisor;
  }

  /** The exact value of a double's shortest round-trip decimal form. */
  static of(value: number): Rational {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
    if (!match) {
      throw new Error(`Not a finite decimal: ${value}`);
    }
    const [, sign = "", integer = "", fraction = "", power = "0"] = match;
    const exponent = Number(power) - fraction.length;
    const digits = BigInt(`${sign}${integer}${fraction}`);
    return exponent >= 0
      ? new Rational(digits * 10n ** BigInt(exponent))
      : new Rational(digits, 10n ** BigInt(-exponent));
  }

  add(other: Rational): Rational {
    return new Rational(
      this.num * other.den + other.num * this.den,
      this.den * other.den,
    );
  }

  sub(other: Rational): Rational {
    return this.add(new Rational(-other.num, other.den));
  }

  mul(other: Rational): Rational {
    return new Rational(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    return new Rational(this.num * other.den, this.den * other.num);
  }

  isPositive(): boolean {
    return this.num > 0n;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  toNumber(): number {
    const negative = this.num < 0n;
    const scaled = (abs(this.num) * 10n ** 40n) / this.den;
    return Number(`${negative ? "-" : ""}${scaled}e-40`);
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

const HUNDRED = new Rational(100n);
const TWO = new Rational(2n);
const AFTER_TAX = new Rational(79n, 100n); // 1 - 21%

type Family = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
type QuarterPeriod = "Q1" | "Q2" | "Q3" | "Q4";
type Q = { year: number; q: 1 | 2 | 3 | 4 };

function label(quarter: Q): string {
  return `${quarter.year}Q${quarter.q}`;
}

function previousQuarter(quarter: Q): Q {
  return quarter.q === 1
    ? { year: quarter.year - 1, q: 4 }
    : { year: quarter.year, q: (quarter.q - 1) as Q["q"] };
}

function later(left: Q, right: Q): boolean {
  return left.year !== right.year ? left.year > right.year : left.q > right.q;
}

/** Newer revision of the same fiscal identity? */
function supersedes(
  candidate: FinancialStatement,
  existing: FinancialStatement,
): boolean {
  if (candidate.availableFromDate !== existing.availableFromDate) {
    return candidate.availableFromDate > existing.availableFromDate;
  }
  if (candidate.observedAt !== existing.observedAt) {
    return candidate.observedAt > existing.observedAt;
  }
  return candidate.contentHash > existing.contentHash;
}

type Book = Map<string, FinancialStatement>;

/** Everything visible on `date`: the latest eligible revision per family and fiscal quarter. */
function visibleBooks(
  statements: readonly FinancialStatement[],
  securityId: string,
  date: string,
): Record<Family, Book> {
  const books: Record<Family, Book> = {
    INCOME: new Map(),
    BALANCE_SHEET: new Map(),
    CASH_FLOW: new Map(),
  };
  for (const statement of statements) {
    if (
      statement.securityId !== securityId ||
      statement.period === "FY" ||
      statement.availableFromDate > date
    ) {
      continue;
    }
    const key = label({
      year: statement.fiscalYear,
      q: Number(statement.period.slice(1)) as Q["q"],
    });
    const book = books[statement.statementType as Family];
    const existing = book.get(key);
    if (!existing || supersedes(statement, existing)) {
      book.set(key, statement);
    }
  }
  return books;
}

function latestQuarter(book: Book): Q | undefined {
  let latest: Q | undefined;
  for (const statement of book.values()) {
    const quarter: Q = {
      year: statement.fiscalYear,
      q: Number((statement.period as QuarterPeriod).slice(1)) as Q["q"],
    };
    if (!latest || later(quarter, latest)) {
      latest = quarter;
    }
  }
  return latest;
}

/** `count` statements walking back from `end`, newest first, or undefined on any gap. */
function walkBack(
  book: Book,
  end: Q,
  count: number,
): FinancialStatement[] | undefined {
  const rows: FinancialStatement[] = [];
  let cursor = end;
  for (let step = 0; step < count; step += 1) {
    const row = book.get(label(cursor));
    if (!row) {
      return undefined;
    }
    rows.push(row);
    cursor = previousQuarter(cursor);
  }
  return rows;
}

function field(
  statement: FinancialStatement,
  name: string,
): Rational | undefined {
  const value = (statement.values as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value)
    ? Rational.of(value)
    : undefined;
}

function total(
  rows: readonly FinancialStatement[],
  name: string,
): Rational | undefined {
  let sum = new Rational(0n);
  for (const row of rows) {
    const value = field(row, name);
    if (!value) {
      return undefined;
    }
    sum = sum.add(value);
  }
  return sum;
}

function freeCashFlow(
  rows: readonly FinancialStatement[],
): Rational | undefined {
  const ocf = total(rows, "operatingCashFlow");
  const capex = total(rows, "capitalExpenditure");
  return ocf && capex ? ocf.add(capex) : undefined;
}

function growth(
  current: Rational | undefined,
  previous: Rational | undefined,
): Rational | undefined {
  if (
    !current ||
    !previous ||
    !current.isPositive() ||
    !previous.isPositive()
  ) {
    return undefined;
  }
  return current.div(previous).sub(new Rational(1n)).mul(HUNDRED);
}

function share(
  numerator: Rational | undefined,
  denominator: Rational | undefined,
  scale: Rational = HUNDRED,
): Rational | undefined {
  if (!numerator || !denominator || !denominator.isPositive()) {
    return undefined;
  }
  return numerator.div(denominator).mul(scale);
}

function average(
  opening: FinancialStatement | undefined,
  ending: FinancialStatement | undefined,
  compute: (state: FinancialStatement) => Rational | undefined,
): Rational | undefined {
  if (!opening || !ending) {
    return undefined;
  }
  const first = compute(opening);
  const second = compute(ending);
  return first && second ? first.add(second).div(TWO) : undefined;
}

function investedCapital(state: FinancialStatement): Rational | undefined {
  const cash =
    field(state, "cashAndShortTermInvestments") ??
    field(state, "cashAndCashEquivalents");
  const debt = field(state, "totalDebt");
  const equity = field(state, "totalStockholdersEquity");
  return cash && debt && equity ? debt.add(equity).sub(cash) : undefined;
}

export type ReferenceSnapshot = Record<string, number | undefined>;

/** The fifteen metrics for `date`, evaluated from scratch. */
export function referenceFundamentals(
  statements: readonly FinancialStatement[],
  securityId: string,
  date: string,
): ReferenceSnapshot {
  const books = visibleBooks(statements, securityId, date);
  const incomeEnd = latestQuarter(books.INCOME);
  const cashFlowEnd = latestQuarter(books.CASH_FLOW);

  const incomeCurrent = incomeEnd && walkBack(books.INCOME, incomeEnd, 4);
  const incomeEight = incomeEnd && walkBack(books.INCOME, incomeEnd, 8);
  const cashFlowEight =
    cashFlowEnd && walkBack(books.CASH_FLOW, cashFlowEnd, 8);

  // FCF margin evaluates the newest quarter either family holds, and needs both families to hold
  // it and the three before it. An older window the two happen to share is never used.
  let alignedEnd: Q | undefined = incomeEnd;
  if (cashFlowEnd && (!alignedEnd || later(cashFlowEnd, alignedEnd))) {
    alignedEnd = cashFlowEnd;
  }
  const alignedIncome = alignedEnd && walkBack(books.INCOME, alignedEnd, 4);
  const alignedCashFlow =
    alignedEnd && walkBack(books.CASH_FLOW, alignedEnd, 4);

  // Aligned states: Q[0] and the quarter immediately before Q[-3], i.e. four steps back.
  let opening: FinancialStatement | undefined;
  let ending: FinancialStatement | undefined;
  if (incomeEnd) {
    ending = books.BALANCE_SHEET.get(label(incomeEnd));
    let cursor = incomeEnd;
    for (let step = 0; step < 4; step += 1) {
      cursor = previousQuarter(cursor);
    }
    opening = books.BALANCE_SHEET.get(label(cursor));
  }
  const balanceSheetEnd = latestQuarter(books.BALANCE_SHEET);
  const latestState =
    balanceSheetEnd && books.BALANCE_SHEET.get(label(balanceSheetEnd));

  const current = incomeEight?.slice(0, 4);
  const previous = incomeEight?.slice(4);
  const netIncome = incomeCurrent && total(incomeCurrent, "netIncome");
  const revenue = incomeCurrent && total(incomeCurrent, "revenue");

  const result: Record<string, Rational | undefined> = {
    revenueGrowthTtmYoy:
      current && previous
        ? growth(total(current, "revenue"), total(previous, "revenue"))
        : undefined,
    epsGrowthTtmYoy:
      current && previous
        ? growth(total(current, "epsDiluted"), total(previous, "epsDiluted"))
        : undefined,
    fcfGrowthTtmYoy: cashFlowEight
      ? growth(
          freeCashFlow(cashFlowEight.slice(0, 4)),
          freeCashFlow(cashFlowEight.slice(4)),
        )
      : undefined,
    grossMarginTtm: incomeCurrent
      ? share(total(incomeCurrent, "grossProfit"), revenue)
      : undefined,
    operatingMarginTtm: incomeCurrent
      ? share(total(incomeCurrent, "operatingIncome"), revenue)
      : undefined,
    netMarginTtm: incomeCurrent ? share(netIncome, revenue) : undefined,
    fcfMarginTtm:
      alignedIncome && alignedCashFlow
        ? share(freeCashFlow(alignedCashFlow), total(alignedIncome, "revenue"))
        : undefined,
    roicTtm: (() => {
      const operatingIncome =
        incomeCurrent && total(incomeCurrent, "operatingIncome");
      const averageCapital = average(opening, ending, investedCapital);
      return operatingIncome
        ? share(operatingIncome.mul(AFTER_TAX), averageCapital)
        : undefined;
    })(),
    roeTtm: incomeCurrent
      ? share(
          netIncome,
          average(opening, ending, (state) =>
            field(state, "totalStockholdersEquity"),
          ),
        )
      : undefined,
    roaTtm: incomeCurrent
      ? share(
          netIncome,
          average(opening, ending, (state) => field(state, "totalAssets")),
        )
      : undefined,
    debtToEquity: latestState
      ? share(
          field(latestState, "totalDebt"),
          field(latestState, "totalStockholdersEquity"),
          new Rational(1n),
        )
      : undefined,
    currentRatio: latestState
      ? share(
          field(latestState, "totalCurrentAssets"),
          field(latestState, "totalCurrentLiabilities"),
          new Rational(1n),
        )
      : undefined,
    netDebtToEbitdaTtm:
      incomeCurrent && latestState
        ? share(
            field(latestState, "netDebt"),
            total(incomeCurrent, "ebitda"),
            new Rational(1n),
          )
        : undefined,
    interestCoverageTtm: incomeCurrent
      ? share(
          total(incomeCurrent, "ebit"),
          total(incomeCurrent, "interestExpense"),
          new Rational(1n),
        )
      : undefined,
    assetTurnoverTtm: (() => {
      if (!incomeCurrent || !revenue || !revenue.isPositive()) {
        return undefined;
      }
      return share(
        revenue,
        average(opening, ending, (state) => field(state, "totalAssets")),
        new Rational(1n),
      );
    })(),
  };

  return Object.fromEntries(
    Object.entries(result).map(([name, value]) => [name, value?.toNumber()]),
  );
}
