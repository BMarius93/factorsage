import {
  FUNDAMENTAL_METRICS,
  type FinancialStatement,
  type FundamentalMetricField,
  type FundamentalMetricSnapshot,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  assembleFundamentalWindows,
  evaluateFundamentalMetrics,
  FUNDAMENTAL_ROIC_TAX_RATE,
} from "./fundamental-metrics.js";
import {
  deepFrozen,
  GOLDEN_AVAILABLE,
  GOLDEN_DATE,
  GOLDEN_ENDING_BALANCE_SHEET,
  GOLDEN_EXPECTED,
  GOLDEN_INCOME,
  goldenStatements,
  quarter,
  quartersOf,
  removeStatement,
  replaceValues,
  SECURITY_ID,
  shuffled,
  statement,
  without,
  type Values,
} from "./fundamental-metrics.test-helper.js";

/**
 * The formula matrix of `docs/development/fundamental-metrics-test-matrix.md`.
 *
 * Every expected value is a literal derived by hand from the fixture (the derivation sits beside
 * it), never a call into production code. Every unavailability case also asserts the nearby valid
 * reading, so a column that is always absent cannot pass.
 */

function evaluate(
  statements: readonly FinancialStatement[],
  date = GOLDEN_DATE,
): FundamentalMetricSnapshot {
  return evaluateFundamentalMetrics({
    securityId: SECURITY_ID,
    date,
    statements,
  });
}

/**
 * Tight tolerance: a relative 1e-12, far inside the eighth decimal `DECIMAL(20,8)` stores, so only
 * floating-point rounding — never a different formula — can pass.
 */
function expectValue(
  snapshot: FundamentalMetricSnapshot,
  field: FundamentalMetricField,
  expected: number,
): void {
  const actual = snapshot[field];
  expect(actual, field).toBeTypeOf("number");
  expect(
    Math.abs((actual as number) - expected),
    `${field}: ${actual} vs ${expected}`,
  ).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected)));
}

function expectUnavailable(
  snapshot: FundamentalMetricSnapshot,
  field: FundamentalMetricField,
): void {
  expect(snapshot, field).not.toHaveProperty(field);
}

/** Replaces one Income line across the four FY2025 quarters. */
function currentIncome(
  statements: readonly FinancialStatement[],
  field: string,
  values: readonly (number | undefined)[],
): FinancialStatement[] {
  let next = [...statements];
  quartersOf(2025).forEach((each, index) => {
    next = replaceValues(next, "INCOME", each, (current) => {
      const value = values[index];
      return value === undefined
        ? without(current, field)
        : { ...current, [field]: value };
    });
  });
  return next;
}

/** Replaces one Income line across the four FY2024 quarters. */
function previousIncome(
  statements: readonly FinancialStatement[],
  field: string,
  values: readonly number[],
): FinancialStatement[] {
  let next = [...statements];
  quartersOf(2024).forEach((each, index) => {
    next = replaceValues(next, "INCOME", each, (current) => ({
      ...current,
      [field]: values[index]!,
    }));
  });
  return next;
}

function cashFlowYear(
  statements: readonly FinancialStatement[],
  fiscalYear: number,
  field: string,
  values: readonly number[],
): FinancialStatement[] {
  let next = [...statements];
  quartersOf(fiscalYear).forEach((each, index) => {
    next = replaceValues(next, "CASH_FLOW", each, (current) => ({
      ...current,
      [field]: values[index]!,
    }));
  });
  return next;
}

function balanceSheet(
  statements: readonly FinancialStatement[],
  fiscalYear: number,
  period: "Q1" | "Q2" | "Q3" | "Q4",
  patch: (current: Values) => Values,
): FinancialStatement[] {
  return replaceValues(
    statements,
    "BALANCE_SHEET",
    quarter(fiscalYear, period),
    patch,
  );
}

const GOLDEN = goldenStatements();

describe("golden vectors", () => {
  it("evaluates all fifteen metrics of the golden fixture to their hand-derived values", () => {
    const snapshot = evaluate(GOLDEN);

    for (const [field, expected] of Object.entries(GOLDEN_EXPECTED)) {
      expectValue(snapshot, field as FundamentalMetricField, expected);
    }
    // Every registered metric fires on a complete fixture: none can be silently always-absent.
    expect(Object.keys(snapshot).sort()).toEqual(
      FUNDAMENTAL_METRICS.map((metric) => metric.field).sort(),
    );
  });

  it("stores percent metrics in percentage points, never as fractions", () => {
    const snapshot = evaluate(GOLDEN);

    // 242 / 540 = 0.448148…, a 44.81% gross margin: the stored number is 44.81…, not 0.448….
    expect(snapshot.grossMarginTtm).toBeCloseTo(44.814814814814, 9);
    expect(snapshot.grossMarginTtm).not.toBeCloseTo(0.448148148148, 3);
    for (const metric of FUNDAMENTAL_METRICS) {
      const value = snapshot[metric.field];
      if (metric.unit === "PERCENT") {
        // Every golden percentage is above 1%, so a fraction would read below 1.
        expect(Math.abs(value as number), metric.id).toBeGreaterThan(1);
      }
    }
    // Multiples stay raw ratios.
    expect(snapshot.debtToEquity).toBe(0.44);
    expect(snapshot.currentRatio).toBe(1.6);
  });

  it("uses the fixed 21% ROIC tax assumption", () => {
    expect(FUNDAMENTAL_ROIC_TAX_RATE).toBe(0.21);
  });
});

describe("Revenue Growth TTM YoY", () => {
  it("requires every quarter of the current four-quarter window", () => {
    const snapshot = evaluate(
      removeStatement(GOLDEN, "INCOME", quarter(2025, "Q2")),
    );

    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
    expectValue(evaluate(GOLDEN), "revenueGrowthTtmYoy", 400 / 23);
  });

  it("requires every quarter of the previous four-quarter window", () => {
    const snapshot = evaluate(
      removeStatement(GOLDEN, "INCOME", quarter(2024, "Q3")),
    );

    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
    expectUnavailable(snapshot, "epsGrowthTtmYoy");
    // The current window is intact, so the four-quarter metrics are unaffected.
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("never lets an FY row fill a missing quarter", () => {
    const statements = removeStatement(GOLDEN, "INCOME", quarter(2024, "Q1"));
    // The FY2024 annual row is still in the fixture, with revenue.
    expect(
      statements.some(
        (each) =>
          each.statementType === "INCOME" &&
          each.fiscalYear === 2024 &&
          each.period === "FY",
      ),
    ).toBe(true);

    expectUnavailable(evaluate(statements), "revenueGrowthTtmYoy");
  });

  it("is unavailable when one quarter lacks the revenue field", () => {
    const snapshot = evaluate(
      replaceValues(GOLDEN, "INCOME", quarter(2024, "Q2"), (values) =>
        without(values, "revenue"),
      ),
    );

    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
  });

  it("is unavailable when the previous TTM revenue is zero", () => {
    const snapshot = evaluate(previousIncome(GOLDEN, "revenue", [0, 0, 0, 0]));

    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("is unavailable when the current TTM revenue is zero or negative", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "revenue", [0, 0, 0, 0])),
      "revenueGrowthTtmYoy",
    );
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "revenue", [10, -40, 10, 10])),
      "revenueGrowthTtmYoy",
    );
  });

  it("reports a decline between two positive windows as a valid negative growth", () => {
    // Current revenue 100 + 100 + 100 + 114 = 414 against 460: (414 / 460 - 1) * 100 = -10.
    const snapshot = evaluate(
      currentIncome(GOLDEN, "revenue", [100, 100, 100, 114]),
    );

    expectValue(snapshot, "revenueGrowthTtmYoy", -10);
  });
});

describe("EPS Growth TTM YoY", () => {
  it("sums standalone quarterly diluted EPS and never recomputes it from share counts", () => {
    const snapshot = evaluate(GOLDEN);

    // (0.6 + 0.65 + 0.7 + 0.85) / (0.5 + 0.5 + 0.6 + 0.6) = 2.8 / 2.2.
    expectValue(snapshot, "epsGrowthTtmYoy", 300 / 11);
    // Share counts change 10 -> 35 across the window; net income / shares would give
    // (0.6 + 0.65 + 0.7 + 0.857142…) / 2.2 - 1 = 27.597…%.
    expect(snapshot.epsGrowthTtmYoy).not.toBeCloseTo(27.597, 2);
  });

  it("is unavailable when the previous EPS TTM is zero or negative", () => {
    expectUnavailable(
      evaluate(previousIncome(GOLDEN, "epsDiluted", [0.5, -0.5, 0, 0])),
      "epsGrowthTtmYoy",
    );
    expectUnavailable(
      evaluate(previousIncome(GOLDEN, "epsDiluted", [-0.5, -0.5, 0.2, 0.1])),
      "epsGrowthTtmYoy",
    );
  });

  it("decides a zero EPS sum exactly, not on binary rounding residue", () => {
    // 0.1 + 0.2 - 0.3 + 0 is exactly zero, but 5.55e-17 in naive double arithmetic, which would
    // read as a positive denominator and a growth rate near 5e18 %.
    const previous = evaluate(
      previousIncome(GOLDEN, "epsDiluted", [0.1, 0.2, -0.3, 0]),
    );
    expectUnavailable(previous, "epsGrowthTtmYoy");
    expectValue(previous, "revenueGrowthTtmYoy", 400 / 23);

    // A growth rate near 5e18 % is out of storage range anyway, so the current window decides it
    // too: its residue would read as a positive EPS TTM and a storable growth of about -100 %.
    const current = evaluate(
      currentIncome(GOLDEN, "epsDiluted", [0.1, 0.2, -0.3, 0]),
    );
    expectUnavailable(current, "epsGrowthTtmYoy");
    expectValue(current, "revenueGrowthTtmYoy", 400 / 23);
  });

  it("is unavailable when the current EPS TTM is zero or negative", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "epsDiluted", [0.6, -0.6, 0, 0])),
      "epsGrowthTtmYoy",
    );
  });

  it("does not turn a loss-to-profit turnaround into an enormous percentage", () => {
    const snapshot = evaluate(
      previousIncome(GOLDEN, "epsDiluted", [-0.5, -0.25, -0.25, 0]),
    );

    expectUnavailable(snapshot, "epsGrowthTtmYoy");
  });

  it("does not turn a profit-to-loss transition into a sign-inverted percentage", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "epsDiluted", [0.1, -0.3, -0.1, -0.1]),
    );

    expectUnavailable(snapshot, "epsGrowthTtmYoy");
  });

  it("is unavailable when one quarter lacks diluted EPS, even with an annual EPS present", () => {
    const snapshot = evaluate(
      replaceValues(GOLDEN, "INCOME", quarter(2025, "Q3"), (values) =>
        without(values, "epsDiluted"),
      ),
    );

    expectUnavailable(snapshot, "epsGrowthTtmYoy");
    expectValue(snapshot, "revenueGrowthTtmYoy", 400 / 23);
  });
});

describe("FCF Growth TTM YoY", () => {
  it("adds signed-negative CapEx to operating cash flow and ignores provider freeCashFlow", () => {
    const snapshot = evaluate(GOLDEN);

    // Previous (20-5)+(25-5)+(30-10)+(35-10) = 80, current (30-10)+(35-10)+(40-15)+(45-15) = 100.
    expectValue(snapshot, "fcfGrowthTtmYoy", 25);
    // Subtracting CapEx would give (150 + 50) / (110 + 30) - 1 = 42.857%; provider freeCashFlow
    // is 999 in every quarter and would give exactly 0%.
    expect(snapshot.fcfGrowthTtmYoy).not.toBeCloseTo(42.857, 2);
    expect(snapshot.fcfGrowthTtmYoy).not.toBe(0);
  });

  it("is unavailable when one quarter lacks operating cash flow, whatever freeCashFlow says", () => {
    const snapshot = evaluate(
      replaceValues(GOLDEN, "CASH_FLOW", quarter(2024, "Q2"), (values) =>
        without(values, "operatingCashFlow"),
      ),
    );

    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
    // The current window is intact.
    expectValue(snapshot, "fcfMarginTtm", 500 / 27);
  });

  it("is unavailable when one quarter lacks CapEx", () => {
    const snapshot = evaluate(
      replaceValues(GOLDEN, "CASH_FLOW", quarter(2025, "Q4"), (values) =>
        without(values, "capitalExpenditure"),
      ),
    );

    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
    expectUnavailable(snapshot, "fcfMarginTtm");
  });

  it("treats an explicit zero CapEx as a real zero", () => {
    // Current CapEx all zero: FCF 150 against 80, (150 / 80 - 1) * 100 = 87.5.
    const snapshot = evaluate(
      cashFlowYear(GOLDEN, 2025, "capitalExpenditure", [0, 0, 0, 0]),
    );

    expectValue(snapshot, "fcfGrowthTtmYoy", 87.5);
  });

  it("is unavailable when either FCF TTM is zero or negative", () => {
    expectUnavailable(
      evaluate(
        cashFlowYear(GOLDEN, 2024, "capitalExpenditure", [-20, -25, -30, -35]),
      ),
      "fcfGrowthTtmYoy",
    );
    expectUnavailable(
      evaluate(
        cashFlowYear(GOLDEN, 2025, "capitalExpenditure", [-40, -40, -40, -40]),
      ),
      "fcfGrowthTtmYoy",
    );
  });

  it("does not report a negative-to-positive transition as growth", () => {
    // Previous FCF (20-30)+(25-30)+(30-30)+(35-30) = -10, current +100.
    const snapshot = evaluate(
      cashFlowYear(GOLDEN, 2024, "capitalExpenditure", [-30, -30, -30, -30]),
    );

    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
  });

  it("requires eight consecutive Cash Flow quarters", () => {
    const snapshot = evaluate(
      removeStatement(GOLDEN, "CASH_FLOW", quarter(2024, "Q1")),
    );

    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
    expectValue(snapshot, "fcfMarginTtm", 500 / 27);
  });
});

describe("TTM margins", () => {
  it("are ratios of TTM sums, never means of quarterly margins", () => {
    const snapshot = evaluate(GOLDEN);

    // Gross 242/540; the quarterly margins 25%, 40%, 50%, 60% average 43.75%.
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
    expect(snapshot.grossMarginTtm).not.toBeCloseTo(43.75, 2);
    // Operating 98/540; quarterly 10%, 10%, 20%, 30% average 17.5%.
    expectValue(snapshot, "operatingMarginTtm", 490 / 27);
    expect(snapshot.operatingMarginTtm).not.toBeCloseTo(17.5, 2);
    // Net 63/540; quarterly 5%, 10%, 10%, 20% average 11.25%.
    expectValue(snapshot, "netMarginTtm", 35 / 3);
    expect(snapshot.netMarginTtm).not.toBeCloseTo(11.25, 2);
    // FCF 100/540; quarterly FCF margins average 18.4386%.
    expectValue(snapshot, "fcfMarginTtm", 500 / 27);
    expect(snapshot.fcfMarginTtm).not.toBeCloseTo(18.4386, 3);
  });

  it("report negative gross, operating and net margins as valid readings", () => {
    let statements = currentIncome(GOLDEN, "grossProfit", [-10, -5, -6, -6]);
    statements = currentIncome(
      statements,
      "operatingIncome",
      [-30, -20, -4, 0],
    );
    statements = currentIncome(statements, "netIncome", [-20, -20, -20, 6]);
    const snapshot = evaluate(statements);

    expectValue(snapshot, "grossMarginTtm", -5); // -27 / 540 * 100
    expectValue(snapshot, "operatingMarginTtm", -10); // -54 / 540 * 100
    expectValue(snapshot, "netMarginTtm", -10); // -54 / 540 * 100
  });

  it("report a zero numerator as a real zero margin", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "grossProfit", [10, -10, 5, -5]),
    );

    expect(snapshot.grossMarginTtm).toBe(0);

    // Exactly zero, not the 5.55e-17 residue of naive double arithmetic.
    const decimal = evaluate(
      currentIncome(GOLDEN, "grossProfit", [0.1, 0.2, -0.3, 0]),
    );
    expect(decimal.grossMarginTtm).toBe(0);
  });

  it("are unavailable when TTM revenue is zero or negative", () => {
    for (const revenue of [
      [0, 0, 0, 0],
      [100, -200, 50, 0],
    ]) {
      const snapshot = evaluate(currentIncome(GOLDEN, "revenue", revenue));

      expectUnavailable(snapshot, "grossMarginTtm");
      expectUnavailable(snapshot, "operatingMarginTtm");
      expectUnavailable(snapshot, "netMarginTtm");
      expectUnavailable(snapshot, "fcfMarginTtm");
      expectUnavailable(snapshot, "assetTurnoverTtm");
      // Revenue plays no part in the balance-sheet ratios.
      expectValue(snapshot, "debtToEquity", 0.44);
    }
  });

  it("are each unavailable when their own numerator is missing in one quarter", () => {
    const grossMissing = evaluate(
      currentIncome(GOLDEN, "grossProfit", [30, undefined, 70, 90]),
    );
    expectUnavailable(grossMissing, "grossMarginTtm");
    expectValue(grossMissing, "operatingMarginTtm", 490 / 27);

    const operatingMissing = evaluate(
      currentIncome(GOLDEN, "operatingIncome", [12, 13, undefined, 45]),
    );
    expectUnavailable(operatingMissing, "operatingMarginTtm");
    expectUnavailable(operatingMissing, "roicTtm");
    expectValue(operatingMissing, "netMarginTtm", 35 / 3);

    const netMissing = evaluate(
      currentIncome(GOLDEN, "netIncome", [undefined, 13, 14, 30]),
    );
    expectUnavailable(netMissing, "netMarginTtm");
    expectUnavailable(netMissing, "roeTtm");
    expectUnavailable(netMissing, "roaTtm");
    expectValue(netMissing, "grossMarginTtm", 1210 / 27);
  });

  it("reports a negative FCF margin as a valid reading", () => {
    const snapshot = evaluate(
      cashFlowYear(GOLDEN, 2025, "capitalExpenditure", [-44, -49, -54, -59]),
    );

    // (30-44)+(35-49)+(40-54)+(45-59) = -56, -56 / 540 * 100 = -10.370370…
    expectValue(snapshot, "fcfMarginTtm", -1400 / 135);
  });

  it("makes FCF margin unavailable when revenue, OCF or CapEx is missing in any window quarter", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "revenue", [120, 130, undefined, 150])),
      "fcfMarginTtm",
    );
    expectUnavailable(
      evaluate(
        replaceValues(GOLDEN, "CASH_FLOW", quarter(2025, "Q1"), (values) =>
          without(values, "operatingCashFlow"),
        ),
      ),
      "fcfMarginTtm",
    );
    expectUnavailable(
      evaluate(
        replaceValues(GOLDEN, "CASH_FLOW", quarter(2025, "Q2"), (values) =>
          without(values, "capitalExpenditure"),
        ),
      ),
      "fcfMarginTtm",
    );
  });
});

describe("newest-window anchoring", () => {
  const NEWER_INCOME = statement(
    "INCOME",
    quarter(2026, "Q1"),
    {
      revenue: 200,
      grossProfit: 100,
      operatingIncome: 40,
      netIncome: 20,
      epsDiluted: 1,
      ebitda: 60,
      ebit: 50,
      interestExpense: 5,
    },
    GOLDEN_AVAILABLE,
  );
  const NEWER_CASH_FLOW = statement(
    "CASH_FLOW",
    quarter(2026, "Q1"),
    { operatingCashFlow: 80, capitalExpenditure: -20 },
    GOLDEN_AVAILABLE,
  );

  it("makes FCF margin unavailable when Income is a quarter ahead of Cash Flow", () => {
    // Income reaches FY2026 Q1, Cash Flow only FY2025 Q4. Both still share FY2025 Q1..Q4 in
    // full, but that is no longer the period the metric is evaluated for.
    const snapshot = evaluate([...GOLDEN, NEWER_INCOME]);

    expectUnavailable(snapshot, "fcfMarginTtm");
    // Neither the stale FY2025 reading (18.52%) nor a mismatched pairing is produced; the
    // Income-only metrics do move to the newer window: (52 + 70 + 90 + 100) / 620.
    expectValue(snapshot, "grossMarginTtm", (312 / 620) * 100);
  });

  it("makes FCF margin unavailable when Cash Flow is a quarter ahead of Income", () => {
    const snapshot = evaluate([...GOLDEN, NEWER_CASH_FLOW]);

    expectUnavailable(snapshot, "fcfMarginTtm");
    // FCF growth is Cash Flow only, so it moves to FY2024 Q2..FY2026 Q1:
    // previous (25-5)+(30-10)+(35-10)+(30-10) = 85, current (35-10)+(40-15)+(45-15)+(80-20) = 140.
    expectValue(snapshot, "fcfGrowthTtmYoy", (140 / 85 - 1) * 100);
    // Income-only metrics keep the FY2025 window.
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("restores FCF margin once both families reach the same newest quarter", () => {
    const snapshot = evaluate([...GOLDEN, NEWER_INCOME, NEWER_CASH_FLOW]);

    // FY2025 Q2..FY2026 Q1: revenue 130 + 140 + 150 + 200 = 620, FCF 25 + 25 + 30 + 60 = 140.
    expectValue(snapshot, "fcfMarginTtm", (140 / 620) * 100);
  });

  it("never reports an old window after one family stopped reporting", () => {
    // Cash Flow ends in FY2025 while Income carries on through FY2026.
    const incomeYear = (["Q1", "Q2", "Q3", "Q4"] as const).map((period) =>
      statement(
        "INCOME",
        quarter(2026, period),
        GOLDEN_INCOME["2025-Q4"]!,
        GOLDEN_AVAILABLE,
      ),
    );
    const snapshot = evaluate([...GOLDEN, ...incomeYear]);

    expectUnavailable(snapshot, "fcfMarginTtm");
    // Cash Flow's own metric still reads its own latest chain.
    expectValue(snapshot, "fcfGrowthTtmYoy", 25);
  });

  it("never falls back to an older complete window when the newest one has a gap", () => {
    // Income FY2025 Q2 is missing; the FY2024 four-quarter window is still complete.
    const snapshot = evaluate(
      removeStatement(GOLDEN, "INCOME", quarter(2025, "Q2")),
    );

    for (const field of [
      "revenueGrowthTtmYoy",
      "epsGrowthTtmYoy",
      "grossMarginTtm",
      "operatingMarginTtm",
      "netMarginTtm",
      "fcfMarginTtm",
      "roicTtm",
      "roeTtm",
      "roaTtm",
      "netDebtToEbitdaTtm",
      "interestCoverageTtm",
      "assetTurnoverTtm",
    ] as const) {
      expectUnavailable(snapshot, field);
    }
    // The latest-state metrics and the Cash Flow chain do not read the Income window.
    expectValue(snapshot, "debtToEquity", 0.44);
    expectValue(snapshot, "currentRatio", 1.6);
    expectValue(snapshot, "fcfGrowthTtmYoy", 25);
  });

  it("makes FCF margin unavailable when one family has a gap in the newest window", () => {
    const snapshot = evaluate(
      removeStatement(GOLDEN, "CASH_FLOW", quarter(2025, "Q2")),
    );

    expectUnavailable(snapshot, "fcfMarginTtm");
    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("assembles the aligned window over identical fiscal identities, or not at all", () => {
    const identities = (rows: readonly FinancialStatement[] | undefined) =>
      rows?.map((row) => `${row.fiscalYear}-${row.period}`);
    const aligned = assembleFundamentalWindows({
      securityId: SECURITY_ID,
      date: GOLDEN_DATE,
      statements: [...GOLDEN, NEWER_INCOME, NEWER_CASH_FLOW],
    });

    expect(identities(aligned.incomeAndCashFlowTtm?.income)).toEqual([
      "2025-Q2",
      "2025-Q3",
      "2025-Q4",
      "2026-Q1",
    ]);
    expect(identities(aligned.incomeAndCashFlowTtm?.cashFlow)).toEqual(
      identities(aligned.incomeAndCashFlowTtm?.income),
    );

    const lagging = assembleFundamentalWindows({
      securityId: SECURITY_ID,
      date: GOLDEN_DATE,
      statements: [...GOLDEN, NEWER_INCOME],
    });
    expect(lagging.incomeAndCashFlowTtm).toBeUndefined();
    expect(identities(lagging.incomeTtm?.statements)).toEqual([
      "2025-Q2",
      "2025-Q3",
      "2025-Q4",
      "2026-Q1",
    ]);
  });
});

describe("one reported currency per metric", () => {
  /** The fixture with one statement's reported currency replaced. */
  function reportedIn(
    statements: readonly FinancialStatement[],
    statementType: FinancialStatement["statementType"],
    target: ReturnType<typeof quarter>,
    reportedCurrency: string,
  ): FinancialStatement[] {
    return statements.map((each) =>
      each.statementType === statementType &&
      each.fiscalYear === target.fiscalYear &&
      each.period === target.period
        ? { ...each, reportedCurrency }
        : each,
    );
  }

  const INCOME_WINDOW_METRICS = [
    "revenueGrowthTtmYoy",
    "epsGrowthTtmYoy",
    "grossMarginTtm",
    "operatingMarginTtm",
    "netMarginTtm",
    "fcfMarginTtm",
    "roicTtm",
    "roeTtm",
    "roaTtm",
    "netDebtToEbitdaTtm",
    "interestCoverageTtm",
    "assetTurnoverTtm",
  ] as const;

  it("accepts any one currency: USD + USD and JPY + JPY give the same readings", () => {
    const inJpy = GOLDEN.map((each) => ({ ...each, reportedCurrency: "JPY" }));

    expect(evaluate(inJpy)).toEqual(evaluate(GOLDEN));
    expect(Object.keys(evaluate(inJpy))).toHaveLength(15);
  });

  it("refuses USD + JPY inside one four-quarter flow window", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "INCOME", quarter(2025, "Q3"), "JPY"),
    );

    for (const field of INCOME_WINDOW_METRICS) {
      expectUnavailable(snapshot, field);
    }
    // Metrics that never read that statement are unaffected.
    expectValue(snapshot, "fcfGrowthTtmYoy", 25);
    expectValue(snapshot, "debtToEquity", 0.44);
    expectValue(snapshot, "currentRatio", 1.6);
  });

  it("refuses a previous TTM window reported in another currency than the current one", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "INCOME", quarter(2024, "Q2"), "JPY"),
    );

    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
    expectUnavailable(snapshot, "epsGrowthTtmYoy");
    // The four-quarter metrics only read the current window, which is all USD.
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
    expectValue(snapshot, "interestCoverageTtm", 10.6);

    // The same for the Cash Flow chain behind FCF growth.
    const cashFlow = evaluate(
      reportedIn(GOLDEN, "CASH_FLOW", quarter(2024, "Q2"), "JPY"),
    );
    expectUnavailable(cashFlow, "fcfGrowthTtmYoy");
    expectValue(cashFlow, "fcfMarginTtm", 500 / 27);
    expectValue(cashFlow, "revenueGrowthTtmYoy", 400 / 23);
  });

  it("refuses Income and Cash Flow reported in different currencies", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "CASH_FLOW", quarter(2025, "Q3"), "JPY"),
    );

    expectUnavailable(snapshot, "fcfMarginTtm");
    // The Cash Flow chain itself now mixes currencies too.
    expectUnavailable(snapshot, "fcfGrowthTtmYoy");
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("refuses Income and an aligned Balance Sheet reported in different currencies", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "BALANCE_SHEET", quarter(2024, "Q4"), "JPY"),
    );

    for (const field of [
      "roicTtm",
      "roeTtm",
      "roaTtm",
      "assetTurnoverTtm",
    ] as const) {
      expectUnavailable(snapshot, field);
    }
    // The latest balance sheet (FY2025 Q4) is still USD.
    expectValue(snapshot, "netDebtToEbitdaTtm", 10 / 13);
    expectValue(snapshot, "debtToEquity", 0.44);
    expectValue(snapshot, "grossMarginTtm", 1210 / 27);
  });

  it("accepts a latest balance sheet in its own currency for state ratios, but not against Income", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "BALANCE_SHEET", quarter(2025, "Q4"), "JPY"),
    );

    // Debt / Equity and Current Ratio read one statement: one currency.
    expectValue(snapshot, "debtToEquity", 0.44);
    expectValue(snapshot, "currentRatio", 1.6);
    // Net debt in JPY against USD EBITDA, and JPY ending states against USD flows, are refused.
    expectUnavailable(snapshot, "netDebtToEbitdaTtm");
    expectUnavailable(snapshot, "roeTtm");
    expectUnavailable(snapshot, "roicTtm");
  });

  it("refuses a statement without a reported currency", () => {
    const noBalanceSheetCurrency = evaluate(
      reportedIn(GOLDEN, "BALANCE_SHEET", quarter(2025, "Q4"), ""),
    );
    expectUnavailable(noBalanceSheetCurrency, "debtToEquity");
    expectUnavailable(noBalanceSheetCurrency, "currentRatio");
    expectUnavailable(noBalanceSheetCurrency, "netDebtToEbitdaTtm");
    expectValue(noBalanceSheetCurrency, "grossMarginTtm", 1210 / 27);

    const noIncomeCurrency = evaluate(
      reportedIn(GOLDEN, "INCOME", quarter(2025, "Q1"), "  "),
    );
    for (const field of INCOME_WINDOW_METRICS) {
      expectUnavailable(noIncomeCurrency, field);
    }
  });

  it("refuses a missing currency even when every statement shares it", () => {
    for (const reportedCurrency of ["", "  "]) {
      const snapshot = evaluate(
        GOLDEN.map((each) => ({ ...each, reportedCurrency })),
      );

      expect(snapshot, JSON.stringify(reportedCurrency)).toEqual({});
    }
  });

  it("never treats two spellings of a currency as the same currency", () => {
    const snapshot = evaluate(
      reportedIn(GOLDEN, "INCOME", quarter(2025, "Q4"), "usd"),
    );

    expectUnavailable(snapshot, "grossMarginTtm");
    expectUnavailable(snapshot, "revenueGrowthTtmYoy");
  });
});

describe("storable range", () => {
  it("keeps a ratio just inside the DECIMAL(20,8) range", () => {
    // EBIT 999,999,999,996 + 1 + 1 + 1 over interest expense 1 + 0 + 0 + 0.
    let statements = currentIncome(GOLDEN, "ebit", [999_999_999_996, 1, 1, 1]);
    statements = currentIncome(statements, "interestExpense", [1, 0, 0, 0]);
    const snapshot = evaluate(statements);

    expectValue(snapshot, "interestCoverageTtm", 999_999_999_999);
    expect(Object.keys(snapshot)).toHaveLength(15);
  });

  it("makes a ratio outside the range unavailable and keeps the other fourteen", () => {
    for (const ebit of [
      [999_999_999_997, 1, 1, 1],
      [-999_999_999_997, -1, -1, -1],
    ]) {
      let statements = currentIncome(GOLDEN, "ebit", ebit);
      statements = currentIncome(statements, "interestExpense", [1, 0, 0, 0]);
      const snapshot = evaluate(statements);

      // |EBIT / interest| = 10^12 needs a thirteenth integer digit: unavailable, not clamped.
      expectUnavailable(snapshot, "interestCoverageTtm");
      expect(Object.keys(snapshot)).toHaveLength(14);
      expectValue(snapshot, "grossMarginTtm", 1210 / 27);
      expectValue(snapshot, "roeTtm", 14);
    }
  });

  it("applies the same range to percentage-point metrics", () => {
    // Previous revenue 1 + 0 + 0 + 0 against a current 10^10: (10^10 / 1 - 1) * 100 is
    // 999,999,999,900 — inside. One more current revenue unit per quarter pushes it past 10^12.
    const inside = evaluate(
      currentIncome(
        previousIncome(GOLDEN, "revenue", [1, 0, 0, 0]),
        "revenue",
        [2_500_000_000, 2_500_000_000, 2_500_000_000, 2_500_000_000],
      ),
    );
    expectValue(inside, "revenueGrowthTtmYoy", (1e10 / 1 - 1) * 100);

    const outside = evaluate(
      currentIncome(
        previousIncome(GOLDEN, "revenue", [1, 0, 0, 0]),
        "revenue",
        [2_600_000_000, 2_600_000_000, 2_600_000_000, 2_600_000_000],
      ),
    );
    expectUnavailable(outside, "revenueGrowthTtmYoy");
    expectValue(outside, "operatingMarginTtm", (98 / 10_400_000_000) * 100);
  });
});

describe("ROIC TTM", () => {
  it("uses the fixed 21% tax assumption, never the statements' own tax lines", () => {
    const snapshot = evaluate(GOLDEN);

    // NOPAT 98 * 0.79 = 77.42; invested capital (200+400-100) = 500 and (220+500-120) = 600.
    expectValue(snapshot, "roicTtm", 3871 / 275);
    // The fixture reports a 50% effective tax rate (incomeTaxExpense / incomeBeforeTax); using
    // it would give 98 * 0.5 / 550 * 100 = 8.909%.
    expect(snapshot.roicTtm).not.toBeCloseTo(8.909, 2);
  });

  it("uses cash and short-term investments when present", () => {
    // With cashAndCashEquivalents instead, invested capital would be 540 and 640: 13.122%.
    expect(evaluate(GOLDEN).roicTtm).not.toBeCloseTo(13.122, 2);
  });

  it("falls back to cash and cash equivalents only when the primary cash field is absent", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) =>
        without(values, "cashAndShortTermInvestments"),
      ),
    );

    // Ending invested capital 220 + 500 - 80 = 640; average (500 + 640) / 2 = 570.
    expectValue(snapshot, "roicTtm", (77.42 / 570) * 100);
  });

  it("is unavailable when both cash fields are missing", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2024, "Q4", (values) =>
        without(
          values,
          "cashAndShortTermInvestments",
          "cashAndCashEquivalents",
        ),
      ),
    );

    expectUnavailable(snapshot, "roicTtm");
    expectValue(snapshot, "roeTtm", 14);
  });

  it("never substitutes totalEquity for a missing totalStockholdersEquity", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2024, "Q4", (values) =>
        without(values, "totalStockholdersEquity"),
      ),
    );

    expectUnavailable(snapshot, "roicTtm");
    expectUnavailable(snapshot, "roeTtm");
    // ROA does not read equity.
    expectValue(snapshot, "roaTtm", 63 / 11);
  });

  it("keeps the aligned ending state when a newer balance sheet becomes eligible", () => {
    const newer = statement(
      "BALANCE_SHEET",
      quarter(2026, "Q1"),
      {
        totalDebt: 5,
        totalStockholdersEquity: 5_000,
        cashAndShortTermInvestments: 5,
        totalAssets: 90_000,
        totalCurrentAssets: 900,
        totalCurrentLiabilities: 100,
        netDebt: 260,
      },
      GOLDEN_AVAILABLE,
    );
    const snapshot = evaluate([...GOLDEN, newer]);

    // The Income window still ends FY2025 Q4, so ROIC, ROE, ROA and asset turnover stay aligned.
    expectValue(snapshot, "roicTtm", 3871 / 275);
    expectValue(snapshot, "roeTtm", 14);
    expectValue(snapshot, "roaTtm", 63 / 11);
    expectValue(snapshot, "assetTurnoverTtm", 27 / 55);
    // The latest-state metrics do move to the newer balance sheet.
    expectValue(snapshot, "debtToEquity", 5 / 5_000);
    expectValue(snapshot, "currentRatio", 9);
    expectValue(snapshot, "netDebtToEbitdaTtm", 2);
  });

  it("is unavailable when an aligned opening or ending balance sheet is missing", () => {
    for (const missing of [quarter(2024, "Q4"), quarter(2025, "Q4")]) {
      const snapshot = evaluate(
        removeStatement(GOLDEN, "BALANCE_SHEET", missing),
      );

      expectUnavailable(snapshot, "roicTtm");
      expectUnavailable(snapshot, "roeTtm");
      expectUnavailable(snapshot, "roaTtm");
      expectUnavailable(snapshot, "assetTurnoverTtm");
    }
  });

  it("reads only the opening and ending states, not the quarters between them", () => {
    const snapshot = evaluate(
      removeStatement(GOLDEN, "BALANCE_SHEET", quarter(2025, "Q2")),
    );

    expectValue(snapshot, "roicTtm", 3871 / 275);
    expectValue(snapshot, "roeTtm", 14);
  });

  it("is unavailable when average invested capital is zero or negative", () => {
    // Opening 200 + 400 - 1100 = -500 and ending 600: average 50 is positive and valid.
    expectValue(
      evaluate(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          cashAndShortTermInvestments: 1_100,
        })),
      ),
      "roicTtm",
      (77.42 / 50) * 100,
    );
    // Opening 200 + 400 - 1200 = -600 and ending 600: average exactly zero.
    expectUnavailable(
      evaluate(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          cashAndShortTermInvestments: 1_200,
        })),
      ),
      "roicTtm",
    );
    // Opening -700 and ending 600: negative average.
    expectUnavailable(
      evaluate(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          cashAndShortTermInvestments: 1_300,
        })),
      ),
      "roicTtm",
    );
  });

  it("reports negative operating income as a valid negative ROIC", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "operatingIncome", [-20, -10, -10, -10]),
    );

    // -50 * 0.79 / 550 * 100 = -7.1818…
    expectValue(snapshot, "roicTtm", ((-50 * 0.79) / 550) * 100);
  });
});

describe("ROE TTM and ROA TTM", () => {
  it("average the aligned opening and ending states rather than using the ending state alone", () => {
    const snapshot = evaluate(GOLDEN);

    // 63 / ((400 + 500) / 2); ending equity alone would give 12.6%.
    expectValue(snapshot, "roeTtm", 14);
    expect(snapshot.roeTtm).not.toBeCloseTo(12.6, 2);
    // 63 / ((1000 + 1200) / 2); ending assets alone would give 5.25%.
    expectValue(snapshot, "roaTtm", 63 / 11);
    expect(snapshot.roaTtm).not.toBeCloseTo(5.25, 2);
  });

  it("make ROE unavailable when average equity is zero or negative", () => {
    for (const opening of [-500, -700]) {
      const snapshot = evaluate(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          totalStockholdersEquity: opening,
        })),
      );

      expectUnavailable(snapshot, "roeTtm");
      expectValue(snapshot, "roaTtm", 63 / 11);
    }
  });

  it("report negative net income over positive averages as valid negative returns", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "netIncome", [-20, -10, -10, -5]),
    );

    expectValue(snapshot, "roeTtm", -10); // -45 / 450 * 100
    expectValue(snapshot, "roaTtm", (-45 / 1100) * 100);
  });

  it("make ROA unavailable when average assets are zero or negative", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
        ...values,
        totalAssets: -1_200,
      })),
    );

    expectUnavailable(snapshot, "roaTtm");
    expectUnavailable(snapshot, "assetTurnoverTtm");
    expectValue(snapshot, "roeTtm", 14);
  });

  it("never substitute totalEquity for a missing ending totalStockholdersEquity", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) =>
        without(values, "totalStockholdersEquity"),
      ),
    );

    expectUnavailable(snapshot, "roeTtm");
    expectUnavailable(snapshot, "debtToEquity");
  });
});

describe("Debt / Equity and Current Ratio", () => {
  it("read the latest eligible quarterly balance sheet", () => {
    const snapshot = evaluate(GOLDEN);

    expectValue(snapshot, "debtToEquity", 0.44); // 220 / 500
    expectValue(snapshot, "currentRatio", 1.6); // 360 / 225
  });

  it("move to a newer balance sheet only once it is eligible", () => {
    const newer = statement(
      "BALANCE_SHEET",
      quarter(2026, "Q1"),
      {
        ...GOLDEN_ENDING_BALANCE_SHEET,
        totalDebt: 300,
        totalCurrentLiabilities: 180,
      },
      "2026-05-01",
    );
    const statements = [...GOLDEN, newer];

    expectValue(evaluate(statements, "2026-04-30"), "debtToEquity", 0.44);
    expectValue(evaluate(statements, "2026-05-01"), "debtToEquity", 0.6);
    expectValue(evaluate(statements, "2026-05-01"), "currentRatio", 2);
  });

  it("make Debt / Equity unavailable for zero or negative equity", () => {
    for (const equity of [0, -250]) {
      const snapshot = evaluate(
        balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
          ...values,
          totalStockholdersEquity: equity,
        })),
      );

      expectUnavailable(snapshot, "debtToEquity");
      expectValue(snapshot, "currentRatio", 1.6);
    }
  });

  it("report explicit zero debt over positive equity as a valid zero", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
        ...values,
        totalDebt: 0,
      })),
    );

    expect(snapshot.debtToEquity).toBe(0);
  });

  it("make Debt / Equity unavailable when total debt is missing", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) =>
        without(values, "totalDebt"),
      ),
    );

    expectUnavailable(snapshot, "debtToEquity");
    expectUnavailable(snapshot, "roicTtm");
  });

  it("make Current Ratio unavailable for zero or negative current liabilities", () => {
    for (const liabilities of [0, -10]) {
      expectUnavailable(
        evaluate(
          balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
            ...values,
            totalCurrentLiabilities: liabilities,
          })),
        ),
        "currentRatio",
      );
    }
  });

  it("make Current Ratio unavailable when either side is missing", () => {
    for (const field of ["totalCurrentAssets", "totalCurrentLiabilities"]) {
      const snapshot = evaluate(
        balanceSheet(GOLDEN, 2025, "Q4", (values) => without(values, field)),
      );

      expectUnavailable(snapshot, "currentRatio");
      expectValue(snapshot, "debtToEquity", 0.44);
    }
  });

  it("report explicit zero current assets as a valid zero ratio", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
        ...values,
        totalCurrentAssets: 0,
      })),
    );

    expect(snapshot.currentRatio).toBe(0);
  });

  it("never fall back to an older balance sheet when the latest one lacks a field", () => {
    // The latest balance sheet is FY2025 Q4; FY2024 Q4 still has current liabilities.
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) =>
        without(values, "totalCurrentLiabilities"),
      ),
    );

    expectUnavailable(snapshot, "currentRatio");
  });
});

describe("Net Debt / EBITDA TTM", () => {
  it("divides the latest net debt by the TTM EBITDA", () => {
    expectValue(evaluate(GOLDEN), "netDebtToEbitdaTtm", 10 / 13); // 100 / 130
  });

  it("reports negative net debt as a valid negative multiple", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
        ...values,
        netDebt: -260,
      })),
    );

    expectValue(snapshot, "netDebtToEbitdaTtm", -2);
  });

  it("reports explicit zero net debt as a valid zero", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => ({ ...values, netDebt: 0 })),
    );

    expect(snapshot.netDebtToEbitdaTtm).toBe(0);
  });

  it("is unavailable when TTM EBITDA is zero or negative", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "ebitda", [20, -20, 5, -5])),
      "netDebtToEbitdaTtm",
    );
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "ebitda", [20, -40, 5, -5])),
      "netDebtToEbitdaTtm",
    );
  });

  it("never reconstructs a missing net debt from debt and cash", () => {
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => without(values, "netDebt")),
    );

    expectUnavailable(snapshot, "netDebtToEbitdaTtm");
    expectValue(snapshot, "debtToEquity", 0.44);
  });

  it("is unavailable when EBITDA is missing in one quarter", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "ebitda", [20, 22, undefined, 53])),
      "netDebtToEbitdaTtm",
    );
  });

  it("requires four consecutive Income quarters", () => {
    expectUnavailable(
      evaluate(removeStatement(GOLDEN, "INCOME", quarter(2025, "Q2"))),
      "netDebtToEbitdaTtm",
    );
  });
});

describe("Interest Coverage TTM", () => {
  it("is the ratio of TTM sums, not the mean of quarterly coverage", () => {
    const snapshot = evaluate(GOLDEN);

    // 106 / 10; quarterly 7, 7.5, 10, 15.67 average 10.04.
    expectValue(snapshot, "interestCoverageTtm", 10.6);
    expect(snapshot.interestCoverageTtm).not.toBeCloseTo(10.0417, 3);
  });

  it("is unavailable, never infinite, for an explicit zero interest expense", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "interestExpense", [0, 0, 0, 0]),
    );

    expectUnavailable(snapshot, "interestCoverageTtm");
    expect(Object.values(snapshot).every(Number.isFinite)).toBe(true);
  });

  it("is unavailable when interest expense is missing in one quarter", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "interestExpense", [2, undefined, 3, 3])),
      "interestCoverageTtm",
    );
  });

  it("uses an explicit zero in one quarter as a real zero", () => {
    // 106 / (2 + 0 + 3 + 3) = 13.25.
    expectValue(
      evaluate(currentIncome(GOLDEN, "interestExpense", [2, 0, 3, 3])),
      "interestCoverageTtm",
      13.25,
    );
  });

  it("reports negative EBIT over positive interest as a valid negative coverage", () => {
    const snapshot = evaluate(
      currentIncome(GOLDEN, "ebit", [-10, -10, -3, -2]),
    );

    expectValue(snapshot, "interestCoverageTtm", -2.5); // -25 / 10
  });

  it("is unavailable when EBIT is missing in one quarter", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "ebit", [14, 15, 30, undefined])),
      "interestCoverageTtm",
    );
  });
});

describe("Asset Turnover TTM", () => {
  it("divides TTM revenue by the average of two aligned asset states", () => {
    const snapshot = evaluate(GOLDEN);

    // 540 / ((1000 + 1200) / 2); ending assets alone would give 0.45, and the mean of quarterly
    // turnover values 0.1227.
    expectValue(snapshot, "assetTurnoverTtm", 27 / 55);
    expect(snapshot.assetTurnoverTtm).not.toBeCloseTo(0.45, 3);
    expect(snapshot.assetTurnoverTtm).not.toBeCloseTo(0.1227, 3);
  });

  it("is unavailable when average assets are zero", () => {
    expectUnavailable(
      evaluate(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          totalAssets: -1_200,
        })),
      ),
      "assetTurnoverTtm",
    );
  });

  it("is unavailable when TTM revenue is zero", () => {
    expectUnavailable(
      evaluate(currentIncome(GOLDEN, "revenue", [0, 0, 0, 0])),
      "assetTurnoverTtm",
    );
  });
});

describe("point-in-time visibility", () => {
  it("sees nothing before the statements' availability date", () => {
    expect(evaluate(GOLDEN, "2026-02-15")).toEqual({});
    expect(Object.keys(evaluate(GOLDEN, GOLDEN_AVAILABLE))).toHaveLength(15);
  });

  it("uses the latest revision eligible on the date and ignores a stored future one", () => {
    const revised = statement(
      "INCOME",
      quarter(2025, "Q4"),
      { ...GOLDEN_INCOME["2025-Q4"]!, revenue: 200 },
      "2026-05-01",
      { contentHash: "revised-2025-Q4" },
    );
    const statements = [...GOLDEN, revised];

    // Before 2026-05-01 the revision is stored but invisible.
    expectValue(
      evaluate(statements, "2026-04-30"),
      "revenueGrowthTtmYoy",
      400 / 23,
    );
    // From 2026-05-01: current revenue 120 + 130 + 140 + 200 = 590; (590 / 460 - 1) * 100.
    expectValue(
      evaluate(statements, "2026-05-01"),
      "revenueGrowthTtmYoy",
      (590 / 460 - 1) * 100,
    );
  });

  it("lets a later revision of an old quarter change a value only from its own availability", () => {
    // A restatement of FY2024 Q2 — a quarter of the previous window — filed long after.
    const restated = statement(
      "INCOME",
      quarter(2024, "Q2"),
      { ...GOLDEN_INCOME["2024-Q2"]!, revenue: 150 },
      "2026-08-19",
      { filingDate: "2026-08-18", contentHash: "restated-2024-Q2" },
    );
    const statements = [...GOLDEN, restated];

    expectValue(
      evaluate(statements, "2026-08-18"),
      "revenueGrowthTtmYoy",
      400 / 23,
    );
    // Previous revenue 100 + 150 + 120 + 130 = 500: (540 / 500 - 1) * 100 = 8.
    expectValue(evaluate(statements, "2026-08-19"), "revenueGrowthTtmYoy", 8);
  });

  it("keys a quarter by fiscal identity and prefers the later period end when one observation carried two", () => {
    // The provider reported FY2025 Q4 with two period ends at once; both rows are eligible.
    const moved = statement(
      "INCOME",
      quarter(2025, "Q4"),
      { ...GOLDEN_INCOME["2025-Q4"]!, revenue: 170 },
      GOLDEN_AVAILABLE,
      { fiscalDate: "2026-01-01", contentHash: "moved-period-end" },
    );

    for (const order of [
      [...GOLDEN, moved],
      [moved, ...GOLDEN],
      shuffled([...GOLDEN, moved], 7),
    ]) {
      // Current revenue 120 + 130 + 140 + 170 = 560.
      expectValue(
        evaluate(order),
        "revenueGrowthTtmYoy",
        (560 / 460 - 1) * 100,
      );
    }
  });

  it("lets a revision that moves a quarter's period end take effect from its own availability", () => {
    // FY2025 Q4 (period end 2025-12-31, public 2026-02-16) is revised with its period end moved,
    // earlier or later, and becomes eligible on 2026-05-04.
    for (const fiscalDate of ["2025-12-27", "2026-01-02"]) {
      const moved = statement(
        "INCOME",
        quarter(2025, "Q4"),
        { ...GOLDEN_INCOME["2025-Q4"]!, revenue: 170 },
        "2026-05-04",
        { fiscalDate, contentHash: `moved-to-${fiscalDate}` },
      );
      const statements = shuffled([...GOLDEN, moved], 11);

      expectValue(
        evaluate(statements, "2026-05-01"),
        "revenueGrowthTtmYoy",
        400 / 23,
      );
      // Current revenue 120 + 130 + 140 + 170 = 560 from the revision's own availability.
      expectValue(
        evaluate(statements, "2026-05-04"),
        "revenueGrowthTtmYoy",
        (560 / 460 - 1) * 100,
      );
    }
  });

  it("ignores statements of another security", () => {
    const foreign = GOLDEN.map((each) => ({
      ...each,
      securityId: "security-other",
      values: { ...each.values, revenue: 1 },
    }));

    expect(evaluate([...GOLDEN, ...foreign])).toEqual(evaluate(GOLDEN));
    expect(evaluate(foreign)).toEqual({});
  });
});

describe("fiscal calendars", () => {
  /** A September fiscal year-end: FY2025 Q1 ends in December 2024. */
  function septemberYearEnd(fiscalYear: number, period: string): string {
    const ends: Record<string, string> = {
      Q1: `${fiscalYear - 1}-12-28`,
      Q2: `${fiscalYear}-03-29`,
      Q3: `${fiscalYear}-06-28`,
      Q4: `${fiscalYear}-09-27`,
      FY: `${fiscalYear}-09-27`,
    };
    return ends[period]!;
  }

  /** A retailer's January/February fiscal year-end: FY2025 Q1 ends in May 2024. */
  function januaryYearEnd(fiscalYear: number, period: string): string {
    const ends: Record<string, string> = {
      Q1: `${fiscalYear - 1}-05-04`,
      Q2: `${fiscalYear - 1}-08-03`,
      Q3: `${fiscalYear - 1}-11-02`,
      Q4: `${fiscalYear}-02-01`,
      FY: `${fiscalYear}-02-01`,
    };
    return ends[period]!;
  }

  it("gives identical answers for identical values whatever the fiscal calendar", () => {
    const calendar = evaluate(GOLDEN);

    for (const fiscalDate of [septemberYearEnd, januaryYearEnd]) {
      const statements = goldenStatements({ fiscalDate });
      // The fiscal dates really are off the calendar quarters.
      expect(
        statements
          .find((each) => each.fiscalYear === 2025 && each.period === "Q1")
          ?.fiscalDate.slice(0, 4),
      ).toBe("2024");

      expect(evaluate(statements)).toEqual(calendar);
    }
  });

  it("chains Q4 to the next fiscal year's Q1 by identity, not by calendar date", () => {
    const newerIncome = statement(
      "INCOME",
      quarter(2026, "Q1"),
      { ...GOLDEN_INCOME["2025-Q4"]!, revenue: 200, grossProfit: 100 },
      GOLDEN_AVAILABLE,
      { fiscalDate: januaryYearEnd(2026, "Q1") },
    );
    const statements = [
      ...goldenStatements({ fiscalDate: januaryYearEnd }),
      newerIncome,
    ];

    // FY2025 Q2..FY2026 Q1: gross profit 52 + 70 + 90 + 100 = 312 over 130 + 140 + 150 + 200.
    expectValue(evaluate(statements), "grossMarginTtm", (312 / 620) * 100);
  });
});

describe("determinism and purity", () => {
  it("returns the same snapshot for every ordering of the statements", () => {
    const expected = evaluate(GOLDEN);

    for (const seed of [1, 2, 3, 42, 1_000]) {
      expect(evaluate(shuffled(GOLDEN, seed))).toEqual(expected);
    }
    expect(evaluate([...GOLDEN].reverse())).toEqual(expected);
  });

  it("never mutates the caller's statements", () => {
    const frozen = deepFrozen(GOLDEN);
    const before = JSON.stringify(frozen);

    expect(evaluate(frozen)).toEqual(evaluate(GOLDEN));
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("rejects a non-finite result instead of returning infinity", () => {
    // Four quarters of 1e308 gross profit overflow the double range.
    const snapshot = evaluate(
      currentIncome(GOLDEN, "grossProfit", [1e308, 1e308, 1e308, 1e308]),
    );

    expectUnavailable(snapshot, "grossMarginTtm");
    expectValue(snapshot, "operatingMarginTtm", 490 / 27);
  });

  it("never divides by an overflowing sum, which would read as a finite zero", () => {
    // Revenue beyond the double range: a margin over an infinite revenue would compute as 0.
    const snapshot = evaluate(
      currentIncome(GOLDEN, "revenue", [1e308, 1e308, 1e308, 1e308]),
    );

    for (const field of [
      "revenueGrowthTtmYoy",
      "grossMarginTtm",
      "operatingMarginTtm",
      "netMarginTtm",
      "fcfMarginTtm",
      "assetTurnoverTtm",
    ] as const) {
      expectUnavailable(snapshot, field);
    }
    // Metrics that do not read revenue are unaffected.
    expectValue(snapshot, "roeTtm", 14);
    expectValue(snapshot, "interestCoverageTtm", 10.6);

    // The same for the balance-sheet averages behind ROE, ROA and asset turnover.
    const assets = evaluate(
      balanceSheet(
        balanceSheet(GOLDEN, 2024, "Q4", (values) => ({
          ...values,
          totalAssets: 1e308,
        })),
        2025,
        "Q4",
        (values) => ({ ...values, totalAssets: 1e308 }),
      ),
    );
    expectUnavailable(assets, "roaTtm");
    expectUnavailable(assets, "assetTurnoverTtm");
    expectValue(assets, "roeTtm", 14);
  });

  it("returns a zero reading as plain zero, never negative zero", () => {
    // -0 / 500 and -0 / 130 are negative zero in double arithmetic; the stored decimal has no sign.
    const snapshot = evaluate(
      balanceSheet(GOLDEN, 2025, "Q4", (values) => ({
        ...values,
        totalDebt: -0,
        netDebt: -0,
      })),
    );

    expect(Object.is(snapshot.debtToEquity, 0)).toBe(true);
    expect(Object.is(snapshot.netDebtToEbitdaTtm, 0)).toBe(true);
  });

  it("returns an extreme but finite ratio unclamped", () => {
    // Previous revenue 0.000001 + 0 + 0 + 0: (540 / 0.000001 - 1) * 100.
    const snapshot = evaluate(
      previousIncome(GOLDEN, "revenue", [0.000001, 0, 0, 0]),
    );

    expectValue(snapshot, "revenueGrowthTtmYoy", (540 / 0.000001 - 1) * 100);
  });
});
