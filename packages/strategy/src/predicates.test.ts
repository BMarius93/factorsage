import { describe, expect, it } from "vitest";
import {
  Evaluability,
  evaluabilityAll,
  evaluabilityAnd,
} from "./evaluability.js";
import { createEvaluationFrame } from "./frame.js";
import { seriesOperand, PRICE_OPERAND, collectOperands } from "./operands.js";
import {
  evaluateConditionValues,
  evaluateMarketSignal,
  evaluateTriggerValues,
} from "./predicates.js";
import { STRATEGY_SCHEMA_VERSION } from "@intrinsic/contracts";

const { NOT_EVALUABLE, FALSE, TRUE } = Evaluability;

describe("condition operators", () => {
  it("compares strictly, with no equality variant in V1", () => {
    expect(evaluateConditionValues("IS_ABOVE", 11, 10)).toBe(TRUE);
    expect(evaluateConditionValues("IS_ABOVE", 10, 10)).toBe(FALSE);
    expect(evaluateConditionValues("IS_BELOW", 9, 10)).toBe(TRUE);
    expect(evaluateConditionValues("IS_BELOW", 10, 10)).toBe(FALSE);
  });

  it("treats `is close to` as within 2% of the comparison value", () => {
    expect(evaluateConditionValues("IS_CLOSE_TO", 102, 100)).toBe(TRUE);
    expect(evaluateConditionValues("IS_CLOSE_TO", 98, 100)).toBe(TRUE);
    expect(evaluateConditionValues("IS_CLOSE_TO", 102.01, 100)).toBe(FALSE);
    // The ratio is undefined at zero, so it is NOT_EVALUABLE rather than an invented fallback.
    expect(evaluateConditionValues("IS_CLOSE_TO", 0, 0)).toBe(NOT_EVALUABLE);
  });

  it("is NOT_EVALUABLE whenever an operand is unavailable", () => {
    for (const operator of ["IS_ABOVE", "IS_BELOW", "IS_CLOSE_TO"] as const) {
      expect(evaluateConditionValues(operator, Number.NaN, 10)).toBe(
        NOT_EVALUABLE,
      );
      expect(evaluateConditionValues(operator, 10, Number.NaN)).toBe(
        NOT_EVALUABLE,
      );
    }
  });
});

describe("trigger operators", () => {
  it("requires the transition, not merely the state", () => {
    expect(evaluateTriggerValues("CROSSES_ABOVE", 11, 10, 9, 10)).toBe(TRUE);
    // Still above, but it crossed yesterday: a Trigger fires once.
    expect(evaluateTriggerValues("CROSSES_ABOVE", 12, 10, 11, 10)).toBe(FALSE);
    // Touching the value counts as not-yet-above on the previous day.
    expect(evaluateTriggerValues("CROSSES_ABOVE", 11, 10, 10, 10)).toBe(TRUE);
    expect(evaluateTriggerValues("CROSSES_BELOW", 9, 10, 11, 10)).toBe(TRUE);
    expect(evaluateTriggerValues("CROSSES_BELOW", 9, 10, 10, 10)).toBe(TRUE);
    expect(evaluateTriggerValues("CROSSES_BELOW", 8, 10, 9, 10)).toBe(FALSE);
  });

  it("is NOT_EVALUABLE when any of the four values is unavailable", () => {
    expect(evaluateTriggerValues("CROSSES_ABOVE", Number.NaN, 10, 9, 10)).toBe(
      NOT_EVALUABLE,
    );
    expect(evaluateTriggerValues("CROSSES_ABOVE", 11, Number.NaN, 9, 10)).toBe(
      NOT_EVALUABLE,
    );
    expect(evaluateTriggerValues("CROSSES_ABOVE", 11, 10, Number.NaN, 10)).toBe(
      NOT_EVALUABLE,
    );
    expect(evaluateTriggerValues("CROSSES_ABOVE", 11, 10, 9, Number.NaN)).toBe(
      NOT_EVALUABLE,
    );
  });
});

describe("conjunction", () => {
  it("is Kleene strong AND with FALSE absorbing", () => {
    expect(evaluabilityAnd(TRUE, TRUE)).toBe(TRUE);
    expect(evaluabilityAnd(TRUE, FALSE)).toBe(FALSE);
    expect(evaluabilityAnd(TRUE, NOT_EVALUABLE)).toBe(NOT_EVALUABLE);
    expect(evaluabilityAnd(FALSE, NOT_EVALUABLE)).toBe(FALSE);
    expect(evaluabilityAnd(NOT_EVALUABLE, FALSE)).toBe(FALSE);
    expect(evaluabilityAnd(NOT_EVALUABLE, NOT_EVALUABLE)).toBe(NOT_EVALUABLE);
  });

  it("treats an empty conjunction as TRUE", () => {
    // A SELL level whose only predicates are position-dependent has a vacuously true market half.
    expect(evaluabilityAll([])).toBe(TRUE);
  });
});

describe("signal evaluation over a frame", () => {
  const frame = createEvaluationFrame({
    securityId: "security-1",
    symbol: "AAA",
    name: "AAA Inc.",
    dates: ["2020-01-02", "2020-01-03", "2020-01-06"],
    closes: Float64Array.from([100, 105, 110]),
    columns: new Map([
      [seriesOperand("SMA_50D"), Float64Array.from([102, 102, Number.NaN])],
    ]),
    periodStartIndex: 0,
  });

  it("ANDs conditions and the trigger by date", () => {
    const signal = {
      conditions: [
        {
          id: "c1",
          metric: { kind: "PRICE" as const },
          operator: "IS_ABOVE" as const,
          value: { kind: "SERIES" as const, seriesId: "SMA_50D" as const },
        },
      ],
      trigger: {
        id: "t1",
        metric: { kind: "PRICE" as const },
        operator: "CROSSES_ABOVE" as const,
        value: { kind: "SERIES" as const, seriesId: "SMA_50D" as const },
      },
    };

    // Index 0 has no previous eligible day, so the Trigger there is NOT_EVALUABLE — but the
    // Condition is definitively FALSE (100 is not above 102), and FALSE absorbs: the signal could
    // not have fired whatever the missing value was, so reporting a data gap would overstate it.
    expect(evaluateMarketSignal(signal, frame, 0)).toBe(FALSE);
    expect(evaluateMarketSignal(signal, frame, 1)).toBe(TRUE);
    // The operand is unavailable on the third day: absence is never a substitute zero.
    expect(evaluateMarketSignal(signal, frame, 2)).toBe(NOT_EVALUABLE);
  });

  it("collects the operand columns a definition references, price always included", () => {
    const operands = collectOperands({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: "s1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c2",
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
                operator: "IS_BELOW",
                value: { kind: "PERCENT", value: 0 },
              },
              {
                id: "c3",
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 25 },
              },
            ],
          },
        },
      ],
    });

    expect(operands).toEqual([
      "margin-of-safety:DCF_FCFF",
      PRICE_OPERAND,
      seriesOperand("RSI_14D"),
    ]);
    // Position-dependent metrics have no column: they are evaluated live against simulated state.
    expect(operands).not.toContain("gain");
  });
});
