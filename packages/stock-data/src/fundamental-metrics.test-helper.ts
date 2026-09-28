import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";

/**
 * Statement fixtures for the Fundamental Metrics suites.
 *
 * Test support, not product code: deliberately not exported from `index.ts`, and the
 * `.test-helper` suffix keeps Vitest from collecting it as a suite. Every fixture names its fiscal
 * identity and its `availableFromDate` explicitly, and a missing field is an absent key — never a
 * zero standing in for it.
 */

export const SECURITY_ID = "security-fundamentals";

export type Quarter = {
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
};

export type Values = Record<string, number>;

/** Period ends of a calendar-year filer. */
const CALENDAR_PERIOD_END: Record<FinancialPeriod, string> = {
  FY: "12-31",
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
};

export function quarter(
  fiscalYear: number,
  period: Quarter["period"],
): Quarter {
  return { fiscalYear, period };
}

export function quartersOf(fiscalYear: number): Quarter[] {
  return (["Q1", "Q2", "Q3", "Q4"] as const).map((period) =>
    quarter(fiscalYear, period),
  );
}

export function calendarFiscalDate(
  fiscalYear: number,
  period: FinancialPeriod,
): string {
  return `${fiscalYear}-${CALENDAR_PERIOD_END[period]}`;
}

export function statement(
  statementType: FinancialStatementType,
  { fiscalYear, period }: { fiscalYear: number; period: FinancialPeriod },
  values: Values,
  availableFromDate: string,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  const fiscalDate =
    overrides.fiscalDate ?? calendarFiscalDate(fiscalYear, period);
  return {
    securityId: SECURITY_ID,
    statementType,
    fiscalDate,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate: availableFromDate,
    availableFromDate,
    // Deliberately observed long after availability: observation never decides eligibility.
    observedAt: "2026-09-29T12:00:00.000Z",
    contentHash: `${statementType}:${fiscalYear}:${period}:${availableFromDate}:${JSON.stringify(values)}`,
    values,
    ...overrides,
  };
}

/** A copy with one field removed: the provider did not report it. */
export function without(values: Values, ...fields: string[]): Values {
  const copy = { ...values };
  for (const field of fields) {
    delete copy[field];
  }
  return copy;
}

/**
 * The golden fixture every hand-derived vector is computed from.
 *
 * Calendar fiscal years, all statements eligible from {@link GOLDEN_AVAILABLE}:
 *
 * - Income FY2024 Q1-Q4 (the previous TTM) and FY2025 Q1-Q4 (the current TTM);
 * - Cash Flow for the same eight quarters, with provider `freeCashFlow` deliberately wrong;
 * - Balance Sheet FY2024 Q4 (the opening state), FY2025 Q4 (the ending and latest state) and
 *   decoy FY2025 Q1-Q3 states whose use would change every aligned answer;
 * - annual FY rows with different values, which no V1 metric may read.
 *
 * Quarterly margins are deliberately unequal, so a ratio of sums and a mean of quarterly ratios
 * give different answers; share counts change every quarter, so EPS can only be summed.
 */
export const GOLDEN_AVAILABLE = "2026-02-16";
export const GOLDEN_DATE = "2026-03-02";

export const GOLDEN_INCOME: Record<string, Values> = {
  "2024-Q1": {
    revenue: 100,
    grossProfit: 40,
    operatingIncome: 10,
    netIncome: 5,
    epsDiluted: 0.5,
    ebitda: 15,
    ebit: 11,
    interestExpense: 2,
    weightedAverageShsOutDil: 10,
  },
  "2024-Q2": {
    revenue: 110,
    grossProfit: 44,
    operatingIncome: 11,
    netIncome: 5,
    epsDiluted: 0.5,
    ebitda: 16,
    ebit: 12,
    interestExpense: 2,
    weightedAverageShsOutDil: 10,
  },
  "2024-Q3": {
    revenue: 120,
    grossProfit: 48,
    operatingIncome: 12,
    netIncome: 6,
    epsDiluted: 0.6,
    ebitda: 17,
    ebit: 13,
    interestExpense: 2,
    weightedAverageShsOutDil: 10,
  },
  "2024-Q4": {
    revenue: 130,
    grossProfit: 52,
    operatingIncome: 13,
    netIncome: 6,
    epsDiluted: 0.6,
    ebitda: 18,
    ebit: 14,
    interestExpense: 2,
    weightedAverageShsOutDil: 10,
  },
  "2025-Q1": {
    revenue: 120,
    grossProfit: 30,
    operatingIncome: 12,
    netIncome: 6,
    epsDiluted: 0.6,
    ebitda: 20,
    ebit: 14,
    interestExpense: 2,
    weightedAverageShsOutDil: 10,
    incomeBeforeTax: 12,
    incomeTaxExpense: 6,
  },
  "2025-Q2": {
    revenue: 130,
    grossProfit: 52,
    operatingIncome: 13,
    netIncome: 13,
    epsDiluted: 0.65,
    ebitda: 22,
    ebit: 15,
    interestExpense: 2,
    weightedAverageShsOutDil: 20,
    incomeBeforeTax: 26,
    incomeTaxExpense: 13,
  },
  "2025-Q3": {
    revenue: 140,
    grossProfit: 70,
    operatingIncome: 28,
    netIncome: 14,
    epsDiluted: 0.7,
    ebitda: 35,
    ebit: 30,
    interestExpense: 3,
    weightedAverageShsOutDil: 20,
    incomeBeforeTax: 28,
    incomeTaxExpense: 14,
  },
  "2025-Q4": {
    revenue: 150,
    grossProfit: 90,
    operatingIncome: 45,
    netIncome: 30,
    epsDiluted: 0.85,
    ebitda: 53,
    ebit: 47,
    interestExpense: 3,
    weightedAverageShsOutDil: 35,
    incomeBeforeTax: 60,
    incomeTaxExpense: 30,
  },
};

export const GOLDEN_CASH_FLOW: Record<string, Values> = {
  "2024-Q1": {
    operatingCashFlow: 20,
    capitalExpenditure: -5,
    freeCashFlow: 999,
  },
  "2024-Q2": {
    operatingCashFlow: 25,
    capitalExpenditure: -5,
    freeCashFlow: 999,
  },
  "2024-Q3": {
    operatingCashFlow: 30,
    capitalExpenditure: -10,
    freeCashFlow: 999,
  },
  "2024-Q4": {
    operatingCashFlow: 35,
    capitalExpenditure: -10,
    freeCashFlow: 999,
  },
  "2025-Q1": {
    operatingCashFlow: 30,
    capitalExpenditure: -10,
    freeCashFlow: 999,
  },
  "2025-Q2": {
    operatingCashFlow: 35,
    capitalExpenditure: -10,
    freeCashFlow: 999,
  },
  "2025-Q3": {
    operatingCashFlow: 40,
    capitalExpenditure: -15,
    freeCashFlow: 999,
  },
  "2025-Q4": {
    operatingCashFlow: 45,
    capitalExpenditure: -15,
    freeCashFlow: 999,
  },
};

export const GOLDEN_OPENING_BALANCE_SHEET: Values = {
  totalDebt: 200,
  totalStockholdersEquity: 400,
  totalEquity: 450,
  cashAndShortTermInvestments: 100,
  cashAndCashEquivalents: 60,
  totalAssets: 1000,
  totalCurrentAssets: 300,
  totalCurrentLiabilities: 200,
  netDebt: 140,
};

export const GOLDEN_ENDING_BALANCE_SHEET: Values = {
  totalDebt: 220,
  totalStockholdersEquity: 500,
  totalEquity: 560,
  cashAndShortTermInvestments: 120,
  cashAndCashEquivalents: 80,
  totalAssets: 1200,
  totalCurrentAssets: 360,
  totalCurrentLiabilities: 225,
  netDebt: 100,
};

/** Interior states that no aligned or latest-state metric may read. */
export const GOLDEN_DECOY_BALANCE_SHEET: Values = {
  totalDebt: 9_000,
  totalStockholdersEquity: 50,
  totalEquity: 60,
  cashAndShortTermInvestments: 1,
  cashAndCashEquivalents: 1,
  totalAssets: 20_000,
  totalCurrentAssets: 7,
  totalCurrentLiabilities: 3,
  netDebt: 8_999,
};

/** Hand-derived expectations for {@link goldenStatements}; derivations in the formula suite. */
export const GOLDEN_EXPECTED = {
  revenueGrowthTtmYoy: 17.391304347826086, // (540 / 460 - 1) * 100 = 400/23
  epsGrowthTtmYoy: 27.272727272727273, // (2.8 / 2.2 - 1) * 100 = 300/11
  fcfGrowthTtmYoy: 25, // (100 / 80 - 1) * 100
  grossMarginTtm: 44.81481481481482, // 242 / 540 * 100 = 1210/27
  operatingMarginTtm: 18.14814814814815, // 98 / 540 * 100 = 490/27
  netMarginTtm: 11.666666666666666, // 63 / 540 * 100 = 35/3
  fcfMarginTtm: 18.51851851851852, // 100 / 540 * 100 = 500/27
  roicTtm: 14.076363636363636, // 98 * 0.79 / ((500 + 600) / 2) * 100 = 3871/275
  roeTtm: 14, // 63 / ((400 + 500) / 2) * 100
  roaTtm: 5.7272727272727275, // 63 / ((1000 + 1200) / 2) * 100 = 63/11
  debtToEquity: 0.44, // 220 / 500
  currentRatio: 1.6, // 360 / 225
  netDebtToEbitdaTtm: 0.7692307692307693, // 100 / 130 = 10/13
  interestCoverageTtm: 10.6, // 106 / 10
  assetTurnoverTtm: 0.4909090909090909, // 540 / 1100 = 27/55
} as const;

function key(fiscalYear: number, period: string): string {
  return `${fiscalYear}-${period}`;
}

export function goldenStatements(
  options: {
    available?: string;
    fiscalDate?: (fiscalYear: number, period: FinancialPeriod) => string;
  } = {},
): FinancialStatement[] {
  const available = options.available ?? GOLDEN_AVAILABLE;
  const dated = (fiscalYear: number, period: FinancialPeriod) =>
    options.fiscalDate
      ? { fiscalDate: options.fiscalDate(fiscalYear, period) }
      : {};
  const rows: FinancialStatement[] = [];
  for (const fiscalYear of [2024, 2025]) {
    for (const each of quartersOf(fiscalYear)) {
      rows.push(
        statement(
          "INCOME",
          each,
          GOLDEN_INCOME[key(fiscalYear, each.period)]!,
          available,
          dated(fiscalYear, each.period),
        ),
        statement(
          "CASH_FLOW",
          each,
          GOLDEN_CASH_FLOW[key(fiscalYear, each.period)]!,
          available,
          dated(fiscalYear, each.period),
        ),
      );
    }
  }
  rows.push(
    statement(
      "BALANCE_SHEET",
      quarter(2024, "Q4"),
      GOLDEN_OPENING_BALANCE_SHEET,
      available,
      dated(2024, "Q4"),
    ),
    ...(["Q1", "Q2", "Q3"] as const).map((period) =>
      statement(
        "BALANCE_SHEET",
        quarter(2025, period),
        GOLDEN_DECOY_BALANCE_SHEET,
        available,
        dated(2025, period),
      ),
    ),
    statement(
      "BALANCE_SHEET",
      quarter(2025, "Q4"),
      GOLDEN_ENDING_BALANCE_SHEET,
      available,
      dated(2025, "Q4"),
    ),
  );
  // Annual rows with very different values: an FY row may never stand in for a quarter.
  for (const fiscalYear of [2024, 2025]) {
    rows.push(
      statement(
        "INCOME",
        { fiscalYear, period: "FY" },
        {
          revenue: 10_000,
          grossProfit: 9_000,
          operatingIncome: 8_000,
          netIncome: 7_000,
          epsDiluted: 70,
          ebitda: 9_500,
          ebit: 8_500,
          interestExpense: 1,
        },
        available,
        dated(fiscalYear, "FY"),
      ),
      statement(
        "CASH_FLOW",
        { fiscalYear, period: "FY" },
        { operatingCashFlow: 5_000, capitalExpenditure: -1 },
        available,
        dated(fiscalYear, "FY"),
      ),
      statement(
        "BALANCE_SHEET",
        { fiscalYear, period: "FY" },
        GOLDEN_DECOY_BALANCE_SHEET,
        available,
        dated(fiscalYear, "FY"),
      ),
    );
  }
  return rows;
}

/** The statement of one family and fiscal quarter in a fixture, which must exist exactly once. */
function findStatement(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
  target: Quarter,
): FinancialStatement {
  const matches = statements.filter(
    (each) =>
      each.statementType === statementType &&
      each.fiscalYear === target.fiscalYear &&
      each.period === target.period,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${statementType} ${target.fiscalYear} ${target.period}`,
    );
  }
  return matches[0]!;
}

/** A copy of the fixture with one statement's values replaced. */
export function replaceValues(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
  target: Quarter,
  values: (current: Values) => Values,
): FinancialStatement[] {
  const original = findStatement(statements, statementType, target);
  return statements.map((each) =>
    each === original
      ? { ...each, values: values(each.values as Values) }
      : each,
  );
}

/** A copy of the fixture with one statement removed entirely: the quarter was never reported. */
export function removeStatement(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
  target: Quarter,
): FinancialStatement[] {
  const original = findStatement(statements, statementType, target);
  return statements.filter((each) => each !== original);
}

/** Deterministic Fisher-Yates shuffle, so a failure reproduces. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

/** Deep-frozen copy: any write by the code under test throws in strict mode. */
export function deepFrozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node && typeof node === "object") {
      Object.freeze(node);
      for (const child of Object.values(node)) {
        freeze(child);
      }
    }
  };
  freeze(copy);
  return copy;
}

/** Weekdays from `from` through `to`, optionally minus exchange holidays. */
export function weekdays(
  from: string,
  to: string,
  holidays: readonly string[] = [],
): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    const date = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.includes(date)) {
      dates.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
