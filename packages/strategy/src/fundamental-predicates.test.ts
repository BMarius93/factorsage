import type {
  ConditionOperator,
  FundamentalMetricId,
  StrategyCondition,
  StrategyValue,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame, type EvaluationFrame } from "./frame.js";
import {
  fundamentalMetricOperand,
  relativeVolumeOperand,
  seriesOperand,
  type OperandKey,
} from "./operands.js";
import { evaluateMarketCondition, evaluateMarketSignal } from "./predicates.js";

/**
 * A Fundamental Condition through the one generic evaluator.
 *
 * There is no Fundamentals evaluator to test: the metric reads its frame column and the Condition is
 * the ordinary strict comparison. These cases pin the boundaries the product states — `is above` is
 * `>`, `is below` is `<`, equality never matches — and the one failure mode that matters most for a
 * statement-derived metric: an unavailable reading must never behave like a zero.
 */

const { NOT_EVALUABLE, FALSE, TRUE } = Evaluability;

function frameWith(
  columns: Record<OperandKey, readonly number[]>,
  closes?: readonly number[],
): EvaluationFrame {
  const length = Object.values(columns)[0]?.length ?? closes?.length ?? 0;
  const dates = Array.from(
    { length },
    (_, index) => `2026-01-${String(index + 5).padStart(2, "0")}`,
  );
  return createEvaluationFrame({
    securityId: "security-1",
    symbol: "FUND",
    name: "Fundamentals Corp",
    dates,
    closes: Float64Array.from(closes ?? dates.map(() => 100)),
    columns: new Map(
      Object.entries(columns).map(([key, values]) => [
        key,
        Float64Array.from(values),
      ]),
    ),
    periodStartIndex: 0,
  });
}

function fundamentalCondition(
  metricId: FundamentalMetricId,
  operator: ConditionOperator,
  value: StrategyValue,
): StrategyCondition {
  return {
    id: `${metricId}-${operator}`,
    metric: { kind: "FUNDAMENTAL", metricId },
    operator,
    value,
  };
}

/** Evaluates `condition` at every index of a one-column frame. */
function across(
  condition: StrategyCondition,
  readings: readonly number[],
): Evaluability[] {
  if (condition.metric.kind !== "FUNDAMENTAL") {
    throw new Error("a fundamental condition is required");
  }
  const frame = frameWith({
    [fundamentalMetricOperand(condition.metric.metricId)]: readings,
  });
  return readings.map((_, index) =>
    evaluateMarketCondition(condition, frame, index),
  );
}

describe("a percentage Fundamental Condition", () => {
  it("ROIC TTM is above 15%: 16 matches, 15 and 14 do not", () => {
    const rule = fundamentalCondition("ROIC_TTM", "IS_ABOVE", {
      kind: "PERCENT",
      value: 15,
    });
    expect(across(rule, [16, 15, 14])).toEqual([TRUE, FALSE, FALSE]);
  });

  it("compares percentage points with percentage points, never a fraction", () => {
    const rule = fundamentalCondition("REVENUE_GROWTH_TTM_YOY", "IS_ABOVE", {
      kind: "PERCENT",
      value: 10,
    });
    // A stored 12.5% is 12.5: above 10. Had anything scaled it to 0.125 it would read below.
    expect(across(rule, [12.5, 0.125, 10])).toEqual([TRUE, FALSE, FALSE]);
  });

  it("sees a negative reading as a negative number, not as absence", () => {
    const rule = fundamentalCondition("NET_MARGIN_TTM", "IS_BELOW", {
      kind: "PERCENT",
      value: 0,
    });
    expect(across(rule, [-4.2, 0, 3.1])).toEqual([TRUE, FALSE, FALSE]);
  });
});

describe("a multiple Fundamental Condition", () => {
  it("Debt / Equity is below 1x: 0.8 matches, 1.0 and 1.2 do not", () => {
    const rule = fundamentalCondition("DEBT_TO_EQUITY", "IS_BELOW", {
      kind: "MULTIPLE",
      value: 1,
    });
    expect(across(rule, [0.8, 1.0, 1.2])).toEqual([TRUE, FALSE, FALSE]);
  });

  it("keeps a real zero as a reading that matches", () => {
    // A debt-free company has a real Debt / Equity of 0, and it is below 1.
    const rule = fundamentalCondition("DEBT_TO_EQUITY", "IS_BELOW", {
      kind: "MULTIPLE",
      value: 1,
    });
    expect(across(rule, [0])).toEqual([TRUE]);
  });

  it("compares signed multiples as signed numbers", () => {
    const netCash = fundamentalCondition("NET_DEBT_TO_EBITDA_TTM", "IS_BELOW", {
      kind: "MULTIPLE",
      value: 0,
    });
    expect(across(netCash, [-0.5, 0, 2.4])).toEqual([TRUE, FALSE, FALSE]);
    const coverage = fundamentalCondition("INTEREST_COVERAGE_TTM", "IS_ABOVE", {
      kind: "MULTIPLE",
      value: -3,
    });
    expect(across(coverage, [-2, -3, -4])).toEqual([TRUE, FALSE, FALSE]);
  });
});

describe("an unavailable Fundamental reading", () => {
  it("is NOT_EVALUABLE under either operator, never a comparison with zero", () => {
    for (const operator of ["IS_ABOVE", "IS_BELOW"] as const) {
      const rule = fundamentalCondition("ROIC_TTM", operator, {
        kind: "PERCENT",
        value: 15,
      });
      expect(across(rule, [Number.NaN]), operator).toEqual([NOT_EVALUABLE]);
    }
  });

  it("never turns `Debt / Equity is below 1x` into a buy signal (regression)", () => {
    // The failure mode this guards: an absent Debt / Equity read as 0 is below every positive
    // threshold, so every security with no statement history would match a leverage screen.
    const rule = fundamentalCondition("DEBT_TO_EQUITY", "IS_BELOW", {
      kind: "MULTIPLE",
      value: 1,
    });
    expect(across(rule, [Number.NaN, Number.NaN, 0.8])).toEqual([
      NOT_EVALUABLE,
      NOT_EVALUABLE,
      TRUE,
    ]);
  });

  it("is NOT_EVALUABLE when the frame has no column for the metric at all", () => {
    const rule = fundamentalCondition("ROE_TTM", "IS_ABOVE", {
      kind: "PERCENT",
      value: 15,
    });
    const frame = frameWith({
      [fundamentalMetricOperand("ROIC_TTM")]: [20],
    });
    // A column for ROIC is not a column for ROE.
    expect(evaluateMarketCondition(rule, frame, 0)).toBe(NOT_EVALUABLE);
  });
});

describe("several Fundamental Conditions in one Signal", () => {
  const signal = {
    conditions: [
      fundamentalCondition("ROIC_TTM", "IS_ABOVE", {
        kind: "PERCENT",
        value: 15,
      }),
      fundamentalCondition("DEBT_TO_EQUITY", "IS_BELOW", {
        kind: "MULTIPLE",
        value: 1,
      }),
      fundamentalCondition("REVENUE_GROWTH_TTM_YOY", "IS_ABOVE", {
        kind: "PERCENT",
        value: 5,
      }),
    ],
  };

  function evaluate(roic: number, debtToEquity: number, growth: number) {
    const frame = frameWith({
      [fundamentalMetricOperand("ROIC_TTM")]: [roic],
      [fundamentalMetricOperand("DEBT_TO_EQUITY")]: [debtToEquity],
      [fundamentalMetricOperand("REVENUE_GROWTH_TTM_YOY")]: [growth],
    });
    return evaluateMarketSignal(signal, frame, 0);
  }

  it("matches only when all three hold", () => {
    expect(evaluate(18, 0.6, 8)).toBe(TRUE);
    expect(evaluate(14, 0.6, 8)).toBe(FALSE);
    expect(evaluate(18, 1.4, 8)).toBe(FALSE);
    expect(evaluate(18, 0.6, 5)).toBe(FALSE);
  });

  it("does not match when any one is unavailable, and substitutes nothing for it", () => {
    expect(evaluate(Number.NaN, 0.6, 8)).toBe(NOT_EVALUABLE);
    expect(evaluate(18, Number.NaN, 8)).toBe(NOT_EVALUABLE);
    expect(evaluate(18, 0.6, Number.NaN)).toBe(NOT_EVALUABLE);
    // A definite FALSE elsewhere still decides the Signal, whatever the missing reading was.
    expect(evaluate(14, Number.NaN, 8)).toBe(FALSE);
  });
});

describe("a Fundamental Condition beside technical Conditions", () => {
  const signal = {
    conditions: [
      {
        id: "price-above-sma200",
        metric: { kind: "PRICE" as const },
        operator: "IS_ABOVE" as const,
        value: { kind: "SERIES" as const, seriesId: "SMA_200D" as const },
      },
      fundamentalCondition("ROIC_TTM", "IS_ABOVE", {
        kind: "PERCENT",
        value: 15,
      }),
      {
        id: "rvol20-above",
        metric: { kind: "RELATIVE_VOLUME" as const, period: 20 as const },
        operator: "IS_ABOVE" as const,
        value: { kind: "MULTIPLE" as const, value: 1.5 },
      },
    ],
  };

  function evaluate(
    close: number,
    sma200: number,
    roic: number,
    rvol20: number,
  ) {
    const frame = frameWith(
      {
        [seriesOperand("SMA_200D")]: [sma200],
        [fundamentalMetricOperand("ROIC_TTM")]: [roic],
        [relativeVolumeOperand(20)]: [rvol20],
      },
      [close],
    );
    return evaluateMarketSignal(signal, frame, 0);
  }

  it("ANDs them exactly as it ANDs any Conditions", () => {
    expect(evaluate(110, 100, 18, 2)).toBe(TRUE);
    expect(evaluate(90, 100, 18, 2)).toBe(FALSE);
    expect(evaluate(110, 100, 12, 2)).toBe(FALSE);
    expect(evaluate(110, 100, 18, 1.2)).toBe(FALSE);
    expect(evaluate(110, 100, Number.NaN, 2)).toBe(NOT_EVALUABLE);
    expect(evaluate(110, Number.NaN, 18, 2)).toBe(NOT_EVALUABLE);
  });
});
