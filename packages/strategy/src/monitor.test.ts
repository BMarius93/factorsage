import type {
  StrategyDefinition,
  StrategySignal,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame, type EvaluationFrame } from "./frame.js";
import { seriesOperand } from "./operands.js";
import {
  evaluateSignalWithoutPosition,
  monitorStrategyLevels,
  signalNeedsPositionState,
} from "./monitor.js";

/**
 * Evaluating a Strategy Signal with no position state.
 *
 * The rule under test is `ai/product/strategies.md`'s own: a predicate is NOT_EVALUABLE when the
 * data, the previous trigger value **or the position state** it needs is unavailable. A Monitor has
 * no position, so Gain/Loss can never decide a match — and must never be allowed to vanish into the
 * empty-conjunction rule and report a vacuous TRUE.
 */

const EMA50 = "EMA_50D";

function frameOf(closes: number[], ema: (number | null)[]): EvaluationFrame {
  const dates = closes.map((_, index) => `2026-03-${String(index + 2).padStart(2, "0")}`);
  return createEvaluationFrame({
    securityId: "sec-1",
    symbol: "TEST",
    name: "Test Security",
    dates,
    closes: Float64Array.from(closes),
    columns: new Map([
      [
        seriesOperand(EMA50),
        Float64Array.from(ema.map((value) => value ?? Number.NaN)),
      ],
    ]),
    periodStartIndex: dates.length - 1,
  });
}

const priceAboveEma: StrategySignal = {
  conditions: [
    {
      id: "c1",
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: EMA50 },
    },
  ],
};

const priceCrossesAboveEma: StrategySignal = {
  conditions: [],
  trigger: {
    id: "t1",
    metric: { kind: "PRICE" },
    operator: "CROSSES_ABOVE",
    value: { kind: "SERIES", seriesId: EMA50 },
  },
};

const gainAbove25: StrategySignal = {
  conditions: [
    {
      id: "c1",
      metric: { kind: "GAIN" },
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 25 },
    },
  ],
};

describe("signalNeedsPositionState", () => {
  it("is false for a market-derived signal", () => {
    expect(signalNeedsPositionState(priceAboveEma)).toBe(false);
    expect(signalNeedsPositionState(priceCrossesAboveEma)).toBe(false);
  });

  it("is true for a Gain or Loss condition", () => {
    expect(signalNeedsPositionState(gainAbove25)).toBe(true);
  });

  it("is true for a Gain or Loss trigger", () => {
    expect(
      signalNeedsPositionState({
        conditions: [],
        trigger: {
          id: "t1",
          metric: { kind: "LOSS" },
          operator: "CROSSES_ABOVE",
          value: { kind: "PERCENT", value: 10 },
        },
      }),
    ).toBe(true);
  });
});

describe("evaluateSignalWithoutPosition", () => {
  it("decides a market-derived condition exactly as the canonical evaluator does", () => {
    const frame = frameOf([100, 110], [105, 105]);
    expect(evaluateSignalWithoutPosition(priceAboveEma, frame, 1)).toBe(
      Evaluability.TRUE,
    );
    expect(evaluateSignalWithoutPosition(priceAboveEma, frame, 0)).toBe(
      Evaluability.FALSE,
    );
  });

  it("decides a crossing from the frame's own previous row", () => {
    // 100 <= 105 yesterday, 110 > 105 today: a genuine crossing.
    expect(
      evaluateSignalWithoutPosition(priceCrossesAboveEma, frameOf([100, 110], [105, 105]), 1),
    ).toBe(Evaluability.TRUE);
    // Already above yesterday: staying above is not a crossing.
    expect(
      evaluateSignalWithoutPosition(priceCrossesAboveEma, frameOf([108, 110], [105, 105]), 1),
    ).toBe(Evaluability.FALSE);
  });

  it("never matches a position-dependent signal, because there is no position", () => {
    const frame = frameOf([100, 110], [105, 105]);
    // Without the no-position rule the empty conjunction would make this vacuously TRUE, and every
    // monitored symbol would signal on every scan.
    expect(evaluateSignalWithoutPosition(gainAbove25, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });

  it("reports FALSE when a market half is definitively false beside a position predicate", () => {
    // Kleene strong AND with FALSE absorbing: the signal cannot fire whatever the position was, so
    // reporting NOT_EVALUABLE there would overstate the gap.
    const frame = frameOf([100, 100], [105, 105]);
    expect(
      evaluateSignalWithoutPosition(
        { conditions: [...priceAboveEma.conditions, ...gainAbove25.conditions] },
        frame,
        1,
      ),
    ).toBe(Evaluability.FALSE);
  });

  it("is NOT_EVALUABLE while a required series has not warmed up", () => {
    const frame = frameOf([100, 110], [null, null]);
    expect(evaluateSignalWithoutPosition(priceAboveEma, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });

  it("is NOT_EVALUABLE for a trigger whose previous value is missing", () => {
    const frame = frameOf([100, 110], [null, 105]);
    expect(evaluateSignalWithoutPosition(priceCrossesAboveEma, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });
});

describe("monitorStrategyLevels", () => {
  it("walks BUY, SELL and FINAL EXIT in the definition's own order", () => {
    const definition: StrategyDefinition = {
      schemaVersion: 1,
      buyLevels: [
        { id: "b1", signal: priceAboveEma, percentage: 50 },
        { id: "b2", signal: priceCrossesAboveEma, percentage: 50 },
      ],
      sellLevels: [{ id: "s1", signal: gainAbove25, percentage: 25 }],
      finalExit: { id: "f1", signal: priceAboveEma },
    };

    expect(monitorStrategyLevels(definition)).toEqual([
      { id: "b1", kind: "BUY", signal: priceAboveEma },
      { id: "b2", kind: "BUY", signal: priceCrossesAboveEma },
      { id: "s1", kind: "SELL", signal: gainAbove25 },
      { id: "f1", kind: "FINAL_EXIT", signal: priceAboveEma },
    ]);
  });

  it("omits FINAL EXIT when the strategy has none", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: 1,
        buyLevels: [{ id: "b1", signal: priceAboveEma, percentage: 100 }],
        sellLevels: [],
      }),
    ).toEqual([{ id: "b1", kind: "BUY", signal: priceAboveEma }]);
  });
});
