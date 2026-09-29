import { describe, expect, it } from "vitest";
import {
  ORACLE_FUNDAMENTAL_METRICS,
  ORACLE_ROIC_TAX_RATE,
  oracleFundamentalMetrics,
  oracleFundamentalOutcomes,
  oracleLineItem,
  oracleNearestDouble,
  type OracleFundamentalMetricId,
  type OracleFundamentalOutcome,
  type OracleFundamentalStatement,
} from "./fundamentals";

/**
 * Golden vectors for the reference Fundamental Metrics (`docs/decisions/fundamental-metrics-v1.md`).
 *
 * Every expected number is worked out by hand in the comment beside it, from the fixture below.
 * None is produced by production code, and none was read off the oracle first.
 */

type Statement = OracleFundamentalStatement;
type Family = Statement["statementType"];
type Quarter = "Q1" | "Q2" | "Q3" | "Q4";
type Values = Record<string, unknown>;
type Id = OracleFundamentalMetricId;
type Outcome = OracleFundamentalOutcome;

const QUARTERS: readonly Quarter[] = ["Q1", "Q2", "Q3", "Q4"];
const SECURITY = "security-1";

/** The evaluation date: every fixture statement is available by 2025-02-01. */
const D = "2025-03-01";
/** A date after every 2025 quarter the anchoring tests add (Q1..Q3 2025 are available by 2025-11-01). */
const LATER = "2025-12-01";

function value(
  numerator: bigint,
  denominator: bigint,
  double: number,
): Outcome {
  return { status: "VALUE", exact: { numerator, denominator }, value: double };
}

function unavailable(reason: string): Outcome {
  return { status: "UNAVAILABLE", reason };
}

const ZERO_READING = value(0n, 1n, 0);

// ---------------------------------------------------------------------------------------------
// The fixture: calendar fiscal years 2023 (previous window) and 2024 (current window)
// ---------------------------------------------------------------------------------------------

const PERIOD_END: Record<Quarter, (year: number) => string> = {
  Q1: (year) => `${year}-03-31`,
  Q2: (year) => `${year}-06-30`,
  Q3: (year) => `${year}-09-30`,
  Q4: (year) => `${year}-12-31`,
};

/** The day each quarter's filing makes it usable: Q4 of year N is available on 1 February N + 1. */
const AVAILABLE_FROM: Record<Quarter, (year: number) => string> = {
  Q1: (year) => `${year}-05-01`,
  Q2: (year) => `${year}-08-01`,
  Q3: (year) => `${year}-11-01`,
  Q4: (year) => `${year + 1}-02-01`,
};

function quarter(
  statementType: Family,
  fiscalYear: number,
  period: Quarter,
  values: Values,
  overrides: Partial<Statement> = {},
): Statement {
  const availableFromDate = AVAILABLE_FROM[period](fiscalYear);
  return {
    securityId: SECURITY,
    statementType,
    fiscalYear,
    period,
    fiscalDate: PERIOD_END[period](fiscalYear),
    reportedCurrency: "USD",
    availableFromDate,
    observedAt: `${availableFromDate}T12:00:00.000Z`,
    contentHash: `${statementType}:${fiscalYear}:${period}:v1`,
    values,
    ...overrides,
  };
}

function annual(
  statementType: Family,
  fiscalYear: number,
  values: Values,
): Statement {
  return {
    securityId: SECURITY,
    statementType,
    fiscalYear,
    period: "FY",
    fiscalDate: `${fiscalYear}-12-31`,
    reportedCurrency: "USD",
    availableFromDate: `${fiscalYear + 1}-02-15`,
    observedAt: `${fiscalYear + 1}-02-15T12:00:00.000Z`,
    contentHash: `${statementType}:${fiscalYear}:FY:v1`,
    values,
  };
}

// Income 2023: revenue 17+19+21+23 = 80; epsDiluted 4 x 0.5 = 2; grossProfit 7+8+8+9 = 32;
// operatingIncome 3+4+4+5 = 16; netIncome 4 x 2 = 8; ebitda 4 x 6 = 24; ebit 4 x 4 = 16;
// interestExpense 4 x 1 = 4.
const INCOME_2023: Record<Quarter, Values> = {
  Q1: {
    revenue: 17,
    grossProfit: 7,
    operatingIncome: 3,
    netIncome: 2,
    epsDiluted: 0.5,
    ebitda: 6,
    ebit: 4,
    interestExpense: 1,
  },
  Q2: {
    revenue: 19,
    grossProfit: 8,
    operatingIncome: 4,
    netIncome: 2,
    epsDiluted: 0.5,
    ebitda: 6,
    ebit: 4,
    interestExpense: 1,
  },
  Q3: {
    revenue: 21,
    grossProfit: 8,
    operatingIncome: 4,
    netIncome: 2,
    epsDiluted: 0.5,
    ebitda: 6,
    ebit: 4,
    interestExpense: 1,
  },
  Q4: {
    revenue: 23,
    grossProfit: 9,
    operatingIncome: 5,
    netIncome: 2,
    epsDiluted: 0.5,
    ebitda: 6,
    ebit: 4,
    interestExpense: 1,
  },
};

// Income 2024: revenue 22+24+26+28 = 100; grossProfit 9+10+10+11 = 40; operatingIncome 4+5+5+6 = 20;
// netIncome 2+3+3+4 = 12; epsDiluted 0.55+0.6+0.6+0.65 = 2.4; ebitda 7+8+8+9 = 32;
// ebit 5+6+6+7 = 24; interestExpense 4 x 1.5 = 6.
const INCOME_2024: Record<Quarter, Values> = {
  Q1: {
    revenue: 22,
    grossProfit: 9,
    operatingIncome: 4,
    netIncome: 2,
    epsDiluted: 0.55,
    ebitda: 7,
    ebit: 5,
    interestExpense: 1.5,
  },
  Q2: {
    revenue: 24,
    grossProfit: 10,
    operatingIncome: 5,
    netIncome: 3,
    epsDiluted: 0.6,
    ebitda: 8,
    ebit: 6,
    interestExpense: 1.5,
  },
  Q3: {
    revenue: 26,
    grossProfit: 10,
    operatingIncome: 5,
    netIncome: 3,
    epsDiluted: 0.6,
    ebitda: 8,
    ebit: 6,
    interestExpense: 1.5,
  },
  Q4: {
    revenue: 28,
    grossProfit: 11,
    operatingIncome: 6,
    netIncome: 4,
    epsDiluted: 0.65,
    ebitda: 9,
    ebit: 7,
    interestExpense: 1.5,
  },
};

// Cash flow 2023: FCF 4 x (7 - 3) = 16. Provider freeCashFlow is carried but never read.
const CASH_FLOW_2023: Record<Quarter, Values> = {
  Q1: { operatingCashFlow: 7, capitalExpenditure: -3, freeCashFlow: 4 },
  Q2: { operatingCashFlow: 7, capitalExpenditure: -3, freeCashFlow: 4 },
  Q3: { operatingCashFlow: 7, capitalExpenditure: -3, freeCashFlow: 4 },
  Q4: { operatingCashFlow: 7, capitalExpenditure: -3, freeCashFlow: 4 },
};

// Cash flow 2024: FCF (8-3)+(9-3)+(9-3)+(10-3) = 5+6+6+7 = 24.
const CASH_FLOW_2024: Record<Quarter, Values> = {
  Q1: { operatingCashFlow: 8, capitalExpenditure: -3, freeCashFlow: 5 },
  Q2: { operatingCashFlow: 9, capitalExpenditure: -3, freeCashFlow: 6 },
  Q3: { operatingCashFlow: 9, capitalExpenditure: -3, freeCashFlow: 6 },
  Q4: { operatingCashFlow: 10, capitalExpenditure: -3, freeCashFlow: 7 },
};

/** 2023 Q4, the opening state of the 2024 window. Invested capital 30 + 80 - 10 = 100. */
const OPENING_SHEET: Values = {
  totalAssets: 150,
  totalStockholdersEquity: 80,
  totalEquity: 85,
  totalDebt: 30,
  cashAndShortTermInvestments: 10,
  cashAndCashEquivalents: 8,
  totalCurrentAssets: 60,
  totalCurrentLiabilities: 40,
  netDebt: 22,
};

/** 2024 Q4, the ending state and the latest balance sheet. Invested capital 36 + 80 - 16 = 100. */
const ENDING_SHEET: Values = {
  totalAssets: 250,
  totalStockholdersEquity: 80,
  totalEquity: 90,
  totalDebt: 36,
  cashAndShortTermInvestments: 16,
  cashAndCashEquivalents: 12,
  totalCurrentAssets: 75,
  totalCurrentLiabilities: 50,
  netDebt: 20,
};

/** Eight Income and eight Cash Flow quarters, and the two balance sheets the 2024 window needs. */
function base(): Statement[] {
  const statements: Statement[] = [];
  for (const period of QUARTERS) {
    statements.push(quarter("INCOME", 2023, period, INCOME_2023[period]));
    statements.push(quarter("INCOME", 2024, period, INCOME_2024[period]));
    statements.push(quarter("CASH_FLOW", 2023, period, CASH_FLOW_2023[period]));
    statements.push(quarter("CASH_FLOW", 2024, period, CASH_FLOW_2024[period]));
  }
  statements.push(quarter("BALANCE_SHEET", 2023, "Q4", OPENING_SHEET));
  statements.push(quarter("BALANCE_SHEET", 2024, "Q4", ENDING_SHEET));
  return statements;
}

function matches(
  statement: Statement,
  family: Family,
  fiscalYear: number,
  period: Statement["period"],
): boolean {
  return (
    statement.statementType === family &&
    statement.fiscalYear === fiscalYear &&
    statement.period === period
  );
}

/** One quarter's line items changed; a change to `undefined` removes the line item. */
function patch(
  statements: readonly Statement[],
  family: Family,
  fiscalYear: number,
  period: Statement["period"],
  changes: Values,
): Statement[] {
  let found = false;
  const patched = statements.map((statement) => {
    if (!matches(statement, family, fiscalYear, period)) {
      return statement;
    }
    found = true;
    const values: Values = { ...statement.values };
    for (const [field, change] of Object.entries(changes)) {
      if (change === undefined) {
        delete values[field];
      } else {
        values[field] = change;
      }
    }
    return { ...statement, values };
  });
  if (!found) {
    throw new Error(`fixture has no ${family} ${fiscalYear} ${period}`);
  }
  return patched;
}

/** Several quarters of one fiscal year patched at once. */
function patchYear(
  statements: readonly Statement[],
  family: Family,
  fiscalYear: number,
  changes: Partial<Record<Quarter, Values>>,
): Statement[] {
  let patched = [...statements];
  for (const period of QUARTERS) {
    const change = changes[period];
    if (change !== undefined) {
      patched = patch(patched, family, fiscalYear, period, change);
    }
  }
  return patched;
}

/** One quarter's metadata changed (a currency, a date). */
function restamp(
  statements: readonly Statement[],
  family: Family,
  fiscalYear: number,
  period: Statement["period"],
  overrides: Partial<Statement>,
): Statement[] {
  let found = false;
  const restamped = statements.map((statement) => {
    if (!matches(statement, family, fiscalYear, period)) {
      return statement;
    }
    found = true;
    return { ...statement, ...overrides };
  });
  if (!found) {
    throw new Error(`fixture has no ${family} ${fiscalYear} ${period}`);
  }
  return restamped;
}

function drop(
  statements: readonly Statement[],
  family: Family,
  fiscalYear: number,
  period: Statement["period"],
): Statement[] {
  const kept = statements.filter(
    (statement) => !matches(statement, family, fiscalYear, period),
  );
  if (kept.length === statements.length) {
    throw new Error(`fixture has no ${family} ${fiscalYear} ${period}`);
  }
  return kept;
}

function outcomes(statements: readonly Statement[], date = D) {
  return oracleFundamentalOutcomes(statements, date);
}

function expectSome(
  actual: Record<Id, Outcome>,
  expected: Partial<Record<Id, Outcome>>,
): void {
  for (const [id, outcome] of Object.entries(expected)) {
    expect(actual[id as Id], id).toEqual(outcome);
  }
}

/** A metric, the statements that make its point, and the hand-computed outcome. */
type Case = readonly [
  name: string,
  metric: Id,
  statements: () => Statement[],
  expected: Outcome,
  date?: string,
];

function cases(list: readonly Case[]): void {
  for (const [name, metric, statements, expected, date] of list) {
    it(name, () => {
      expect(outcomes(statements(), date ?? D)[metric]).toEqual(expected);
    });
  }
}

/** The base fixture on D, every value worked out from the sums in the fixture comments. */
const BASE: Record<Id, Outcome> = {
  // (100 / 80 - 1) x 100 = 25
  REVENUE_GROWTH_TTM_YOY: value(25n, 1n, 25),
  // (2.4 / 2 - 1) x 100 = 20
  EPS_GROWTH_TTM_YOY: value(20n, 1n, 20),
  // (24 / 16 - 1) x 100 = 50
  FCF_GROWTH_TTM_YOY: value(50n, 1n, 50),
  // 40 / 100 x 100 = 40
  GROSS_MARGIN_TTM: value(40n, 1n, 40),
  // 20 / 100 x 100 = 20
  OPERATING_MARGIN_TTM: value(20n, 1n, 20),
  // 12 / 100 x 100 = 12
  NET_MARGIN_TTM: value(12n, 1n, 12),
  // 24 / 100 x 100 = 24
  FCF_MARGIN_TTM: value(24n, 1n, 24),
  // NOPAT 20 x (1 - 0.21) = 15.8; average invested capital (100 + 100) / 2 = 100; 15.8 / 100 x 100
  ROIC_TTM: value(79n, 5n, 15.8),
  // 12 / ((80 + 80) / 2) x 100 = 15
  ROE_TTM: value(15n, 1n, 15),
  // 12 / ((150 + 250) / 2) x 100 = 6
  ROA_TTM: value(6n, 1n, 6),
  // 36 / 80 = 0.45
  DEBT_TO_EQUITY: value(9n, 20n, 0.45),
  // 75 / 50 = 1.5
  CURRENT_RATIO: value(3n, 2n, 1.5),
  // 20 / 32 = 0.625
  NET_DEBT_TO_EBITDA_TTM: value(5n, 8n, 0.625),
  // 24 / 6 = 4
  INTEREST_COVERAGE_TTM: value(4n, 1n, 4),
  // 100 / ((150 + 250) / 2) = 0.5
  ASSET_TURNOVER_TTM: value(1n, 2n, 0.5),
};

// A later revision of 2024 Q4 in every family, first usable on 2025-06-02.
const RESTATED_INCOME_Q4: Values = {
  revenue: 48,
  grossProfit: 25,
  operatingIncome: 16,
  netIncome: 10,
  epsDiluted: 0.85,
  ebitda: 17,
  ebit: 13,
  interestExpense: 1.5,
};
const RESTATED_CASH_FLOW_Q4: Values = {
  operatingCashFlow: 16,
  capitalExpenditure: -3,
};
const RESTATED_ENDING_SHEET: Values = {
  totalAssets: 350,
  totalStockholdersEquity: 120,
  totalEquity: 125,
  totalDebt: 60,
  cashAndShortTermInvestments: 40,
  cashAndCashEquivalents: 30,
  totalCurrentAssets: 96,
  totalCurrentLiabilities: 60,
  netDebt: 26,
};

function revision(
  family: Family,
  values: Values,
  overrides: Partial<Statement> = {},
): Statement {
  return quarter(family, 2024, "Q4", values, {
    availableFromDate: "2025-06-02",
    observedAt: "2025-06-01T12:00:00.000Z",
    contentHash: `${family}:2024:Q4:v2`,
    ...overrides,
  });
}

function restated(): Statement[] {
  return [
    ...base(),
    revision("INCOME", RESTATED_INCOME_Q4),
    revision("CASH_FLOW", RESTATED_CASH_FLOW_Q4),
    revision("BALANCE_SHEET", RESTATED_ENDING_SHEET),
  ];
}

/** Every metric once all three 2024 Q4 restatements are the representing revisions. */
const RESTATED: Record<Id, Outcome> = {
  // current revenue 22+24+26+48 = 120; (120 / 80 - 1) x 100 = 50
  REVENUE_GROWTH_TTM_YOY: value(50n, 1n, 50),
  // current EPS 0.55+0.6+0.6+0.85 = 2.6; (2.6 / 2 - 1) x 100 = 30
  EPS_GROWTH_TTM_YOY: value(30n, 1n, 30),
  // current FCF 5+6+6+(16-3) = 30; (30 / 16 - 1) x 100 = 87.5
  FCF_GROWTH_TTM_YOY: value(175n, 2n, 87.5),
  // gross profit 9+10+10+25 = 54; 54 / 120 x 100 = 45
  GROSS_MARGIN_TTM: value(45n, 1n, 45),
  // operating income 4+5+5+16 = 30; 30 / 120 x 100 = 25
  OPERATING_MARGIN_TTM: value(25n, 1n, 25),
  // net income 2+3+3+10 = 18; 18 / 120 x 100 = 15
  NET_MARGIN_TTM: value(15n, 1n, 15),
  // 30 / 120 x 100 = 25
  FCF_MARGIN_TTM: value(25n, 1n, 25),
  // NOPAT 30 x 0.79 = 23.7; ending capital 60+120-40 = 140; average (100+140)/2 = 120; 23.7/120 x 100 = 19.75
  ROIC_TTM: value(79n, 4n, 19.75),
  // 18 / ((80 + 120) / 2) x 100 = 18
  ROE_TTM: value(18n, 1n, 18),
  // 18 / ((150 + 350) / 2) x 100 = 7.2
  ROA_TTM: value(36n, 5n, 7.2),
  // 60 / 120 = 0.5
  DEBT_TO_EQUITY: value(1n, 2n, 0.5),
  // 96 / 60 = 1.6
  CURRENT_RATIO: value(8n, 5n, 1.6),
  // EBITDA 7+8+8+17 = 40; 26 / 40 = 0.65
  NET_DEBT_TO_EBITDA_TTM: value(13n, 20n, 0.65),
  // EBIT 5+6+6+13 = 30; 30 / 6 = 5
  INTEREST_COVERAGE_TTM: value(5n, 1n, 5),
  // 120 / ((150 + 350) / 2) = 0.48
  ASSET_TURNOVER_TTM: value(12n, 25n, 0.48),
};

/** Every metric when only Income 2024 Q4 is represented by RESTATED_INCOME_Q4. */
const INCOME_Q4_REPLACED: Record<Id, Outcome> = {
  REVENUE_GROWTH_TTM_YOY: value(50n, 1n, 50), // (120 / 80 - 1) x 100
  EPS_GROWTH_TTM_YOY: value(30n, 1n, 30), // (2.6 / 2 - 1) x 100
  FCF_GROWTH_TTM_YOY: BASE.FCF_GROWTH_TTM_YOY, // cash flow unchanged
  GROSS_MARGIN_TTM: value(45n, 1n, 45), // 54 / 120 x 100
  OPERATING_MARGIN_TTM: value(25n, 1n, 25), // 30 / 120 x 100
  NET_MARGIN_TTM: value(15n, 1n, 15), // 18 / 120 x 100
  FCF_MARGIN_TTM: value(20n, 1n, 20), // 24 / 120 x 100
  ROIC_TTM: value(237n, 10n, 23.7), // 30 x 0.79 = 23.7; / 100 x 100
  ROE_TTM: value(45n, 2n, 22.5), // 18 / 80 x 100
  ROA_TTM: value(9n, 1n, 9), // 18 / 200 x 100
  DEBT_TO_EQUITY: BASE.DEBT_TO_EQUITY,
  CURRENT_RATIO: BASE.CURRENT_RATIO,
  NET_DEBT_TO_EBITDA_TTM: value(1n, 2n, 0.5), // 20 / 40
  INTEREST_COVERAGE_TTM: value(5n, 1n, 5), // 30 / 6
  ASSET_TURNOVER_TTM: value(3n, 5n, 0.6), // 120 / 200
};

/** Income 2025 Q1, one quarter past the fixture (available 2025-05-01). */
const INCOME_2025_Q1: Values = {
  revenue: 22,
  grossProfit: 19,
  operatingIncome: 4,
  netIncome: 2,
  epsDiluted: 0.55,
  ebitda: 7,
  ebit: 5,
  interestExpense: 1.5,
};

/** A 2025 Q1 balance sheet very unlike the fixture's (available 2025-05-01). */
const NEWER_SHEET: Values = {
  totalAssets: 1000,
  totalStockholdersEquity: 500,
  totalEquity: 510,
  totalDebt: 100,
  cashAndShortTermInvestments: 50,
  cashAndCashEquivalents: 40,
  totalCurrentAssets: 300,
  totalCurrentLiabilities: 100,
  netDebt: 64,
};

const INCOME_FLOW_METRICS: readonly Id[] = [
  "REVENUE_GROWTH_TTM_YOY",
  "EPS_GROWTH_TTM_YOY",
  "GROSS_MARGIN_TTM",
  "OPERATING_MARGIN_TTM",
  "NET_MARGIN_TTM",
  "FCF_MARGIN_TTM",
  "ROIC_TTM",
  "ROE_TTM",
  "ROA_TTM",
  "NET_DEBT_TO_EBITDA_TTM",
  "INTEREST_COVERAGE_TTM",
  "ASSET_TURNOVER_TTM",
];

const AVERAGED_STATE_METRICS: readonly Id[] = [
  "ROIC_TTM",
  "ROE_TTM",
  "ROA_TTM",
  "ASSET_TURNOVER_TTM",
];

function every(
  reason: string,
  ids: readonly Id[],
): Partial<Record<Id, Outcome>> {
  return Object.fromEntries(ids.map((id) => [id, unavailable(reason)]));
}

// ---------------------------------------------------------------------------------------------

describe("fundamental metrics catalog (ADR Scope table)", () => {
  it("has exactly the fifteen metrics, in the ADR's order, with its storage fields and units", () => {
    expect(
      ORACLE_FUNDAMENTAL_METRICS.map(({ id, column, unit }) => [
        id,
        column,
        unit,
      ]),
    ).toEqual([
      ["REVENUE_GROWTH_TTM_YOY", "revenueGrowthTtmYoy", "PERCENT"],
      ["EPS_GROWTH_TTM_YOY", "epsGrowthTtmYoy", "PERCENT"],
      ["FCF_GROWTH_TTM_YOY", "fcfGrowthTtmYoy", "PERCENT"],
      ["GROSS_MARGIN_TTM", "grossMarginTtm", "PERCENT"],
      ["OPERATING_MARGIN_TTM", "operatingMarginTtm", "PERCENT"],
      ["NET_MARGIN_TTM", "netMarginTtm", "PERCENT"],
      ["FCF_MARGIN_TTM", "fcfMarginTtm", "PERCENT"],
      ["ROIC_TTM", "roicTtm", "PERCENT"],
      ["ROE_TTM", "roeTtm", "PERCENT"],
      ["ROA_TTM", "roaTtm", "PERCENT"],
      ["DEBT_TO_EQUITY", "debtToEquity", "MULTIPLE"],
      ["CURRENT_RATIO", "currentRatio", "MULTIPLE"],
      ["NET_DEBT_TO_EBITDA_TTM", "netDebtToEbitdaTtm", "MULTIPLE"],
      ["INTEREST_COVERAGE_TTM", "interestCoverageTtm", "MULTIPLE"],
      ["ASSET_TURNOVER_TTM", "assetTurnoverTtm", "MULTIPLE"],
    ]);
    expect(Object.keys(outcomes(base()))).toEqual(
      ORACLE_FUNDAMENTAL_METRICS.map(({ id }) => id),
    );
  });
});

describe("ordinary readings", () => {
  it("computes all fifteen metrics from the base fixture", () => {
    expect(outcomes(base())).toEqual(BASE);
  });

  it("computes exactly: (2.4 / 2 - 1) x 100 is exactly 20, not the 19.999999999999996 of doubles", () => {
    // Already in BASE; restated because in doubles 2.4 / 2 - 1 is 0.19999999999999996.
    expect(outcomes(base()).EPS_GROWTH_TTM_YOY).toEqual(value(20n, 1n, 20));
  });

  it("reports only available metrics through the convenience entry point", () => {
    expect(oracleFundamentalMetrics(base(), D)).toEqual({
      REVENUE_GROWTH_TTM_YOY: 25,
      EPS_GROWTH_TTM_YOY: 20,
      FCF_GROWTH_TTM_YOY: 50,
      GROSS_MARGIN_TTM: 40,
      OPERATING_MARGIN_TTM: 20,
      NET_MARGIN_TTM: 12,
      FCF_MARGIN_TTM: 24,
      ROIC_TTM: 15.8,
      ROE_TTM: 15,
      ROA_TTM: 6,
      DEBT_TO_EQUITY: 0.45,
      CURRENT_RATIO: 1.5,
      NET_DEBT_TO_EBITDA_TTM: 0.625,
      INTEREST_COVERAGE_TTM: 4,
      ASSET_TURNOVER_TTM: 0.5,
    });
    // Equity 0 at 2024 Q4: ROE's average (80 + 0) / 2 = 40 still stands, Debt / Equity does not.
    const withoutEquity = patch(base(), "BALANCE_SHEET", 2024, "Q4", {
      totalStockholdersEquity: 0,
    });
    const metrics = oracleFundamentalMetrics(withoutEquity, D);
    expect(Object.keys(metrics)).toHaveLength(14);
    expect(metrics.DEBT_TO_EQUITY).toBeUndefined();
    expect(metrics.ROE_TTM).toBe(30); // 12 / 40 x 100
  });
});

describe("negative readings, where the ADR allows them", () => {
  cases([
    // previous revenue 62+19+21+23 = 125; (100 / 125 - 1) x 100 = -20
    [
      "Revenue Growth",
      "REVENUE_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { revenue: 62 }),
      value(-20n, 1n, -20),
    ],
    // previous EPS 1+0.5+0.5+0.5 = 2.5; (2.4 / 2.5 - 1) x 100 = -4
    [
      "EPS Growth",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { epsDiluted: 1 }),
      value(-4n, 1n, -4),
    ],
    // previous FCF (21-3)+4+4+4 = 30; (24 / 30 - 1) x 100 = -20
    [
      "FCF Growth",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2023, "Q1", { operatingCashFlow: 21 }),
      value(-20n, 1n, -20),
    ],
    // gross profit 9+10+10-39 = -10; -10 / 100 x 100 = -10
    [
      "Gross Margin",
      "GROSS_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { grossProfit: -39 }),
      value(-10n, 1n, -10),
    ],
    // operating income 4+5+5-24 = -10; -10 / 100 x 100 = -10
    [
      "Operating Margin",
      "OPERATING_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { operatingIncome: -24 }),
      value(-10n, 1n, -10),
    ],
    // net income 2+3+3-16 = -8; -8 / 100 x 100 = -8
    [
      "Net Margin",
      "NET_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -16 }),
      value(-8n, 1n, -8),
    ],
    // FCF 5+6+6+(10-41) = -14; -14 / 100 x 100 = -14
    [
      "FCF Margin",
      "FCF_MARGIN_TTM",
      () => patch(base(), "CASH_FLOW", 2024, "Q4", { capitalExpenditure: -41 }),
      value(-14n, 1n, -14),
    ],
    // operating income 4+5+5-34 = -20; NOPAT -20 x 0.79 = -15.8; / 100 x 100 = -15.8
    [
      "ROIC",
      "ROIC_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { operatingIncome: -34 }),
      value(-79n, 5n, -15.8),
    ],
    // net income 2+3+3-20 = -12; -12 / 80 x 100 = -15
    [
      "ROE",
      "ROE_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -20 }),
      value(-15n, 1n, -15),
    ],
    // -12 / 200 x 100 = -6
    [
      "ROA",
      "ROA_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -20 }),
      value(-6n, 1n, -6),
    ],
    // net cash: -8 / 32 = -0.25
    [
      "Net Debt / EBITDA",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { netDebt: -8 }),
      value(-1n, 4n, -0.25),
    ],
    // EBIT 5+6+6-41 = -24; -24 / 6 = -4
    [
      "Interest Coverage",
      "INTEREST_COVERAGE_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { ebit: -41 }),
      value(-4n, 1n, -4),
    ],
    // No rule excludes a negative numerator for the single-statement ratios, so the literal reading
    // passes it through: -8 / 80 = -0.1 and -25 / 50 = -0.5.
    [
      "Debt / Equity (negative debt, literal reading)",
      "DEBT_TO_EQUITY",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalDebt: -8 }),
      value(-1n, 10n, -0.1),
    ],
    [
      "Current Ratio (negative current assets, literal reading)",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalCurrentAssets: -25 }),
      value(-1n, 2n, -0.5),
    ],
  ]);

  it("never gives Asset Turnover a sign: both of its terms must be positive", () => {
    // Revenue 22+24+26-80 = -8: unavailable, not -8 / 200 = -0.04.
    const negativeRevenue = patch(base(), "INCOME", 2024, "Q4", {
      revenue: -80,
    });
    expect(outcomes(negativeRevenue).ASSET_TURNOVER_TTM).toEqual(
      unavailable("NON_POSITIVE_TTM"),
    );
  });
});

describe("zero readings are real zeros", () => {
  cases([
    // previous revenue 37+19+21+23 = 100 = current; (100 / 100 - 1) x 100 = 0
    [
      "Revenue Growth",
      "REVENUE_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { revenue: 37 }),
      ZERO_READING,
    ],
    // previous EPS 0.9+0.5+0.5+0.5 = 2.4 = current
    [
      "EPS Growth",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { epsDiluted: 0.9 }),
      ZERO_READING,
    ],
    // previous FCF (15-3)+4+4+4 = 24 = current
    [
      "FCF Growth",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2023, "Q1", { operatingCashFlow: 15 }),
      ZERO_READING,
    ],
    // gross profit 9+10+10-29 = 0
    [
      "Gross Margin",
      "GROSS_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { grossProfit: -29 }),
      ZERO_READING,
    ],
    // operating income 4+5+5-14 = 0
    [
      "Operating Margin",
      "OPERATING_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { operatingIncome: -14 }),
      ZERO_READING,
    ],
    // net income 2+3+3-8 = 0
    [
      "Net Margin",
      "NET_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -8 }),
      ZERO_READING,
    ],
    // FCF 5+6+6+(10-27) = 0
    [
      "FCF Margin",
      "FCF_MARGIN_TTM",
      () => patch(base(), "CASH_FLOW", 2024, "Q4", { capitalExpenditure: -27 }),
      ZERO_READING,
    ],
    // operating income 0, so NOPAT 0
    [
      "ROIC",
      "ROIC_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { operatingIncome: -14 }),
      ZERO_READING,
    ],
    // net income 0
    [
      "ROE",
      "ROE_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -8 }),
      ZERO_READING,
    ],
    [
      "ROA",
      "ROA_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: -8 }),
      ZERO_READING,
    ],
    // 0 / 80
    [
      "Debt / Equity",
      "DEBT_TO_EQUITY",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalDebt: 0 }),
      ZERO_READING,
    ],
    // 0 / 50
    [
      "Current Ratio",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalCurrentAssets: 0 }),
      ZERO_READING,
    ],
    // 0 / 32
    [
      "Net Debt / EBITDA",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { netDebt: 0 }),
      ZERO_READING,
    ],
    // EBIT 5+6+6-17 = 0
    [
      "Interest Coverage",
      "INTEREST_COVERAGE_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { ebit: -17 }),
      ZERO_READING,
    ],
  ]);

  it("reports a zero as 0, never -0, even when it is reached through negative terms", () => {
    const reading = outcomes(
      patch(base(), "INCOME", 2024, "Q4", { grossProfit: -29 }),
    ).GROSS_MARGIN_TTM;
    expect(reading.status === "VALUE" && Object.is(reading.value, 0)).toBe(
      true,
    );
  });

  it("gives Asset Turnover no zero: a zero revenue window is unavailable", () => {
    // Revenue 22+24+26-72 = 0.
    expect(
      outcomes(patch(base(), "INCOME", 2024, "Q4", { revenue: -72 }))
        .ASSET_TURNOVER_TTM,
    ).toEqual(unavailable("NON_POSITIVE_TTM"));
  });
});

describe("denominator and positivity rules", () => {
  const revenueZero = () =>
    patch(base(), "INCOME", 2024, "Q4", { revenue: -72 }); // 22+24+26-72 = 0
  const revenueNegative = () =>
    patch(base(), "INCOME", 2024, "Q4", { revenue: -80 }); // = -8

  cases([
    // previous revenue -63+19+21+23 = 0
    [
      "Revenue Growth: previous window zero",
      "REVENUE_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { revenue: -63 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // previous revenue -70+19+21+23 = -7
    [
      "Revenue Growth: previous window negative",
      "REVENUE_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { revenue: -70 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Revenue Growth: current window zero",
      "REVENUE_GROWTH_TTM_YOY",
      revenueZero,
      unavailable("NON_POSITIVE_TTM"),
    ],
    [
      "Revenue Growth: current window negative",
      "REVENUE_GROWTH_TTM_YOY",
      revenueNegative,
      unavailable("NON_POSITIVE_TTM"),
    ],
    // previous EPS -1.5+0.5+0.5+0.5 = 0
    [
      "EPS Growth: previous window zero",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { epsDiluted: -1.5 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // loss to profit: previous EPS -2+1.5 = -0.5
    [
      "EPS Growth: loss to profit",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q1", { epsDiluted: -2 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // current EPS 0.55+0.6+0.6-1.75 = 0
    [
      "EPS Growth: current window zero",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2024, "Q4", { epsDiluted: -1.75 }),
      unavailable("NON_POSITIVE_TTM"),
    ],
    // profit to loss: current EPS 1.75-2 = -0.25
    [
      "EPS Growth: profit to loss",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2024, "Q4", { epsDiluted: -2 }),
      unavailable("NON_POSITIVE_TTM"),
    ],
    // both windows negative (-0.5 and -0.25): the current window's rule is listed first
    [
      "EPS Growth: two losses",
      "EPS_GROWTH_TTM_YOY",
      () =>
        patch(
          patch(base(), "INCOME", 2023, "Q1", { epsDiluted: -2 }),
          "INCOME",
          2024,
          "Q4",
          { epsDiluted: -2 },
        ),
      unavailable("NON_POSITIVE_TTM"),
    ],
    // previous FCF (7-19)+4+4+4 = 0
    [
      "FCF Growth: previous window zero",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2023, "Q1", { capitalExpenditure: -19 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // previous FCF (7-20)+12 = -1
    [
      "FCF Growth: previous window negative",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2023, "Q1", { capitalExpenditure: -20 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // current FCF 5+6+6+(10-27) = 0
    [
      "FCF Growth: current window zero",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2024, "Q4", { capitalExpenditure: -27 }),
      unavailable("NON_POSITIVE_TTM"),
    ],
    // current FCF 17+(10-30) = -3
    [
      "FCF Growth: current window negative",
      "FCF_GROWTH_TTM_YOY",
      () => patch(base(), "CASH_FLOW", 2024, "Q4", { capitalExpenditure: -30 }),
      unavailable("NON_POSITIVE_TTM"),
    ],
    [
      "Gross Margin: revenue zero",
      "GROSS_MARGIN_TTM",
      revenueZero,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Gross Margin: revenue negative",
      "GROSS_MARGIN_TTM",
      revenueNegative,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Operating Margin: revenue zero",
      "OPERATING_MARGIN_TTM",
      revenueZero,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Operating Margin: revenue negative",
      "OPERATING_MARGIN_TTM",
      revenueNegative,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Net Margin: revenue zero",
      "NET_MARGIN_TTM",
      revenueZero,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Net Margin: revenue negative",
      "NET_MARGIN_TTM",
      revenueNegative,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "FCF Margin: revenue zero",
      "FCF_MARGIN_TTM",
      revenueZero,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "FCF Margin: revenue negative",
      "FCF_MARGIN_TTM",
      revenueNegative,
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // ending capital 36+80-216 = -100; average (100-100)/2 = 0
    [
      "ROIC: average invested capital zero",
      "ROIC_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          cashAndShortTermInvestments: 216,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // ending capital 36+80-226 = -110; average (100-110)/2 = -5
    [
      "ROIC: average invested capital negative",
      "ROIC_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          cashAndShortTermInvestments: 226,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // average equity (80-80)/2 = 0
    [
      "ROE: average equity zero",
      "ROE_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: -80,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // average equity (80-100)/2 = -10
    [
      "ROE: average equity negative",
      "ROE_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: -100,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // average assets (150-150)/2 = 0
    [
      "ROA: average assets zero",
      "ROA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalAssets: -150 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // average assets (150-250)/2 = -50
    [
      "ROA: average assets negative",
      "ROA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalAssets: -250 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Debt / Equity: equity zero",
      "DEBT_TO_EQUITY",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: 0,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Debt / Equity: equity negative",
      "DEBT_TO_EQUITY",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: -80,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Current Ratio: liabilities zero",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalCurrentLiabilities: 0,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Current Ratio: liabilities negative",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalCurrentLiabilities: -50,
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // EBITDA 7+8+8-23 = 0
    [
      "Net Debt / EBITDA: EBITDA zero",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { ebitda: -23 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // EBITDA 23-30 = -7
    [
      "Net Debt / EBITDA: EBITDA negative",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { ebitda: -30 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // four reported zeros: a real zero, so an unbounded ratio, not a missing field
    [
      "Interest Coverage: interest expense zero",
      "INTEREST_COVERAGE_TTM",
      () =>
        patchYear(base(), "INCOME", 2024, {
          Q1: { interestExpense: 0 },
          Q2: { interestExpense: 0 },
          Q3: { interestExpense: 0 },
          Q4: { interestExpense: 0 },
        }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    // interest 1.5+1.5+1.5-10 = -5.5
    [
      "Interest Coverage: interest expense negative",
      "INTEREST_COVERAGE_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { interestExpense: -10 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Asset Turnover: revenue zero",
      "ASSET_TURNOVER_TTM",
      revenueZero,
      unavailable("NON_POSITIVE_TTM"),
    ],
    [
      "Asset Turnover: revenue negative",
      "ASSET_TURNOVER_TTM",
      revenueNegative,
      unavailable("NON_POSITIVE_TTM"),
    ],
    // average assets (150-150)/2 = 0 and (150-250)/2 = -50
    [
      "Asset Turnover: average assets zero",
      "ASSET_TURNOVER_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalAssets: -150 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
    [
      "Asset Turnover: average assets negative",
      "ASSET_TURNOVER_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalAssets: -250 }),
      unavailable("NON_POSITIVE_DENOMINATOR"),
    ],
  ]);
});

describe("missing fields are never zero", () => {
  cases([
    [
      "Revenue Growth: revenue missing in the previous window",
      "REVENUE_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2023, "Q2", { revenue: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "EPS Growth: epsDiluted missing",
      "EPS_GROWTH_TTM_YOY",
      () => patch(base(), "INCOME", 2024, "Q3", { epsDiluted: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    // freeCashFlow 4 is still reported and never fills the gap
    [
      "FCF Growth: capitalExpenditure missing",
      "FCF_GROWTH_TTM_YOY",
      () =>
        patch(base(), "CASH_FLOW", 2023, "Q2", {
          capitalExpenditure: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "FCF Growth: operatingCashFlow missing",
      "FCF_GROWTH_TTM_YOY",
      () =>
        patch(base(), "CASH_FLOW", 2024, "Q1", {
          operatingCashFlow: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Gross Margin: grossProfit missing",
      "GROSS_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { grossProfit: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Operating Margin: operatingIncome missing",
      "OPERATING_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q2", { operatingIncome: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Net Margin: netIncome missing",
      "NET_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q4", { netIncome: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "FCF Margin: operatingCashFlow missing",
      "FCF_MARGIN_TTM",
      () =>
        patch(base(), "CASH_FLOW", 2024, "Q3", {
          operatingCashFlow: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "FCF Margin: revenue missing",
      "FCF_MARGIN_TTM",
      () => patch(base(), "INCOME", 2024, "Q2", { revenue: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "ROIC: operatingIncome missing",
      "ROIC_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { operatingIncome: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "ROIC: opening totalDebt missing",
      "ROIC_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2023, "Q4", { totalDebt: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    // totalEquity 90 is still reported: no fallback from totalStockholdersEquity
    [
      "ROIC: ending totalStockholdersEquity missing",
      "ROIC_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "ROIC: both cash fields missing",
      "ROIC_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          cashAndShortTermInvestments: undefined,
          cashAndCashEquivalents: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "ROE: ending totalStockholdersEquity missing (totalEquity is no fallback)",
      "ROE_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalStockholdersEquity: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "ROA: opening totalAssets missing",
      "ROA_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2023, "Q4", { totalAssets: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Debt / Equity: totalDebt missing",
      "DEBT_TO_EQUITY",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalDebt: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Current Ratio: totalCurrentLiabilities missing",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalCurrentLiabilities: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Current Ratio: totalCurrentAssets missing",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalCurrentAssets: undefined,
        }),
      unavailable("MISSING_FIELD"),
    ],
    // totalDebt and both cash fields are still reported: netDebt is never reconstructed
    [
      "Net Debt / EBITDA: netDebt missing",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { netDebt: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Net Debt / EBITDA: ebitda missing",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "INCOME", 2024, "Q2", { ebitda: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Interest Coverage: interestExpense missing",
      "INTEREST_COVERAGE_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { interestExpense: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Asset Turnover: ending totalAssets missing",
      "ASSET_TURNOVER_TTM",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalAssets: undefined }),
      unavailable("MISSING_FIELD"),
    ],
    [
      "Asset Turnover: revenue missing",
      "ASSET_TURNOVER_TTM",
      () => patch(base(), "INCOME", 2024, "Q3", { revenue: undefined }),
      unavailable("MISSING_FIELD"),
    ],
  ]);

  it("treats every non-finite or non-number representation as missing", () => {
    for (const missing of [
      undefined,
      null,
      Number.NaN,
      Infinity,
      -Infinity,
      "22",
      true,
      {},
    ]) {
      const statements = patch(base(), "INCOME", 2024, "Q1", {
        revenue: 0,
      }).map((statement) =>
        matches(statement, "INCOME", 2024, "Q1")
          ? { ...statement, values: { ...statement.values, revenue: missing } }
          : statement,
      );
      expect(outcomes(statements).GROSS_MARGIN_TTM, String(missing)).toEqual(
        unavailable("MISSING_FIELD"),
      );
    }
  });

  it("ignores a missing line item outside the window", () => {
    // Gross Margin reads 2024 only, so 2023 Q1's missing grossProfit changes nothing.
    const statements = patch(base(), "INCOME", 2023, "Q1", {
      grossProfit: undefined,
    });
    expect(outcomes(statements).GROSS_MARGIN_TTM).toEqual(
      BASE.GROSS_MARGIN_TTM,
    );
  });
});

describe("missing quarters and balance sheets", () => {
  cases([
    [
      "Revenue Growth: a previous-window quarter missing",
      "REVENUE_GROWTH_TTM_YOY",
      () => drop(base(), "INCOME", 2023, "Q3"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "EPS Growth: a previous-window quarter missing",
      "EPS_GROWTH_TTM_YOY",
      () => drop(base(), "INCOME", 2023, "Q3"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "FCF Growth: a current-window quarter missing",
      "FCF_GROWTH_TTM_YOY",
      () => drop(base(), "CASH_FLOW", 2024, "Q1"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Gross Margin",
      "GROSS_MARGIN_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Operating Margin",
      "OPERATING_MARGIN_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Net Margin",
      "NET_MARGIN_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "FCF Margin: a cash-flow quarter missing",
      "FCF_MARGIN_TTM",
      () => drop(base(), "CASH_FLOW", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "FCF Margin: an income quarter missing",
      "FCF_MARGIN_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "ROIC: an income quarter missing",
      "ROIC_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "ROIC: opening balance sheet missing",
      "ROIC_TTM",
      () => drop(base(), "BALANCE_SHEET", 2023, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "ROIC: ending balance sheet missing",
      "ROIC_TTM",
      () => drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "ROE: an income quarter missing",
      "ROE_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "ROE: opening balance sheet missing",
      "ROE_TTM",
      () => drop(base(), "BALANCE_SHEET", 2023, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "ROE: ending balance sheet missing",
      "ROE_TTM",
      () => drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "ROA: an income quarter missing",
      "ROA_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "ROA: opening balance sheet missing",
      "ROA_TTM",
      () => drop(base(), "BALANCE_SHEET", 2023, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "ROA: ending balance sheet missing",
      "ROA_TTM",
      () => drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "Debt / Equity: no balance sheet",
      "DEBT_TO_EQUITY",
      () =>
        drop(
          drop(base(), "BALANCE_SHEET", 2023, "Q4"),
          "BALANCE_SHEET",
          2024,
          "Q4",
        ),
      unavailable("NO_BALANCE_SHEET"),
    ],
    [
      "Current Ratio: no balance sheet",
      "CURRENT_RATIO",
      () =>
        drop(
          drop(base(), "BALANCE_SHEET", 2023, "Q4"),
          "BALANCE_SHEET",
          2024,
          "Q4",
        ),
      unavailable("NO_BALANCE_SHEET"),
    ],
    [
      "Net Debt / EBITDA: an income quarter missing",
      "NET_DEBT_TO_EBITDA_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Net Debt / EBITDA: no balance sheet",
      "NET_DEBT_TO_EBITDA_TTM",
      () =>
        drop(
          drop(base(), "BALANCE_SHEET", 2023, "Q4"),
          "BALANCE_SHEET",
          2024,
          "Q4",
        ),
      unavailable("NO_BALANCE_SHEET"),
    ],
    [
      "Interest Coverage",
      "INTEREST_COVERAGE_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Asset Turnover: an income quarter missing",
      "ASSET_TURNOVER_TTM",
      () => drop(base(), "INCOME", 2024, "Q2"),
      unavailable("MISSING_QUARTER"),
    ],
    [
      "Asset Turnover: opening balance sheet missing",
      "ASSET_TURNOVER_TTM",
      () => drop(base(), "BALANCE_SHEET", 2023, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
    [
      "Asset Turnover: ending balance sheet missing",
      "ASSET_TURNOVER_TTM",
      () => drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      unavailable("MISSING_BALANCE_SHEET"),
    ],
  ]);
});

describe("annual rows never stand in for quarters (rules 3 and 4)", () => {
  function annualOnly(): Statement[] {
    return [
      annual("INCOME", 2023, {
        revenue: 80,
        grossProfit: 32,
        operatingIncome: 16,
        netIncome: 8,
        epsDiluted: 2,
        ebitda: 24,
        ebit: 16,
        interestExpense: 4,
      }),
      annual("INCOME", 2024, {
        revenue: 100,
        grossProfit: 40,
        operatingIncome: 20,
        netIncome: 12,
        epsDiluted: 2.4,
        ebitda: 32,
        ebit: 24,
        interestExpense: 6,
      }),
      annual("CASH_FLOW", 2023, {
        operatingCashFlow: 28,
        capitalExpenditure: -12,
      }),
      annual("CASH_FLOW", 2024, {
        operatingCashFlow: 36,
        capitalExpenditure: -12,
      }),
      annual("BALANCE_SHEET", 2023, OPENING_SHEET),
      annual("BALANCE_SHEET", 2024, ENDING_SHEET),
    ];
  }

  it("leaves every metric unavailable when only FY rows exist", () => {
    // The same annual figures would give BASE if an FY row could serve; none can.
    expect(outcomes(annualOnly())).toEqual({
      ...every("NO_QUARTERLY_STATEMENT", [
        ...INCOME_FLOW_METRICS,
        "FCF_GROWTH_TTM_YOY",
      ]),
      DEBT_TO_EQUITY: unavailable("NO_BALANCE_SHEET"),
      CURRENT_RATIO: unavailable("NO_BALANCE_SHEET"),
    });
  });

  it("never fills a quarterly gap with an FY row", () => {
    const incomeGap = [
      ...drop(base(), "INCOME", 2024, "Q2"),
      annual("INCOME", 2024, {
        revenue: 100,
        grossProfit: 40,
        operatingIncome: 20,
        netIncome: 12,
        epsDiluted: 2.4,
        ebitda: 32,
        ebit: 24,
        interestExpense: 6,
      }),
    ];
    expectSome(
      outcomes(incomeGap),
      every("MISSING_QUARTER", INCOME_FLOW_METRICS),
    );

    const cashFlowGap = [
      ...drop(base(), "CASH_FLOW", 2024, "Q2"),
      annual("CASH_FLOW", 2024, {
        operatingCashFlow: 36,
        capitalExpenditure: -12,
      }),
    ];
    expectSome(outcomes(cashFlowGap), {
      FCF_GROWTH_TTM_YOY: unavailable("MISSING_QUARTER"),
      FCF_MARGIN_TTM: unavailable("MISSING_QUARTER"),
    });
  });

  it("never takes an FY balance sheet as a state", () => {
    const statements = [
      ...drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      annual("BALANCE_SHEET", 2024, ENDING_SHEET),
    ];
    expectSome(outcomes(statements), {
      ...every("MISSING_BALANCE_SHEET", AVERAGED_STATE_METRICS),
      // latest quarterly balance sheet is 2023 Q4: 30 / 80 = 0.375
      DEBT_TO_EQUITY: value(3n, 8n, 0.375),
    });
  });
});

describe("non-calendar fiscal years (rule 9)", () => {
  /** Fiscal years ending in late September: fiscal year N runs from October of N - 1. */
  const SEPTEMBER_YEARS: Record<
    number,
    Record<Quarter, readonly [string, string]>
  > = {
    // [fiscalDate, availableFromDate]
    2024: {
      Q1: ["2023-12-30", "2024-02-01"],
      Q2: ["2024-03-30", "2024-05-01"],
      Q3: ["2024-06-29", "2024-08-01"],
      Q4: ["2024-09-28", "2024-11-01"],
    },
    2025: {
      Q1: ["2024-12-28", "2025-02-01"],
      Q2: ["2025-03-29", "2025-05-01"],
      Q3: ["2025-06-28", "2025-08-01"],
      Q4: ["2025-09-27", "2025-11-01"],
    },
  };

  function september(
    family: Family,
    fiscalYear: number,
    period: Quarter,
    values: Values,
  ): Statement {
    const [fiscalDate, availableFromDate] =
      SEPTEMBER_YEARS[fiscalYear]![period];
    return quarter(family, fiscalYear, period, values, {
      fiscalDate,
      availableFromDate,
      observedAt: `${availableFromDate}T12:00:00.000Z`,
    });
  }

  /** The base figures relabelled: FY2024 carries 2023's quarters and FY2025 carries 2024's. */
  function septemberFixture(): Statement[] {
    const statements: Statement[] = [];
    for (const period of QUARTERS) {
      statements.push(september("INCOME", 2024, period, INCOME_2023[period]));
      statements.push(september("INCOME", 2025, period, INCOME_2024[period]));
      statements.push(
        september("CASH_FLOW", 2024, period, CASH_FLOW_2023[period]),
      );
      statements.push(
        september("CASH_FLOW", 2025, period, CASH_FLOW_2024[period]),
      );
    }
    statements.push(september("BALANCE_SHEET", 2024, "Q4", OPENING_SHEET));
    statements.push(september("BALANCE_SHEET", 2025, "Q4", ENDING_SHEET));
    return statements;
  }

  it("treats a September fiscal year exactly like a calendar one", () => {
    // Same figures on the same fiscal identities, so every value is BASE: FY2025 Q1 ends in
    // calendar December 2024 and still follows FY2024 Q4, opening state FY2024 Q4 (2024-09-28).
    expect(outcomes(septemberFixture(), LATER)).toEqual(BASE);
  });

  it("anchors on the latest fiscal quarter available, not on calendar position", () => {
    // On 2025-10-15 FY2025 Q4 (available 2025-11-01) is not yet usable: the window is
    // FY2024 Q4..FY2025 Q3, gross profit 9+9+10+10 = 38 over revenue 23+22+24+26 = 95, 40%;
    // the latest balance sheet is FY2024 Q4: 30 / 80 = 0.375.
    expectSome(outcomes(septemberFixture(), "2025-10-15"), {
      GROSS_MARGIN_TTM: value(40n, 1n, 40),
      DEBT_TO_EQUITY: value(3n, 8n, 0.375),
      ROE_TTM: unavailable("MISSING_BALANCE_SHEET"),
    });
  });

  it("breaks the chain when a quarter that ends in the previous calendar year is missing", () => {
    const statements = drop(septemberFixture(), "INCOME", 2025, "Q1"); // fiscal date 2024-12-28
    expectSome(
      outcomes(statements, LATER),
      every("MISSING_QUARTER", INCOME_FLOW_METRICS),
    );
  });
});

describe("point in time and restatements (rules 1, 2, 7)", () => {
  it("counts a statement from its availableFromDate, inclusive", () => {
    // 2025-01-31: 2024 Q4 (available 2025-02-01) is not usable. The income window is
    // 2023 Q4..2024 Q3: gross profit 9+9+10+10 = 38 / revenue 23+22+24+26 = 95 = 40%; growth
    // would need 2022 Q4; the latest balance sheet is 2023 Q4 (30 / 80); 2024 Q3 has no ending state.
    expectSome(outcomes(base(), "2025-01-31"), {
      GROSS_MARGIN_TTM: value(40n, 1n, 40),
      OPERATING_MARGIN_TTM: value(20n, 1n, 20), // 5+4+5+5 = 19 / 95
      REVENUE_GROWTH_TTM_YOY: unavailable("MISSING_QUARTER"),
      DEBT_TO_EQUITY: value(3n, 8n, 0.375),
      ROE_TTM: unavailable("MISSING_BALANCE_SHEET"),
    });
    expect(outcomes(base(), "2025-02-01")).toEqual(BASE);
  });

  it("shows a restatement only from its availableFromDate", () => {
    expect(outcomes(restated(), "2025-06-01")).toEqual(BASE);
    expect(outcomes(restated(), "2025-06-02")).toEqual(RESTATED);
  });

  it("is stateless: an earlier date after a later one is still the earlier answer", () => {
    const statements = restated();
    expect(outcomes(statements, "2025-06-02")).toEqual(RESTATED);
    expect(outcomes(statements, "2025-06-01")).toEqual(BASE);
    expect(outcomes(statements, "2025-06-02")).toEqual(RESTATED);
  });

  it("lets a later revision invalidate a metric from its availableFromDate on (rule 7)", () => {
    // The revision drops interestExpense and reports revenue -72 (22+24+26-72 = 0).
    const invalidating = [
      ...base(),
      revision("INCOME", {
        ...INCOME_2024.Q4,
        interestExpense: undefined,
        revenue: -72,
      }),
    ];
    expectSome(outcomes(invalidating, "2025-06-01"), {
      INTEREST_COVERAGE_TTM: BASE.INTEREST_COVERAGE_TTM,
      GROSS_MARGIN_TTM: BASE.GROSS_MARGIN_TTM,
    });
    expectSome(outcomes(invalidating, "2025-06-02"), {
      INTEREST_COVERAGE_TTM: unavailable("MISSING_FIELD"),
      GROSS_MARGIN_TTM: unavailable("NON_POSITIVE_DENOMINATOR"),
    });
  });
});

describe("one fiscal quarter, one representing revision (rule 13)", () => {
  function moved(
    fiscalDate: string,
    overrides: Partial<Statement> = {},
  ): Statement {
    return quarter("INCOME", 2024, "Q4", RESTATED_INCOME_Q4, {
      fiscalDate,
      availableFromDate: "2025-06-02",
      observedAt: "2025-06-01T12:00:00.000Z",
      contentHash: "INCOME:2024:Q4:moved",
      ...overrides,
    });
  }

  it("represents a quarter whose period end moved earlier by its later revision, counted once", () => {
    const statements = [...base(), moved("2024-12-28")];
    expect(outcomes(statements, "2025-06-01")).toEqual(BASE);
    // Counted twice, current revenue would be 22+24+26+28+48; represented once it is 120.
    expect(outcomes(statements, "2025-06-02")).toEqual(INCOME_Q4_REPLACED);
  });

  it("does the same when the period end moved later", () => {
    const statements = [...base(), moved("2025-01-02")];
    expect(outcomes(statements, "2025-06-01")).toEqual(BASE);
    expect(outcomes(statements, "2025-06-02")).toEqual(INCOME_Q4_REPLACED);
  });

  it("lets the later period end decide between rows one observation delivered, before the hash", () => {
    // Same availableFromDate (2025-02-01) and observedAt as the base 2024-12-31 row.
    const sameObservation = {
      availableFromDate: "2025-02-01",
      observedAt: "2025-02-01T12:00:00.000Z",
    };
    // 2024-12-28 < 2024-12-31: the base row represents, though "…:z" > "…:v1".
    expect(
      outcomes([
        ...base(),
        moved("2024-12-28", {
          ...sameObservation,
          contentHash: "INCOME:2024:Q4:z",
        }),
      ]),
    ).toEqual(BASE);
    // 2025-01-02 > 2024-12-31: the moved row represents, though "…:a" < "…:v1".
    expect(
      outcomes([
        ...base(),
        moved("2025-01-02", {
          ...sameObservation,
          contentHash: "INCOME:2024:Q4:a",
        }),
      ]),
    ).toEqual(INCOME_Q4_REPLACED);
  });

  it("prefers the later availableFromDate whichever way the period end moved", () => {
    // The moved row is available on 2025-01-20, before the original (2025-02-01).
    const statements = [
      ...base(),
      moved("2024-12-28", {
        availableFromDate: "2025-01-20",
        observedAt: "2025-01-20T12:00:00.000Z",
      }),
    ];
    // 2025-01-25: only the moved row represents 2024 Q4 (revenue 22+24+26+48 = 120).
    expectSome(outcomes(statements, "2025-01-25"), {
      REVENUE_GROWTH_TTM_YOY: INCOME_Q4_REPLACED.REVENUE_GROWTH_TTM_YOY,
      GROSS_MARGIN_TTM: INCOME_Q4_REPLACED.GROSS_MARGIN_TTM,
    });
    // From 2025-02-01 the original is the later revision again.
    expect(outcomes(statements, "2025-02-01")).toEqual(BASE);
  });
});

describe("revision order within one logical identity (loader read selection)", () => {
  it("prefers the later observedAt when availableFromDate ties, before the hash", () => {
    const later = quarter("INCOME", 2024, "Q4", RESTATED_INCOME_Q4, {
      observedAt: "2025-02-01T13:00:00.000Z",
      contentHash: "INCOME:2024:Q4:a",
    });
    expect(outcomes([...base(), later])).toEqual(INCOME_Q4_REPLACED);
  });

  it("falls back to the greater contentHash when everything else ties", () => {
    const greater = quarter("INCOME", 2024, "Q4", RESTATED_INCOME_Q4, {
      contentHash: "INCOME:2024:Q4:v2",
    });
    const smaller = quarter("INCOME", 2024, "Q4", RESTATED_INCOME_Q4, {
      contentHash: "INCOME:2024:Q4:v0",
    });
    expect(outcomes([...base(), greater])).toEqual(INCOME_Q4_REPLACED);
    expect(outcomes([...base(), smaller])).toEqual(BASE);
  });

  it("orders by availableFromDate before observedAt", () => {
    const observedLater = quarter("INCOME", 2024, "Q4", RESTATED_INCOME_Q4, {
      availableFromDate: "2025-01-20",
      observedAt: "2025-09-01T00:00:00.000Z",
      contentHash: "INCOME:2024:Q4:v9",
    });
    expect(outcomes([...base(), observedLater])).toEqual(BASE);
  });
});

describe("window anchors (rule 11: no stale-window fallback)", () => {
  it("makes every Income flow metric unavailable when the newest window has a gap", () => {
    // 2025 Q2 arrives without 2025 Q1. The complete 2024 window still exists and is not used.
    const statements = [
      ...base(),
      quarter("INCOME", 2025, "Q2", INCOME_2024.Q2),
    ];
    expect(outcomes(statements, LATER)).toEqual({
      ...every("MISSING_QUARTER", INCOME_FLOW_METRICS),
      FCF_GROWTH_TTM_YOY: BASE.FCF_GROWTH_TTM_YOY,
      DEBT_TO_EQUITY: BASE.DEBT_TO_EQUITY,
      CURRENT_RATIO: BASE.CURRENT_RATIO,
    });
  });

  it("does the same for the Cash Flow family", () => {
    const statements = [
      ...base(),
      quarter("CASH_FLOW", 2025, "Q2", CASH_FLOW_2024.Q2),
    ];
    expect(outcomes(statements, LATER)).toEqual({
      ...BASE,
      FCF_GROWTH_TTM_YOY: unavailable("MISSING_QUARTER"),
      FCF_MARGIN_TTM: unavailable("MISSING_QUARTER"),
    });
  });

  it("anchors on the newest quarter a family holds", () => {
    // Without Income 2024 Q4 the newest Income quarter is 2024 Q3: margins read 2023 Q4..2024 Q3
    // (38 / 95 and 19 / 95), growth needs 2022 Q4, ROE's ending state would be 2024 Q3, and
    // FCF Margin is anchored on Cash Flow's 2024 Q4, which Income lacks.
    expectSome(outcomes(drop(base(), "INCOME", 2024, "Q4")), {
      GROSS_MARGIN_TTM: value(40n, 1n, 40),
      OPERATING_MARGIN_TTM: value(20n, 1n, 20),
      REVENUE_GROWTH_TTM_YOY: unavailable("MISSING_QUARTER"),
      ROE_TTM: unavailable("MISSING_BALANCE_SHEET"),
      FCF_MARGIN_TTM: unavailable("MISSING_QUARTER"),
    });
  });

  it("joins Q4 of one fiscal year to Q1 of the next", () => {
    const statements = [
      ...base(),
      quarter("INCOME", 2025, "Q1", INCOME_2025_Q1),
    ];
    expectSome(outcomes(statements, LATER), {
      // window 2024 Q2..2025 Q1: gross profit 10+10+11+19 = 50 / revenue 24+26+28+22 = 100
      GROSS_MARGIN_TTM: value(50n, 1n, 50),
      // operating income 5+5+6+4 = 20 / 100
      OPERATING_MARGIN_TTM: value(20n, 1n, 20),
      // EBIT 6+6+7+5 = 24 / interest 4 x 1.5 = 6
      INTEREST_COVERAGE_TTM: value(4n, 1n, 4),
      // EBITDA 8+8+9+7 = 32; the latest balance sheet (2024 Q4) may be older than Q[0]: 20 / 32
      NET_DEBT_TO_EBITDA_TTM: value(5n, 8n, 0.625),
      // no 2025 Q1 balance sheet for the ending state
      ROIC_TTM: unavailable("MISSING_BALANCE_SHEET"),
    });
  });

  it("does not join fiscal years that are not adjacent", () => {
    // 2026 Q1 after 2024 Q4: the window 2025 Q2..2026 Q1 has three gaps.
    const statements = [
      ...base(),
      quarter("INCOME", 2026, "Q1", INCOME_2025_Q1),
    ];
    expect(outcomes(statements, "2026-06-01").GROSS_MARGIN_TTM).toEqual(
      unavailable("MISSING_QUARTER"),
    );
  });
});

describe("FCF Margin needs both families on the same newest quarter (rule 5)", () => {
  const nextCashFlow = quarter("CASH_FLOW", 2025, "Q1", {
    operatingCashFlow: 13,
    capitalExpenditure: -3,
  });

  it("is unavailable when Income leads", () => {
    const statements = [
      ...base(),
      quarter("INCOME", 2025, "Q1", INCOME_2025_Q1),
    ];
    expect(outcomes(statements, LATER).FCF_MARGIN_TTM).toEqual(
      unavailable("MISSING_QUARTER"),
    );
  });

  it("is unavailable when Cash Flow leads", () => {
    expect(outcomes([...base(), nextCashFlow], LATER).FCF_MARGIN_TTM).toEqual(
      unavailable("MISSING_QUARTER"),
    );
  });

  it("is unavailable when Cash Flow stopped reporting", () => {
    expect(
      outcomes(drop(base(), "CASH_FLOW", 2024, "Q4")).FCF_MARGIN_TTM,
    ).toEqual(unavailable("MISSING_QUARTER"));
  });

  it("uses the shared newest window once both families hold it", () => {
    const statements = [
      ...base(),
      quarter("INCOME", 2025, "Q1", INCOME_2025_Q1),
      nextCashFlow,
    ];
    // revenue 24+26+28+22 = 100; FCF 6+6+7+(13-3) = 29; 29 / 100 x 100
    expect(outcomes(statements, LATER).FCF_MARGIN_TTM).toEqual(
      value(29n, 1n, 29),
    );
  });
});

describe("balance-sheet states", () => {
  it("keeps the aligned ending state when a newer balance sheet exists; latest-state metrics move", () => {
    const statements = [
      ...base(),
      quarter("BALANCE_SHEET", 2025, "Q1", NEWER_SHEET),
    ];
    expectSome(outcomes(statements, LATER), {
      ROIC_TTM: BASE.ROIC_TTM,
      ROE_TTM: BASE.ROE_TTM,
      ROA_TTM: BASE.ROA_TTM,
      ASSET_TURNOVER_TTM: BASE.ASSET_TURNOVER_TTM,
      DEBT_TO_EQUITY: value(1n, 5n, 0.2), // 100 / 500
      CURRENT_RATIO: value(3n, 1n, 3), // 300 / 100
      NET_DEBT_TO_EBITDA_TTM: value(2n, 1n, 2), // 64 / 32
    });
  });

  it("never lets a newer balance sheet replace a missing ending state", () => {
    const statements = [
      ...drop(base(), "BALANCE_SHEET", 2024, "Q4"),
      quarter("BALANCE_SHEET", 2025, "Q1", NEWER_SHEET),
    ];
    expectSome(outcomes(statements, LATER), {
      ...every("MISSING_BALANCE_SHEET", AVERAGED_STATE_METRICS),
      DEBT_TO_EQUITY: value(1n, 5n, 0.2),
    });
  });

  it("never substitutes another quarter for the opening state", () => {
    const statements = [
      ...drop(base(), "BALANCE_SHEET", 2023, "Q4"),
      quarter("BALANCE_SHEET", 2023, "Q3", OPENING_SHEET),
    ];
    expectSome(
      outcomes(statements),
      every("MISSING_BALANCE_SHEET", AVERAGED_STATE_METRICS),
    );
  });

  it("neither reads nor requires the interior balance sheets", () => {
    const nonsense = {
      totalAssets: -1e6,
      totalStockholdersEquity: -1e6,
      totalDebt: 1e9,
      cashAndShortTermInvestments: -5,
    };
    const statements = [
      ...base(),
      quarter("BALANCE_SHEET", 2024, "Q1", nonsense, { reportedCurrency: "" }),
      quarter("BALANCE_SHEET", 2024, "Q2", nonsense, {
        reportedCurrency: "EUR",
      }),
      quarter("BALANCE_SHEET", 2024, "Q3", nonsense),
    ];
    expect(outcomes(statements)).toEqual(BASE);
  });

  it("takes net debt from the latest balance sheet even when it is older than the flow window", () => {
    // Without 2024 Q4 the latest balance sheet is 2023 Q4: 22 / 32, 30 / 80, 60 / 40.
    expectSome(outcomes(drop(base(), "BALANCE_SHEET", 2024, "Q4")), {
      NET_DEBT_TO_EBITDA_TTM: value(11n, 16n, 0.6875),
      DEBT_TO_EQUITY: value(3n, 8n, 0.375),
      CURRENT_RATIO: value(3n, 2n, 1.5),
    });
  });

  it("picks the latest balance sheet by fiscal quarter, not by availability", () => {
    // A revision of 2023 Q4 becomes available after 2024 Q4 did; 2024 Q4 is still the latest.
    const statements = [
      ...base(),
      quarter("BALANCE_SHEET", 2023, "Q4", OPENING_SHEET, {
        availableFromDate: "2025-02-15",
        observedAt: "2025-02-15T12:00:00.000Z",
        contentHash: "BALANCE_SHEET:2023:Q4:v2",
      }),
    ];
    expectSome(outcomes(statements), {
      DEBT_TO_EQUITY: BASE.DEBT_TO_EQUITY, // 36 / 80, not 30 / 80
      NET_DEBT_TO_EBITDA_TTM: BASE.NET_DEBT_TO_EBITDA_TTM, // 20 / 32, not 22 / 32
    });
  });

  it("falls back to cashAndCashEquivalents only when cashAndShortTermInvestments is missing", () => {
    // opening capital 30 + 80 - 50 = 60; average (60 + 100) / 2 = 80; 15.8 / 80 x 100 = 19.75
    const fallback = patch(base(), "BALANCE_SHEET", 2023, "Q4", {
      cashAndShortTermInvestments: undefined,
      cashAndCashEquivalents: 50,
    });
    expect(outcomes(fallback).ROIC_TTM).toEqual(value(79n, 4n, 19.75));

    // A reported 0 is cash: opening capital 30 + 80 - 0 = 110; ending 36 + 80 - 68 = 48;
    // average 79; 15.8 / 79 x 100 = 20. (Falling back to the 8 would give 102, 75, 21.07.)
    const zeroCash = patch(
      patch(base(), "BALANCE_SHEET", 2023, "Q4", {
        cashAndShortTermInvestments: 0,
      }),
      "BALANCE_SHEET",
      2024,
      "Q4",
      { cashAndShortTermInvestments: 68 },
    );
    expect(outcomes(zeroCash).ROIC_TTM).toEqual(value(20n, 1n, 20));
  });
});

describe("one currency per observation (rule 12)", () => {
  it("compares currencies without converting them", () => {
    const euro = base().map((statement) => ({
      ...statement,
      reportedCurrency: "EUR",
    }));
    expect(outcomes(euro)).toEqual(BASE);
  });

  cases([
    // across the previous and the current window
    [
      "Revenue Growth: previous window in EUR",
      "REVENUE_GROWTH_TTM_YOY",
      () => restamp(base(), "INCOME", 2023, "Q1", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "EPS Growth: previous window in EUR",
      "EPS_GROWTH_TTM_YOY",
      () => restamp(base(), "INCOME", 2023, "Q1", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "FCF Growth: previous window in EUR",
      "FCF_GROWTH_TTM_YOY",
      () =>
        restamp(base(), "CASH_FLOW", 2023, "Q1", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    // inside one window
    [
      "Gross Margin: one quarter in EUR",
      "GROSS_MARGIN_TTM",
      () => restamp(base(), "INCOME", 2024, "Q2", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "Operating Margin: one quarter in EUR",
      "OPERATING_MARGIN_TTM",
      () => restamp(base(), "INCOME", 2024, "Q2", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "Net Margin: one quarter in EUR",
      "NET_MARGIN_TTM",
      () => restamp(base(), "INCOME", 2024, "Q2", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "Interest Coverage: one quarter in EUR",
      "INTEREST_COVERAGE_TTM",
      () => restamp(base(), "INCOME", 2024, "Q2", { reportedCurrency: "EUR" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    // no two codes are equivalent
    [
      "Gross Margin: usd is not USD",
      "GROSS_MARGIN_TTM",
      () => restamp(base(), "INCOME", 2024, "Q2", { reportedCurrency: "usd" }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    // across families: every Cash Flow quarter is EUR, every Income quarter USD
    [
      "FCF Margin: families in different currencies",
      "FCF_MARGIN_TTM",
      () =>
        base().map((statement) =>
          statement.statementType === "CASH_FLOW"
            ? { ...statement, reportedCurrency: "EUR" }
            : statement,
        ),
      unavailable("CURRENCY_MISMATCH"),
    ],
    // between the flow window and a balance-sheet state
    [
      "ROIC: opening state in EUR",
      "ROIC_TTM",
      () =>
        restamp(base(), "BALANCE_SHEET", 2023, "Q4", {
          reportedCurrency: "EUR",
        }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "ROE: opening state in EUR",
      "ROE_TTM",
      () =>
        restamp(base(), "BALANCE_SHEET", 2023, "Q4", {
          reportedCurrency: "EUR",
        }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "ROA: opening state in EUR",
      "ROA_TTM",
      () =>
        restamp(base(), "BALANCE_SHEET", 2023, "Q4", {
          reportedCurrency: "EUR",
        }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "Asset Turnover: opening state in EUR",
      "ASSET_TURNOVER_TTM",
      () =>
        restamp(base(), "BALANCE_SHEET", 2023, "Q4", {
          reportedCurrency: "EUR",
        }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    [
      "Net Debt / EBITDA: latest state in EUR",
      "NET_DEBT_TO_EBITDA_TTM",
      () =>
        restamp(base(), "BALANCE_SHEET", 2024, "Q4", {
          reportedCurrency: "EUR",
        }),
      unavailable("CURRENCY_MISMATCH"),
    ],
    // a single-statement ratio has nothing to disagree with
    [
      "Debt / Equity: latest state in EUR",
      "DEBT_TO_EQUITY",
      () =>
        restamp(base(), "BALANCE_SHEET", 2024, "Q4", {
          reportedCurrency: "EUR",
        }),
      BASE.DEBT_TO_EQUITY,
    ],
    [
      "Current Ratio: latest state in EUR",
      "CURRENT_RATIO",
      () =>
        restamp(base(), "BALANCE_SHEET", 2024, "Q4", {
          reportedCurrency: "EUR",
        }),
      BASE.CURRENT_RATIO,
    ],
  ]);

  /** One statement each metric reads, to strip of its currency. */
  const CONTRIBUTOR: Record<Id, readonly [Family, number, Quarter]> = {
    REVENUE_GROWTH_TTM_YOY: ["INCOME", 2023, "Q2"],
    EPS_GROWTH_TTM_YOY: ["INCOME", 2023, "Q2"],
    FCF_GROWTH_TTM_YOY: ["CASH_FLOW", 2024, "Q3"],
    GROSS_MARGIN_TTM: ["INCOME", 2024, "Q1"],
    OPERATING_MARGIN_TTM: ["INCOME", 2024, "Q1"],
    NET_MARGIN_TTM: ["INCOME", 2024, "Q1"],
    FCF_MARGIN_TTM: ["CASH_FLOW", 2024, "Q1"],
    ROIC_TTM: ["BALANCE_SHEET", 2024, "Q4"],
    ROE_TTM: ["BALANCE_SHEET", 2024, "Q4"],
    ROA_TTM: ["BALANCE_SHEET", 2023, "Q4"],
    DEBT_TO_EQUITY: ["BALANCE_SHEET", 2024, "Q4"],
    CURRENT_RATIO: ["BALANCE_SHEET", 2024, "Q4"],
    NET_DEBT_TO_EBITDA_TTM: ["BALANCE_SHEET", 2024, "Q4"],
    INTEREST_COVERAGE_TTM: ["INCOME", 2024, "Q3"],
    ASSET_TURNOVER_TTM: ["BALANCE_SHEET", 2023, "Q4"],
  };

  for (const { id } of ORACLE_FUNDAMENTAL_METRICS) {
    it(`${id}: a contributing statement with an empty or blank currency`, () => {
      const [family, fiscalYear, period] = CONTRIBUTOR[id];
      for (const reportedCurrency of ["", "   "]) {
        const statements = restamp(base(), family, fiscalYear, period, {
          reportedCurrency,
        });
        expect(
          outcomes(statements)[id],
          JSON.stringify(reportedCurrency),
        ).toEqual(unavailable("MISSING_CURRENCY"));
      }
    });
  }

  it("ignores the currency of statements the observation does not read", () => {
    const statements = [
      ...base(),
      quarter("INCOME", 2022, "Q4", INCOME_2023.Q4, { reportedCurrency: "" }), // before every window
      quarter("CASH_FLOW", 2022, "Q4", CASH_FLOW_2023.Q4, {
        reportedCurrency: "EUR",
      }),
      annual("INCOME", 2024, { revenue: 100 }), // FY rows are never read
      {
        ...annual("BALANCE_SHEET", 2024, ENDING_SHEET),
        reportedCurrency: "EUR",
      },
    ];
    expect(outcomes(statements)).toEqual(BASE);
  });
});

describe("storage range: |value| >= 10^12 is unavailable, never clamped", () => {
  const OUT = unavailable("OUT_OF_STORAGE_RANGE");
  const tinyRevenue = () =>
    patchYear(base(), "INCOME", 2024, {
      Q1: { revenue: 1e-12 },
      Q2: { revenue: 0 },
      Q3: { revenue: 0 },
      Q4: { revenue: 0 },
    });

  cases([
    // previous revenue 1e-9: (100 / 1e-9 - 1) x 100 = 9 999 999 999 900
    [
      "Revenue Growth",
      "REVENUE_GROWTH_TTM_YOY",
      () =>
        patchYear(base(), "INCOME", 2023, {
          Q1: { revenue: 1e-9 },
          Q2: { revenue: 0 },
          Q3: { revenue: 0 },
          Q4: { revenue: 0 },
        }),
      OUT,
    ],
    // previous EPS 1e-12: (2.4 / 1e-12 - 1) x 100 = 239 999 999 999 900
    [
      "EPS Growth",
      "EPS_GROWTH_TTM_YOY",
      () =>
        patchYear(base(), "INCOME", 2023, {
          Q1: { epsDiluted: 1e-12 },
          Q2: { epsDiluted: 0 },
          Q3: { epsDiluted: 0 },
          Q4: { epsDiluted: 0 },
        }),
      OUT,
    ],
    // previous FCF (3.000000000001 - 3) + 0 + 0 + 0 = 1e-12: (24 / 1e-12 - 1) x 100 = 2.4e15 - 100
    [
      "FCF Growth",
      "FCF_GROWTH_TTM_YOY",
      () =>
        patchYear(base(), "CASH_FLOW", 2023, {
          Q1: { operatingCashFlow: 3.000000000001 },
          Q2: { operatingCashFlow: 3 },
          Q3: { operatingCashFlow: 3 },
          Q4: { operatingCashFlow: 3 },
        }),
      OUT,
    ],
    // revenue 1e-12: 40 / 1e-12 x 100 = 4e15
    ["Gross Margin", "GROSS_MARGIN_TTM", tinyRevenue, OUT],
    // 20 / 1e-12 x 100 = 2e15
    ["Operating Margin", "OPERATING_MARGIN_TTM", tinyRevenue, OUT],
    // 12 / 1e-12 x 100 = 1.2e15
    ["Net Margin", "NET_MARGIN_TTM", tinyRevenue, OUT],
    // 24 / 1e-12 x 100 = 2.4e15
    ["FCF Margin", "FCF_MARGIN_TTM", tinyRevenue, OUT],
    // operating income 2e12+5+5+6; NOPAT x 0.79 = 1 580 000 000 012.64; / 100 x 100
    [
      "ROIC",
      "ROIC_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { operatingIncome: 2e12 }),
      OUT,
    ],
    // net income 1e12+3+3+4; / 80 x 100 = 1 250 000 000 012.5
    [
      "ROE",
      "ROE_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { netIncome: 1e12 }),
      OUT,
    ],
    // net income 3e12+10; / 200 x 100 = 1 500 000 000 005
    [
      "ROA",
      "ROA_TTM",
      () => patch(base(), "INCOME", 2024, "Q1", { netIncome: 3e12 }),
      OUT,
    ],
    // exactly the bound: 8e13 / 80 = 10^12
    [
      "Debt / Equity at exactly 10^12",
      "DEBT_TO_EQUITY",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { totalDebt: 8e13 }),
      OUT,
    ],
    // 5e13 / 50 = 10^12
    [
      "Current Ratio at exactly 10^12",
      "CURRENT_RATIO",
      () =>
        patch(base(), "BALANCE_SHEET", 2024, "Q4", {
          totalCurrentAssets: 5e13,
        }),
      OUT,
    ],
    // the magnitude counts: -3.2e13 / 32 = -10^12
    [
      "Net Debt / EBITDA at exactly -10^12",
      "NET_DEBT_TO_EBITDA_TTM",
      () => patch(base(), "BALANCE_SHEET", 2024, "Q4", { netDebt: -3.2e13 }),
      OUT,
    ],
    // interest expense 1e-12: 24 / 1e-12 = 2.4e13
    [
      "Interest Coverage",
      "INTEREST_COVERAGE_TTM",
      () =>
        patchYear(base(), "INCOME", 2024, {
          Q1: { interestExpense: 1e-12 },
          Q2: { interestExpense: 0 },
          Q3: { interestExpense: 0 },
          Q4: { interestExpense: 0 },
        }),
      OUT,
    ],
    // average assets 1e-12: 100 / 1e-12 = 1e14
    [
      "Asset Turnover",
      "ASSET_TURNOVER_TTM",
      () =>
        patch(
          patch(base(), "BALANCE_SHEET", 2023, "Q4", { totalAssets: 1e-12 }),
          "BALANCE_SHEET",
          2024,
          "Q4",
          { totalAssets: 1e-12 },
        ),
      OUT,
    ],
  ]);

  it("keeps a value just inside the bound", () => {
    // 999999999999.9999 / 1 is below 10^12; the decimal is exact and its nearest double is the literal.
    const statements = patch(base(), "BALANCE_SHEET", 2024, "Q4", {
      totalDebt: 999999999999.9999,
      totalStockholdersEquity: 1,
    });
    expect(outcomes(statements).DEBT_TO_EQUITY).toEqual(
      value(9999999999999999n, 10000n, 999999999999.9999),
    );
  });
});

describe("non-finite intermediates", () => {
  it("rejects a window total a double cannot hold", () => {
    // 4 x 1e308 = 4e308 > Number.MAX_VALUE (about 1.797e308), though every quarter is finite.
    const statements = patchYear(base(), "INCOME", 2024, {
      Q1: { revenue: 1e308 },
      Q2: { revenue: 1e308 },
      Q3: { revenue: 1e308 },
      Q4: { revenue: 1e308 },
    });
    expect(outcomes(statements)).toEqual({
      ...BASE,
      ...every("NON_FINITE_INTERMEDIATE", [
        "REVENUE_GROWTH_TTM_YOY",
        "GROSS_MARGIN_TTM",
        "OPERATING_MARGIN_TTM",
        "NET_MARGIN_TTM",
        "FCF_MARGIN_TTM",
        "ASSET_TURNOVER_TTM",
      ]),
    });
  });

  it("rejects a balance-sheet sum a double cannot hold, though each state and the average could", () => {
    // opening + ending assets 1e308 + 1e308 = 2e308.
    const assets = patch(
      patch(base(), "BALANCE_SHEET", 2023, "Q4", { totalAssets: 1e308 }),
      "BALANCE_SHEET",
      2024,
      "Q4",
      { totalAssets: 1e308 },
    );
    expectSome(
      outcomes(assets),
      every("NON_FINITE_INTERMEDIATE", ["ROA_TTM", "ASSET_TURNOVER_TTM"]),
    );

    // Ending invested capital 1e308 + 1e308 - 16 is past MAX_VALUE; Debt / Equity reads the same
    // two fields with no sum at all: 1e308 / 1e308 = 1.
    const capital = patch(base(), "BALANCE_SHEET", 2024, "Q4", {
      totalDebt: 1e308,
      totalStockholdersEquity: 1e308,
    });
    expectSome(outcomes(capital), {
      ROIC_TTM: unavailable("NON_FINITE_INTERMEDIATE"),
      DEBT_TO_EQUITY: value(1n, 1n, 1),
    });
  });

  it("rejects a quarter's free cash flow a double cannot hold", () => {
    const statements = patch(base(), "CASH_FLOW", 2024, "Q1", {
      operatingCashFlow: 1e308,
      capitalExpenditure: 1e308,
    });
    expectSome(
      outcomes(statements),
      every("NON_FINITE_INTERMEDIATE", [
        "FCF_GROWTH_TTM_YOY",
        "FCF_MARGIN_TTM",
      ]),
    );
  });
});

describe("numeric model", () => {
  it("reads a line item as the exact decimal its shortest text denotes", () => {
    expect(oracleLineItem(0.1)).toEqual({ numerator: 1n, denominator: 10n });
    expect(oracleLineItem(-2.5)).toEqual({ numerator: -5n, denominator: 2n });
    // 123456 / 1000, reduced by 8
    expect(oracleLineItem(123.456)).toEqual({
      numerator: 15432n,
      denominator: 125n,
    });
    expect(oracleLineItem(-0)).toEqual({ numerator: 0n, denominator: 1n });
    // "1e+21" and "1.5e-7" = 15 / 10^8 = 3 / 20 000 000
    expect(oracleLineItem(1e21)).toEqual({
      numerator: 10n ** 21n,
      denominator: 1n,
    });
    expect(oracleLineItem(1.5e-7)).toEqual({
      numerator: 3n,
      denominator: 20000000n,
    });
    // "1.7976931348623157e+308" and "5e-324" = 5 / 10^324 = 1 / (2 x 10^323)
    expect(oracleLineItem(1.7976931348623157e308)).toEqual({
      numerator: 17976931348623157n * 10n ** 292n,
      denominator: 1n,
    });
    expect(oracleLineItem(5e-324)).toEqual({
      numerator: 1n,
      denominator: 2n * 10n ** 323n,
    });
  });

  it("finds no value in anything but a finite number", () => {
    for (const missing of [
      undefined,
      null,
      Number.NaN,
      Infinity,
      -Infinity,
      "22",
      true,
      {},
      [],
    ]) {
      expect(oracleLineItem(missing), String(missing)).toBeUndefined();
    }
  });

  it("rounds an exact rational to the nearest double, ties to even", () => {
    expect(oracleNearestDouble({ numerator: 1n, denominator: 3n })).toBe(
      0.3333333333333333,
    );
    expect(oracleNearestDouble({ numerator: -2n, denominator: 3n })).toBe(
      -0.6666666666666666,
    );
    expect(oracleNearestDouble({ numerator: 1n, denominator: 10n })).toBe(0.1);
    // 2^53 + 1 lies halfway between 2^53 and 2^53 + 2: the even significand, 2^53, wins.
    expect(
      oracleNearestDouble({ numerator: 2n ** 53n + 1n, denominator: 1n }),
    ).toBe(9007199254740992);
    // 2^53 + 3 lies halfway between 2^53 + 2 (odd significand) and 2^53 + 4 (even).
    expect(
      oracleNearestDouble({ numerator: 2n ** 53n + 3n, denominator: 1n }),
    ).toBe(9007199254740996);
    // Largest double, (2^53 - 1) x 2^971, and 2^1024 past it.
    expect(
      oracleNearestDouble({
        numerator: ((1n << 53n) - 1n) << 971n,
        denominator: 1n,
      }),
    ).toBe(1.7976931348623157e308);
    expect(
      oracleNearestDouble({ numerator: 1n << 1024n, denominator: 1n }),
    ).toBe(Infinity);
    // Smallest normal 2^-1022 and smallest subnormal 2^-1074.
    expect(
      oracleNearestDouble({ numerator: 1n, denominator: 2n ** 1022n }),
    ).toBe(2.2250738585072014e-308);
    expect(
      oracleNearestDouble({ numerator: 1n, denominator: 2n ** 1074n }),
    ).toBe(5e-324);
    // 3/4 of the smallest subnormal rounds up to it; exactly half of it ties to 0 (even).
    expect(
      oracleNearestDouble({ numerator: 3n, denominator: 2n ** 1076n }),
    ).toBe(5e-324);
    expect(
      Object.is(
        oracleNearestDouble({ numerator: 1n, denominator: 2n ** 1075n }),
        0,
      ),
    ).toBe(true);
    expect(
      Object.is(
        oracleNearestDouble({ numerator: -1n, denominator: 2n ** 1075n }),
        0,
      ),
    ).toBe(true);
    expect(
      Object.is(oracleNearestDouble({ numerator: 0n, denominator: 1n }), 0),
    ).toBe(true);
  });

  it("reports a non-terminating ratio exactly, and as its nearest double", () => {
    // Debt / Equity 1 / 3
    const statements = patch(base(), "BALANCE_SHEET", 2024, "Q4", {
      totalDebt: 1,
      totalStockholdersEquity: 3,
    });
    expect(outcomes(statements).DEBT_TO_EQUITY).toEqual(
      value(1n, 3n, 0.3333333333333333),
    );
  });

  it("does all arithmetic exactly", () => {
    // revenue 0.1+0.2+0.3+0.4 = 1 and gross profit 4 x 0.1 = 0.4: exactly 40%.
    const decimals = patchYear(base(), "INCOME", 2024, {
      Q1: { revenue: 0.1, grossProfit: 0.1 },
      Q2: { revenue: 0.2, grossProfit: 0.1 },
      Q3: { revenue: 0.3, grossProfit: 0.1 },
      Q4: { revenue: 0.4, grossProfit: 0.1 },
    });
    expect(outcomes(decimals).GROSS_MARGIN_TTM).toEqual(value(40n, 1n, 40));
  });

  it("uses a tax rate of exactly 21/100", () => {
    expect(ORACLE_ROIC_TAX_RATE).toEqual({ numerator: 21n, denominator: 100n });
    // operating income 4 x 25 = 100; NOPAT 100 x 0.79 = 79; / 100 x 100 = 79
    const statements = patchYear(base(), "INCOME", 2024, {
      Q1: { operatingIncome: 25 },
      Q2: { operatingIncome: 25 },
      Q3: { operatingIncome: 25 },
      Q4: { operatingIncome: 25 },
    });
    expect(outcomes(statements).ROIC_TTM).toEqual(value(79n, 1n, 79));
  });
});

describe("input the rules could only misread", () => {
  it("refuses a malformed date and statements of two securities", () => {
    expect(() => oracleFundamentalOutcomes(base(), "2025-3-1")).toThrow();
    const mixed = [
      ...base(),
      {
        ...quarter("INCOME", 2025, "Q1", INCOME_2025_Q1),
        securityId: "security-2",
      },
    ];
    expect(() => oracleFundamentalOutcomes(mixed, LATER)).toThrow();
  });
});
