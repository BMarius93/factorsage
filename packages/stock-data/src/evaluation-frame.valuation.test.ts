import type { StrategyCondition } from "@intrinsic/contracts";
import type {
  DailyPrice,
  FinancialStatement,
  Security,
} from "@intrinsic/domain";
import {
  Evaluability,
  evaluateMarketCondition,
  PRICE_OPERAND,
  readOperand,
  valuationRatioOperand,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { projectEvaluationFrame } from "./evaluation-frame.js";
import { projectMonitorEvaluationFrame } from "./monitor-frame.js";
import { buildValuationTimeline } from "./valuation-ratios.js";

/**
 * Valuation ratios through the canonical projections: the backtest frame and the Monitor frame read
 * one calculation, and a Condition on an unavailable ratio is NOT_EVALUABLE in both.
 */

const SECURITY: Security = {
  id: "sec-valuation",
  symbol: "VAL",
  name: "Valuation Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

const PE = valuationRatioOperand("PRICE_TO_EARNINGS_TTM");
const PE_BELOW_15: StrategyCondition = {
  id: "pe-below-15",
  metric: { kind: "VALUATION_RATIO", ratioId: "PRICE_TO_EARNINGS_TTM" },
  operator: "IS_BELOW",
  value: { kind: "MULTIPLE", value: 15 },
};

/** Four quarters of 100 diluted shares and net income 5; the fourth public on 2026-02-09. */
const STATEMENTS: FinancialStatement[] = [
  ["2025-03-31", "Q1", "2025-05-09"],
  ["2025-06-30", "Q2", "2025-08-08"],
  ["2025-09-30", "Q3", "2025-11-07"],
  ["2025-12-31", "Q4", "2026-02-09"],
].map(
  ([fiscalDate, period, availableFromDate]) =>
    ({
      securityId: SECURITY.id,
      statementType: "INCOME",
      fiscalDate,
      fiscalYear: 2025,
      period,
      reportedCurrency: "USD",
      filingDate: availableFromDate,
      availableFromDate,
      observedAt: `${availableFromDate}T12:00:00.000Z`,
      contentHash: `${fiscalDate}`,
      values: {
        weightedAverageShsOutDil: 100,
        netIncome: 5,
        revenue: 50,
        ebitda: 10,
      },
    }) as FinancialStatement,
);

const TIMELINE = buildValuationTimeline({
  securityId: SECURITY.id,
  currency: "USD",
  statements: STATEMENTS,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  events: [],
  splits: [],
});

function price(date: string, close: number): DailyPrice {
  return {
    securityId: SECURITY.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

const PRICES = [
  price("2026-02-05", 2),
  price("2026-02-06", 2),
  price("2026-02-09", 2),
  price("2026-02-10", 4),
];

describe("valuation ratios in the backtest frame", () => {
  it("projects each session's ratio from its own close and statements, NaN where unavailable", () => {
    const { frame } = projectEvaluationFrame({
      security: SECURITY,
      prices: PRICES,
      derived: [],
      operands: [PRICE_OPERAND, PE],
      periodStart: "2026-02-05",
      valuation: { timeline: TIMELINE },
    });
    // Three quarters before 2026-02-09: no trailing year yet.
    expect(readOperand(frame, PE, 0)).toBeNaN();
    expect(readOperand(frame, PE, 1)).toBeNaN();
    // Close 2 × 100 shares over net income 20.
    expect(readOperand(frame, PE, 2)).toBeCloseTo(10, 12);
    expect(readOperand(frame, PE, 3)).toBeCloseTo(20, 12);
    expect(evaluateMarketCondition(PE_BELOW_15, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
    expect(evaluateMarketCondition(PE_BELOW_15, frame, 2)).toBe(
      Evaluability.TRUE,
    );
    expect(evaluateMarketCondition(PE_BELOW_15, frame, 3)).toBe(
      Evaluability.FALSE,
    );
  });

  it("refuses a ratio operand without its inputs rather than reading it as unavailable", () => {
    expect(() =>
      projectEvaluationFrame({
        security: SECURITY,
        prices: PRICES,
        derived: [],
        operands: [PRICE_OPERAND, PE],
        periodStart: "2026-02-05",
      }),
    ).toThrow(/valuation ratios without their inputs/);
  });
});

describe("valuation ratios in the Monitor frame", () => {
  it("reads the live quote with the newest closed session's statements on a new session", () => {
    // Closed through 2026-02-06; the provisional session 2026-02-09 is the first the fourth
    // quarter is public. Carried forward, it reads three quarters — no P/E — and agrees with a
    // backtest from the next observation on.
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices: PRICES.slice(0, 2),
      derived: [],
      operands: [PRICE_OPERAND, PE],
      observation: { price: 2.2 },
      observationDate: "2026-02-09",
      valuation: TIMELINE,
    })!;
    expect(readOperand(monitor.frame, PE, monitor.observationIndex)).toBeNaN();

    const next = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices: PRICES.slice(0, 3),
      derived: [],
      operands: [PRICE_OPERAND, PE],
      observation: { price: 2.2 },
      observationDate: "2026-02-10",
      valuation: TIMELINE,
    })!;
    // The live quote is the close: 2.2 × 100 / 20.
    expect(readOperand(next.frame, PE, next.observationIndex)).toBeCloseTo(
      11,
      12,
    );
    expect(
      evaluateMarketCondition(PE_BELOW_15, next.frame, next.observationIndex),
    ).toBe(Evaluability.TRUE);
  });
});

describe("valuation ratios on a Monitor's repriced day and around a listed event", () => {
  it("reads a repriced closed day's own statements", () => {
    // The provider repriced 2026-02-09, the first session the fourth quarter is public: the live
    // observation replaces that closed row and reads its statements, not the day before's.
    const repriced = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices: PRICES.slice(0, 3),
      derived: [],
      operands: [PRICE_OPERAND, PE],
      observation: { price: 2.2 },
      observationDate: "2026-02-09",
      valuation: TIMELINE,
    })!;
    expect(
      readOperand(repriced.frame, PE, repriced.observationIndex),
    ).toBeCloseTo(11, 12);
  });

  it("withholds the provisional session inside a listed event the provider has not re-based", () => {
    const listed = buildValuationTimeline({
      securityId: SECURITY.id,
      currency: "USD",
      statements: STATEMENTS,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      events: [],
      splits: [
        {
          securityId: SECURITY.id,
          date: "2026-02-10",
          numerator: 1,
          denominator: 10,
          label: "stock-split",
        },
      ],
    });
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices: PRICES.slice(0, 3),
      derived: [],
      operands: [PRICE_OPERAND, PE],
      observation: { price: 2.2 },
      observationDate: "2026-02-10",
      valuation: listed,
    })!;
    // The closed session before the event keeps its ratio; the provisional one on it has none.
    expect(
      readOperand(monitor.frame, PE, monitor.observationIndex - 1),
    ).toBeCloseTo(10, 12);
    expect(readOperand(monitor.frame, PE, monitor.observationIndex)).toBeNaN();
    expect(
      evaluateMarketCondition(
        PE_BELOW_15,
        monitor.frame,
        monitor.observationIndex,
      ),
    ).toBe(Evaluability.NOT_EVALUABLE);
  });
});
