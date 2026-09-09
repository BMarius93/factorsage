import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import {
  applyBuy,
  applySell,
  averageCost,
  evaluatePositionSignal,
  gainPercent,
  lossPercent,
  type PositionState,
} from "./position.js";

const { NOT_EVALUABLE, FALSE, TRUE } = Evaluability;

function position(overrides: Partial<PositionState> = {}): PositionState {
  return {
    securityId: "security-1",
    symbol: "AAA",
    name: "AAA Inc.",
    epoch: 1,
    openedDate: "2020-01-02",
    shares: 100,
    costTotal: 10_000,
    buyLevelsSettled: new Set<string>(),
    sellLevelsFired: new Set<string>(),
    lastPrice: 100,
    lastPriceDate: "2020-01-02",
    realizedPnl: 0,
    ...overrides,
  };
}

describe("gain and loss", () => {
  it("measures both against average cost, with Loss clamped at zero", () => {
    expect(gainPercent(125, 100)).toBeCloseTo(25, 9);
    expect(gainPercent(85, 100)).toBeCloseTo(-15, 9);
    expect(lossPercent(125, 100)).toBe(0);
    expect(lossPercent(85, 100)).toBeCloseTo(15, 9);
  });

  it("is unavailable rather than zero when the basis is not usable", () => {
    expect(gainPercent(100, 0)).toBeNaN();
    expect(gainPercent(Number.NaN, 100)).toBeNaN();
    expect(lossPercent(100, -1)).toBeNaN();
  });
});

describe("average cost under repeated buys and partial sells", () => {
  it("blends on a top-up and leaves the basis unchanged on a partial sell", () => {
    const state = position({ shares: 0, costTotal: 0 });
    applyBuy(state, 100, 100, 0);
    expect(averageCost(state)).toBeCloseTo(100, 9);

    applyBuy(state, 100, 50, 0);
    expect(state.shares).toBe(200);
    expect(averageCost(state)).toBeCloseTo(75, 9);

    const { realizedPnl } = applySell(state, 100, 120, 0);
    // Proceeds 12,000 against 100 shares at a 75 basis.
    expect(realizedPnl).toBeCloseTo(4_500, 9);
    expect(state.shares).toBe(100);
    // A partial sell removes shares and cost proportionally, so Gain keeps describing the same
    // position instead of jumping.
    expect(averageCost(state)).toBeCloseTo(75, 9);
  });

  it("closes cleanly to zero shares and zero cost", () => {
    const state = position();
    applySell(state, 100, 150, 0);
    expect(state.shares).toBe(0);
    expect(state.costTotal).toBe(0);
    expect(state.realizedPnl).toBeCloseTo(5_000, 9);
  });
});

describe("position-dependent predicates", () => {
  const gainAbove25 = {
    conditions: [
      {
        id: "c1",
        metric: { kind: "GAIN" as const },
        operator: "IS_ABOVE" as const,
        value: { kind: "PERCENT" as const, value: 25 },
      },
    ],
  };

  it("evaluates a Condition against the position's own basis", () => {
    expect(
      evaluatePositionSignal(gainAbove25, {
        close: 130,
        position: position(),
      }),
    ).toBe(TRUE);
    expect(
      evaluatePositionSignal(gainAbove25, {
        close: 120,
        position: position(),
      }),
    ).toBe(FALSE);
  });

  it("is NOT_EVALUABLE when the security has no close that day", () => {
    expect(
      evaluatePositionSignal(gainAbove25, {
        close: Number.NaN,
        position: position(),
      }),
    ).toBe(NOT_EVALUABLE);
  });

  const lossCrossesAbove10 = {
    conditions: [],
    trigger: {
      id: "t1",
      metric: { kind: "LOSS" as const },
      operator: "CROSSES_ABOVE" as const,
      value: { kind: "PERCENT" as const, value: 10 },
    },
  };

  it("cannot fire a position Trigger on the entry date", () => {
    // No previous value exists for this position, and reaching back to a market day before entry
    // would compare against a basis that did not exist.
    expect(
      evaluatePositionSignal(lossCrossesAbove10, {
        close: 85,
        position: position(),
        previousDate: "2019-12-31",
      }),
    ).toBe(NOT_EVALUABLE);
  });

  it("fires only against the value that actually held on the previous eligible day", () => {
    const held = position({
      previousSignedReturnPercent: -5,
      previousValueDate: "2020-01-03",
    });
    expect(
      evaluatePositionSignal(lossCrossesAbove10, {
        close: 85,
        position: held,
        previousDate: "2020-01-03",
      }),
    ).toBe(TRUE);

    // A gap in the security's own axis breaks the adjacency the Trigger requires.
    expect(
      evaluatePositionSignal(lossCrossesAbove10, {
        close: 85,
        position: held,
        previousDate: "2020-01-06",
      }),
    ).toBe(NOT_EVALUABLE);
  });

  it("never lets a reopened position inherit the previous one's history", () => {
    // A fresh epoch is a fresh state object: the previous value is simply absent.
    const reopened = position({ epoch: 2 });
    expect(
      evaluatePositionSignal(lossCrossesAbove10, {
        close: 85,
        position: reopened,
        previousDate: "2020-01-03",
      }),
    ).toBe(NOT_EVALUABLE);
  });
});
