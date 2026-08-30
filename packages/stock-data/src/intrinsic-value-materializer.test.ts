import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  materializeDailyIntrinsicValues,
  planIntrinsicEvaluationDates,
  type DailyIntrinsicState,
} from "./intrinsic-value-materializer.js";

const SECURITY_ID = "security-1";

type Quarter = { fiscalYear: number; period: "Q1" | "Q2" | "Q3" | "Q4" };
type Values = Record<string, number>;

const PERIOD_END: Record<FinancialPeriod, string> = {
  FY: "12-31",
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
};

/** Values chosen so all four models calculate; growth falls back to the default rate. */
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

function quarter(fiscalYear: number, period: Quarter["period"]): Quarter {
  return { fiscalYear, period };
}

function quartersOf(fiscalYear: number): Quarter[] {
  return (["Q1", "Q2", "Q3", "Q4"] as const).map((period) =>
    quarter(fiscalYear, period),
  );
}

function statement(
  statementType: FinancialStatementType,
  { fiscalYear, period }: Quarter,
  values: Values,
  availableFromDate: string,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  const fiscalDate = `${fiscalYear}-${PERIOD_END[period]}`;
  return {
    securityId: SECURITY_ID,
    statementType,
    fiscalDate,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate: availableFromDate,
    availableFromDate,
    observedAt: "2026-12-31T12:00:00.000Z",
    contentHash: `${statementType}:${fiscalYear}:${period}:${availableFromDate}:${JSON.stringify(values)}`,
    values,
    ...overrides,
  };
}

/** A complete four-quarter set for one fiscal year, all eligible from the same date. */
function completeYear(
  fiscalYear: number,
  availableFromDate: string,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement[] {
  return quartersOf(fiscalYear).flatMap((each) => [
    statement("INCOME", each, INCOME_QUARTER, availableFromDate, overrides),
    statement(
      "CASH_FLOW",
      each,
      CASH_FLOW_QUARTER,
      availableFromDate,
      overrides,
    ),
    statement(
      "BALANCE_SHEET",
      each,
      BALANCE_SHEET_QUARTER,
      availableFromDate,
      overrides,
    ),
  ]);
}

function materialize(
  tradingDates: readonly string[],
  statements: readonly FinancialStatement[],
): DailyIntrinsicState[] {
  return materializeDailyIntrinsicValues({
    securityId: SECURITY_ID,
    tradingDates,
    statements,
  });
}

function stateOn(
  states: readonly DailyIntrinsicState[],
  date: string,
): DailyIntrinsicState {
  const state = states.find((each) => each.date === date);
  if (!state) {
    throw new Error(`No materialized state for ${date}`);
  }
  return state;
}

const BASE_AVAILABLE = "2026-01-05";
const TRADING_DATES = [
  "2026-02-02",
  "2026-02-03",
  "2026-02-04",
  "2026-02-05",
  "2026-02-06",
];

describe("daily intrinsic materialization", () => {
  it("returns nothing for an empty trading-date range", () => {
    expect(materialize([], completeYear(2025, BASE_AVAILABLE))).toEqual([]);
  });

  it("always evaluates the first trading day from already eligible statements", () => {
    // Everything became eligible a month before the requested range starts.
    const states = materialize(
      TRADING_DATES,
      completeYear(2025, BASE_AVAILABLE),
    );

    expect(states.map((each) => each.date)).toEqual(TRADING_DATES);
    expect(stateOn(states, "2026-02-02").intrinsicCurrency).toBe("USD");
    expect(
      Object.keys(stateOn(states, "2026-02-02").intrinsicValues ?? {}).sort(),
    ).toEqual(["DCF_FCFF", "DDM", "GRAHAM", "RESIDUAL_INCOME"]);
    expect(planIntrinsicEvaluationDates({
      securityId: SECURITY_ID,
      tradingDates: TRADING_DATES,
      statements: completeYear(2025, BASE_AVAILABLE),
    })).toEqual(["2026-02-02"]);
  });

  it("applies an event on the trading day the statement becomes available", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      // A newer income quarter without diluted EPS: Graham can no longer be formed.
      statement(
        "INCOME",
        quarter(2026, "Q1"),
        { netIncome: 20, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
        "2026-02-04",
      ),
    ];

    const states = materialize(TRADING_DATES, statements);

    expect(stateOn(states, "2026-02-03").intrinsicValues?.GRAHAM).toBeDefined();
    expect(
      stateOn(states, "2026-02-04").intrinsicValues?.GRAHAM,
    ).toBeUndefined();
  });

  it("maps a weekend event to the next supplied trading day", () => {
    const tradingDates = ["2026-02-05", "2026-02-06", "2026-02-09"];
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      // Saturday 2026-02-07; the next supplied trading day is Monday.
      statement(
        "INCOME",
        quarter(2026, "Q1"),
        { netIncome: 20, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
        "2026-02-07",
      ),
    ];

    expect(
      planIntrinsicEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates,
        statements,
      }),
    ).toEqual(["2026-02-05", "2026-02-09"]);
    const states = materialize(tradingDates, statements);
    expect(
      stateOn(states, "2026-02-06").intrinsicValues?.GRAHAM,
    ).toBeDefined();
    expect(
      stateOn(states, "2026-02-09").intrinsicValues?.GRAHAM,
    ).toBeUndefined();
  });

  it("maps a market-holiday event to the first supplied trading day after it", () => {
    // 2026-02-04 is not a supplied trading day.
    const tradingDates = ["2026-02-02", "2026-02-03", "2026-02-05"];
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      statement(
        "INCOME",
        quarter(2026, "Q1"),
        { netIncome: 20, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
        "2026-02-04",
      ),
    ];

    expect(
      planIntrinsicEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates,
        statements,
      }),
    ).toEqual(["2026-02-02", "2026-02-05"]);
  });

  it("collapses several events landing on one trading day into a single evaluation", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      ...completeYear(2024, "2026-02-04"),
      statement(
        "BALANCE_SHEET",
        quarter(2025, "Q4"),
        { ...BALANCE_SHEET_QUARTER, totalDebt: 10 },
        "2026-02-04",
        { contentHash: "restated-balance-sheet" },
      ),
    ];

    const states = materialize(TRADING_DATES, statements);

    expect(
      planIntrinsicEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: TRADING_DATES,
        statements,
      }),
    ).toEqual(["2026-02-02", "2026-02-04"]);
    // One evaluation for both events, and it produces exactly what a single evaluation on that
    // trading day would produce.
    expect(stateOn(states, "2026-02-04")).toEqual(
      materialize(["2026-02-04"], statements)[0],
    );
  });

  it("carries the whole snapshot forward between events", () => {
    const states = materialize(
      TRADING_DATES,
      completeYear(2025, BASE_AVAILABLE),
    );
    const [first, ...rest] = states;

    for (const state of rest) {
      expect({ ...state, date: first?.date }).toEqual(first);
    }
    // Provenance travels with the value it belongs to.
    expect(stateOn(states, "2026-02-06").dcfFcffSourceAsOf).toBe(
      `${BASE_AVAILABLE}T00:00:00.000Z`,
    );
  });

  it("replaces carried values and provenance from the event day onward", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      // A newer complete quarter rolls every window forward.
      statement("INCOME", quarter(2026, "Q1"), INCOME_QUARTER, "2026-02-04"),
      statement(
        "CASH_FLOW",
        quarter(2026, "Q1"),
        { ...CASH_FLOW_QUARTER, commonDividendsPaid: -10 },
        "2026-02-04",
      ),
      statement(
        "BALANCE_SHEET",
        quarter(2026, "Q1"),
        BALANCE_SHEET_QUARTER,
        "2026-02-04",
      ),
    ];

    const states = materialize(TRADING_DATES, statements);
    const before = stateOn(states, "2026-02-03");
    const after = stateOn(states, "2026-02-04");

    expect(after.intrinsicValues?.DDM).not.toBe(before.intrinsicValues?.DDM);
    expect(before.ddmSourceAsOf).toBe(`${BASE_AVAILABLE}T00:00:00.000Z`);
    expect(after.ddmSourceAsOf).toBe("2026-02-04T00:00:00.000Z");
    // The earlier days keep the provenance that was correct for them.
    expect(stateOn(states, "2026-02-02").ddmSourceAsOf).toBe(
      `${BASE_AVAILABLE}T00:00:00.000Z`,
    );
  });

  it("clears an invalidated model and its provenance without carrying the stale value", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      statement(
        "INCOME",
        quarter(2026, "Q1"),
        { netIncome: 20, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
        "2026-02-04",
      ),
    ];

    const states = materialize(TRADING_DATES, statements);

    expect(stateOn(states, "2026-02-03").grahamSourceAsOf).toBeDefined();
    for (const date of ["2026-02-04", "2026-02-05", "2026-02-06"]) {
      expect(stateOn(states, date).intrinsicValues?.GRAHAM).toBeUndefined();
      expect(stateOn(states, date).grahamSourceAsOf).toBeUndefined();
      // Models that do not need diluted EPS are unaffected.
      expect(stateOn(states, date).intrinsicValues?.DDM).toBeDefined();
      expect(stateOn(states, date).intrinsicValues?.DCF_FCFF).toBeDefined();
    }
  });

  it("drops and restores blends with their components", () => {
    const invalidatingQuarter = quarter(2026, "Q1");
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      statement(
        "INCOME",
        invalidatingQuarter,
        { netIncome: 20, interestExpense: 2.5, weightedAverageShsOutDil: 10 },
        "2026-02-04",
      ),
      // A later revision of that same quarter restores diluted EPS.
      statement(
        "INCOME",
        invalidatingQuarter,
        INCOME_QUARTER,
        "2026-02-06",
        { contentHash: "restated-with-eps" },
      ),
    ];

    const states = materialize(TRADING_DATES, statements);

    expect(
      stateOn(states, "2026-02-03").intrinsicValueBlends?.BALANCED,
    ).toBeDefined();
    // Graham is a BALANCED/CONSERVATIVE component but not a DIVIDEND component.
    expect(
      stateOn(states, "2026-02-05").intrinsicValueBlends?.BALANCED,
    ).toBeUndefined();
    expect(
      stateOn(states, "2026-02-05").intrinsicValueBlends?.CONSERVATIVE,
    ).toBeUndefined();
    expect(
      stateOn(states, "2026-02-05").intrinsicValueBlends?.DIVIDEND,
    ).toBeDefined();
    expect(
      stateOn(states, "2026-02-06").intrinsicValues?.GRAHAM,
    ).toBeDefined();
    expect(
      stateOn(states, "2026-02-06").intrinsicValueBlends?.BALANCED,
    ).toBeDefined();
  });

  it("materializes nothing intrinsic through a row currency conflict and restores afterwards", () => {
    const newerQuarters = [
      quarter(2025, "Q2"),
      quarter(2025, "Q3"),
      quarter(2025, "Q4"),
      quarter(2026, "Q1"),
    ];
    const statements = [
      // Consistent EUR opening state.
      ...completeYear(2024, BASE_AVAILABLE, { reportedCurrency: "EUR" }),
      // Newer USD income/balance-sheet rows: models split across currencies.
      ...newerQuarters.map((each) =>
        statement("INCOME", each, INCOME_QUARTER, "2026-02-04"),
      ),
      statement(
        "BALANCE_SHEET",
        quarter(2026, "Q1"),
        BALANCE_SHEET_QUARTER,
        "2026-02-04",
      ),
      // Matching USD cash-flow quarters land later and make every model USD again.
      ...newerQuarters.map((each) =>
        statement("CASH_FLOW", each, CASH_FLOW_QUARTER, "2026-02-06"),
      ),
    ];

    const states = materialize(TRADING_DATES, statements);

    expect(stateOn(states, "2026-02-03").intrinsicCurrency).toBe("EUR");
    for (const date of ["2026-02-04", "2026-02-05"]) {
      // Nothing is materialized while the row currency conflicts, and no majority is chosen.
      expect(stateOn(states, date)).toEqual({ date });
    }
    expect(stateOn(states, "2026-02-06").intrinsicCurrency).toBe("USD");
    expect(
      stateOn(states, "2026-02-06").intrinsicValues?.DCF_FCFF,
    ).toBeDefined();
  });

  it("produces an empty snapshot when no model can be calculated", () => {
    // Two quarters cannot form a trailing four-quarter window.
    const statements = completeYear(2025, BASE_AVAILABLE).filter(
      (each) => each.period === "Q1" || each.period === "Q2",
    );

    expect(materialize(TRADING_DATES, statements)).toEqual(
      TRADING_DATES.map((date) => ({ date })),
    );
  });

  it("ignores statements belonging to another security", () => {
    const foreign = completeYear(2025, "2026-02-04").map((each) => ({
      ...each,
      securityId: "security-2",
    }));

    expect(
      planIntrinsicEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: TRADING_DATES,
        statements: [...completeYear(2025, BASE_AVAILABLE), ...foreign],
      }),
    ).toEqual(["2026-02-02"]);
  });

  it("ignores a statement that becomes available after the last trading day", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      statement("INCOME", quarter(2026, "Q1"), INCOME_QUARTER, "2026-03-01"),
    ];

    expect(
      planIntrinsicEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: TRADING_DATES,
        statements,
      }),
    ).toEqual(["2026-02-02"]);
    const states = materialize(TRADING_DATES, statements);
    expect(new Set(states.map((each) => each.intrinsicValues?.DDM)).size).toBe(
      1,
    );
  });

  it("normalizes unsorted trading dates into ascending output", () => {
    const shuffled = ["2026-02-05", "2026-02-02", "2026-02-06", "2026-02-03"];

    expect(
      materialize(shuffled, completeYear(2025, BASE_AVAILABLE)).map(
        (each) => each.date,
      ),
    ).toEqual(["2026-02-02", "2026-02-03", "2026-02-05", "2026-02-06"]);
  });

  it("rejects duplicate trading dates", () => {
    expect(() =>
      materialize(
        ["2026-02-02", "2026-02-03", "2026-02-02"],
        completeYear(2025, BASE_AVAILABLE),
      ),
    ).toThrow("duplicate 2026-02-02");
  });

  it("is deterministic under statement reordering", () => {
    const statements = [
      ...completeYear(2025, BASE_AVAILABLE),
      statement("INCOME", quarter(2026, "Q1"), INCOME_QUARTER, "2026-02-04"),
    ];

    expect(materialize(TRADING_DATES, [...statements].reverse())).toEqual(
      materialize(TRADING_DATES, statements),
    );
  });

  it("evaluates only on event days across a long trading-date range", () => {
    // One trading day per date across a year of weekdays.
    const tradingDates: string[] = [];
    const cursor = new Date("2026-01-01T00:00:00.000Z");
    while (tradingDates.length < 250) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        tradingDates.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const statements = [
      ...completeYear(2025, "2025-12-01"),
      ...completeYear(2024, "2026-04-15"),
      statement("INCOME", quarter(2026, "Q1"), INCOME_QUARTER, "2026-07-20"),
    ];
    const request = {
      securityId: SECURITY_ID,
      tradingDates,
      statements,
    };

    // 250 trading days, three evaluations: the opening day plus two statement events.
    expect(planIntrinsicEvaluationDates(request)).toEqual([
      tradingDates[0],
      "2026-04-15",
      "2026-07-20",
    ]);
    expect(materializeDailyIntrinsicValues(request)).toHaveLength(250);
  });
});
