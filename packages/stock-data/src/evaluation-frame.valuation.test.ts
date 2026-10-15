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
import { buildValuationTimeline } from "./valuation-ratios.js";

/**
 * Valuation ratios through the canonical projection every engine reads — backtests and the Monitor's
 * end-of-day evaluation alike — and a Condition on an unavailable ratio is NOT_EVALUABLE.
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

describe("valuation ratios around a listed event", () => {
  it("withholds the session of a listed event the provider has not re-based", () => {
    // Q4 public more than 30 days before the event, so its count is not one first observed in the
    // month before it (rule 5, before the event: the next test).
    const listed = buildValuationTimeline({
      securityId: SECURITY.id,
      currency: "USD",
      statements: STATEMENTS.map((statement) =>
        statement.period === "Q4"
          ? {
              ...statement,
              filingDate: "2026-01-09",
              availableFromDate: "2026-01-09",
              observedAt: "2026-01-09T12:00:00.000Z",
            }
          : statement,
      ),
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
    const { frame } = projectEvaluationFrame({
      security: SECURITY,
      prices: PRICES,
      derived: [],
      operands: [PRICE_OPERAND, PE],
      periodStart: "2026-02-05",
      valuation: { timeline: listed },
    });
    // The session before the event keeps its ratio; the event's own session has none.
    expect(readOperand(frame, PE, 2)).toBeCloseTo(10, 12);
    expect(readOperand(frame, PE, 3)).toBeNaN();
    expect(evaluateMarketCondition(PE_BELOW_15, frame, 3)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });

  it("withholds the session before a listed event when the count was first observed in the month before it (owner, 2026-10-06)", () => {
    // Q4 first observed on 2026-02-09, the day before the listed 1:10 event: the provider may already
    // have restated it, so no session before the event reads it.
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
    const { frame } = projectEvaluationFrame({
      security: SECURITY,
      prices: PRICES,
      derived: [],
      operands: [PRICE_OPERAND, PE],
      periodStart: "2026-02-05",
      valuation: { timeline: listed },
    });
    expect(readOperand(frame, PE, 2)).toBeNaN();
    expect(readOperand(frame, PE, 3)).toBeNaN();
  });
});
