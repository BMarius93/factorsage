import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import { ComparisonScenarios } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  summarizeInvariants,
  validateRunInvariants,
  type EvidenceEquity,
  type EvidencePosition,
  type EvidenceTrade,
  type InvariantResult,
  type RunEvidence,
} from "./matrix-invariants";

/**
 * Negative tests: the validator must *reject* a deliberate difference.
 *
 * A validator is only worth what it refuses. These are the differences a reviewer found the
 * two-decimal tolerances would have absorbed — `sumEpsilon` allowed $909.17 across the matrix's
 * 181,831 trades, the `1e-7` relative term allowed $33,431.07 at the largest observed portfolio,
 * and `averageCostEpsilon` re-created the same 29.77 window at the $1 configuration that the whole
 * persistence change existed to close.
 *
 * Every case here perturbs one persisted value by a known amount and requires a FAIL. None of them
 * may be answered with INDETERMINATE: a numeric contradiction is not an unanswerable question.
 */

const SECURITY = "sec-1";

const SNAPSHOT = {
  securities: [
    {
      securityId: SECURITY,
      symbol: "AAA",
      name: "AAA Inc.",
      exchangeCode: "NASDAQ",
      currency: "USD",
      buyWindowMode: "FULL",
      buyWindows: [],
    },
  ],
  strategy: {
    definition: {
      buyLevels: [{ id: "b100", percentage: 100 }],
      sellLevels: [{ id: "s50", percentage: 50 }],
      finalExit: null,
    },
  },
} as unknown as BacktestRunSnapshot;

const CALENDAR = ["2026-01-02", "2026-01-05"];

/** A small, exactly reconcilable run: 100 shares at 50, then half sold at 60. */
function baseline(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId: "run-1",
    caseId: "PRECISION",
    status: "COMPLETED",
    failureCode: null,
    failureMessage: null,
    failurePhase: null,
    snapshot: SNAPSHOT,
    startDate: "2026-01-01",
    endDate: "2026-01-05",
    initialCapital: "100000.000000",
    monthlyContribution: "0.000000",
    maximumPositions: 20,
    summary: {
      firstSimulatedDate: "2026-01-02",
      lastSimulatedDate: "2026-01-05",
      tradingDays: 2,
      investedCapital: "100000.000000",
      finalCash: "98000.000000",
      finalPositionsValue: "3000.000000",
      finalValue: "101000.000000",
      netProfit: "1000.000000",
      realizedPnl: "500.000000",
      unrealizedPnl: "500.000000",
      totalTrades: 2,
      buyTrades: 1,
      sellTrades: 1,
      finalExitTrades: 0,
      winningTrades: 1,
      losingTrades: 0,
      openPositions: 1,
    },
    equity: [
      {
        date: "2026-01-02",
        cash: "95000.000000",
        positionsValue: "5000.000000",
        totalValue: "100000.000000",
        investedCapital: "100000.000000",
        benchmarkValue: "100000.000000",
        cashBaselineValue: "100000.000000",
        openPositions: 1,
      },
      {
        date: "2026-01-05",
        cash: "98000.000000",
        positionsValue: "3000.000000",
        totalValue: "101000.000000",
        investedCapital: "100000.000000",
        benchmarkValue: "110000.000000",
        cashBaselineValue: "100000.000000",
        openPositions: 1,
      },
    ],
    trades: [
      {
        sequence: 1,
        date: "2026-01-02",
        securityId: SECURITY,
        symbol: "AAA",
        action: "BUY",
        levelId: "b100",
        levelPercentage: 100,
        shares: "100.0000000000",
        price: "50.00000000",
        amount: "5000.000000",
        fees: "0.000000",
        realizedPnl: null,
        cashAfter: "95000.000000",
        sharesAfter: "100.0000000000",
        averageCostAfter: "50.00000000",
      },
      {
        sequence: 2,
        date: "2026-01-05",
        securityId: SECURITY,
        symbol: "AAA",
        action: "SELL",
        levelId: "s50",
        levelPercentage: 50,
        shares: "50.0000000000",
        price: "60.00000000",
        amount: "3000.000000",
        fees: "0.000000",
        realizedPnl: "500.000000",
        cashAfter: "98000.000000",
        sharesAfter: "50.0000000000",
        averageCostAfter: "50.00000000",
      },
    ],
    positions: [
      {
        securityId: SECURITY,
        symbol: "AAA",
        openedDate: "2026-01-02",
        shares: "50.0000000000",
        averageCost: "50.00000000",
        lastPrice: "60.00000000",
        marketValue: "3000.000000",
        unrealizedPnl: "500.000000",
      },
    ],
    executionCalendarDates: CALENDAR,
    benchmarkCloses: [
      { date: "2026-01-02", close: "100.00000000" },
      { date: "2026-01-05", close: "110.00000000" },
    ],
    firstPriceDateBySecurityId: new Map([[SECURITY, "2020-01-02"]]),
    ...overrides,
  };
}

const byId = (r: readonly InvariantResult[], id: number): InvariantResult =>
  r.find((e) => e.id === id) as InvariantResult;

/** A rejection must be a FAIL. INDETERMINATE would be dressing a contradiction as a question. */
function expectRejected(results: readonly InvariantResult[], id: number): void {
  expect(byId(results, id).status).toBe("FAIL");
  expect(byId(results, id).status).not.toBe("INDETERMINATE");
}

describe("the baseline is exactly reconcilable", () => {
  it("passes every invariant persisted evidence can settle", () => {
    const results = validateRunInvariants(baseline());
    expect(results.filter((r) => r.status === "FAIL")).toEqual([]);
    expect(results.filter((r) => r.status === "INDETERMINATE")).toEqual([]);
    expect(summarizeInvariants(results).needsArchive).toBe(2);
  });
});

describe("one money ULP — 0.000001 — where equality is required", () => {
  const perturb = (field: keyof EvidenceEquity, value: string) =>
    baseline({
      equity: [
        baseline().equity[0] as EvidenceEquity,
        { ...(baseline().equity[1] as EvidenceEquity), [field]: value },
      ],
    });

  it("rejects a one-ULP break in cash + positionsValue == totalValue", () => {
    expectRejected(
      validateRunInvariants(perturb("totalValue", "101000.000001")),
      9,
    );
  });

  it("rejects a one-ULP break in the cash baseline against the funding schedule", () => {
    expectRejected(
      validateRunInvariants(perturb("cashBaselineValue", "100000.000001")),
      15,
    );
  });

  it("rejects a one-ULP break in the canonical trade amount", () => {
    const results = validateRunInvariants(
      baseline({
        trades: [
          baseline().trades[0] as EvidenceTrade,
          { ...(baseline().trades[1] as EvidenceTrade), amount: "3000.000001" },
        ],
      }),
    );
    expectRejected(results, 10);
  });

  it("rejects a one-ULP break in a cash transition", () => {
    const results = validateRunInvariants(
      baseline({
        trades: [
          baseline().trades[0] as EvidenceTrade,
          {
            ...(baseline().trades[1] as EvidenceTrade),
            cashAfter: "98000.000001",
          },
        ],
      }),
    );
    // cashAfter must equal cashBefore + amount exactly.
    expect(results.some((r) => r.status === "FAIL")).toBe(true);
  });

  it("rejects a one-ULP break in summary final value against the last equity row", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            finalValue: "101000.000001",
          },
        }),
      ),
      32,
    );
  });
});

describe("a cent, and a dollar", () => {
  it("rejects 0.01 on the realized-P&L sum", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            realizedPnl: "500.010000",
          },
        }),
      ),
      29,
    );
  });

  it("rejects $1 on the realized-P&L sum", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            realizedPnl: "501.000000",
          },
        }),
      ),
      29,
    );
  });

  it("rejects $1 on invested capital", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            investedCapital: "100001.000000",
          },
        }),
      ),
      33,
    );
  });

  it("rejects 0.01 between final positions and the final equity positionsValue", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          positions: [
            {
              ...(baseline().positions[0] as EvidencePosition),
              marketValue: "3000.010000",
            },
          ],
        }),
      ),
      31,
    );
  });
});

describe("a relative error at C08 magnitude", () => {
  /**
   * The `1e-7` relative term allowed $33,431.07 at the largest portfolio the matrix produced.
   * A $1,000 discrepancy there is four hundred times a cent and must not be absorbed.
   */
  const HUGE = "334310721745.960000";
  const huge = (overrides: Partial<RunEvidence> = {}): RunEvidence =>
    baseline({
      initialCapital: HUGE,
      equity: [
        {
          date: "2026-01-02",
          cash: HUGE,
          positionsValue: "0.000000",
          totalValue: HUGE,
          investedCapital: HUGE,
          benchmarkValue: HUGE,
          cashBaselineValue: HUGE,
          openPositions: 0,
        },
        {
          date: "2026-01-05",
          cash: HUGE,
          positionsValue: "0.000000",
          totalValue: HUGE,
          investedCapital: HUGE,
          benchmarkValue: HUGE,
          cashBaselineValue: HUGE,
          openPositions: 0,
        },
      ],
      trades: [],
      positions: [],
      benchmarkCloses: [
        { date: "2026-01-02", close: "100.00000000" },
        { date: "2026-01-05", close: "100.00000000" },
      ],
      summary: {
        firstSimulatedDate: "2026-01-02",
        lastSimulatedDate: "2026-01-05",
        tradingDays: 2,
        investedCapital: HUGE,
        finalCash: HUGE,
        finalPositionsValue: "0.000000",
        finalValue: HUGE,
        netProfit: "0.000000",
        realizedPnl: "0.000000",
        unrealizedPnl: "0.000000",
        totalTrades: 0,
        buyTrades: 0,
        sellTrades: 0,
        finalExitTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        openPositions: 0,
      },
      ...overrides,
    });

  it("passes when the huge run is exactly consistent", () => {
    expect(
      validateRunInvariants(huge()).filter((r) => r.status === "FAIL"),
    ).toEqual([]);
  });

  it("rejects $1,000 at $334bn, which the 1e-7 relative term would have absorbed", () => {
    const results = validateRunInvariants(
      huge({
        summary: {
          ...(huge().summary as NonNullable<RunEvidence["summary"]>),
          finalValue: "334310722745.960000",
        },
      }),
    );
    expectRejected(results, 32);
  });

  it("rejects $1,000 on invested capital at $334bn", () => {
    const results = validateRunInvariants(
      huge({
        summary: {
          ...(huge().summary as NonNullable<RunEvidence["summary"]>),
          investedCapital: "334310722745.960000",
        },
      }),
    );
    expectRejected(results, 33);
  });

  it("rejects one ULP at $334bn on the equity identity", () => {
    const results = validateRunInvariants(
      huge({
        equity: [
          huge().equity[0] as EvidenceEquity,
          {
            ...(huge().equity[1] as EvidenceEquity),
            totalValue: "334310721745.960001",
          },
        ],
      }),
    );
    expectRejected(results, 9);
  });
});

describe("counts and signs", () => {
  it("rejects a winner count the persisted rows do not support", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            winningTrades: 2,
          },
        }),
      ),
      34,
    );
  });

  it("rejects a loser count the persisted rows do not support", () => {
    expectRejected(
      validateRunInvariants(
        baseline({
          summary: {
            ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
            losingTrades: 1,
          },
        }),
      ),
      34,
    );
  });

  it("rejects a sign flip of one money ULP that changes the classification", () => {
    // -0.000001 is a loss. A summary still calling it a win is a contradiction.
    const results = validateRunInvariants(
      baseline({
        trades: [
          baseline().trades[0] as EvidenceTrade,
          {
            ...(baseline().trades[1] as EvidenceTrade),
            realizedPnl: "-0.000001",
          },
        ],
        summary: {
          ...(baseline().summary as NonNullable<RunEvidence["summary"]>),
          realizedPnl: "-0.000001",
          winningTrades: 1,
          losingTrades: 0,
        },
      }),
    );
    expectRejected(results, 34);
  });
});

describe("negative cash at the first representable money unit", () => {
  it("rejects cash of -0.000001", () => {
    const results = validateRunInvariants(
      baseline({
        equity: [
          { ...(baseline().equity[0] as EvidenceEquity), cash: "-0.000001" },
          baseline().equity[1] as EvidenceEquity,
        ],
      }),
    );
    expectRejected(results, 6);
  });
});

describe("average cost at the $1 configuration", () => {
  it("rejects a basis error far smaller than the old 29.77 window", () => {
    // averageCostEpsilon was 0.005 / shares, which at 0.0001679656 shares is 29.77 — wide enough
    // to accept a basis of 178 for a stock that closed at 148.84.
    const results = validateRunInvariants(
      baseline({
        initialCapital: "1.000000",
        trades: [
          {
            ...(baseline().trades[0] as EvidenceTrade),
            shares: "0.0001679656",
            price: "148.84000000",
            amount: "0.025000",
            cashAfter: "0.975000",
            sharesAfter: "0.0001679656",
            averageCostAfter: "178.60800069",
          },
        ],
        equity: [
          {
            date: "2026-01-02",
            cash: "0.975000",
            positionsValue: "0.025000",
            totalValue: "1.000000",
            investedCapital: "1.000000",
            benchmarkValue: "1.000000",
            cashBaselineValue: "1.000000",
            openPositions: 1,
          },
          {
            date: "2026-01-05",
            cash: "0.975000",
            positionsValue: "0.025000",
            totalValue: "1.000000",
            investedCapital: "1.000000",
            benchmarkValue: "1.100000",
            cashBaselineValue: "1.000000",
            openPositions: 1,
          },
        ],
        positions: [
          {
            securityId: SECURITY,
            symbol: "AAA",
            openedDate: "2026-01-02",
            shares: "0.0001679656",
            averageCost: "148.84000057",
            lastPrice: "148.84000000",
            marketValue: "0.025000",
            unrealizedPnl: "0.000000",
          },
        ],
        summary: null,
      }),
    );
    expectRejected(results, 28);
  });
});

/**
 * The benchmark reconstruction, pinned to the engine's own class rather than to a reading of it.
 *
 * Invariant 17 is only an equality if the validator models what `ComparisonScenarios` actually
 * does — truncating each purchase to the share scale, marking at a close rounded to the price
 * scale. Asserting that against hand-computed numbers would prove the arithmetic and not the
 * model, so the fixture's benchmark column is produced *by the class itself* and the validator has
 * to agree with it exactly.
 *
 * This is also the tripwire for the residual the scenario currently discards: when that behaviour
 * changes, the engine and this validator have to change together or this test says so.
 */
describe("the funded benchmark, against the engine's own scenario", () => {
  const CLOSES = [
    "412.19000000",
    "398.77500000",
    "401.00500000",
    "417.33000000",
    "399.99900000",
    "433.87000000",
  ];
  const DATES = [
    "2026-01-02",
    "2026-02-02",
    "2026-03-02",
    "2026-04-01",
    "2026-05-01",
    "2026-06-01",
  ];
  const INITIAL = "12345.670000";
  const MONTHLY = "789.010000";

  /** Every benchmark value the run would record, straight out of the engine. */
  function engineBenchmarkValues(): string[] {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(Number(INITIAL));
    return DATES.map((_, index) => {
      if (index > 0) {
        scenarios.fund(Number(MONTHLY));
      }
      const value = scenarios.markBenchmark(Number(CLOSES[index] as string));
      return (value as { toFixed(places: number): string }).toFixed(6);
    });
  }

  const funded = (benchmarkValues: readonly string[]): RunEvidence => {
    const cashBaseline = (index: number): string =>
      (Number(INITIAL) + index * Number(MONTHLY)).toFixed(6);
    return baseline({
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      initialCapital: INITIAL,
      monthlyContribution: MONTHLY,
      executionCalendarDates: DATES,
      trades: [],
      positions: [],
      summary: null,
      benchmarkCloses: DATES.map((date, index) => ({
        date,
        close: CLOSES[index] as string,
      })),
      equity: DATES.map((date, index) => ({
        date,
        cash: cashBaseline(index),
        positionsValue: "0.000000",
        totalValue: cashBaseline(index),
        investedCapital: cashBaseline(index),
        benchmarkValue: benchmarkValues[index] as string,
        cashBaselineValue: cashBaseline(index),
        openPositions: 0,
      })),
    });
  };

  it("agrees with ComparisonScenarios to the last digit", () => {
    const values = engineBenchmarkValues();
    // Non-vacuous: fractional share truncation has to actually bite somewhere in this series.
    expect(values.some((value) => !value.endsWith("0000"))).toBe(true);
    const results = validateRunInvariants(funded(values));
    expect(byId(results, 17).status).toBe("PASS");
    expect(byId(results, 16).status).toBe("PASS");
  });

  it("rejects a benchmark value one money unit away from the engine's", () => {
    const values = engineBenchmarkValues();
    const nudged = [...values];
    const last = values.length - 1;
    nudged[last] = (Number(values[last] as string) + 0.000001).toFixed(6);
    expect(byId(validateRunInvariants(funded(nudged)), 17).status).toBe("FAIL");
  });
});
