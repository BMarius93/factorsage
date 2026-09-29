import {
  FUNDAMENTAL_METRICS,
  type FinancialStatement,
} from "@intrinsic/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as formulas from "./fundamental-metrics.js";
import {
  materializeDailyFundamentals,
  planFundamentalEvaluationDates,
  type DailyFundamentalState,
} from "./fundamental-metrics-materializer.js";
import {
  deepFrozen,
  GOLDEN_EXPECTED,
  goldenStatements,
  quarter,
  quartersOf,
  SECURITY_ID,
  shuffled,
  statement,
  weekdays,
  without,
  type Values,
} from "./fundamental-metrics.test-helper.js";

// Counts formula evaluations without changing them, to prove the materializer is event-driven.
vi.mock("./fundamental-metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof formulas>();
  return {
    ...actual,
    evaluateFundamentalMetrics: vi.fn(actual.evaluateFundamentalMetrics),
  };
});

/**
 * The daily-materialization and point-in-time matrices of
 * `docs/development/fundamental-metrics-test-matrix.md`.
 *
 * The canonical axis is a real exchange calendar shape: weekdays minus Independence Day (observed
 * Friday 2026-07-03), Labor Day (2026-09-07), Thanksgiving (2026-11-26) and Christmas. Every
 * statement names its fiscal identity and its `availableFromDate`.
 */
const HOLIDAYS = ["2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
const AXIS = weekdays("2026-06-01", "2026-12-31", HOLIDAYS);

/** Everything in the golden fixture was public before the axis starts. */
const BASE = goldenStatements({ available: "2026-05-15" });

const FY2026_Q1: Record<"INCOME" | "CASH_FLOW" | "BALANCE_SHEET", Values> = {
  INCOME: {
    revenue: 160,
    grossProfit: 64,
    operatingIncome: 32,
    netIncome: 16,
    epsDiluted: 0.8,
    ebitda: 40,
    ebit: 34,
    interestExpense: 4,
  },
  CASH_FLOW: { operatingCashFlow: 50, capitalExpenditure: -20 },
  BALANCE_SHEET: {
    totalDebt: 240,
    totalStockholdersEquity: 520,
    cashAndShortTermInvestments: 130,
    totalAssets: 1_250,
    totalCurrentAssets: 390,
    totalCurrentLiabilities: 260,
    netDebt: 110,
  },
};

const FY2026_Q2: typeof FY2026_Q1 = {
  INCOME: {
    revenue: 170,
    grossProfit: 85,
    operatingIncome: 34,
    netIncome: 17,
    epsDiluted: 0.9,
    ebitda: 44,
    ebit: 36,
    interestExpense: 4,
  },
  CASH_FLOW: { operatingCashFlow: 60, capitalExpenditure: -20 },
  BALANCE_SHEET: {
    totalDebt: 250,
    totalStockholdersEquity: 625,
    cashAndShortTermInvestments: 140,
    totalAssets: 1_300,
    totalCurrentAssets: 400,
    totalCurrentLiabilities: 250,
    netDebt: 110,
  },
};

/** FY2026 Q1 (period end 2026-03-31) was filed 2026-05-14 and is part of the opening state. */
const OPENING = [
  ...BASE,
  ...(["INCOME", "CASH_FLOW", "BALANCE_SHEET"] as const).map((type) =>
    statement(type, quarter(2026, "Q1"), FY2026_Q1[type], "2026-05-15", {
      filingDate: "2026-05-14",
    }),
  ),
];

/**
 * FY2026 Q2 exactly as the matrix states it: fiscal period end 2026-06-30, filed 2026-07-31,
 * available 2026-08-01 — a Saturday, so the first eligible session is Monday 2026-08-03.
 */
function fy2026Q2(
  type: "INCOME" | "CASH_FLOW" | "BALANCE_SHEET",
  availableFromDate = "2026-08-01",
  values: Values = FY2026_Q2[type],
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement(type, quarter(2026, "Q2"), values, availableFromDate, {
    fiscalDate: "2026-06-30",
    filingDate: "2026-07-31",
    ...overrides,
  });
}

const NEW_QUARTER = (["INCOME", "CASH_FLOW", "BALANCE_SHEET"] as const).map(
  (type) => fy2026Q2(type),
);

function materialize(
  statements: readonly FinancialStatement[],
  tradingDates: readonly string[] = AXIS,
): DailyFundamentalState[] {
  return materializeDailyFundamentals({
    securityId: SECURITY_ID,
    tradingDates,
    statements,
  });
}

function stateOn(
  states: readonly DailyFundamentalState[],
  date: string,
): DailyFundamentalState {
  const state = states.find((each) => each.date === date);
  if (!state) {
    throw new Error(`No materialized state for ${date}`);
  }
  return state;
}

function withoutDate({ date: _date, ...metrics }: DailyFundamentalState) {
  return metrics;
}

const evaluations = vi.mocked(formulas.evaluateFundamentalMetrics);

beforeEach(() => {
  evaluations.mockClear();
});

describe("daily fundamental materialization", () => {
  it("returns nothing for an empty trading-date axis", () => {
    expect(materialize(OPENING, [])).toEqual([]);
  });

  it("evaluates the first trading day from statements that were already eligible", () => {
    const states = materialize(BASE);

    expect(states[0]?.date).toBe("2026-06-01");
    const opening = withoutDate(states[0]!);
    expect(Object.keys(opening).sort()).toEqual(
      Object.keys(GOLDEN_EXPECTED).sort(),
    );
    for (const [field, expected] of Object.entries(GOLDEN_EXPECTED)) {
      expect(opening[field as keyof typeof opening], field).toBeCloseTo(
        expected,
        10,
      );
    }
    expect(
      planFundamentalEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: AXIS,
        statements: BASE,
      }),
    ).toEqual(["2026-06-01"]);
  });

  it("produces exactly one state per canonical trading day and none on weekends or holidays", () => {
    const states = materialize(OPENING, shuffled(AXIS, 11));

    expect(states.map((each) => each.date)).toEqual(AXIS);
    for (const closed of [
      "2026-07-03",
      "2026-07-04",
      "2026-08-01",
      "2026-08-02",
      ...HOLIDAYS,
    ]) {
      expect(
        states.some((each) => each.date === closed),
        closed,
      ).toBe(false);
    }
  });

  it("rejects a duplicated trading date", () => {
    expect(() =>
      materialize(OPENING, ["2026-06-01", "2026-06-02", "2026-06-01"]),
    ).toThrow("duplicate 2026-06-01");
  });

  it("carries the whole snapshot forward unchanged between events", () => {
    const states = materialize([...OPENING, ...NEW_QUARTER]);
    const before = states.filter((each) => each.date < "2026-08-03");
    const after = states.filter((each) => each.date >= "2026-08-03");

    for (const run of [before, after]) {
      for (const state of run) {
        expect(withoutDate(state)).toEqual(withoutDate(run[0]!));
      }
    }
    expect(withoutDate(after[0]!)).not.toEqual(withoutDate(before[0]!));
  });

  it("evaluates only on statement events, never once per trading day", () => {
    const statements = [...OPENING, ...NEW_QUARTER];
    const plan = planFundamentalEvaluationDates({
      securityId: SECURITY_ID,
      tradingDates: AXIS,
      statements,
    });

    evaluations.mockClear();
    const states = materialize(statements);

    expect(states).toHaveLength(AXIS.length);
    expect(plan).toEqual(["2026-06-01", "2026-08-03"]);
    expect(evaluations).toHaveBeenCalledTimes(plan.length);
    expect(evaluations.mock.calls.map(([request]) => request.date)).toEqual(
      plan,
    );
  });
});

describe("point-in-time boundaries", () => {
  it("does not expose a filed quarter before its availability date, whatever its period end", () => {
    const states = materialize([...OPENING, ...NEW_QUARTER]);

    // Period end 2026-06-30 and filing 2026-07-31 expose nothing: Friday 2026-07-31 still reads
    // the FY2026 Q1 balance sheet, 240 / 520.
    for (const date of ["2026-06-30", "2026-07-01", "2026-07-31"]) {
      expect(stateOn(states, date).debtToEquity).toBe(240 / 520);
      expect(stateOn(states, date).currentRatio).toBe(1.5);
    }
    // Available Saturday 2026-08-01: the next actual session, Monday 2026-08-03, is the first.
    expect(stateOn(states, "2026-08-03").debtToEquity).toBe(0.4); // 250 / 625
    expect(stateOn(states, "2026-08-03").currentRatio).toBe(1.6); // 400 / 250
  });

  it("makes a trading-day availability date the first eligible observation", () => {
    const states = materialize([
      ...OPENING,
      fy2026Q2("BALANCE_SHEET", "2026-08-04"),
    ]);

    expect(stateOn(states, "2026-08-03").debtToEquity).toBe(240 / 520);
    expect(stateOn(states, "2026-08-04").debtToEquity).toBe(0.4);
  });

  it("moves Saturday and Sunday availability to Monday without a synthetic row", () => {
    for (const availableFromDate of ["2026-08-01", "2026-08-02"]) {
      const statements = [
        ...OPENING,
        fy2026Q2("BALANCE_SHEET", availableFromDate),
      ];
      const states = materialize(statements);

      expect(
        planFundamentalEvaluationDates({
          securityId: SECURITY_ID,
          tradingDates: AXIS,
          statements,
        }),
      ).toEqual(["2026-06-01", "2026-08-03"]);
      expect(stateOn(states, "2026-07-31").debtToEquity).toBe(240 / 520);
      expect(stateOn(states, "2026-08-03").debtToEquity).toBe(0.4);
      expect(states.some((each) => each.date === availableFromDate)).toBe(
        false,
      );
    }
  });

  it("moves exchange-holiday availability to the next session on the canonical axis", () => {
    // Labor Day 2026-09-07 is absent from the axis; the next session is Tuesday 2026-09-08.
    const states = materialize([
      ...OPENING,
      fy2026Q2("BALANCE_SHEET", "2026-09-07"),
    ]);

    expect(stateOn(states, "2026-09-04").debtToEquity).toBe(240 / 520);
    expect(stateOn(states, "2026-09-08").debtToEquity).toBe(0.4);
  });

  it("switches between two revisions of one fiscal identity exactly at each availability date", () => {
    const revisionA = fy2026Q2("BALANCE_SHEET", "2026-08-01");
    const revisionB = fy2026Q2(
      "BALANCE_SHEET",
      "2026-10-15",
      { ...FY2026_Q2.BALANCE_SHEET, totalDebt: 500 },
      { filingDate: "2026-10-14", contentHash: "revision-b" },
    );
    const withB = materialize([...OPENING, revisionA, revisionB]);

    for (const state of withB) {
      const expected =
        state.date < "2026-08-01"
          ? 240 / 520 // before 2026-08-01: the prior state
          : state.date < "2026-10-15"
            ? 0.4 // 2026-08-01..2026-10-14: revision A, 250 / 625
            : 0.8; // 2026-10-15 onward: revision B, 500 / 625
      expect(state.debtToEquity, state.date).toBe(expected);
    }

    // No row before 2026-10-15 depends on revision B: byte-for-byte what it was without it.
    const withoutB = materialize([...OPENING, revisionA]);
    const earlier = (states: DailyFundamentalState[]) =>
      JSON.stringify(states.filter((each) => each.date < "2026-10-15"));
    expect(earlier(withB)).toBe(earlier(withoutB));
  });

  it("uses a later-observed revision only from its own availability, not its filing date", () => {
    // A correction to FY2026 Q1 that carries no newer filing date: the loader makes it available
    // from the day it was first observed, 2026-09-21, so it is never backdated.
    const correction = statement(
      "INCOME",
      quarter(2026, "Q1"),
      { ...FY2026_Q1.INCOME, grossProfit: 96 },
      "2026-09-21",
      { filingDate: "2026-05-14", contentHash: "observed-later" },
    );
    const before = materialize(OPENING);
    const after = materialize([...OPENING, correction]);

    // Window FY2025 Q2..FY2026 Q1: gross profit 52 + 70 + 90 + 64 = 276, revenue 580.
    expect(stateOn(after, "2026-09-18").grossMarginTtm).toBe(
      stateOn(before, "2026-09-18").grossMarginTtm,
    );
    expect(stateOn(after, "2026-09-18").grossMarginTtm).toBeCloseTo(
      (276 / 580) * 100,
      10,
    );
    // From 2026-09-21: 52 + 70 + 90 + 96 = 308.
    expect(stateOn(after, "2026-09-21").grossMarginTtm).toBeCloseTo(
      (308 / 580) * 100,
      10,
    );
    expect(
      JSON.stringify(after.filter((each) => each.date < "2026-09-21")),
    ).toBe(JSON.stringify(before.filter((each) => each.date < "2026-09-21")));
  });

  it("collapses revisions that become eligible on the same session into one complete evaluation", () => {
    // Income on Saturday, the balance sheet on Sunday: one event, Monday, seeing both.
    const statements = [
      ...OPENING,
      fy2026Q2("INCOME", "2026-08-01"),
      fy2026Q2("BALANCE_SHEET", "2026-08-02"),
    ];

    expect(
      planFundamentalEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: AXIS,
        statements,
      }),
    ).toEqual(["2026-06-01", "2026-08-03"]);
    const monday = stateOn(materialize(statements), "2026-08-03");
    // Exactly what one evaluation of the complete set on that session produces.
    expect(monday).toEqual(materialize(statements, ["2026-08-03"])[0]);
    // Both revisions are visible: the new balance sheet and the new income window.
    expect(monday.debtToEquity).toBe(0.4);
    // Gross margin over FY2025 Q3..FY2026 Q2: (70 + 90 + 64 + 85) / (140 + 150 + 160 + 170).
    expect(monday.grossMarginTtm).toBeCloseTo((309 / 620) * 100, 10);
  });

  it("never lets a statement available after a trading day influence that day", () => {
    const statements = [...OPENING, ...NEW_QUARTER];
    const full = materialize(statements);

    for (const cutoff of ["2026-07-31", "2026-08-03", "2026-10-30"]) {
      // Dropping everything that becomes available after the cutoff changes nothing up to it.
      const visible = statements.filter(
        (each) => each.availableFromDate <= cutoff,
      );
      const prefix = full.filter((each) => each.date <= cutoff);
      expect(
        materialize(visible).filter((each) => each.date <= cutoff),
      ).toEqual(prefix);
      // Truncating the trading-date axis changes nothing for the days kept either.
      expect(
        materialize(
          statements,
          AXIS.filter((date) => date <= cutoff),
        ),
      ).toEqual(prefix);
    }
  });

  it("ignores statements of another security", () => {
    const foreign = NEW_QUARTER.map((each) => ({
      ...each,
      securityId: "security-other",
    }));

    expect(
      planFundamentalEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: AXIS,
        statements: [...OPENING, ...foreign],
      }),
    ).toEqual(["2026-06-01"]);
    expect(materialize([...OPENING, ...foreign])).toEqual(materialize(OPENING));
  });

  it("does not treat an annual revision as an event, because no metric reads one", () => {
    const annual = statement(
      "INCOME",
      { fiscalYear: 2026, period: "FY" },
      { revenue: 99_999, epsDiluted: 99 },
      "2026-08-04",
    );

    expect(
      planFundamentalEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: AXIS,
        statements: [...OPENING, annual],
      }),
    ).toEqual(["2026-06-01"]);
    expect(materialize([...OPENING, annual])).toEqual(materialize(OPENING));
  });
});

describe("invalidation and restoration", () => {
  it("drops a metric from the invalidating session onward and restores it on a later event", () => {
    const invalidating = fy2026Q2(
      "BALANCE_SHEET",
      "2026-11-02",
      { ...FY2026_Q2.BALANCE_SHEET, totalStockholdersEquity: -10 },
      { filingDate: "2026-11-01", contentHash: "negative-equity" },
    );
    const restoring = fy2026Q2(
      "BALANCE_SHEET",
      "2026-12-01",
      FY2026_Q2.BALANCE_SHEET,
      { filingDate: "2026-11-30", contentHash: "restored-equity" },
    );
    const states = materialize([
      ...OPENING,
      ...NEW_QUARTER,
      invalidating,
      restoring,
    ]);

    for (const state of states) {
      if (state.date < "2026-08-03") {
        expect(state.debtToEquity, state.date).toBe(240 / 520);
      } else if (state.date < "2026-11-02") {
        expect(state.debtToEquity, state.date).toBe(0.4);
      } else if (state.date < "2026-12-01") {
        // Absent, not the stale 0.4 and not zero, on every session of the invalidated stretch.
        expect(state, state.date).not.toHaveProperty("debtToEquity");
        // Metrics the revision does not touch are unaffected.
        expect(state.currentRatio, state.date).toBe(1.6);
      } else {
        expect(state.debtToEquity, state.date).toBe(0.4);
      }
    }
  });

  it("drops a flow metric when a newer quarter arrives without a required field", () => {
    const withoutRevenue = fy2026Q2(
      "INCOME",
      "2026-08-01",
      without(FY2026_Q2.INCOME, "revenue"),
    );
    const states = materialize([...OPENING, withoutRevenue]);

    expect(stateOn(states, "2026-07-31").grossMarginTtm).toBeDefined();
    expect(stateOn(states, "2026-07-31").revenueGrowthTtmYoy).toBeDefined();
    for (const date of ["2026-08-03", "2026-10-01", "2026-12-31"]) {
      // The newer quarter is authoritative: no fallback to the older complete window.
      expect(stateOn(states, date)).not.toHaveProperty("grossMarginTtm");
      expect(stateOn(states, date)).not.toHaveProperty("revenueGrowthTtmYoy");
      // EBIT over interest expense does not read revenue.
      expect(stateOn(states, date).interestCoverageTtm).toBeCloseTo(
        (30 + 47 + 34 + 36) / (3 + 3 + 4 + 4),
        10,
      );
    }
  });
});

describe("currency and storable-range events", () => {
  it("invalidates from a currency-changing revision's session, leaving history untouched", () => {
    // FY2026 Q2's income statement is restated in EUR on Tuesday 2026-10-06 and back in USD on
    // Monday 2026-11-02.
    const inEuro = fy2026Q2("INCOME", "2026-10-06", FY2026_Q2.INCOME, {
      filingDate: "2026-10-05",
      reportedCurrency: "EUR",
      contentHash: "restated-in-eur",
    });
    const backInDollars = fy2026Q2("INCOME", "2026-11-02", FY2026_Q2.INCOME, {
      filingDate: "2026-11-01",
      contentHash: "restated-in-usd",
    });
    const before = materialize([...OPENING, ...NEW_QUARTER]);
    const states = materialize([
      ...OPENING,
      ...NEW_QUARTER,
      inEuro,
      backInDollars,
    ]);

    // Every session before the revision is byte-for-byte what it was without it.
    expect(
      JSON.stringify(states.filter((each) => each.date < "2026-10-06")),
    ).toBe(JSON.stringify(before.filter((each) => each.date < "2026-10-06")));
    for (const state of states) {
      if (state.date < "2026-08-03") {
        continue;
      }
      if (state.date >= "2026-10-06" && state.date < "2026-11-02") {
        // An EUR quarter inside a USD window: every Income-window metric is unavailable, and the
        // stale USD reading is not carried through.
        expect(state, state.date).not.toHaveProperty("grossMarginTtm");
        expect(state, state.date).not.toHaveProperty("revenueGrowthTtmYoy");
        expect(state, state.date).not.toHaveProperty("roeTtm");
        // Balance-sheet-only metrics are untouched.
        expect(state.debtToEquity, state.date).toBe(0.4);
      } else {
        expect(state.grossMarginTtm, state.date).toBeCloseTo(
          (309 / 620) * 100,
          10,
        );
      }
    }
  });

  it("drops only an out-of-range metric from its event, and restores it later", () => {
    // Restated FY2026 Q2 income: interest expense collapses to one unit against an EBIT of 10^12
    // over the window, so coverage cannot be stored from 2026-09-15 until the 2026-10-15
    // restatement.
    const collapsed = fy2026Q2(
      "INCOME",
      "2026-09-15",
      { ...FY2026_Q2.INCOME, ebit: 1e12 - 111, interestExpense: -9 },
      { filingDate: "2026-09-14", contentHash: "collapsed-interest" },
    );
    const restored = fy2026Q2("INCOME", "2026-10-15", FY2026_Q2.INCOME, {
      filingDate: "2026-10-14",
      contentHash: "restored-interest",
    });
    const states = materialize([
      ...OPENING,
      ...NEW_QUARTER,
      collapsed,
      restored,
    ]);

    // Window FY2025 Q3..FY2026 Q2: interest 3 + 3 + 4 + -9 = 1 and EBIT
    // 30 + 47 + 34 + (10^12 - 111) = 10^12, which needs a thirteenth integer digit.
    for (const state of states) {
      if (state.date >= "2026-09-15" && state.date < "2026-10-15") {
        expect(state, state.date).not.toHaveProperty("interestCoverageTtm");
        expect(Object.keys(state), state.date).toHaveLength(1 + 14);
      } else if (state.date >= "2026-08-03") {
        expect(state.interestCoverageTtm, state.date).toBeCloseTo(
          (30 + 47 + 34 + 36) / (3 + 3 + 4 + 4),
          10,
        );
      }
    }
  });
});

describe("determinism, purity and coverage", () => {
  const statements = [...OPENING, ...NEW_QUARTER];

  it("produces identical output on every run and for every statement ordering", () => {
    const expected = materialize(statements);

    expect(materialize(statements)).toEqual(expected);
    for (const seed of [2, 17, 99]) {
      expect(materialize(shuffled(statements, seed))).toEqual(expected);
    }
  });

  it("never mutates or reorders the caller's arrays", () => {
    const frozenStatements = deepFrozen(statements);
    const frozenDates = deepFrozen(shuffled(AXIS, 5));
    const datesBefore = [...frozenDates];

    expect(materialize(frozenStatements, frozenDates)).toEqual(
      materialize(statements),
    );
    expect(frozenDates).toEqual(datesBefore);
  });

  it("gives every row its own object, so no later write can alias an earlier day", () => {
    const states = materialize(statements);

    expect(new Set(states).size).toBe(states.length);
  });

  it("materializes every one of the fifteen metrics non-null on a complete fixture", () => {
    const states = materialize(statements);

    for (const metric of FUNDAMENTAL_METRICS) {
      expect(
        states.filter((state) => state[metric.field] !== undefined).length,
        metric.id,
      ).toBe(AXIS.length);
    }
  });
});

describe("long-history shape", () => {
  /**
   * Thirty-seven fiscal years of quarterly and annual statements (thirty visible plus the seven
   * retained warm-up years), a restatement every few years, and thirty years of weekday sessions.
   */
  function longHistory(): FinancialStatement[] {
    const rows: FinancialStatement[] = [];
    for (let fiscalYear = 1989; fiscalYear <= 2025; fiscalYear += 1) {
      const growth = 1 + (fiscalYear - 1989) * 0.03;
      quartersOf(fiscalYear).forEach((each, index) => {
        // Filed about six weeks after the period end.
        const month = [5, 8, 11, 2][index]!;
        const filedYear = index === 3 ? fiscalYear + 1 : fiscalYear;
        const available = `${filedYear}-${String(month).padStart(2, "0")}-15`;
        const scale = growth * (1 + index * 0.01);
        rows.push(
          statement(
            "INCOME",
            each,
            {
              revenue: 1_000 * scale,
              grossProfit: 400 * scale,
              operatingIncome: 150 * scale,
              netIncome: 100 * scale,
              epsDiluted: Number((1.5 * scale).toFixed(2)),
              ebitda: 220 * scale,
              ebit: 160 * scale,
              interestExpense: 12,
            },
            available,
          ),
          statement(
            "CASH_FLOW",
            each,
            { operatingCashFlow: 180 * scale, capitalExpenditure: -60 * scale },
            available,
          ),
          statement(
            "BALANCE_SHEET",
            each,
            {
              totalDebt: 800,
              totalStockholdersEquity: 1_500 * growth,
              cashAndShortTermInvestments: 300,
              totalAssets: 4_000 * growth,
              totalCurrentAssets: 1_200,
              totalCurrentLiabilities: 900,
              netDebt: 500,
            },
            available,
          ),
        );
        if (each.period === "Q2" && fiscalYear % 4 === 0) {
          // A later restatement of the same fiscal identity.
          rows.push(
            statement(
              "INCOME",
              each,
              { ...(rows.at(-3)!.values as Values), revenue: 1_010 * scale },
              `${fiscalYear + 1}-03-02`,
              { contentHash: `restated-${fiscalYear}` },
            ),
          );
        }
      });
      rows.push(
        statement(
          "INCOME",
          { fiscalYear, period: "FY" },
          { revenue: 4_100 * growth },
          `${fiscalYear + 1}-03-01`,
        ),
      );
    }
    return rows;
  }

  it("materializes thirty years in one pass with one evaluation per statement event", () => {
    const statements = longHistory();
    const axis = weekdays("1996-01-02", "2025-12-31");
    const plan = planFundamentalEvaluationDates({
      securityId: SECURITY_ID,
      tradingDates: axis,
      statements,
    });

    evaluations.mockClear();
    const states = materializeDailyFundamentals({
      securityId: SECURITY_ID,
      tradingDates: axis,
      statements,
    });

    expect(states).toHaveLength(axis.length);
    expect(axis.length).toBeGreaterThan(7_500);
    // A handful of events per year, never one per trading day.
    expect(plan.length).toBeLessThan(200);
    expect(evaluations).toHaveBeenCalledTimes(plan.length);
    for (const metric of FUNDAMENTAL_METRICS) {
      expect(
        states.every((state) => state[metric.field] !== undefined),
        metric.id,
      ).toBe(true);
    }
  });
});
