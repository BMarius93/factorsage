import type { FinancialStatement } from "@intrinsic/domain";
import {
  evaluateFundamentalMetrics,
  materializeDailyFundamentals,
} from "@intrinsic/stock-data";
import {
  FUNDAMENTAL_AUDIT_METRICS,
  type FundamentalAuditMetricId,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { oracleFundamentalOutcomes } from "../oracle/fundamentals";
import { valueTolerance } from "./differential";

/**
 * The targeted edge matrix of audit section 5 (with the fiscal-sequencing cases of section 6 and
 * the currency cases of section 9): every one of the fifteen metrics under every named situation.
 *
 * Each case states **by hand** which metrics must be unavailable and, where the arithmetic is short,
 * the exact reading. The production snapshot (`evaluateFundamentalMetrics`) must then agree with that
 * statement *and* with the independent oracle on all fifteen: availability exactly, values within
 * `valueTolerance` (far below the storage quantum). Nothing expected here is computed by production
 * code.
 *
 * The base company (a December fiscal year, FY2023 Q2 … FY2025 Q1, all public by 2025-05-10) reads,
 * by hand:
 *
 * - revenue 200 a quarter in the previous year and 250 in the current one: growth 1000/800 = +25%;
 * - diluted EPS 0.4 then 0.5: 2.0/1.6 = +25%; FCF (OCF + CapEx) 30-10 then 40-15: 100/80 = +25%;
 * - current year: gross profit 400 (40%), operating income 120 (12%), net income 80 (8%), FCF 100
 *   (10%), EBITDA 180, EBIT 128, interest expense 16 (coverage 8);
 * - opening balance sheet FY2024 Q1: debt 700, equity 500, cash 400 (invested capital 800), assets
 *   1,800; ending FY2025 Q1: debt 740, equity 700, cash 660 (invested capital 780), assets 2,200,
 *   current assets 900, current liabilities 600, net debt 90;
 * - ROIC 120 x 0.79 / 790 = 12%; ROE 80 / 600 = 13.33…%; ROA 80 / 2000 = 4%; Asset Turnover
 *   1000 / 2000 = 0.5; Debt / Equity 740 / 700 = 1.0571…; Current Ratio 1.5; Net Debt / EBITDA 0.5.
 */

type Id = FundamentalAuditMetricId;
type Family = FinancialStatement["statementType"];
type Values = Record<string, number>;

const SECURITY = "edge-security";
const EVALUATED_ON = "2025-06-02";
const ALL_IDS = FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id) as Id[];

const BASE_VALUES: Record<Id, number> = {
  REVENUE_GROWTH_TTM_YOY: 25,
  EPS_GROWTH_TTM_YOY: 25,
  FCF_GROWTH_TTM_YOY: 25,
  GROSS_MARGIN_TTM: 40,
  OPERATING_MARGIN_TTM: 12,
  NET_MARGIN_TTM: 8,
  FCF_MARGIN_TTM: 10,
  ROIC_TTM: 12,
  ROE_TTM: 40 / 3,
  ROA_TTM: 4,
  DEBT_TO_EQUITY: 740 / 700,
  CURRENT_RATIO: 1.5,
  NET_DEBT_TO_EBITDA_TTM: 0.5,
  INTEREST_COVERAGE_TTM: 8,
  ASSET_TURNOVER_TTM: 0.5,
};

/** Fiscal quarters of the base, oldest first: FY2023 Q2 … FY2025 Q1. */
const QUARTERS: readonly {
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
}[] = [
  { fiscalYear: 2023, period: "Q2" },
  { fiscalYear: 2023, period: "Q3" },
  { fiscalYear: 2023, period: "Q4" },
  { fiscalYear: 2024, period: "Q1" },
  { fiscalYear: 2024, period: "Q2" },
  { fiscalYear: 2024, period: "Q3" },
  { fiscalYear: 2024, period: "Q4" },
  { fiscalYear: 2025, period: "Q1" },
];

const MONTH_END = {
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
} as const;

function key(fiscalYear: number, period: string): string {
  return `${fiscalYear}${period}`;
}

type Fixture = {
  statements: FinancialStatement[];
  /** The statement of one family and quarter, for a case to edit in place. */
  row(family: Family, fiscalYear: number, period: string): FinancialStatement;
  drop(family: Family, fiscalYear: number, period: string): void;
};

let hashSequence = 0;

function statement(
  family: Family,
  fiscalYear: number,
  period: "FY" | "Q1" | "Q2" | "Q3" | "Q4",
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  hashSequence += 1;
  const fiscalDate =
    period === "FY"
      ? `${fiscalYear}-12-31`
      : `${fiscalYear}-${MONTH_END[period]}`;
  return {
    securityId: SECURITY,
    statementType: family,
    fiscalDate,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate: "2025-05-09",
    availableFromDate: "2025-05-10",
    observedAt: "2025-05-10T12:00:00.000Z",
    contentHash: `hash-${String(hashSequence).padStart(6, "0")}`,
    values,
    ...overrides,
  } as FinancialStatement;
}

function base(): Fixture {
  const statements: FinancialStatement[] = [];
  QUARTERS.forEach(({ fiscalYear, period }, index) => {
    const current = index >= 4;
    statements.push(
      statement("INCOME", fiscalYear, period, {
        revenue: current ? 250 : 200,
        grossProfit: current ? 100 : 70,
        operatingIncome: current ? 30 : 25,
        netIncome: current ? 20 : 16,
        epsDiluted: current ? 0.5 : 0.4,
        ebitda: current ? 45 : 40,
        ebit: current ? 32 : 28,
        interestExpense: current ? 4 : 5,
      }),
      statement("CASH_FLOW", fiscalYear, period, {
        operatingCashFlow: current ? 40 : 30,
        capitalExpenditure: current ? -15 : -10,
        freeCashFlow: 999,
      }),
    );
    const sheet: Values =
      key(fiscalYear, period) === "2024Q1"
        ? {
            totalDebt: 700,
            totalStockholdersEquity: 500,
            cashAndShortTermInvestments: 400,
            cashAndCashEquivalents: 300,
            totalAssets: 1_800,
            totalCurrentAssets: 800,
            totalCurrentLiabilities: 500,
            netDebt: 300,
          }
        : key(fiscalYear, period) === "2025Q1"
          ? {
              totalDebt: 740,
              totalStockholdersEquity: 700,
              totalEquity: 900,
              cashAndShortTermInvestments: 660,
              cashAndCashEquivalents: 500,
              totalAssets: 2_200,
              totalCurrentAssets: 900,
              totalCurrentLiabilities: 600,
              netDebt: 90,
            }
          : // Interior and older balance sheets: deliberately odd, never read by the averaged states.
            {
              totalDebt: 1,
              totalStockholdersEquity: -9,
              cashAndShortTermInvestments: 5,
              totalAssets: 7,
              totalCurrentAssets: 3,
              totalCurrentLiabilities: 1,
              netDebt: 1,
            };
    statements.push(statement("BALANCE_SHEET", fiscalYear, period, sheet));
  });
  const find = (family: Family, fiscalYear: number, period: string) =>
    statements.findIndex(
      (row) =>
        row.statementType === family &&
        row.fiscalYear === fiscalYear &&
        row.period === period,
    );
  return {
    statements,
    row(family, fiscalYear, period) {
      const index = find(family, fiscalYear, period);
      if (index < 0) {
        throw new Error(`no ${family} ${fiscalYear} ${period}`);
      }
      return statements[index]!;
    },
    drop(family, fiscalYear, period) {
      statements.splice(find(family, fiscalYear, period), 1);
    },
  };
}

/** Replaces some line items of one statement; `undefined` removes the line item. */
function edit(
  fixture: Fixture,
  family: Family,
  fiscalYear: number,
  period: string,
  changes: Record<string, number | undefined>,
): void {
  const row = fixture.row(family, fiscalYear, period);
  const values = { ...(row.values as Values) };
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete values[field];
    } else {
      values[field] = value;
    }
  }
  (row as { values: Values }).values = values;
}

function editWindow(
  fixture: Fixture,
  family: Family,
  window: "current" | "previous",
  changes: Record<string, number | undefined>,
): void {
  const quarters =
    window === "current" ? QUARTERS.slice(4) : QUARTERS.slice(0, 4);
  for (const { fiscalYear, period } of quarters) {
    edit(fixture, family, fiscalYear, period, changes);
  }
}

function currency(
  fixture: Fixture,
  family: Family,
  fiscalYear: number,
  period: string,
  code: string,
): void {
  (
    fixture.row(family, fiscalYear, period) as { reportedCurrency: string }
  ).reportedCurrency = code;
}

type Case = {
  name: string;
  build: (fixture: Fixture) => void;
  /** Hand-stated: exactly these metrics are unavailable. */
  unavailable: readonly Id[];
  /** Hand-computed readings for some of the available metrics. */
  values?: Partial<Record<Id, number>>;
  date?: string;
};

const INCOME_READERS: readonly Id[] = [
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
const AVERAGED_STATE: readonly Id[] = [
  "ROIC_TTM",
  "ROE_TTM",
  "ROA_TTM",
  "ASSET_TURNOVER_TTM",
];

const CASES: readonly Case[] = [
  // ---- the ordinary case --------------------------------------------------------------------
  {
    name: "base: every metric available at its hand-computed reading",
    build: () => {},
    unavailable: [],
    values: BASE_VALUES,
  },

  // ---- legitimate negative readings -----------------------------------------------------------
  {
    name: "a loss quarter: net income -100 in FY2025 Q1 (Net Margin -4%, ROE -6.67%, ROA -2%)",
    build: (f) => edit(f, "INCOME", 2025, "Q1", { netIncome: -100 }),
    unavailable: [],
    values: { NET_MARGIN_TTM: -4, ROE_TTM: -40 / 6, ROA_TTM: -2 },
  },
  {
    name: "operating losses: Operating Margin -12%, ROIC -12%",
    build: (f) => editWindow(f, "INCOME", "current", { operatingIncome: -30 }),
    unavailable: [],
    values: { OPERATING_MARGIN_TTM: -12, ROIC_TTM: -12 },
  },
  {
    name: "net cash: Net Debt / EBITDA -0.5",
    build: (f) => edit(f, "BALANCE_SHEET", 2025, "Q1", { netDebt: -90 }),
    unavailable: [],
    values: { NET_DEBT_TO_EBITDA_TTM: -0.5 },
  },
  {
    name: "negative EBIT: Interest Coverage -8",
    build: (f) => editWindow(f, "INCOME", "current", { ebit: -32 }),
    unavailable: [],
    values: { INTEREST_COVERAGE_TTM: -8 },
  },
  {
    name: "negative free cash flow: FCF Margin -4%, FCF Growth unavailable (current TTM not positive)",
    build: (f) =>
      editWindow(f, "CASH_FLOW", "current", { operatingCashFlow: 5 }),
    unavailable: ["FCF_GROWTH_TTM_YOY"],
    values: { FCF_MARGIN_TTM: -4 },
  },
  {
    name: "shrinking revenue: Revenue Growth -25%",
    build: (f) => editWindow(f, "INCOME", "current", { revenue: 150 }),
    unavailable: [],
    values: {
      REVENUE_GROWTH_TTM_YOY: -25,
      GROSS_MARGIN_TTM: 400 / 6,
      ASSET_TURNOVER_TTM: 0.3,
    },
  },
  {
    name: "a negative gross margin is a reading",
    build: (f) => editWindow(f, "INCOME", "current", { grossProfit: -25 }),
    unavailable: [],
    values: { GROSS_MARGIN_TTM: -10 },
  },

  // ---- real zeros -----------------------------------------------------------------------------
  {
    name: "zero gross profit: Gross Margin 0",
    build: (f) => editWindow(f, "INCOME", "current", { grossProfit: 0 }),
    unavailable: [],
    values: { GROSS_MARGIN_TTM: 0 },
  },
  {
    name: "zero net debt: Net Debt / EBITDA 0",
    build: (f) => edit(f, "BALANCE_SHEET", 2025, "Q1", { netDebt: 0 }),
    unavailable: [],
    values: { NET_DEBT_TO_EBITDA_TTM: 0 },
  },
  {
    name: "zero debt: Debt / Equity 0; invested capital 40, ROIC 120 x 0.79 / 420",
    build: (f) => edit(f, "BALANCE_SHEET", 2025, "Q1", { totalDebt: 0 }),
    unavailable: [],
    values: { DEBT_TO_EQUITY: 0, ROIC_TTM: (94.8 / 420) * 100 },
  },
  {
    name: "zero current assets: Current Ratio 0",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalCurrentAssets: 0 }),
    unavailable: [],
    values: { CURRENT_RATIO: 0 },
  },
  {
    name: "zero EBIT: Interest Coverage 0",
    build: (f) => editWindow(f, "INCOME", "current", { ebit: 0 }),
    unavailable: [],
    values: { INTEREST_COVERAGE_TTM: 0 },
  },
  {
    name: "zero net income: Net Margin, ROE, ROA 0",
    build: (f) => editWindow(f, "INCOME", "current", { netIncome: 0 }),
    unavailable: [],
    values: { NET_MARGIN_TTM: 0, ROE_TTM: 0, ROA_TTM: 0 },
  },
  {
    name: "equal trailing years: Revenue Growth exactly 0",
    build: (f) => editWindow(f, "INCOME", "previous", { revenue: 250 }),
    unavailable: [],
    values: { REVENUE_GROWTH_TTM_YOY: 0 },
  },
  {
    name: "zero free cash flow: FCF Margin 0; FCF Growth unavailable",
    build: (f) =>
      editWindow(f, "CASH_FLOW", "current", { operatingCashFlow: 15 }),
    unavailable: ["FCF_GROWTH_TTM_YOY"],
    values: { FCF_MARGIN_TTM: 0 },
  },

  // ---- zero and negative denominators ---------------------------------------------------------
  {
    name: "zero revenue: the margins, Asset Turnover and Revenue Growth unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { revenue: 0 }),
    unavailable: [
      "REVENUE_GROWTH_TTM_YOY",
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ASSET_TURNOVER_TTM",
    ],
  },
  {
    name: "negative revenue: the same metrics unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { revenue: -250 }),
    unavailable: [
      "REVENUE_GROWTH_TTM_YOY",
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ASSET_TURNOVER_TTM",
    ],
  },
  {
    name: "zero interest expense: Interest Coverage unavailable, never infinite",
    build: (f) => editWindow(f, "INCOME", "current", { interestExpense: 0 }),
    unavailable: ["INTEREST_COVERAGE_TTM"],
  },
  {
    name: "negative interest expense: Interest Coverage unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { interestExpense: -4 }),
    unavailable: ["INTEREST_COVERAGE_TTM"],
  },
  {
    name: "zero ending equity: Debt / Equity unavailable; ROE on average equity 250 is 32%",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalStockholdersEquity: 0 }),
    unavailable: ["DEBT_TO_EQUITY"],
    values: { ROE_TTM: 32 },
  },
  {
    name: "negative ending equity: Debt / Equity unavailable, never a signed leverage ratio",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalStockholdersEquity: -50 }),
    unavailable: ["DEBT_TO_EQUITY"],
  },
  {
    name: "non-positive average equity: ROE unavailable",
    build: (f) => {
      edit(f, "BALANCE_SHEET", 2024, "Q1", { totalStockholdersEquity: -900 });
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalStockholdersEquity: 700 });
    },
    unavailable: ["ROE_TTM"],
  },
  {
    name: "zero current liabilities: Current Ratio unavailable",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalCurrentLiabilities: 0 }),
    unavailable: ["CURRENT_RATIO"],
  },
  {
    name: "negative current liabilities: Current Ratio unavailable",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalCurrentLiabilities: -10 }),
    unavailable: ["CURRENT_RATIO"],
  },
  {
    name: "zero EBITDA: Net Debt / EBITDA unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { ebitda: 0 }),
    unavailable: ["NET_DEBT_TO_EBITDA_TTM"],
  },
  {
    name: "negative EBITDA: Net Debt / EBITDA unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { ebitda: -45 }),
    unavailable: ["NET_DEBT_TO_EBITDA_TTM"],
  },
  {
    name: "zero previous revenue: Revenue Growth unavailable",
    build: (f) => editWindow(f, "INCOME", "previous", { revenue: 0 }),
    unavailable: ["REVENUE_GROWTH_TTM_YOY"],
  },
  {
    name: "previous EPS nets to exactly zero (0.1 + 0.2 - 0.3 + 0): EPS Growth unavailable, never 5.55e-17",
    build: (f) => {
      const eps = [0.1, 0.2, -0.3, 0];
      QUARTERS.slice(0, 4).forEach(({ fiscalYear, period }, index) =>
        edit(f, "INCOME", fiscalYear, period, { epsDiluted: eps[index]! }),
      );
    },
    unavailable: ["EPS_GROWTH_TTM_YOY"],
  },
  {
    name: "loss to profit: EPS Growth unavailable, never a turnaround percentage",
    build: (f) => editWindow(f, "INCOME", "previous", { epsDiluted: -0.4 }),
    unavailable: ["EPS_GROWTH_TTM_YOY"],
  },
  {
    name: "profit to loss: EPS Growth unavailable",
    build: (f) => editWindow(f, "INCOME", "current", { epsDiluted: -0.5 }),
    unavailable: ["EPS_GROWTH_TTM_YOY"],
  },
  {
    name: "negative previous FCF: FCF Growth unavailable",
    build: (f) =>
      editWindow(f, "CASH_FLOW", "previous", { operatingCashFlow: 0 }),
    unavailable: ["FCF_GROWTH_TTM_YOY"],
  },
  {
    name: "average assets exactly zero: ROA and Asset Turnover unavailable",
    build: (f) => edit(f, "BALANCE_SHEET", 2024, "Q1", { totalAssets: -2_200 }),
    unavailable: ["ROA_TTM", "ASSET_TURNOVER_TTM"],
  },
  {
    name: "average invested capital exactly zero: ROIC unavailable, ROE still 80 / 410",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2024, "Q1", {
        totalDebt: 0,
        totalStockholdersEquity: 120,
        cashAndShortTermInvestments: 900,
      }),
    unavailable: ["ROIC_TTM"],
    values: { ROE_TTM: (80 / 410) * 100 },
  },

  // ---- missing line items -------------------------------------------------------------------
  {
    name: "missing revenue",
    build: (f) => edit(f, "INCOME", 2025, "Q1", { revenue: undefined }),
    unavailable: [
      "REVENUE_GROWTH_TTM_YOY",
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ASSET_TURNOVER_TTM",
    ],
  },
  {
    name: "missing gross profit",
    build: (f) => edit(f, "INCOME", 2024, "Q3", { grossProfit: undefined }),
    unavailable: ["GROSS_MARGIN_TTM"],
  },
  {
    name: "missing operating income",
    build: (f) => edit(f, "INCOME", 2024, "Q2", { operatingIncome: undefined }),
    unavailable: ["OPERATING_MARGIN_TTM", "ROIC_TTM"],
  },
  {
    name: "missing net income",
    build: (f) => edit(f, "INCOME", 2025, "Q1", { netIncome: undefined }),
    unavailable: ["NET_MARGIN_TTM", "ROE_TTM", "ROA_TTM"],
  },
  {
    name: "missing diluted EPS in the previous year",
    build: (f) => edit(f, "INCOME", 2023, "Q3", { epsDiluted: undefined }),
    unavailable: ["EPS_GROWTH_TTM_YOY"],
  },
  {
    name: "missing EBITDA",
    build: (f) => edit(f, "INCOME", 2024, "Q4", { ebitda: undefined }),
    unavailable: ["NET_DEBT_TO_EBITDA_TTM"],
  },
  {
    name: "missing EBIT",
    build: (f) => edit(f, "INCOME", 2024, "Q4", { ebit: undefined }),
    unavailable: ["INTEREST_COVERAGE_TTM"],
  },
  {
    name: "missing interest expense, never zero",
    build: (f) => edit(f, "INCOME", 2024, "Q4", { interestExpense: undefined }),
    unavailable: ["INTEREST_COVERAGE_TTM"],
  },
  {
    name: "missing operating cash flow in the current year",
    build: (f) =>
      edit(f, "CASH_FLOW", 2025, "Q1", { operatingCashFlow: undefined }),
    unavailable: ["FCF_GROWTH_TTM_YOY", "FCF_MARGIN_TTM"],
  },
  {
    name: "missing capital expenditure in the previous year (provider freeCashFlow never substitutes)",
    build: (f) =>
      edit(f, "CASH_FLOW", 2023, "Q4", { capitalExpenditure: undefined }),
    unavailable: ["FCF_GROWTH_TTM_YOY"],
  },
  {
    name: "missing ending debt",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalDebt: undefined }),
    unavailable: ["DEBT_TO_EQUITY", "ROIC_TTM"],
  },
  {
    name: "missing ending stockholders' equity: totalEquity never substitutes",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        totalStockholdersEquity: undefined,
      }),
    unavailable: ["DEBT_TO_EQUITY", "ROIC_TTM", "ROE_TTM"],
  },
  {
    name: "missing opening assets",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2024, "Q1", { totalAssets: undefined }),
    unavailable: ["ROA_TTM", "ASSET_TURNOVER_TTM"],
  },
  {
    name: "missing current assets",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", { totalCurrentAssets: undefined }),
    unavailable: ["CURRENT_RATIO"],
  },
  {
    name: "missing current liabilities",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        totalCurrentLiabilities: undefined,
      }),
    unavailable: ["CURRENT_RATIO"],
  },
  {
    name: "missing net debt, never reconstructed",
    build: (f) => edit(f, "BALANCE_SHEET", 2025, "Q1", { netDebt: undefined }),
    unavailable: ["NET_DEBT_TO_EBITDA_TTM"],
  },
  {
    name: "ROIC cash falls back to cash and equivalents: (800 + (740 + 700 - 500)) / 2 = 870",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        cashAndShortTermInvestments: undefined,
      }),
    unavailable: [],
    values: { ROIC_TTM: (94.8 / 870) * 100 },
  },
  {
    name: "ROIC with both cash fields missing",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        cashAndShortTermInvestments: undefined,
        cashAndCashEquivalents: undefined,
      }),
    unavailable: ["ROIC_TTM"],
  },

  // ---- quarters, sequencing and windows -----------------------------------------------------
  {
    name: "a missing current Income quarter",
    build: (f) => f.drop("INCOME", 2024, "Q3"),
    unavailable: INCOME_READERS,
  },
  {
    name: "a missing previous-year Cash Flow quarter: FCF Growth alone",
    build: (f) => f.drop("CASH_FLOW", 2023, "Q3"),
    unavailable: ["FCF_GROWTH_TTM_YOY"],
  },
  {
    name: "a missing opening balance sheet",
    build: (f) => f.drop("BALANCE_SHEET", 2024, "Q1"),
    unavailable: AVERAGED_STATE,
  },
  {
    name: "a missing ending balance sheet: the latest is then FY2024 Q4",
    build: (f) => f.drop("BALANCE_SHEET", 2025, "Q1"),
    unavailable: [...AVERAGED_STATE, "DEBT_TO_EQUITY"],
  },
  {
    name: "missing interior balance sheets are neither read nor required",
    build: (f) => {
      f.drop("BALANCE_SHEET", 2024, "Q2");
      f.drop("BALANCE_SHEET", 2024, "Q3");
      f.drop("BALANCE_SHEET", 2024, "Q4");
    },
    unavailable: [],
    values: BASE_VALUES,
  },
  {
    name: "an FY row beside a missing quarter never fills it",
    build: (f) => {
      f.drop("INCOME", 2024, "Q4");
      f.statements.push(
        statement("INCOME", 2024, "FY", {
          revenue: 1_000,
          grossProfit: 400,
          operatingIncome: 120,
          netIncome: 80,
          epsDiluted: 2,
          ebitda: 180,
          ebit: 128,
          interestExpense: 16,
        }),
      );
    },
    unavailable: INCOME_READERS,
  },
  {
    name: "a newer quarter with a gap before it: never the older complete window (no stale fallback)",
    build: (f) => {
      f.statements.push(
        statement("INCOME", 2025, "Q3", {
          revenue: 250,
          grossProfit: 100,
          operatingIncome: 30,
          netIncome: 20,
          epsDiluted: 0.5,
          ebitda: 45,
          ebit: 32,
          interestExpense: 4,
        }),
      );
    },
    unavailable: INCOME_READERS,
  },
  {
    name: "Cash Flow one quarter ahead of Income: FCF Margin unavailable, never the older shared window",
    build: (f) =>
      f.statements.push(
        statement("CASH_FLOW", 2025, "Q2", {
          operatingCashFlow: 40,
          capitalExpenditure: -15,
        }),
      ),
    unavailable: ["FCF_MARGIN_TTM"],
    // FCF Growth follows its own family's newest quarter: 2024 Q3 … 2025 Q2 (100) against
    // 2023 Q3 … 2024 Q2 (20 + 20 + 20 + 25 = 85).
    values: { FCF_GROWTH_TTM_YOY: (100 / 85 - 1) * 100 },
  },
  {
    name: "Income one quarter ahead of Cash Flow: FCF Margin unavailable; the Income window moves",
    build: (f) => {
      f.statements.push(
        statement("INCOME", 2025, "Q2", {
          revenue: 250,
          grossProfit: 100,
          operatingIncome: 30,
          netIncome: 20,
          epsDiluted: 0.5,
          ebitda: 45,
          ebit: 32,
          interestExpense: 4,
        }),
      );
      f.statements.push(
        statement("BALANCE_SHEET", 2025, "Q2", {
          totalDebt: 740,
          totalStockholdersEquity: 700,
          cashAndShortTermInvestments: 660,
          totalAssets: 2_200,
          totalCurrentAssets: 900,
          totalCurrentLiabilities: 600,
          netDebt: 90,
        }),
      );
    },
    // The averaged states now open on FY2024 Q2, an odd interior sheet (invested capital -13, equity
    // -9) whose averages with the new ending sheet stay positive: (-13 + 780) / 2 and (-9 + 700) / 2.
    unavailable: ["FCF_MARGIN_TTM"],
    values: {
      REVENUE_GROWTH_TTM_YOY: (1000 / 850 - 1) * 100,
      ROIC_TTM: (94.8 / 383.5) * 100,
      ROE_TTM: (80 / 345.5) * 100,
    },
  },
  {
    name: "a newer balance sheet never replaces the aligned ending state",
    build: (f) =>
      f.statements.push(
        statement("BALANCE_SHEET", 2025, "Q2", {
          totalDebt: 100,
          totalStockholdersEquity: 5_000,
          cashAndShortTermInvestments: 0,
          totalAssets: 10_000,
          totalCurrentAssets: 400,
          totalCurrentLiabilities: 100,
          netDebt: 45,
        }),
      ),
    unavailable: [],
    // The latest-state metrics read the newer sheet; the averaged states keep FY2025 Q1.
    values: {
      ROIC_TTM: 12,
      ROE_TTM: 40 / 3,
      ROA_TTM: 4,
      ASSET_TURNOVER_TTM: 0.5,
      DEBT_TO_EQUITY: 0.02,
      CURRENT_RATIO: 4,
      NET_DEBT_TO_EBITDA_TTM: 0.25,
    },
  },
  {
    name: "a quarter not yet public on the evaluation date is invisible",
    build: (f) =>
      f.statements.push(
        statement(
          "INCOME",
          2025,
          "Q2",
          { revenue: 9_999, grossProfit: 1 },
          { availableFromDate: "2025-06-03" },
        ),
      ),
    unavailable: [],
    values: BASE_VALUES,
  },
  {
    name: "shuffled input and another security's statements change nothing",
    build: (f) => {
      const foreign = f.statements.map((row) => ({
        ...row,
        securityId: "someone-else",
        values: { ...(row.values as Values), revenue: 1 },
      }));
      f.statements.reverse();
      f.statements.push(...foreign);
    },
    unavailable: [],
    values: BASE_VALUES,
  },

  // ---- currencies (audit section 9) ---------------------------------------------------------
  { name: "USD + USD: valid", build: () => {}, unavailable: [] },
  {
    name: "JPY + JPY: every statement in one other currency is just as valid",
    build: (f) =>
      f.statements.forEach(
        (row) =>
          ((row as { reportedCurrency: string }).reportedCurrency = "JPY"),
      ),
    unavailable: [],
    values: BASE_VALUES,
  },
  {
    name: "USD + JPY inside the current Income window",
    build: (f) => currency(f, "INCOME", 2024, "Q3", "JPY"),
    unavailable: INCOME_READERS,
  },
  {
    name: "the previous Income year in JPY: only the YoY metrics",
    build: (f) =>
      QUARTERS.slice(0, 4).forEach(({ fiscalYear, period }) =>
        currency(f, "INCOME", fiscalYear, period, "JPY"),
      ),
    unavailable: ["REVENUE_GROWTH_TTM_YOY", "EPS_GROWTH_TTM_YOY"],
  },
  {
    name: "Cash Flow in JPY: FCF Margin mixes it with USD revenue; FCF Growth reads JPY alone and stands",
    build: (f) =>
      QUARTERS.forEach(({ fiscalYear, period }) =>
        currency(f, "CASH_FLOW", fiscalYear, period, "JPY"),
      ),
    unavailable: ["FCF_MARGIN_TTM"],
    values: { FCF_GROWTH_TTM_YOY: 25 },
  },
  {
    name: "one Cash Flow quarter in JPY: FCF Growth and FCF Margin",
    build: (f) => currency(f, "CASH_FLOW", 2025, "Q1", "JPY"),
    unavailable: ["FCF_GROWTH_TTM_YOY", "FCF_MARGIN_TTM"],
  },
  {
    name: "the ending balance sheet in JPY: cross-family metrics unavailable, single-statement ratios valid",
    build: (f) => currency(f, "BALANCE_SHEET", 2025, "Q1", "JPY"),
    unavailable: [
      "ROIC_TTM",
      "ROE_TTM",
      "ROA_TTM",
      "ASSET_TURNOVER_TTM",
      "NET_DEBT_TO_EBITDA_TTM",
    ],
    values: { DEBT_TO_EQUITY: 740 / 700, CURRENT_RATIO: 1.5 },
  },
  {
    name: "the opening balance sheet in JPY: the averaged states only",
    build: (f) => currency(f, "BALANCE_SHEET", 2024, "Q1", "JPY"),
    unavailable: AVERAGED_STATE,
  },
  {
    name: "an interior balance sheet in JPY is never read",
    build: (f) => currency(f, "BALANCE_SHEET", 2024, "Q3", "JPY"),
    unavailable: [],
  },
  {
    name: '"USD" + "usd" are two currencies',
    build: (f) => currency(f, "INCOME", 2025, "Q1", "usd"),
    unavailable: INCOME_READERS,
  },
  {
    name: "USD + missing currency",
    build: (f) => currency(f, "INCOME", 2025, "Q1", ""),
    unavailable: INCOME_READERS,
  },
  {
    name: "a blank currency on the ending balance sheet: even Debt / Equity and Current Ratio",
    build: (f) => currency(f, "BALANCE_SHEET", 2025, "Q1", ""),
    unavailable: [
      ...AVERAGED_STATE,
      "NET_DEBT_TO_EBITDA_TTM",
      "DEBT_TO_EQUITY",
      "CURRENT_RATIO",
    ],
  },
  {
    name: "a whitespace currency is no currency",
    build: (f) => currency(f, "BALANCE_SHEET", 2025, "Q1", "   "),
    unavailable: [
      ...AVERAGED_STATE,
      "NET_DEBT_TO_EBITDA_TTM",
      "DEBT_TO_EQUITY",
      "CURRENT_RATIO",
    ],
  },

  // ---- numeric safety (audit section 10) ------------------------------------------------------
  {
    name: "a revenue sum beyond the largest double: those metrics unavailable, the rest untouched",
    build: (f) => {
      edit(f, "INCOME", 2024, "Q4", { revenue: 1.7e308 });
      edit(f, "INCOME", 2025, "Q1", { revenue: 1.7e308 });
    },
    unavailable: [
      "REVENUE_GROWTH_TTM_YOY",
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ASSET_TURNOVER_TTM",
    ],
    values: { DEBT_TO_EQUITY: 740 / 700, ROIC_TTM: 12 },
  },
  {
    name: "Current Ratio of exactly 10^12: out of storage range, siblings untouched",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        totalCurrentAssets: 1e12,
        totalCurrentLiabilities: 1,
      }),
    unavailable: ["CURRENT_RATIO"],
    values: { DEBT_TO_EQUITY: 740 / 700 },
  },
  {
    name: "Current Ratio just inside the range is stored as it is, never clamped",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        totalCurrentAssets: 999_999_999_999.5,
        totalCurrentLiabilities: 1,
      }),
    unavailable: [],
    values: { CURRENT_RATIO: 999_999_999_999.5 },
  },
  {
    name: "Debt / Equity of -10^12 and beyond: out of range whatever the sign",
    build: (f) =>
      edit(f, "BALANCE_SHEET", 2025, "Q1", {
        totalDebt: -2e12,
        totalStockholdersEquity: 1,
      }),
    unavailable: ["DEBT_TO_EQUITY", "ROIC_TTM"],
  },
  {
    name: "a percentage-point growth of 2.5e10 is inside the range and stored as it is",
    build: (f) => editWindow(f, "INCOME", "previous", { revenue: 0.000001 }),
    unavailable: [],
    values: { REVENUE_GROWTH_TTM_YOY: (1000 / 0.000004 - 1) * 100 },
  },
  {
    name: "a percentage-point growth beyond the range: Revenue Growth alone (1000 / 4e-9 = 2.5e13 pp)",
    build: (f) => editWindow(f, "INCOME", "previous", { revenue: 0.000000001 }),
    unavailable: ["REVENUE_GROWTH_TTM_YOY"],
  },
];

function assertAgreement(
  testCase: Case,
  statements: readonly FinancialStatement[],
  date: string,
): void {
  const production = evaluateFundamentalMetrics({
    securityId: SECURITY,
    date,
    statements,
  }) as Record<string, number | undefined>;
  const oracle = oracleFundamentalOutcomes(
    statements.filter((row) => row.securityId === SECURITY),
    date,
  );
  const unavailable = new Set<string>(testCase.unavailable);
  for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
    const expectedAvailable = !unavailable.has(metric.id);
    const produced = production[metric.field];
    const outcome = oracle[metric.id as keyof typeof oracle];
    expect(
      outcome.status === "VALUE",
      `${testCase.name}: oracle ${metric.id} (${outcome.status === "UNAVAILABLE" ? outcome.reason : "value"})`,
    ).toBe(expectedAvailable);
    expect(
      produced !== undefined,
      `${testCase.name}: production ${metric.id} = ${String(produced)}`,
    ).toBe(expectedAvailable);
    if (outcome.status === "VALUE" && produced !== undefined) {
      expect(
        Math.abs(produced - outcome.value),
        `${testCase.name}: ${metric.id} ${produced} vs oracle ${outcome.value}`,
      ).toBeLessThanOrEqual(valueTolerance(outcome.value));
      expect(
        Object.is(produced, -0),
        `${testCase.name}: ${metric.id} is -0`,
      ).toBe(false);
    }
    const hand = testCase.values?.[metric.id];
    if (hand !== undefined) {
      expect(
        produced,
        `${testCase.name}: ${metric.id} hand value`,
      ).toBeDefined();
      expect(
        Math.abs(produced! - hand),
        `${testCase.name}: ${metric.id} ${produced} vs hand ${hand}`,
      ).toBeLessThanOrEqual(valueTolerance(hand));
    }
  }
}

describe("every metric under every named situation, against hand statements and the oracle (audit section 5)", () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      const fixture = base();
      testCase.build(fixture);
      assertAgreement(
        testCase,
        fixture.statements,
        testCase.date ?? EVALUATED_ON,
      );
    },
  );

  it("names every metric unavailable at least once and available at least once across the matrix", () => {
    const everUnavailable = new Set(
      CASES.flatMap((testCase) => testCase.unavailable),
    );
    expect(ALL_IDS.filter((id) => !everUnavailable.has(id))).toEqual([]);
    const everAvailable = new Set(
      CASES.flatMap((testCase) =>
        ALL_IDS.filter((id) => !testCase.unavailable.includes(id)),
      ),
    );
    expect(ALL_IDS.filter((id) => !everAvailable.has(id))).toEqual([]);
  });

  it("never mutates the caller's statements", () => {
    const fixture = base();
    const before = JSON.stringify(fixture.statements);
    const frozen = fixture.statements.map((row) =>
      Object.freeze({
        ...row,
        values: Object.freeze({ ...(row.values as Values) }),
      }),
    );
    evaluateFundamentalMetrics({
      securityId: SECURITY,
      date: EVALUATED_ON,
      statements: frozen,
    });
    expect(JSON.stringify(fixture.statements)).toBe(before);
  });
});

describe("fiscal sequencing (audit section 6)", () => {
  /** The base history relabelled onto a fiscal calendar whose year ends in another month. */
  function relabelled(
    yearEndMonth: number,
    labelOffset: number,
    weekEnding: boolean,
  ): FinancialStatement[] {
    const fixture = base();
    return fixture.statements.map((row) => {
      if (row.period === "FY") {
        return row;
      }
      const quarter = Number(row.period.slice(1));
      const q4Year = row.fiscalYear - labelOffset;
      const monthIndex = q4Year * 12 + (yearEndMonth - 1) - 3 * (4 - quarter);
      const monthEnd = new Date(
        Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 0),
      );
      if (weekEnding) {
        // The Saturday nearest the month end: 52/53-week years whose period ends cross months.
        const offset = (6 - monthEnd.getUTCDay() + 7) % 7;
        monthEnd.setUTCDate(
          monthEnd.getUTCDate() + (offset <= 3 ? offset : offset - 7),
        );
      }
      return { ...row, fiscalDate: monthEnd.toISOString().slice(0, 10) };
    });
  }

  it.each([
    [9, 0, true],
    [1, -1, true],
    [6, 0, false],
    [3, 1, false],
  ] as const)(
    "a fiscal year ending in month %i (label offset %i, 52/53-week %s) gives the calendar answer",
    (month, offset, weekEnding) => {
      const statements = relabelled(month, offset, weekEnding);
      const production = evaluateFundamentalMetrics({
        securityId: SECURITY,
        date: EVALUATED_ON,
        statements,
      }) as Record<string, number>;
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        expect(
          Math.abs(production[metric.field]! - BASE_VALUES[metric.id as Id]),
          metric.id,
        ).toBeLessThanOrEqual(valueTolerance(BASE_VALUES[metric.id as Id]));
      }
    },
  );

  it("follows Q4 into the next fiscal year's Q1 by identity, whatever the period-end dates say", () => {
    // Every period end rewritten to one date: adjacency comes from (fiscalYear, period) alone.
    const statements = base().statements.map((row) => ({
      ...row,
      fiscalDate: "2000-01-01",
    }));
    const production = evaluateFundamentalMetrics({
      securityId: SECURITY,
      date: EVALUATED_ON,
      statements,
    }) as Record<string, number>;
    expect(production.revenueGrowthTtmYoy).toBe(25);
    expect(production.roicTtm).toBeCloseTo(12, 12);
  });
});

describe("revisions on the trading axis (audit sections 6, 7 and 12)", () => {
  const AXIS = [
    "2025-05-09",
    "2025-05-12",
    "2025-05-13",
    "2025-07-31",
    "2025-08-01",
    "2025-08-04",
    "2025-08-05",
    "2025-08-06",
    "2025-09-02",
  ];

  function daily(statements: readonly FinancialStatement[]) {
    return new Map(
      materializeDailyFundamentals({
        securityId: SECURITY,
        tradingDates: AXIS,
        statements,
      }).map((row) => [row.date, row as Record<string, unknown>]),
    );
  }

  it("applies a restatement only from its own availability, and every earlier session keeps the original", () => {
    const fixture = base();
    const restated = { ...fixture.row("INCOME", 2025, "Q1") };
    fixture.statements.push({
      ...restated,
      values: { ...(restated.values as Values), netIncome: 60 },
      filingDate: "2025-07-31",
      availableFromDate: "2025-08-01",
      observedAt: "2025-08-01T12:00:00.000Z",
      contentHash: "restated",
    });
    const rows = daily(fixture.statements);
    expect(rows.get("2025-05-09")).toEqual({ date: "2025-05-09" });
    expect(rows.get("2025-05-12")?.netMarginTtm).toBe(8);
    expect(rows.get("2025-07-31")?.netMarginTtm).toBe(8);
    expect(rows.get("2025-08-01")?.netMarginTtm).toBe(12); // (20 x 3 + 60) / 1000
  });

  it("an identical duplicate revision changes nothing", () => {
    const fixture = base();
    const original = fixture.row("INCOME", 2025, "Q1");
    fixture.statements.push({
      ...original,
      filingDate: "2025-07-31",
      availableFromDate: "2025-08-01",
      observedAt: "2025-08-01T12:00:00.000Z",
      contentHash: "duplicate",
    });
    const rows = daily(fixture.statements);
    for (const date of AXIS.slice(1)) {
      expect(rows.get(date), date).toEqual({ ...rows.get("2025-05-12"), date });
    }
  });

  it("two revisions public over one weekend take effect together on Monday, the later one winning", () => {
    const fixture = base();
    const original = fixture.row("BALANCE_SHEET", 2025, "Q1");
    fixture.statements.push(
      {
        ...original,
        values: { ...(original.values as Values), totalDebt: 350 },
        availableFromDate: "2025-08-02",
        observedAt: "2025-08-02T12:00:00.000Z",
        contentHash: "saturday",
      },
      {
        ...original,
        values: { ...(original.values as Values), totalDebt: 70 },
        availableFromDate: "2025-08-03",
        observedAt: "2025-08-03T12:00:00.000Z",
        contentHash: "sunday",
      },
    );
    const rows = daily(fixture.statements);
    expect(rows.get("2025-08-01")?.debtToEquity).toBeCloseTo(740 / 700, 12);
    expect(rows.get("2025-08-04")?.debtToEquity).toBe(0.1);
    expect([...rows.keys()]).toEqual(AXIS);
  });

  it("an invalidating revision is absence from its session on, never the older value carried; a later one restores", () => {
    const fixture = base();
    const original = fixture.row("BALANCE_SHEET", 2025, "Q1");
    fixture.statements.push(
      {
        ...original,
        values: { ...(original.values as Values), totalStockholdersEquity: -1 },
        availableFromDate: "2025-08-01",
        observedAt: "2025-08-01T12:00:00.000Z",
        contentHash: "invalidating",
      },
      {
        ...original,
        values: {
          ...(original.values as Values),
          totalStockholdersEquity: 925,
        },
        availableFromDate: "2025-08-06",
        observedAt: "2025-08-06T12:00:00.000Z",
        contentHash: "restoring",
      },
    );
    const rows = daily(fixture.statements);
    expect(rows.get("2025-07-31")?.debtToEquity).toBeCloseTo(740 / 700, 12);
    for (const date of ["2025-08-01", "2025-08-04", "2025-08-05"]) {
      expect(rows.get(date)?.debtToEquity, date).toBeUndefined();
      expect(rows.get(date) && "debtToEquity" in rows.get(date)!, date).toBe(
        false,
      );
    }
    expect(rows.get("2025-08-06")?.debtToEquity).toBe(0.8);
  });

  it("a moved period end represents the quarter from its own availability, whichever way it moved", () => {
    for (const movedTo of ["2025-03-28", "2025-04-04"]) {
      const fixture = base();
      const original = fixture.row("INCOME", 2025, "Q1");
      fixture.statements.push({
        ...original,
        fiscalDate: movedTo,
        values: { ...(original.values as Values), grossProfit: 300 },
        availableFromDate: "2025-08-01",
        observedAt: "2025-08-01T12:00:00.000Z",
        contentHash: `moved-${movedTo}`,
      });
      const rows = daily(fixture.statements);
      expect(rows.get("2025-07-31")?.grossMarginTtm, movedTo).toBe(40);
      expect(rows.get("2025-08-01")?.grossMarginTtm, movedTo).toBe(60); // (100 x 3 + 300) / 1000
    }
  });

  it("between rows one observation delivered, the later period end represents the quarter", () => {
    const fixture = base();
    const original = fixture.row("INCOME", 2025, "Q1");
    fixture.statements.push({
      ...original,
      fiscalDate: "2025-03-29",
      values: { ...(original.values as Values), grossProfit: 300 },
      contentHash: "zzz-earlier-end",
    });
    const rows = daily(fixture.statements);
    // Same availability and observation: 2025-03-31 is the later period end, so the original stands.
    expect(rows.get("2025-05-12")?.grossMarginTtm).toBe(40);
  });
});
