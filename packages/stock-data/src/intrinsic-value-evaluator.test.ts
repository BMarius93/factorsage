import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";
import { INTRINSIC_VALUE_BLENDS } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  combineBlendComponents,
  evaluateIntrinsicValues,
  type EvaluatedIntrinsicValues,
} from "./intrinsic-value-evaluator.js";

const SECURITY_ID = "security-1";
const VALUATION_DATE = "2026-08-30";

type Quarter = { fiscalYear: number; period: "Q1" | "Q2" | "Q3" | "Q4" };
type Values = Record<string, number>;

const PERIOD_END: Record<FinancialPeriod, string> = {
  FY: "12-31",
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
};

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
    observedAt: "2026-08-30T12:00:00.000Z",
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

/** Quarterly values chosen so the trailing sums are exactly the locked golden vector inputs. */
const INCOME_QUARTER: Values = {
  netIncome: 20,
  interestExpense: 2.5,
  epsDiluted: 2,
  weightedAverageShsOutDil: 10,
};
const CASH_FLOW_QUARTER: Values = {
  operatingCashFlow: 30,
  capitalExpenditure: -5,
  commonDividendsPaid: -5,
};
const BALANCE_SHEET_QUARTER: Values = {
  cashAndShortTermInvestments: 50,
  totalDebt: 30,
  totalStockholdersEquity: 500,
};
/** 100 -> 127.62815625 is exactly 5% compounded over five fiscal years. */
const ANNUAL_LATEST: Values = { revenue: 127.62815625 };
const ANNUAL_EARLIER: Values = { revenue: 100 };

const WINDOW: Quarter[] = [
  quarter(2025, "Q1"),
  quarter(2025, "Q2"),
  quarter(2025, "Q3"),
  quarter(2025, "Q4"),
];

function completeStatements(
  overrides: {
    income?: Values;
    cashFlow?: Values;
    balanceSheet?: Values;
  } = {},
): FinancialStatement[] {
  return [
    ...WINDOW.flatMap((each) => [
      income(each, { ...INCOME_QUARTER, ...overrides.income }),
      cashFlow(each, { ...CASH_FLOW_QUARTER, ...overrides.cashFlow }),
      balanceSheet(each, { ...BALANCE_SHEET_QUARTER, ...overrides.balanceSheet }),
    ]),
    // Published after the quarterly rows, so growth-consuming models carry newer provenance
    // than DDM, which never reads an annual statement.
    annualIncome(2025, ANNUAL_LATEST, { availableFromDate: "2026-03-01" }),
    annualIncome(2020, ANNUAL_EARLIER, { availableFromDate: "2021-03-01" }),
  ];
}

function evaluate(
  statements: readonly FinancialStatement[],
  valuationDate = VALUATION_DATE,
): EvaluatedIntrinsicValues {
  return evaluateIntrinsicValues({
    securityId: SECURITY_ID,
    valuationDate,
    statements,
  });
}

function calculatedModel(
  result: EvaluatedIntrinsicValues,
  model: keyof EvaluatedIntrinsicValues["models"],
) {
  const evaluated = result.models[model];
  if (evaluated.status !== "CALCULATED") {
    throw new Error(
      `Expected ${model} to be CALCULATED, got ${evaluated.phase}/${evaluated.reason}`,
    );
  }
  return evaluated;
}

describe("intrinsic value evaluation", () => {
  it("flows a complete statement set through assembly into every model and blend", () => {
    const result = evaluate(completeStatements());

    // End-to-end reproduction of the locked golden vectors, from statements to blends.
    expect(calculatedModel(result, "DCF_FCFF").valuePerShare).toBeCloseTo(
      178.8977101328,
      8,
    );
    expect(
      calculatedModel(result, "RESIDUAL_INCOME").valuePerShare,
    ).toBeCloseTo(99.1837933641, 8);
    expect(calculatedModel(result, "DDM").valuePerShare).toBeCloseTo(
      27.3333333333,
      8,
    );
    expect(calculatedModel(result, "GRAHAM").valuePerShare).toBeCloseTo(148, 8);

    expect(result.blends.BALANCED.status).toBe("CALCULATED");
    expect(
      result.blends.BALANCED.status === "CALCULATED" &&
        result.blends.BALANCED.valuePerShare,
    ).toBeCloseTo(148.8039930756, 8);
    expect(
      result.blends.CONSERVATIVE.status === "CALCULATED" &&
        result.blends.CONSERVATIVE.valuePerShare,
    ).toBeCloseTo(145.7142220623, 8);
    expect(
      result.blends.DIVIDEND.status === "CALCULATED" &&
        result.blends.DIVIDEND.valuePerShare,
    ).toBeCloseTo(102.3291760593, 8);
  });

  it("preserves assembly provenance and currency on every calculated model", () => {
    const statements = completeStatements();
    const latestUsed = statements
      .map((each) => each.availableFromDate)
      .reduce((left, right) => (left > right ? left : right));
    const result = evaluate(statements);

    for (const model of [
      "DCF_FCFF",
      "RESIDUAL_INCOME",
      "DDM",
      "GRAHAM",
    ] as const) {
      expect(calculatedModel(result, model).currency).toBe("USD");
    }
    // DCF consumes the newest of everything, so its provenance is the newest availability.
    expect(calculatedModel(result, "DCF_FCFF").sourceDataAsOf).toBe(
      `${latestUsed}T00:00:00.000Z`,
    );
    // DDM consumes no annual growth rows, so its provenance can be older.
    expect(calculatedModel(result, "DDM").sourceDataAsOf).toBe(
      "2026-01-21T00:00:00.000Z",
    );
  });

  it("reports an assembly failure with phase ASSEMBLY", () => {
    // No statements at all: nothing can be selected.
    const result = evaluate([]);

    expect(result.models.DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      phase: "ASSEMBLY",
      reason: "MISSING_TTM_WINDOW",
    });
    expect(result.models.GRAHAM).toMatchObject({ phase: "ASSEMBLY" });
  });

  it("distinguishes a non-positive FCFF from missing DCF inputs", () => {
    const financiallyUnavailable = evaluate(
      completeStatements({
        // Capital expenditure outweighs operating cash flow.
        cashFlow: { operatingCashFlow: 1, capitalExpenditure: -5 },
      }),
    );
    const structurallyUnavailable = evaluate(
      completeStatements().map((each) =>
        each.statementType === "CASH_FLOW"
          ? { ...each, values: { commonDividendsPaid: -5 } }
          : each,
      ),
    );

    expect(financiallyUnavailable.models.DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      phase: "VALUATION",
      reason: "NON_POSITIVE_FCFF",
    });
    expect(structurallyUnavailable.models.DCF_FCFF).toEqual({
      status: "NOT_APPLICABLE",
      phase: "ASSEMBLY",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("calculates through DCF with an explicit zero interest expense", () => {
    const result = evaluate(
      completeStatements({ income: { ...INCOME_QUARTER, interestExpense: 0 } }),
    );

    // FCFF_0 = 120 - 20 + 0, so the model stays available.
    expect(result.models.DCF_FCFF.status).toBe("CALCULATED");
  });

  it("treats non-positive Graham EPS as a valuation failure, not an assembly failure", () => {
    const result = evaluate(
      completeStatements({ income: { ...INCOME_QUARTER, epsDiluted: -1 } }),
    );

    expect(result.models.GRAHAM).toEqual({
      status: "NOT_APPLICABLE",
      phase: "VALUATION",
      reason: "NON_POSITIVE_EPS",
    });
  });

  it("treats a zero trailing dividend as a valuation failure", () => {
    const result = evaluate(
      completeStatements({
        cashFlow: { ...CASH_FLOW_QUARTER, commonDividendsPaid: 0 },
      }),
    );

    // Assembly preserves the reported zero; the pure formula owns the inapplicability.
    expect(result.models.DDM).toEqual({
      status: "NOT_APPLICABLE",
      phase: "VALUATION",
      reason: "NON_POSITIVE_DIVIDEND",
    });
  });

  it("makes only the blends that require a missing model unavailable", () => {
    // Diluted EPS is required by Graham alone.
    const result = evaluate(
      completeStatements().map((each) =>
        each.statementType === "INCOME" && each.period !== "FY"
          ? {
              ...each,
              values: Object.fromEntries(
                Object.entries(each.values).filter(
                  ([field]) => field !== "epsDiluted",
                ),
              ),
            }
          : each,
      ),
    );

    expect(result.models.GRAHAM).toMatchObject({
      status: "NOT_APPLICABLE",
      phase: "ASSEMBLY",
    });
    expect(result.blends.BALANCED).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_COMPONENT",
    });
    expect(result.blends.CONSERVATIVE).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_COMPONENT",
    });
    // Graham is not a DIVIDEND component, so its absence changes nothing there.
    expect(result.blends.DIVIDEND.status).toBe("CALCULATED");
  });

  it("derives blend provenance from the maximum over its own components", () => {
    const result = evaluate(completeStatements());
    const dcf = calculatedModel(result, "DCF_FCFF");
    const residualIncome = calculatedModel(result, "RESIDUAL_INCOME");
    const ddm = calculatedModel(result, "DDM");
    const graham = calculatedModel(result, "GRAHAM");

    const maxOf = (...instants: string[]) =>
      instants.reduce((left, right) => (left > right ? left : right));

    expect(
      result.blends.BALANCED.status === "CALCULATED" &&
        result.blends.BALANCED.sourceDataAsOf,
    ).toBe(
      maxOf(
        dcf.sourceDataAsOf,
        residualIncome.sourceDataAsOf,
        graham.sourceDataAsOf,
      ),
    );
    expect(
      result.blends.DIVIDEND.status === "CALCULATED" &&
        result.blends.DIVIDEND.sourceDataAsOf,
    ).toBe(
      maxOf(dcf.sourceDataAsOf, ddm.sourceDataAsOf, residualIncome.sourceDataAsOf),
    );
    // The maximum is a real choice here: DDM's own provenance is strictly older.
    expect(ddm.sourceDataAsOf < dcf.sourceDataAsOf).toBe(true);
  });

  it("ignores a non-component model when combining a blend", () => {
    const models = {
      DCF_FCFF: {
        status: "CALCULATED",
        valuePerShare: 178.8977101328,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
      RESIDUAL_INCOME: {
        status: "CALCULATED",
        valuePerShare: 99.1837933641,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
      DDM: {
        status: "CALCULATED",
        valuePerShare: 27.3333333333,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
      // Not a DIVIDEND component: newer provenance and a different currency must not leak in.
      GRAHAM: {
        status: "CALCULATED",
        valuePerShare: 148,
        sourceDataAsOf: "2026-07-01T00:00:00.000Z",
        currency: "EUR",
      },
    } as const;

    const dividend = combineBlendComponents(
      INTRINSIC_VALUE_BLENDS.DIVIDEND,
      models,
    );

    expect(dividend).toMatchObject({
      status: "CALCULATED",
      sourceDataAsOf: "2026-01-21T00:00:00.000Z",
      currency: "USD",
    });
    expect(
      dividend.status === "CALCULATED" && dividend.valuePerShare,
    ).toBeCloseTo(102.3291760593, 9);
  });

  it("refuses to blend components reported in different currencies", () => {
    const models = {
      DCF_FCFF: {
        status: "CALCULATED",
        valuePerShare: 178.8977101328,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
      RESIDUAL_INCOME: {
        status: "CALCULATED",
        valuePerShare: 99.1837933641,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "EUR",
      },
      DDM: {
        status: "CALCULATED",
        valuePerShare: 27.3333333333,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
      GRAHAM: {
        status: "CALCULATED",
        valuePerShare: 148,
        sourceDataAsOf: "2026-01-21T00:00:00.000Z",
        currency: "USD",
      },
    } as const;

    // No conversion and no preferred currency: the blend is simply unavailable.
    expect(
      combineBlendComponents(INTRINSIC_VALUE_BLENDS.BALANCED, models),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "CURRENCY_MISMATCH" });
  });

  it("reports a consistent row currency when every model agrees", () => {
    expect(evaluate(completeStatements()).currencyConsistency).toEqual({
      status: "CONSISTENT",
      currency: "USD",
    });
  });

  it("reports no values when nothing could be calculated", () => {
    expect(evaluate([]).currencyConsistency).toEqual({ status: "NO_VALUES" });
  });

  it("reports a row currency conflict without choosing a majority", () => {
    // Disjoint flow windows: the cash-flow family stops in 2024, so DDM's common window is the
    // older EUR one while Graham and residual income roll forward on the newer USD quarters.
    const olderQuarters: Quarter[] = [
      quarter(2024, "Q1"),
      quarter(2024, "Q2"),
      quarter(2024, "Q3"),
      quarter(2024, "Q4"),
    ];
    const newerQuarters: Quarter[] = [
      quarter(2025, "Q2"),
      quarter(2025, "Q3"),
      quarter(2025, "Q4"),
      quarter(2026, "Q1"),
    ];
    const statements = [
      ...olderQuarters.flatMap((each) => [
        income(each, INCOME_QUARTER, { reportedCurrency: "EUR" }),
        cashFlow(each, CASH_FLOW_QUARTER, { reportedCurrency: "EUR" }),
      ]),
      ...newerQuarters.map((each) => income(each, INCOME_QUARTER)),
      balanceSheet(quarter(2026, "Q1"), BALANCE_SHEET_QUARTER),
      annualIncome(2025, ANNUAL_LATEST),
      annualIncome(2020, ANNUAL_EARLIER),
    ];

    const result = evaluate(statements);

    expect(calculatedModel(result, "DDM").currency).toBe("EUR");
    expect(calculatedModel(result, "GRAHAM").currency).toBe("USD");
    expect(calculatedModel(result, "RESIDUAL_INCOME").currency).toBe("USD");
    // Two of three calculated models are USD; no majority or priority is applied.
    expect(result.currencyConsistency).toEqual({
      status: "CONFLICT",
      currencies: ["EUR", "USD"],
    });
  });

  it("cannot see a revision that is not yet eligible on the valuation date", () => {
    const statements = [
      ...completeStatements(),
      income(quarter(2026, "Q1"), { ...INCOME_QUARTER, epsDiluted: 50 }),
      cashFlow(quarter(2026, "Q1"), CASH_FLOW_QUARTER),
      balanceSheet(quarter(2026, "Q1"), BALANCE_SHEET_QUARTER),
    ];

    // The 2026 Q1 rows only become available on 2026-04-21.
    expect(
      calculatedModel(evaluate(statements, "2026-04-01"), "GRAHAM")
        .valuePerShare,
    ).toBeCloseTo(148, 8);
    expect(
      calculatedModel(evaluate(statements, "2026-08-30"), "GRAHAM")
        .valuePerShare,
    ).toBeCloseTo(56 * 18.5, 8);
  });

  it("returns NOT_APPLICABLE once a newer eligible quarter invalidates a model", () => {
    const invalidating = [
      ...completeStatements(),
      // Newer eligible income quarter without diluted EPS: Graham can no longer be formed.
      income(quarter(2026, "Q1"), {
        netIncome: 20,
        interestExpense: 2.5,
        weightedAverageShsOutDil: 10,
      }),
    ];

    // Before it is eligible the older window still calculates.
    expect(
      calculatedModel(evaluate(invalidating, "2026-04-01"), "GRAHAM")
        .valuePerShare,
    ).toBeCloseTo(148, 8);
    // Afterwards the evaluator reports unavailability instead of the previous value.
    expect(evaluate(invalidating, "2026-08-30").models.GRAHAM).toEqual({
      status: "NOT_APPLICABLE",
      phase: "ASSEMBLY",
      reason: "MISSING_REQUIRED_FIELD",
    });
  });

  it("is deterministic for the same statements and valuation date", () => {
    const statements = completeStatements();

    expect(evaluate(statements)).toEqual(evaluate(statements));
    expect(evaluate([...statements].reverse())).toEqual(evaluate(statements));
  });
});
