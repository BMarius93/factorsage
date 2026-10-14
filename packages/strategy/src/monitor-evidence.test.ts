import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame } from "./frame.js";
import { monitorStrategyLevels } from "./monitor.js";
import { explainMonitorLevel } from "./monitor-lifecycle.js";
import { seriesOperand } from "./operands.js";
import {
  evaluateMarketCondition,
  evaluateMarketTrigger,
  explainMarketSignal,
} from "./predicates.js";

/**
 * The evidence a Monitor stores behind a lifecycle change (`docs/decisions/monitor-eod-v2.md` §5).
 * It must be the decision's own operands and result — never a recomputation that could disagree.
 */

const EMA = "EMA_50D";
const frame = createEvaluationFrame({
  securityId: "sec-1",
  symbol: "TEST",
  name: "Test",
  dates: ["2026-10-12", "2026-10-13", "2026-10-14"],
  closes: Float64Array.from([95, 105, 104]),
  columns: new Map([
    [seriesOperand(EMA), Float64Array.from([100, Number.NaN, 101])],
  ]),
  periodStartIndex: 0,
});

const ABOVE: StrategySignal = {
  conditions: [
    {
      id: "c1",
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: EMA },
    },
    {
      id: "c2",
      metric: { kind: "PRICE" },
      operator: "IS_BELOW",
      value: { kind: "NUMBER", value: 200 },
    },
  ],
};
const CROSSES: StrategySignal = {
  conditions: [],
  trigger: {
    id: "t1",
    metric: { kind: "PRICE" },
    operator: "CROSSES_ABOVE",
    value: { kind: "NUMBER", value: 100 },
  },
};

const name = (value: Evaluability) =>
  value === Evaluability.TRUE
    ? "TRUE"
    : value === Evaluability.FALSE
      ? "FALSE"
      : "NOT_EVALUABLE";

describe("Monitor transition evidence", () => {
  it("records each condition's compared operands and the evaluator's own result", () => {
    const evidence = explainMarketSignal(ABOVE, frame, 2);
    expect(evidence).toEqual([
      { id: "c1", role: "CONDITION", result: "TRUE", metric: 104, value: 101 },
      { id: "c2", role: "CONDITION", result: "TRUE", metric: 104, value: 200 },
    ]);
    for (const [position, condition] of ABOVE.conditions.entries()) {
      expect(evidence[position]!.result).toBe(
        name(evaluateMarketCondition(condition, frame, 2)),
      );
    }
  });

  it("records an operand that did not resolve as null, never as zero", () => {
    const evidence = explainMarketSignal(ABOVE, frame, 1);
    expect(evidence[0]).toEqual({
      id: "c1",
      role: "CONDITION",
      result: "NOT_EVALUABLE",
      metric: 105,
      value: null,
    });
  });

  it("records a trigger's previous-session operands beside the current ones", () => {
    const [crossing] = explainMarketSignal(CROSSES, frame, 1);
    expect(crossing).toEqual({
      id: "t1",
      role: "TRIGGER",
      result: "TRUE",
      metric: 105,
      value: 100,
      previousMetric: 95,
      previousValue: 100,
    });
    expect(crossing!.result).toBe(
      name(evaluateMarketTrigger(CROSSES.trigger!, frame, 1)),
    );
    // On the first session there is no previous one: NOT_EVALUABLE, with nothing invented.
    const [first] = explainMarketSignal(CROSSES, frame, 0);
    expect(first).toMatchObject({
      result: "NOT_EVALUABLE",
      previousMetric: null,
      previousValue: null,
    });
  });

  it("keeps a FINAL EXIT change's evidence to the Exit Rule that drove it", () => {
    const definition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "buy-1", percentage: 100, signal: ABOVE }],
      sellLevels: [],
      finalExit: {
        id: "exit",
        rules: [
          { id: "exit-a", signal: ABOVE },
          { id: "exit-b", signal: CROSSES },
        ],
      },
    } as unknown as StrategyDefinition;
    const exit = monitorStrategyLevels(definition).find(
      (level) => level.kind === "FINAL_EXIT",
    )!;
    expect(
      explainMonitorLevel(exit, frame, 1, "exit-b").rules.map((r) => r.ruleId),
    ).toEqual(["exit-b"]);
    const all = explainMonitorLevel(exit, frame, 1);
    expect(all.v).toBe(1);
    expect(all.rules.map((rule) => rule.ruleId)).toEqual(["exit-a", "exit-b"]);
  });
});
