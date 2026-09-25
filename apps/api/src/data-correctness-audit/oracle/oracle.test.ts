import { describe, expect, it } from "vitest";
import { prismaFloatBoundAtScale, storedAtScale } from "./decimal";
import {
  exponentialMovingAverage,
  isoWeekStart,
  referenceIndicators,
  simpleMovingAverage,
  wilderRsi,
} from "./indicators";
import {
  BLEND_WEIGHTS,
  dcfFcff,
  dividendDiscount,
  graham,
  residualIncome,
  valueOn,
  type OracleStatement,
} from "./intrinsic";
import { compare, cross, and, or, signalValue } from "./predicates";
import {
  compoundAnnualGrowth,
  referenceAnnualReturns,
  runReferenceBacktest,
} from "./reference-backtester";
import {
  oracleAlternativeDataColumn,
  oracleAvailabilityDate,
  oracleCongressEligible,
  oracleCongressKind,
  oracleDisclosedAmount,
  oracleInsiderCategory,
  oracleInsiderTransactionValue,
  oracleObservableSession,
} from "./alternative-data";
import { oracleRelativeVolume } from "./relative-volume";
import { oracleSessionClose } from "./sessions";
import { parseOracleStrategy } from "./strategy-model";

/**
 * The oracle is only worth something if it is right on its own terms. Every expectation here is
 * hand-computed or published outside this repository — none is produced by production code.
 */

describe("reference session clock", () => {
  it("closes a session at 16:00 New York, in both offsets", () => {
    // Published exchange hours: 09:30-16:00 Eastern. EDT is UTC-4, EST is UTC-5.
    expect(oracleSessionClose("2026-09-15")).toBe("2026-09-15T20:00:00.000Z");
    expect(oracleSessionClose("2026-01-15")).toBe("2026-01-15T21:00:00.000Z");
    // The 2026 transitions: 8 March and 1 November, both at 02:00 local.
    expect(oracleSessionClose("2026-03-07")).toBe("2026-03-07T21:00:00.000Z");
    expect(oracleSessionClose("2026-03-08")).toBe("2026-03-08T20:00:00.000Z");
    expect(oracleSessionClose("2026-10-31")).toBe("2026-10-31T20:00:00.000Z");
    expect(oracleSessionClose("2026-11-01")).toBe("2026-11-01T21:00:00.000Z");
  });
});

describe("reference predicates (ai/product/strategies.md)", () => {
  it("is above / is below are strict", () => {
    expect(compare("IS_ABOVE", 10, 10)).toBe("FALSE");
    expect(compare("IS_ABOVE", 10.000001, 10)).toBe("TRUE");
    expect(compare("IS_BELOW", 10, 10)).toBe("FALSE");
    expect(compare("IS_BELOW", 9.999999, 10)).toBe("TRUE");
  });

  it("is close to is within 2% of the value, inclusive, and undecidable at a zero value", () => {
    expect(compare("IS_CLOSE_TO", 102, 100)).toBe("TRUE");
    expect(compare("IS_CLOSE_TO", 98, 100)).toBe("TRUE");
    expect(compare("IS_CLOSE_TO", 102.01, 100)).toBe("FALSE");
    expect(compare("IS_CLOSE_TO", 0.5, 0)).toBe("NOT_EVALUABLE");
  });

  it("crosses need both the current and the previous reading", () => {
    expect(cross("CROSSES_ABOVE", 11, 10, 10, 10)).toBe("TRUE");
    expect(cross("CROSSES_ABOVE", 11, 10, 11, 10)).toBe("FALSE");
    expect(cross("CROSSES_BELOW", 9, 10, 10, 10)).toBe("TRUE");
    expect(cross("CROSSES_ABOVE", 11, 10, Number.NaN, 10)).toBe(
      "NOT_EVALUABLE",
    );
  });

  it("combines with Kleene AND and OR", () => {
    expect(and(["TRUE", "NOT_EVALUABLE"])).toBe("NOT_EVALUABLE");
    expect(and(["FALSE", "NOT_EVALUABLE"])).toBe("FALSE");
    expect(and([])).toBe("TRUE");
    expect(or(["FALSE", "NOT_EVALUABLE"])).toBe("NOT_EVALUABLE");
    expect(or(["TRUE", "NOT_EVALUABLE"])).toBe("TRUE");
  });

  it("never evaluates a Gain condition without a position", () => {
    const strategy = parseOracleStrategy({
      buyLevels: [],
      sellLevels: [
        {
          id: "s",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c",
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 10 },
              },
            ],
          },
        },
      ],
    });
    const row = {
      date: "2024-01-02",
      close: 10,
      values: new Map<string, number>(),
    };
    expect(signalValue(strategy.sellLevels[0]!.signal, row, null, null)).toBe(
      "NOT_EVALUABLE",
    );
    expect(
      signalValue(strategy.sellLevels[0]!.signal, row, null, {
        gain: 10.5,
        previousGain: Number.NaN,
      }),
    ).toBe("TRUE");
  });
});

describe("reference indicators", () => {
  it("SMA and EMA on a hand example", () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    // Seed 2 (SMA of 1,2,3), alpha 0.5: 2 + 0.5 (4 - 2) = 3, then 3 + 0.5 (5 - 3) = 4.
    expect(exponentialMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
  });

  it("reproduces Wilder's published RSI(14) example (70.46, 66.25)", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
      46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
      43.42, 42.66, 43.13,
    ];
    const rsi = wilderRsi(closes, 14);
    expect(rsi.slice(0, 14).every((value) => value === null)).toBe(true);
    expect(rsi[14]).toBeCloseTo(70.46, 2);
    expect(rsi[15]).toBeCloseTo(66.25, 2);
  });

  it("reads 50 on a flat series and 100 on only gains", () => {
    expect(wilderRsi([5, 5, 5, 5], 3)[3]).toBe(50);
    expect(wilderRsi([1, 2, 3, 4], 3)[3]).toBe(100);
  });

  it("makes a completed week effective on its own last trading day only", () => {
    // Week of 2024-03-25 ends on Thursday 28th (Good Friday); week of 2024-04-01 is in progress at asOf.
    const rows = [
      { date: "2024-03-18", close: 1 },
      { date: "2024-03-22", close: 2 },
      { date: "2024-03-25", close: 3 },
      { date: "2024-03-28", close: 4 },
      { date: "2024-04-01", close: 5 },
    ];
    const { weekStart } = referenceIndicators(rows, {
      asOf: "2024-04-02",
      dropFirstWeek: null,
    });
    expect(weekStart).toEqual([
      null,
      "2024-03-18",
      "2024-03-18",
      "2024-03-25",
      "2024-03-25",
    ]);
    expect(isoWeekStart("2024-03-31")).toBe("2024-03-25");
  });
});

describe("reference intrinsic value (docs/decisions/intrinsic-value-engine.md golden vectors)", () => {
  it("DCF_FCFF 178.8977101328", () => {
    const result = dcfFcff({
      operatingCashFlowTtm: 120,
      capitalExpenditureTtm: -20,
      interestExpenseTtm: 10,
      growthUsed: 0.05,
      cash: 50,
      debt: 30,
      shares: 10,
    });
    expect("value" in result && result.value).toBeCloseTo(178.8977101328, 9);
  });

  it("RESIDUAL_INCOME 99.1837933641, DDM 27.3333333333, GRAHAM 148", () => {
    const ri = residualIncome({
      netIncomeTtm: 80,
      bookValue: 500,
      shares: 10,
      growthUsed: 0.05,
    });
    expect("value" in ri && ri.value).toBeCloseTo(99.1837933641, 9);
    const ddm = dividendDiscount(2);
    expect("value" in ddm && ddm.value).toBeCloseTo(27.3333333333, 9);
    const g = graham(8, 0.05);
    expect("value" in g && g.value).toBeCloseTo(148, 10);
  });

  it("blends BALANCED 148.8039930756, CONSERVATIVE 145.7142220623, DIVIDEND 102.3291760593", () => {
    const models = {
      DCF_FCFF: 178.8977101328,
      RESIDUAL_INCOME: 99.1837933641,
      DDM: 27.3333333333,
      GRAHAM: 148,
    };
    const blend = (
      weights: Partial<Record<keyof typeof models, number>>,
    ): number =>
      Object.entries(weights).reduce(
        (sum, [model, weight]) =>
          sum + weight! * models[model as keyof typeof models],
        0,
      );
    expect(blend(BLEND_WEIGHTS.BALANCED)).toBeCloseTo(148.8039930756, 9);
    expect(blend(BLEND_WEIGHTS.CONSERVATIVE)).toBeCloseTo(145.7142220623, 9);
    expect(blend(BLEND_WEIGHTS.DIVIDEND)).toBeCloseTo(102.3291760593, 9);
  });

  it("uses only statements available on the valuation date, and needs four consecutive quarters", () => {
    const quarter = (
      fiscalYear: number,
      period: "Q1" | "Q2" | "Q3" | "Q4",
      available: string,
      eps: number,
    ): OracleStatement => ({
      statementType: "INCOME",
      fiscalYear,
      period,
      fiscalDate: available,
      filingDate: available,
      availableFromDate: available,
      observedAt: "2026-01-01T00:00:00.000000",
      contentHash: `${fiscalYear}${period}`,
      reportedCurrency: "USD",
      values: { epsDiluted: eps, netIncome: 1, weightedAverageShsOutDil: 1 },
    });
    const statements = [
      quarter(2023, "Q1", "2023-05-01", 1),
      quarter(2023, "Q2", "2023-08-01", 1),
      quarter(2023, "Q3", "2023-11-01", 1),
      quarter(2023, "Q4", "2024-02-01", 2),
    ];
    expect(valueOn(statements, "2024-01-31").models.GRAHAM).toMatchObject({
      status: "NOT_APPLICABLE",
      reason: "MISSING_TTM_WINDOW",
    });
    // EPS 1+1+1+2 = 5, default growth 5%: 5 x (8.5 + 10) = 92.5, sourced from the latest availability.
    expect(valueOn(statements, "2024-02-01").models.GRAHAM).toMatchObject({
      status: "VALUE",
      value: 92.5,
      sourceAsOf: "2024-02-01",
    });
  });
});

describe("reference backtester on a hand-computed run", () => {
  const strategy = parseOracleStrategy({
    buyLevels: [
      {
        id: "b",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 9 },
            },
          ],
        },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "x",
      rules: [
        {
          id: "r",
          signal: {
            conditions: [
              {
                id: "c2",
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 15 },
              },
            ],
          },
        },
      ],
    },
  });
  const row = (date: string, close: number) => ({
    date,
    close,
    values: new Map<string, number>(),
  });

  it("buys the full budget, exits on Gain, re-enters the next date, liquidates on the last", () => {
    const result = runReferenceBacktest({
      strategy,
      securities: [
        {
          securityId: "s1",
          symbol: "AAA",
          buyWindowMode: "FULL",
          buyWindows: [],
          rows: [
            row("2024-01-02", 10),
            row("2024-01-03", 12),
            row("2024-01-04", 11.6),
            row("2024-01-05", 11),
          ],
        },
      ],
      calendar: ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"],
      startDate: "2024-01-02",
      endDate: "2024-01-05",
      initialCapital: 1000,
      monthlyContribution: 0,
      maximumPositions: 1,
      benchmark: { dates: ["2024-01-02", "2024-01-05"], closes: [100, 110] },
    });
    // Day 1: 1000 / 10 = 100 shares. Day 2: Gain 20% > 15% -> FINAL EXIT at 12 = 1200; no same-day
    // re-entry. Day 3: price 11.6 > 9 -> 1200 / 11.6 = 103.4482758620 shares (truncated) for
    // 1199.9999999992, rounded half-up to 1200.000000 (equal to the cash, so it stands). Day 4:
    // Gain -5.17% -> hold; the last day liquidates at 11: 1137.931034482 -> 1137.931034.
    expect(
      result.trades.map((trade) => [
        trade.date,
        trade.action,
        trade.source,
        trade.shares,
        trade.amount,
        trade.cashAfter,
      ]),
    ).toEqual([
      [
        "2024-01-02",
        "BUY",
        "STRATEGY",
        "100.0000000000",
        "1000.000000",
        "0.000000",
      ],
      [
        "2024-01-03",
        "FINAL_EXIT",
        "STRATEGY",
        "100.0000000000",
        "1200.000000",
        "1200.000000",
      ],
      [
        "2024-01-04",
        "BUY",
        "STRATEGY",
        "103.4482758620",
        "1200.000000",
        "0.000000",
      ],
      [
        "2024-01-05",
        "SELL",
        "END_OF_BACKTEST",
        "103.4482758620",
        "1137.931034",
        "1137.931034",
      ],
    ]);
    expect(result.summary.finalValue).toBe("1137.931034");
    expect(result.summary.finalPositionsValue).toBe("0.000000");
    // Benchmark: base 100, carried forward until 110 on the 5th.
    expect(result.equity.map((point) => point.benchmarkIndex)).toEqual([
      1, 1, 1, 1.1,
    ]);
    expect(result.summary.portfolioReturnPercent).toBeCloseTo(13.7931034, 6);
  });

  it("annual returns are each year alone and chain to the total", () => {
    const years = referenceAnnualReturns(
      [
        { date: "2023-06-30", returnIndex: 1.1 },
        { date: "2023-12-29", returnIndex: 1.21 },
        { date: "2024-12-31", returnIndex: 1.089 },
      ],
      { startDate: "2023-06-01", endDate: "2024-12-31" },
    );
    expect(
      years.map((year) => [
        year.year,
        Number(year.returnPercent.toFixed(10)),
        year.partial,
      ]),
    ).toEqual([
      ["2023", 21, true],
      ["2024", -10, false],
    ]);
  });

  it("CAGR uses 365.25-day years over the simulated span", () => {
    expect(compoundAnnualGrowth(2, "2020-01-01", "2021-01-01")).toBeCloseTo(
      (Math.pow(2, 365.25 / 366) - 1) * 100,
      10,
    );
    expect(compoundAnnualGrowth(2, "2020-01-01", "2020-01-01")).toBeNull();
  });

  it("models a stored ratio as one rounding, and the old binding as two (AUD-01)", () => {
    // The write path renders the ratio at the column's scale, so the stored value is the float's
    // own correctly rounded value.
    expect(storedAtScale(1.0009891328499996, 10)).toBe("1.0009891328");
    expect(storedAtScale(8.8441117764499992, 10)).toBe("8.8441117764");
    // What the same two floats were stored as before the fix. The first is the one the audit found
    // in the matrix database; the second rounds the same way under both models.
    expect(prismaFloatBoundAtScale(1.0009891328499996, 10)).toBe(
      "1.0009891329",
    );
    expect(prismaFloatBoundAtScale(8.8441117764499992, 10)).toBe(
      "8.8441117764",
    );
  });
});

describe("reference relative volume", () => {
  it("divides the session by the mean of the p sessions strictly before it", () => {
    // Hand-computed: the baseline is 1..4, mean 2.5, and the measured session is 10.
    const values = oracleRelativeVolume([1, 2, 3, 4, 10], 4);
    expect(values.slice(0, 4)).toEqual([null, null, null, null]);
    expect(values[4]!.toString()).toBe("4");
  });

  it("requires the full lookback before any value exists", () => {
    // Eleven observations are needed before `RVOL 10` has one: the first value is at index 10.
    const volumes = Array.from({ length: 12 }, () => 100);
    const values = oracleRelativeVolume(volumes, 10);
    expect(values.slice(0, 10).every((value) => value === null)).toBe(true);
    expect(values[10]!.toString()).toBe("1");
    expect(values[11]!.toString()).toBe("1");
  });

  it("never lets the measured session enter its own baseline", () => {
    // If index 2 were included the baseline would be (10+10+40)/3 = 20 and the value 2. It is not:
    // the baseline is (10+10)/2 = 10 and the value is 4.
    const values = oracleRelativeVolume([10, 10, 40], 2);
    expect(values[2]!.toString()).toBe("4");
  });

  it("has no value where the baseline is entirely zero", () => {
    expect(oracleRelativeVolume([0, 0, 5], 2)[2]).toBeNull();
    // A zero *measured* session against a real baseline is a real reading of zero, not an absence.
    expect(oracleRelativeVolume([10, 10, 0], 2)[2]!.toString()).toBe("0");
  });

  it("has no value while an unusable observation is inside the baseline", () => {
    const values = oracleRelativeVolume([10, null, 10, 10, 10], 2);
    // index 2's baseline holds the null; index 3's still does; index 4's has passed it.
    expect(values[2]).toBeNull();
    expect(values[3]).toBeNull();
    expect(values[4]!.toString()).toBe("1");
  });

  it("reproduces AAPL's first stored RVOL 10 from its own persisted volumes", () => {
    // The real series, read out of the development database. The baseline is the ten sessions
    // 1992-09-11 … 1992-09-24 and the measured session is 1992-09-25; the stored value is
    // 0.89808224 at Decimal(20,8).
    const volumes = [
      179883376, 214681811, 218523416, 178718576, 172435372, 115606512,
      89678487, 111540908, 123972920, 125652924, 137468936,
    ];
    const value = oracleRelativeVolume(volumes, 10)[10]!;
    expect(value.toDecimalPlaces(8).toString()).toBe("0.89808224");
  });
});

describe("reference alternative-data availability", () => {
  it("is the publication date plus one calendar day", () => {
    expect(oracleAvailabilityDate("2026-03-03")).toBe("2026-03-04");
    // Across a month, a year and a leap day.
    expect(oracleAvailabilityDate("2026-01-31")).toBe("2026-02-01");
    expect(oracleAvailabilityDate("2025-12-31")).toBe("2026-01-01");
    expect(oracleAvailabilityDate("2024-02-28")).toBe("2024-02-29");
  });

  it("resolves the observable session as the first session at or after it", () => {
    // Friday 2026-03-06, Monday 2026-03-09: a Saturday filing is first readable on the Monday.
    const dates = ["2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10"];
    expect(oracleObservableSession(dates, "2026-03-07")).toBe(2);
    expect(oracleObservableSession(dates, "2026-03-09")).toBe(2);
    expect(oracleObservableSession(dates, "2026-03-06")).toBe(1);
    // Past the end of the axis there is no session at all.
    expect(oracleObservableSession(dates, "2026-03-11")).toBe(-1);
  });
});

describe("reference alternative-data column", () => {
  const dates = [
    "2026-03-02",
    "2026-03-03",
    "2026-03-04",
    "2026-03-05",
    "2026-03-06",
  ];
  const coverage = { from: "2026-01-01", to: "2026-12-31" };

  it("counts a disclosure only from the session after it was published", () => {
    // Published 2026-03-03, so available 2026-03-04 and first counted on that session.
    const column = oracleAlternativeDataColumn({
      dates,
      lookback: 2,
      aggregation: "EVENT_COUNT",
      coverage,
      observations: [
        { availableFrom: "2026-03-04", actorKey: "A", amount: null },
      ],
    });
    expect(column[0]).toBeNull(); // no complete window
    expect(column[1]!.toString()).toBe("0");
    expect(column[2]!.toString()).toBe("1");
    expect(column[3]!.toString()).toBe("1");
    // Two sessions later the window has moved past it.
    expect(column[4]!.toString()).toBe("0");
  });

  it("counts distinct actors, not rows", () => {
    const observations = [
      { availableFrom: "2026-03-03", actorKey: "A", amount: null },
      { availableFrom: "2026-03-03", actorKey: "A", amount: null },
      { availableFrom: "2026-03-03", actorKey: "B", amount: null },
    ];
    const distinct = oracleAlternativeDataColumn({
      dates,
      lookback: 2,
      aggregation: "DISTINCT_ACTORS",
      coverage,
      observations,
    });
    const events = oracleAlternativeDataColumn({
      dates,
      lookback: 2,
      aggregation: "EVENT_COUNT",
      coverage,
      observations,
    });
    expect(distinct[1]!.toString()).toBe("2");
    expect(events[1]!.toString()).toBe("3");
  });

  it("is absent, never zero, where the window is not wholly inside coverage", () => {
    const column = oracleAlternativeDataColumn({
      dates,
      lookback: 2,
      aggregation: "EVENT_COUNT",
      coverage: { from: "2026-03-04", to: "2026-03-05" },
      observations: [],
    });
    // index 1's window opens on 2026-03-02, before the floor; index 4 is past the ceiling.
    expect(column[1]).toBeNull();
    expect(column[2]).toBeNull();
    expect(column[3]!.toString()).toBe("0");
    expect(column[4]).toBeNull();
  });

  it("sums only the amounts the source states", () => {
    const column = oracleAlternativeDataColumn({
      dates,
      lookback: 3,
      aggregation: "SUM_AMOUNT",
      coverage,
      observations: [
        { availableFrom: "2026-03-03", actorKey: "A", amount: 15_001 },
        { availableFrom: "2026-03-03", actorKey: "B", amount: null },
      ],
    });
    expect(column[2]!.toString()).toBe("15001");
  });

  it("drops a disclosure that became observable before the frame begins", () => {
    // Its observable session is not in this frame, so counting it at index 0 would place it inside
    // windows it was never in.
    const column = oracleAlternativeDataColumn({
      dates,
      lookback: 2,
      aggregation: "EVENT_COUNT",
      coverage,
      observations: [
        { availableFrom: "2026-02-20", actorKey: "A", amount: null },
      ],
    });
    expect(column[1]!.toString()).toBe("0");
  });
});

describe("reference alternative-data classification", () => {
  it("treats only P and S as discretionary open-market trades", () => {
    expect(oracleInsiderCategory("P-Purchase")).toBe("OPEN_MARKET_PURCHASE");
    expect(oracleInsiderCategory("S-Sale")).toBe("OPEN_MARKET_SALE");
    // Published SEC Form 4 codes: A award, G gift, M/X option exercise, C conversion,
    // D/F disposition to the issuer.
    expect(oracleInsiderCategory("A-Award")).toBe("AWARD");
    expect(oracleInsiderCategory("G-Gift")).toBe("GIFT");
    expect(oracleInsiderCategory("M-Exempt")).toBe("OPTION_EXERCISE");
    expect(oracleInsiderCategory("F-InKind")).toBe("DISPOSITION_TO_ISSUER");
    expect(oracleInsiderCategory("")).toBe("OTHER");
    expect(oracleInsiderCategory("Z-Trust")).toBe("OTHER");
  });

  it("gives an unpriced line no value at all", () => {
    // An award the form prices at zero is not a $0 purchase.
    expect(
      oracleInsiderTransactionValue({ securitiesTransacted: 30_104, price: 0 }),
    ).toBeNull();
    expect(
      oracleInsiderTransactionValue({ securitiesTransacted: 100, price: null }),
    ).toBeNull();
    expect(
      oracleInsiderTransactionValue({
        securitiesTransacted: 2_399,
        price: 340.06,
      })!.toString(),
    ).toBe("815803.94");
  });

  it("stores a disclosed band's own bounds and never a midpoint", () => {
    expect(oracleDisclosedAmount("$15,001 - $50,000")).toEqual({
      lower: 15_001,
      upper: 50_000,
    });
    expect(oracleDisclosedAmount("Over $50,000,000")).toEqual({
      lower: 50_000_000,
      upper: null,
    });
    expect(oracleDisclosedAmount("$50,000,001 +")).toEqual({
      lower: 50_000_001,
      upper: null,
    });
    // A band with no readable figure has no bounds rather than bounds of zero.
    expect(oracleDisclosedAmount("Unknown")).toEqual({
      lower: null,
      upper: null,
    });
    expect(oracleDisclosedAmount(null)).toEqual({ lower: null, upper: null });
  });

  it("classifies a partial sale as a sale and admits only common stock", () => {
    expect(oracleCongressKind("Sale (Partial)")).toBe("SALE");
    expect(oracleCongressKind("Sale (Full)")).toBe("SALE");
    expect(oracleCongressKind("Purchase")).toBe("PURCHASE");
    expect(oracleCongressKind("Exchange")).toBe("EXCHANGE");
    expect(oracleCongressEligible("STOCK")).toBe(true);
    expect(oracleCongressEligible("STOCK_OPTION")).toBe(false);
    expect(oracleCongressEligible("BOND")).toBe(false);
  });
});
