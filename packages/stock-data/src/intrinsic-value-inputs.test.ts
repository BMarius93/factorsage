import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";
import { DEFAULT_GROWTH } from "@intrinsic/valuation";
import { describe, expect, it } from "vitest";
import {
  assembleIntrinsicValueInputs,
  type AssembledModelInput,
  type IntrinsicValueInputs,
} from "./intrinsic-value-inputs.js";

const SECURITY_ID = "security-1";
const VALUATION_DATE = "2026-08-30";
/** Deliberately far later than every `availableFromDate`: backfill must not affect provenance. */
const OBSERVED_AT = "2026-08-30T12:00:00.000Z";

const PERIOD_END: Record<FinancialPeriod, string> = {
  FY: "12-31",
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
};

type Quarter = { fiscalYear: number; period: "Q1" | "Q2" | "Q3" | "Q4" };
type Values = Record<string, number>;

function quarter(fiscalYear: number, period: Quarter["period"]): Quarter {
  return { fiscalYear, period };
}

function plusDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function statement(
  statementType: FinancialStatementType,
  fiscalYear: number,
  period: FinancialPeriod,
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  const fiscalDate = `${fiscalYear}-${PERIOD_END[period]}`;
  const filingDate = plusDays(fiscalDate, 20);
  return {
    securityId: SECURITY_ID,
    statementType,
    fiscalDate,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate,
    availableFromDate: plusDays(filingDate, 1),
    observedAt: OBSERVED_AT,
    contentHash: `${statementType}:${fiscalYear}:${period}:${JSON.stringify(values)}`,
    values,
    ...overrides,
  };
}

function income(
  { fiscalYear, period }: Quarter,
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement("INCOME", fiscalYear, period, values, overrides);
}

function cashFlow(
  { fiscalYear, period }: Quarter,
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement("CASH_FLOW", fiscalYear, period, values, overrides);
}

function balanceSheet(
  { fiscalYear, period }: Quarter,
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement("BALANCE_SHEET", fiscalYear, period, values, overrides);
}

function annualIncome(
  fiscalYear: number,
  values: Values,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement("INCOME", fiscalYear, "FY", values, overrides);
}

const INCOME_QUARTER: Values = {
  netIncome: 20,
  interestExpense: 2.5,
  epsDiluted: 2,
  weightedAverageShsOutDil: 10,
};
const CASH_FLOW_QUARTER: Values = {
  operatingCashFlow: 30,
  capitalExpenditure: -5,
  commonDividendsPaid: -10,
};
const BALANCE_SHEET_QUARTER: Values = {
  cashAndShortTermInvestments: 50,
  cashAndCashEquivalents: 40,
  totalDebt: 30,
  totalStockholdersEquity: 500,
};

const WINDOW: Quarter[] = [
  quarter(2025, "Q1"),
  quarter(2025, "Q2"),
  quarter(2025, "Q3"),
  quarter(2025, "Q4"),
];

/** 100 -> 127.62815625 is exactly 5% compounded over five fiscal years. */
const ANNUAL_LATEST: Values = { revenue: 127.62815625, netIncome: 50 };
const ANNUAL_EARLIER: Values = { revenue: 100, netIncome: 40 };

function completeStatements(): FinancialStatement[] {
  return [
    ...WINDOW.flatMap((each) => [
      income(each, INCOME_QUARTER),
      cashFlow(each, CASH_FLOW_QUARTER),
      balanceSheet(each, BALANCE_SHEET_QUARTER),
    ]),
    annualIncome(2025, ANNUAL_LATEST),
    annualIncome(2020, ANNUAL_EARLIER),
  ];
}

function assemble(
  statements: readonly FinancialStatement[],
  valuationDate = VALUATION_DATE,
): IntrinsicValueInputs {
  return assembleIntrinsicValueInputs({
    securityId: SECURITY_ID,
    valuationDate,
    statements,
  });
}

/** Narrows to the assembled input, failing loudly when a test expected READY. */
function readyInput<T>(result: AssembledModelInput<T>): T {
  if (result.status !== "READY") {
    throw new Error(`Expected READY assembly, got ${result.reason}`);
  }
  return result.input;
}

function matches(
  candidate: FinancialStatement,
  statementType: FinancialStatementType,
  { fiscalYear, period }: Quarter,
): boolean {
  return (
    candidate.statementType === statementType &&
    candidate.fiscalYear === fiscalYear &&
    candidate.period === period
  );
}

/** Replaces a row's values, e.g. to drop one required field from one quarter. */
function withValues(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
  target: Quarter,
  transform: (values: Values) => Values,
): FinancialStatement[] {
  return statements.map((candidate) =>
    matches(candidate, statementType, target)
      ? { ...candidate, values: transform(candidate.values as Values) }
      : candidate,
  );
}

function without(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
  target: Quarter,
): FinancialStatement[] {
  return statements.filter(
    (candidate) => !matches(candidate, statementType, target),
  );
}

function omitField(field: string) {
  return (values: Values): Values =>
    Object.fromEntries(
      Object.entries(values).filter(([name]) => name !== field),
    );
}

describe("point-in-time valuation input assembly", () => {
  it("assembles every model from a complete eligible statement set", () => {
    const result = assemble(completeStatements());

    expect(result.DCF_FCFF).toMatchObject({
      status: "READY",
      currency: "USD",
      input: {
        operatingCashFlowTtm: 120,
        // The provider's negative sign is summed unchanged.
        capitalExpenditureTtm: -20,
        interestExpenseTtm: 10,
        cash: 50,
        debt: 30,
        shares: 10,
      },
    });
    expect(result.RESIDUAL_INCOME).toMatchObject({
      status: "READY",
      input: { netIncomeTtm: 80, bookValue: 500, shares: 10 },
    });
    expect(result.DDM).toMatchObject({
      status: "READY",
      input: { dpsTtm: 4 },
    });
    expect(result.GRAHAM).toMatchObject({
      status: "READY",
      input: { epsTtm: 8 },
    });
    // 100 -> 127.62815625 over five fiscal years, capped nowhere near the 15% ceiling.
    expect(readyInput(result.GRAHAM).growthUsed).toBeCloseTo(0.05, 12);
    expect(readyInput(result.DCF_FCFF).growthUsed).toBeCloseTo(0.05, 12);
  });

  it("never lets a future revision leak into an earlier valuation date", () => {
    const statements = [
      ...completeStatements(),
      // A newer quarter that only becomes eligible after the valuation date.
      income(quarter(2026, "Q1"), { ...INCOME_QUARTER, netIncome: 999 }),
      cashFlow(quarter(2026, "Q1"), {
        ...CASH_FLOW_QUARTER,
        operatingCashFlow: 999,
      }),
      balanceSheet(quarter(2026, "Q1"), {
        ...BALANCE_SHEET_QUARTER,
        totalDebt: 999,
      }),
    ];

    const beforeEligibility = assemble(statements, "2026-04-01");
    const afterEligibility = assemble(statements, "2026-08-30");

    expect(beforeEligibility.DCF_FCFF).toMatchObject({
      status: "READY",
      input: { operatingCashFlowTtm: 120, debt: 30 },
    });
    expect(beforeEligibility.RESIDUAL_INCOME).toMatchObject({
      status: "READY",
      input: { netIncomeTtm: 80 },
    });
    // Once eligible the newer quarter is used, proving the earlier result was a cutoff effect.
    expect(afterEligibility.DCF_FCFF).toMatchObject({
      status: "READY",
      input: { operatingCashFlowTtm: 1089, debt: 999 },
    });
  });

  it("uses the latest eligible revision of a fiscal identity", () => {
    const original = income(quarter(2025, "Q4"), INCOME_QUARTER);
    const restated = income(
      quarter(2025, "Q4"),
      { ...INCOME_QUARTER, netIncome: 50 },
      {
        availableFromDate: plusDays(original.availableFromDate, 60),
        contentHash: "restated",
      },
    );
    const statements = [...completeStatements(), restated];

    // 20 + 20 + 20 + 50 from the restated fourth quarter.
    expect(assemble(statements).RESIDUAL_INCOME).toMatchObject({
      status: "READY",
      input: { netIncomeTtm: 110 },
    });
    // Before the restatement was public, the original revision stands.
    expect(
      assemble(statements, plusDays(original.availableFromDate, 30))
        .RESIDUAL_INCOME,
    ).toMatchObject({ status: "READY", input: { netIncomeTtm: 80 } });
  });

  it("derives sourceDataAsOf from the maximum availableFromDate actually used", () => {
    const statements = completeStatements();
    const latestUsed = statements
      .map((each) => each.availableFromDate)
      .reduce((left, right) => (left > right ? left : right));

    const result = assemble(statements);

    expect(result.GRAHAM).toMatchObject({
      sourceDataAsOf: `${latestUsed}T00:00:00.000Z`,
    });
    // Encoded at UTC midnight of the availability date, never the observation instant.
    expect(
      result.GRAHAM.status === "READY" && result.GRAHAM.sourceDataAsOf,
    ).not.toBe(OBSERVED_AT);
  });

  it("uses historical availability even when the statement was observed years later", () => {
    // Every row became public by 2020-05-01 but was backfilled into our store in 2026.
    const statements = completeStatements().map((each) => ({
      ...each,
      availableFromDate: "2020-04-01",
      observedAt: "2026-08-30T09:00:00.000Z",
    }));
    const withLatestAvailability = [
      ...without(statements, "INCOME", quarter(2025, "Q4")),
      income(quarter(2025, "Q4"), INCOME_QUARTER, {
        availableFromDate: "2020-05-01",
        observedAt: "2026-08-30T09:00:00.000Z",
      }),
    ];

    const result = assemble(withLatestAvailability, "2020-06-30");

    expect(result.GRAHAM).toMatchObject({
      status: "READY",
      sourceDataAsOf: "2020-05-01T00:00:00.000Z",
    });
    expect(result.DCF_FCFF).toMatchObject({
      status: "READY",
      sourceDataAsOf: "2020-05-01T00:00:00.000Z",
    });
  });

  it("forms a window across a fiscal-year boundary", () => {
    const rolled: Quarter[] = [
      quarter(2025, "Q2"),
      quarter(2025, "Q3"),
      quarter(2025, "Q4"),
      quarter(2026, "Q1"),
    ];
    const statements = [
      ...rolled.flatMap((each) => [
        income(each, INCOME_QUARTER),
        cashFlow(each, CASH_FLOW_QUARTER),
        balanceSheet(each, BALANCE_SHEET_QUARTER),
      ]),
      annualIncome(2025, ANNUAL_LATEST),
      annualIncome(2020, ANNUAL_EARLIER),
    ];

    expect(assemble(statements).DCF_FCFF).toMatchObject({
      status: "READY",
      input: { operatingCashFlowTtm: 120, interestExpenseTtm: 10 },
    });
    expect(assemble(statements).GRAHAM).toMatchObject({
      status: "READY",
      input: { epsTtm: 8 },
    });
  });

  it("is not applicable when the four-quarter sequence has a gap", () => {
    const gapped = without(completeStatements(), "INCOME", quarter(2025, "Q2"));
    const result = assemble(gapped);

    expect(result.GRAHAM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_TTM_WINDOW",
    });
    expect(result.RESIDUAL_INCOME).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_TTM_WINDOW",
    });
    expect(result.DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_TTM_WINDOW",
    });
  });

  it("does not skip an incomplete latest quarter to reuse an older window", () => {
    // A fifth, newer income quarter exists but lacks the fields the models need.
    const statements = [
      ...completeStatements(),
      income(quarter(2026, "Q1"), { weightedAverageShsOutDil: 10 }),
    ];

    const result = assemble(statements);

    expect(result.GRAHAM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_REQUIRED_FIELD",
    });
    expect(result.RESIDUAL_INCOME).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("does not advance the DCF window for a quarter present in only one family", () => {
    // Newer cash-flow quarter with no matching eligible income statement.
    const statements = [
      ...completeStatements(),
      cashFlow(quarter(2026, "Q1"), {
        ...CASH_FLOW_QUARTER,
        operatingCashFlow: 999,
      }),
    ];

    expect(assemble(statements).DCF_FCFF).toMatchObject({
      status: "READY",
      input: { operatingCashFlowTtm: 120 },
    });
  });

  it("advances to the newer common window once both families are eligible", () => {
    const statements = [
      ...completeStatements(),
      cashFlow(quarter(2026, "Q1"), {
        ...CASH_FLOW_QUARTER,
        operatingCashFlow: 90,
      }),
      income(quarter(2026, "Q1"), INCOME_QUARTER),
    ];

    // 30 + 30 + 30 + 90: the oldest quarter drops out of the common window.
    expect(assemble(statements).DCF_FCFF).toMatchObject({
      status: "READY",
      input: { operatingCashFlowTtm: 180 },
    });
  });

  it("invalidates DCF when the authoritative newer common quarter lacks interest expense", () => {
    const statements = [
      ...completeStatements(),
      cashFlow(quarter(2026, "Q1"), CASH_FLOW_QUARTER),
      income(quarter(2026, "Q1"), omitField("interestExpense")(INCOME_QUARTER)),
    ];

    // Falling back to the older complete window would be look-back, not invalidation.
    expect(assemble(statements).DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("accepts an explicit zero interest expense", () => {
    const statements = withValues(
      completeStatements(),
      "INCOME",
      quarter(2025, "Q4"),
      (values) => ({ ...values, interestExpense: 0 }),
    );

    expect(assemble(statements).DCF_FCFF).toMatchObject({
      status: "READY",
      input: { interestExpenseTtm: 7.5 },
    });
  });

  it("uses latest-state balance sheet and shares newer than the flow window", () => {
    const statements = [
      ...completeStatements(),
      // Newer state rows only; the flow window cannot advance without a cash-flow quarter.
      balanceSheet(quarter(2026, "Q1"), {
        ...BALANCE_SHEET_QUARTER,
        cashAndShortTermInvestments: 75,
        totalDebt: 15,
        totalStockholdersEquity: 600,
      }),
      income(quarter(2026, "Q1"), {
        ...INCOME_QUARTER,
        weightedAverageShsOutDil: 12,
      }),
    ];

    const result = assemble(statements);

    expect(result.DCF_FCFF).toMatchObject({
      status: "READY",
      // Flow window unchanged, state taken from the newer quarter.
      input: { operatingCashFlowTtm: 120, cash: 75, debt: 15, shares: 12 },
    });
    expect(result.RESIDUAL_INCOME).toMatchObject({
      status: "READY",
      // Its own income flow window rolled to 2025 Q2 - 2026 Q1; state comes from the newer rows.
      input: { netIncomeTtm: 80, bookValue: 600, shares: 12 },
    });
  });

  it("does not fall back to an older balance sheet when the newest lacks cash or debt", () => {
    const statements = [
      ...completeStatements(),
      balanceSheet(quarter(2026, "Q1"), { totalStockholdersEquity: 600 }),
    ];

    expect(assemble(statements).DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("falls back within the latest balance sheet from short-term investments to cash", () => {
    const statements = withValues(
      completeStatements(),
      "BALANCE_SHEET",
      quarter(2025, "Q4"),
      omitField("cashAndShortTermInvestments"),
    );

    expect(assemble(statements).DCF_FCFF).toMatchObject({
      status: "READY",
      input: { cash: 40 },
    });
  });

  it("estimates growth from the exact N and N-5 revenue endpoints only", () => {
    const statements = [
      ...completeStatements(),
      // Neighbouring years must never be substituted or averaged in.
      annualIncome(2021, { revenue: 5_000, netIncome: 5_000 }),
      annualIncome(2024, { revenue: 9_000, netIncome: 9_000 }),
    ];

    expect(readyInput(assemble(statements).GRAHAM).growthUsed).toBeCloseTo(
      0.05,
      12,
    );
  });

  it("falls back to the net-income CAGR when revenue endpoints are unusable", () => {
    const statements = [
      ...WINDOW.flatMap((each) => [
        income(each, INCOME_QUARTER),
        cashFlow(each, CASH_FLOW_QUARTER),
        balanceSheet(each, BALANCE_SHEET_QUARTER),
      ]),
      annualIncome(2025, { netIncome: 127.62815625 }),
      annualIncome(2020, { netIncome: 100 }),
    ];

    expect(readyInput(assemble(statements).GRAHAM).growthUsed).toBeCloseTo(
      0.05,
      12,
    );
  });

  it("uses default growth and no annual provenance when neither CAGR is available", () => {
    const quarterly = WINDOW.flatMap((each) => [
      income(each, INCOME_QUARTER),
      cashFlow(each, CASH_FLOW_QUARTER),
      balanceSheet(each, BALANCE_SHEET_QUARTER),
    ]);
    const latestQuarterlyAvailability = quarterly
      .map((each) => each.availableFromDate)
      .reduce((left, right) => (left > right ? left : right));
    const statements = [
      ...quarterly,
      // Eligible but unusable endpoints, and published later than every quarterly row.
      annualIncome(2025, { revenue: 0 }, { availableFromDate: "2026-08-01" }),
      annualIncome(2020, { revenue: 0 }, { availableFromDate: "2026-08-01" }),
    ];

    const result = assemble(statements);

    expect(result.GRAHAM).toMatchObject({
      status: "READY",
      input: { growthUsed: DEFAULT_GROWTH },
      // Unused annual rows must not inflate provenance.
      sourceDataAsOf: `${latestQuarterlyAvailability}T00:00:00.000Z`,
    });
  });

  it("does not require the intermediate annual rows", () => {
    // Only FY 2025 and FY 2020 exist; N-1..N-4 are absent.
    expect(
      readyInput(assemble(completeStatements()).GRAHAM).growthUsed,
    ).toBeCloseTo(0.05, 12);
  });

  it("pairs DDM dividends and diluted shares by exact fiscal identity", () => {
    // Each quarter divides by its own share count, so a changing count is handled correctly.
    const shareCounts = [10, 10, 20, 25];
    const statements = [
      ...WINDOW.flatMap((each, index) => [
        income(each, {
          ...INCOME_QUARTER,
          weightedAverageShsOutDil: shareCounts[index] ?? 10,
        }),
        cashFlow(each, CASH_FLOW_QUARTER),
        balanceSheet(each, BALANCE_SHEET_QUARTER),
      ]),
      annualIncome(2025, ANNUAL_LATEST),
      annualIncome(2020, ANNUAL_EARLIER),
    ];

    // 10/10 + 10/10 + 10/20 + 10/25 = 2.9, not 40 / 25 = 1.6.
    expect(assemble(statements).DDM).toMatchObject({
      status: "READY",
      input: { dpsTtm: 2.9 },
    });
  });

  it("preserves an explicit zero dividend rather than rejecting it during assembly", () => {
    const statements = withValues(
      completeStatements(),
      "CASH_FLOW",
      quarter(2025, "Q4"),
      (values) => ({ ...values, commonDividendsPaid: 0 }),
    );

    // The pure DDM formula owns ordinary dividend inapplicability, not assembly.
    expect(assemble(statements).DDM).toMatchObject({
      status: "READY",
      input: { dpsTtm: 3 },
    });
  });

  it("is not applicable when a paired quarterly diluted share count is not positive", () => {
    const statements = withValues(
      completeStatements(),
      "INCOME",
      quarter(2025, "Q3"),
      (values) => ({ ...values, weightedAverageShsOutDil: 0 }),
    );

    expect(assemble(statements).DDM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "INVALID_DILUTED_SHARES",
    });
  });

  it("is not applicable when a dividend field is missing rather than reported zero", () => {
    const statements = withValues(
      completeStatements(),
      "CASH_FLOW",
      quarter(2025, "Q2"),
      omitField("commonDividendsPaid"),
    );

    expect(assemble(statements).DDM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("sums four quarterly diluted EPS values for Graham", () => {
    const statements = WINDOW.flatMap((each, index) => [
      income(each, { ...INCOME_QUARTER, epsDiluted: index + 1 }),
      cashFlow(each, CASH_FLOW_QUARTER),
      balanceSheet(each, BALANCE_SHEET_QUARTER),
    ]);

    expect(assemble(statements).GRAHAM).toMatchObject({
      status: "READY",
      input: { epsTtm: 10 },
    });
  });

  it("is not applicable when a model's statements disagree on currency", () => {
    const statements = completeStatements().map((each) =>
      matches(each, "CASH_FLOW", quarter(2025, "Q3"))
        ? { ...each, reportedCurrency: "EUR" }
        : each,
    );

    const result = assemble(statements);

    // Only the models that actually consume that statement are affected.
    expect(result.DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      reason: "CURRENCY_MISMATCH",
    });
    expect(result.DDM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "CURRENCY_MISMATCH",
    });
    expect(result.GRAHAM).toMatchObject({ status: "READY", currency: "USD" });
    expect(result.RESIDUAL_INCOME).toMatchObject({
      status: "READY",
      currency: "USD",
    });
  });

  it("ignores statements belonging to another security", () => {
    const foreign = completeStatements().map((each) => ({
      ...each,
      securityId: "security-2",
      values: { ...(each.values as Values), netIncome: 9_999 },
    }));

    expect(assemble([...completeStatements(), ...foreign]).RESIDUAL_INCOME)
      .toMatchObject({ status: "READY", input: { netIncomeTtm: 80 } });
    expect(assemble(foreign).GRAHAM).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_TTM_WINDOW",
    });
  });
});
