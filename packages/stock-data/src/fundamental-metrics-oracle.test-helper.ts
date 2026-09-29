import type {
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";

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

/** One metric's exact value and the statements it was built from, or nothing when unavailable. */
type Candidate = { value: Rational | undefined; sources: FinancialStatement[] };

/** `DECIMAL(20,8)` holds magnitudes strictly below 10^12. */
const STORABLE_LIMIT = new Rational(10n ** 12n);

function storable(value: Rational): boolean {
  const magnitude =
    value.num < 0n ? new Rational(-value.num, value.den) : value;
  return magnitude.sub(STORABLE_LIMIT).num < 0n;
}

/** Every contributing statement reports the same non-empty currency. */
function oneCurrency(sources: readonly FinancialStatement[]): boolean {
  const currencies = new Set(sources.map((source) => source.reportedCurrency));
  const [only] = [...currencies];
  return (
    currencies.size === 1 && typeof only === "string" && only.trim() !== ""
  );
}

function stepsBack(quarter: Q, steps: number): Q {
  let cursor = quarter;
  for (let step = 0; step < steps; step += 1) {
    cursor = previousQuarter(cursor);
  }
  return cursor;
}

/**
 * Switches for measuring how much each availability rule removes; the comparison itself always
 * runs with every rule on.
 */
export type ReferenceRules = {
  ignoreCurrency?: boolean;
  ignoreStorableRange?: boolean;
};

/** The fifteen metrics for `date`, evaluated from scratch. */
export function referenceFundamentals(
  statements: readonly FinancialStatement[],
  securityId: string,
  date: string,
  rules: ReferenceRules = {},
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
  const ending = incomeEnd && books.BALANCE_SHEET.get(label(incomeEnd));
  const opening =
    incomeEnd && books.BALANCE_SHEET.get(label(stepsBack(incomeEnd, 4)));
  const states = opening && ending ? [opening, ending] : undefined;
  const balanceSheetEnd = latestQuarter(books.BALANCE_SHEET);
  const latestState =
    balanceSheetEnd && books.BALANCE_SHEET.get(label(balanceSheetEnd));

  const current = incomeEight?.slice(0, 4);
  const previous = incomeEight?.slice(4);
  const netIncome = incomeCurrent && total(incomeCurrent, "netIncome");
  const revenue = incomeCurrent && total(incomeCurrent, "revenue");
  const ONE = new Rational(1n);

  const candidates: Record<string, Candidate | undefined> = {
    revenueGrowthTtmYoy:
      current && previous
        ? {
            value: growth(
              total(current, "revenue"),
              total(previous, "revenue"),
            ),
            sources: [...current, ...previous],
          }
        : undefined,
    epsGrowthTtmYoy:
      current && previous
        ? {
            value: growth(
              total(current, "epsDiluted"),
              total(previous, "epsDiluted"),
            ),
            sources: [...current, ...previous],
          }
        : undefined,
    fcfGrowthTtmYoy: cashFlowEight
      ? {
          value: growth(
            freeCashFlow(cashFlowEight.slice(0, 4)),
            freeCashFlow(cashFlowEight.slice(4)),
          ),
          sources: cashFlowEight,
        }
      : undefined,
    grossMarginTtm: incomeCurrent
      ? {
          value: share(total(incomeCurrent, "grossProfit"), revenue),
          sources: incomeCurrent,
        }
      : undefined,
    operatingMarginTtm: incomeCurrent
      ? {
          value: share(total(incomeCurrent, "operatingIncome"), revenue),
          sources: incomeCurrent,
        }
      : undefined,
    netMarginTtm: incomeCurrent
      ? { value: share(netIncome, revenue), sources: incomeCurrent }
      : undefined,
    fcfMarginTtm:
      alignedIncome && alignedCashFlow
        ? {
            value: share(
              freeCashFlow(alignedCashFlow),
              total(alignedIncome, "revenue"),
            ),
            sources: [...alignedIncome, ...alignedCashFlow],
          }
        : undefined,
    roicTtm:
      incomeCurrent && states
        ? {
            value: (() => {
              const operatingIncome = total(incomeCurrent, "operatingIncome");
              const averageCapital = average(opening, ending, investedCapital);
              return operatingIncome
                ? share(operatingIncome.mul(AFTER_TAX), averageCapital)
                : undefined;
            })(),
            sources: [...incomeCurrent, ...states],
          }
        : undefined,
    roeTtm:
      incomeCurrent && states
        ? {
            value: share(
              netIncome,
              average(opening, ending, (state) =>
                field(state, "totalStockholdersEquity"),
              ),
            ),
            sources: [...incomeCurrent, ...states],
          }
        : undefined,
    roaTtm:
      incomeCurrent && states
        ? {
            value: share(
              netIncome,
              average(opening, ending, (state) => field(state, "totalAssets")),
            ),
            sources: [...incomeCurrent, ...states],
          }
        : undefined,
    debtToEquity: latestState
      ? {
          value: share(
            field(latestState, "totalDebt"),
            field(latestState, "totalStockholdersEquity"),
            ONE,
          ),
          sources: [latestState],
        }
      : undefined,
    currentRatio: latestState
      ? {
          value: share(
            field(latestState, "totalCurrentAssets"),
            field(latestState, "totalCurrentLiabilities"),
            ONE,
          ),
          sources: [latestState],
        }
      : undefined,
    netDebtToEbitdaTtm:
      incomeCurrent && latestState
        ? {
            value: share(
              field(latestState, "netDebt"),
              total(incomeCurrent, "ebitda"),
              ONE,
            ),
            sources: [...incomeCurrent, latestState],
          }
        : undefined,
    interestCoverageTtm: incomeCurrent
      ? {
          value: share(
            total(incomeCurrent, "ebit"),
            total(incomeCurrent, "interestExpense"),
            ONE,
          ),
          sources: incomeCurrent,
        }
      : undefined,
    assetTurnoverTtm:
      incomeCurrent && states && revenue && revenue.isPositive()
        ? {
            value: share(
              revenue,
              average(opening, ending, (state) => field(state, "totalAssets")),
              ONE,
            ),
            sources: [...incomeCurrent, ...states],
          }
        : undefined,
  };

  return Object.fromEntries(
    Object.entries(candidates).map(([name, candidate]) => {
      const value = candidate?.value;
      const available =
        candidate !== undefined &&
        value !== undefined &&
        (rules.ignoreCurrency || oneCurrency(candidate.sources)) &&
        (rules.ignoreStorableRange || storable(value));
      return [name, available ? value.toNumber() : undefined];
    }),
  );
}

/** mulberry32: a small deterministic PRNG, so every failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Last day of `month` (1-12) in `year`, as a fiscal period end. */
function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export type HistoryScenario = {
  seed: number;
  /** Calendar month (1-12) the fiscal year ends in. */
  fiscalYearEndMonth: number;
  firstFiscalYear: number;
  fiscalYears: number;
  /**
   * Reported currencies. Without it every statement is `USD`. `switchTo` from `switchAtFiscalYear`
   * models a change of reporting currency; `noise` is the probability that one statement reports a
   * different (`EUR`) or no currency; restatements may then change a statement's currency too.
   */
  currency?: {
    base: string;
    switchAtFiscalYear?: number;
    switchTo?: string;
    noise?: number;
  };
  /**
   * Monetary scale factor (per-share and share-count fields are untouched), and the probability
   * that a denominator collapses to a single currency unit — a whole fiscal year of revenue,
   * EBITDA or interest expense summing to one unit, or one balance sheet's equity, current
   * liabilities or assets. Together they produce ratios beyond what the calculated-series column
   * can store.
   */
  magnitude?: number;
  tinyDenominators?: number;
};

/**
 * A deliberately messy, fully deterministic statement history for one security: losses and
 * near-zero sums, two-decimal EPS, missing fields and quarters, families filed on different days,
 * restatements that flip signs or drop fields, annual rows no metric may read, and — when asked for
 * — currency changes and JPY-scale magnitudes with single-unit denominators. The default options
 * draw exactly the random stream they always did, so an existing scenario's history never moves.
 */
export function generateHistory(
  scenario: HistoryScenario,
  securityId: string,
): FinancialStatement[] {
  const next = random(scenario.seed);
  const pick = (probability: number) => next() < probability;
  const integer = (low: number, high: number) =>
    Math.round(low + next() * (high - low));
  const rows: FinancialStatement[] = [];
  let hashes = 0;

  const currencyOf = (fiscalYear: number): string => {
    const options = scenario.currency;
    if (!options) {
      return "USD";
    }
    const reporting =
      options.switchAtFiscalYear !== undefined &&
      options.switchTo !== undefined &&
      fiscalYear >= options.switchAtFiscalYear
        ? options.switchTo
        : options.base;
    if (options.noise !== undefined && pick(options.noise)) {
      return pick(0.5) ? "EUR" : "";
    }
    return reporting;
  };
  const magnitude = scenario.magnitude ?? 1;
  const monetary = (value: number) => Math.round(value * magnitude);

  const emit = (
    statementType: FinancialStatementType,
    fiscalYear: number,
    period: FinancialStatement["period"],
    fiscalDate: string,
    availableFromDate: string,
    values: Record<string, number>,
    reportedCurrency: string,
  ) => {
    // A field the provider did not report is an absent key, never a zero.
    const reported = Object.fromEntries(
      Object.entries(values).filter(() => !pick(0.015)),
    );
    hashes += 1;
    rows.push({
      securityId,
      statementType,
      fiscalDate,
      fiscalYear,
      period,
      reportedCurrency,
      filingDate: addDays(availableFromDate, -1),
      availableFromDate,
      observedAt: `${availableFromDate}T12:00:00.000Z`,
      contentHash: `hash-${String(hashes).padStart(6, "0")}`,
      values: reported,
    });
  };

  let scale = 1_000;
  for (
    let fiscalYear = scenario.firstFiscalYear;
    fiscalYear < scenario.firstFiscalYear + scenario.fiscalYears;
    fiscalYear += 1
  ) {
    // A fiscal year whose flow denominator sums to one currency unit: 1, 0, 0, 0.
    const collapsedFlow =
      scenario.tinyDenominators !== undefined && pick(scenario.tinyDenominators)
        ? (["interestExpense", "revenue", "ebitda"] as const)[integer(0, 2)]
        : undefined;
    for (let index = 0; index < 4; index += 1) {
      const period = (["Q1", "Q2", "Q3", "Q4"] as const)[index]!;
      // Q4 ends in the fiscal year-end month of the label year; each earlier quarter three months
      // before, so a September or January year-end puts early quarters in the prior calendar year.
      const monthsBeforeYearEnd = (3 - index) * 3;
      const endMonthIndex =
        fiscalYear * 12 +
        (scenario.fiscalYearEndMonth - 1) -
        monthsBeforeYearEnd;
      const fiscalDate = monthEnd(
        Math.floor(endMonthIndex / 12),
        (endMonthIndex % 12) + 1,
      );
      const filed = addDays(fiscalDate, integer(25, 55));
      scale *= 0.97 + next() * 0.09;
      const loss = pick(0.15);
      const revenue = pick(0.04) ? 0 : integer(scale * 0.8, scale * 1.2);
      const netIncome = loss
        ? -integer(1, scale * 0.2)
        : integer(0, scale * 0.15);
      const shares = integer(90, 110);
      const income: Record<string, number> = {
        revenue: monetary(pick(0.01) ? -integer(1, 50) : revenue),
        grossProfit: monetary(integer(-scale * 0.1, scale * 0.6)),
        operatingIncome: monetary(integer(-scale * 0.2, scale * 0.3)),
        netIncome: monetary(netIncome),
        // Two-decimal EPS, so sums of reported decimals are exercised, including exact zeros.
        epsDiluted: Math.round((netIncome / shares) * 100) / 100,
        weightedAverageShsOutDil: shares,
        ebitda: monetary(integer(-scale * 0.1, scale * 0.4)),
        ebit: monetary(integer(-scale * 0.2, scale * 0.3)),
        interestExpense: monetary(pick(0.1) ? 0 : integer(1, scale * 0.05)),
        incomeTaxExpense: monetary(integer(0, scale * 0.1)),
      };
      const cashFlow: Record<string, number> = {
        operatingCashFlow: monetary(integer(-scale * 0.05, scale * 0.4)),
        capitalExpenditure: monetary(pick(0.1) ? 0 : -integer(1, scale * 0.15)),
        freeCashFlow: monetary(integer(-scale, scale)),
      };
      const balanceSheet: Record<string, number> = {
        totalDebt: monetary(pick(0.1) ? 0 : integer(0, scale * 2)),
        totalStockholdersEquity: monetary(
          pick(0.08) ? -integer(1, scale) : integer(1, scale * 3),
        ),
        totalEquity: monetary(integer(1, scale * 3)),
        cashAndShortTermInvestments: monetary(integer(0, scale * 1.5)),
        cashAndCashEquivalents: monetary(integer(0, scale)),
        totalAssets: monetary(integer(scale, scale * 6)),
        totalCurrentAssets: monetary(integer(0, scale * 2)),
        totalCurrentLiabilities: monetary(
          pick(0.05) ? 0 : integer(1, scale * 1.5),
        ),
        netDebt: monetary(integer(-scale, scale * 2)),
      };
      if (collapsedFlow !== undefined) {
        income[collapsedFlow] = index === 0 ? 1 : 0;
      }
      if (
        scenario.tinyDenominators !== undefined &&
        pick(scenario.tinyDenominators)
      ) {
        // One balance sheet whose denominator is a single currency unit.
        const name = (
          [
            "totalStockholdersEquity",
            "totalCurrentLiabilities",
            "totalAssets",
          ] as const
        )[integer(0, 2)]!;
        balanceSheet[name] = 1;
      }

      // Families are usually filed together; sometimes one lags by a week or more, and very
      // occasionally a quarter of one family is never reported at all.
      const lag = () => (pick(0.15) ? integer(1, 20) : 0);
      const families: [FinancialStatementType, Record<string, number>][] = [
        ["INCOME", income],
        ["CASH_FLOW", cashFlow],
        ["BALANCE_SHEET", balanceSheet],
      ];
      for (const [type, values] of families) {
        if (pick(0.02)) {
          continue;
        }
        const available = addDays(filed, 1 + lag());
        const currency = currencyOf(fiscalYear);
        emit(type, fiscalYear, period, fiscalDate, available, values, currency);
        if (pick(0.12)) {
          // A later restatement of the same fiscal identity: perturbed values, sometimes with a
          // field removed or a sign flipped, eligible only from its own availability date.
          const restated = Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
              name,
              pick(0.3) ? -value : Math.round(value * (0.8 + next() * 0.4)),
            ]),
          );
          emit(
            type,
            fiscalYear,
            period,
            fiscalDate,
            addDays(available, integer(30, 500)),
            restated,
            // A restatement can change the reported currency too.
            scenario.currency ? currencyOf(fiscalYear) : currency,
          );
        }
      }
    }
    // Annual rows exist and carry large, different values: no metric may read them.
    const yearEnd = monthEnd(fiscalYear, scenario.fiscalYearEndMonth);
    const annualAvailable = addDays(yearEnd, integer(40, 80));
    for (const type of ["INCOME", "CASH_FLOW", "BALANCE_SHEET"] as const) {
      emit(
        type,
        fiscalYear,
        "FY",
        yearEnd,
        annualAvailable,
        {
          revenue: 9e9,
          grossProfit: 9e9,
          operatingIncome: 9e9,
          netIncome: 9e9,
          epsDiluted: 999,
          ebitda: 9e9,
          ebit: 9e9,
          interestExpense: 1,
          operatingCashFlow: 9e9,
          capitalExpenditure: -1,
          totalDebt: 1,
          totalStockholdersEquity: 1,
          totalAssets: 1,
          totalCurrentAssets: 9e9,
          totalCurrentLiabilities: 1,
          netDebt: 9e9,
        },
        "USD",
      );
    }
  }
  return rows;
}

/** A few fixed exchange holidays each year, so availability also lands on closed weekdays. */
export function holidays(firstYear: number, lastYear: number): string[] {
  const dates: string[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    dates.push(`${year}-01-01`, `${year}-07-04`, `${year}-12-25`);
  }
  return dates;
}
