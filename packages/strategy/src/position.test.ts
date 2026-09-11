import { describe, expect, it } from "vitest";
import {
  MONEY_ZERO,
  quantizeMoney as money,
  quantizeSharesDown,
} from "./backtest/money.js";
import { Evaluability } from "./evaluability.js";
import {
  applyBuy,
  applySell,
  averageCost,
  costTotal,
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
    shares: money(100),
    averageCostValue: money(100),
    costTotalValue: money(10_000),
    buyLevelsSettled: new Set<string>(),
    sellLevelsFired: new Set<string>(),
    lastPrice: 100,
    lastPriceDate: "2020-01-02",
    realizedPnl: MONEY_ZERO,
    ...overrides,
  };
}

const emptyPosition = (): PositionState =>
  position({
    shares: MONEY_ZERO,
    averageCostValue: MONEY_ZERO,
    costTotalValue: MONEY_ZERO,
  });

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
    const state = emptyPosition();
    // `applyBuy` takes the canonical amount that will be persisted, not a price to re-multiply:
    // 100 shares at 100 is an amount of 10,000.
    applyBuy(state, money(100), money(10_000), MONEY_ZERO);
    expect(averageCost(state)).toBeCloseTo(100, 9);

    applyBuy(state, money(100), money(5_000), MONEY_ZERO);
    expect(state.shares.toNumber()).toBe(200);
    expect(averageCost(state)).toBeCloseTo(75, 9);

    const { realizedPnl } = applySell(
      state,
      money(100),
      money(120),
      MONEY_ZERO,
    );
    // Proceeds 12,000 against 100 shares at a 75 basis.
    expect(realizedPnl.toNumber()).toBeCloseTo(4_500, 9);
    expect(state.shares.toNumber()).toBe(100);
    // A partial sell removes shares and cost proportionally, so Gain keeps describing the same
    // position instead of jumping.
    expect(averageCost(state)).toBeCloseTo(75, 9);
  });

  it("closes cleanly to zero shares and zero cost", () => {
    const state = position();
    applySell(state, money(100), money(150), MONEY_ZERO);
    expect(state.shares.toNumber()).toBe(0);
    expect(state.shares.isZero()).toBe(true);
    expect(costTotal(state).toNumber()).toBe(0);
    expect(state.averageCostValue.isZero()).toBe(true);
    expect(state.realizedPnl.toNumber()).toBeCloseTo(5_000, 9);
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

/**
 * The ledger guarantees the `Decimal(20,2)` implementation could not make.
 *
 * Each of these is a property the validation matrix found violated at the $1 contract minimum,
 * where a real 2.5-cent spend was stored as three cents and a real sub-half-cent profit as zero.
 */
describe("the decimal ledger", () => {
  it("keeps a sub-cent position exact instead of rounding it into nonsense", () => {
    // The matrix reported `IBM 2016-09-09: averageCostAfter 148.84 but (0.00 + 0.03) / 0.0001679656
    // = 178.61` — a 20% error created purely by storing a 0.025 spend at two decimals.
    const price = money(148.84);
    const shares = quantizeSharesDown(money(0.025).div(price));
    const amount = money(shares.times(price));
    const state = emptyPosition();
    applyBuy(state, shares, amount, MONEY_ZERO);
    // Truncated shares mean the amount is a hair under the 0.025 target, so the basis is a hair
    // over the close — exactly, and reproducibly, rather than 178.61.
    expect(amount.toFixed(6)).toBe("0.025000");
    expect(state.averageCostValue.toFixed(8)).toBe("148.84000057");
    expect(averageCost(state)).toBeCloseTo(148.84, 4);
  });

  it("leaves the basis per share bit-identical across many partial sells", () => {
    // Accumulating a cost total and dividing it independently drifted by 3.4e-3 over a thousand
    // cycles at $1. Carrying the basis itself cannot drift, and this asserts the stronger property:
    // not "close to", but the same canonical value.
    const state = emptyPosition();
    applyBuy(state, money(0.0001679656), money(0.025), MONEY_ZERO);
    const basis = state.averageCostValue.toFixed(8);
    for (let i = 0; i < 40; i += 1) {
      if (!state.shares.gt(MONEY_ZERO)) {
        break;
      }
      const slice = quantizeSharesDown(state.shares.times(10).div(100));
      if (!slice.gt(MONEY_ZERO)) {
        break;
      }
      applySell(state, slice, money(151.02), MONEY_ZERO);
      expect(state.averageCostValue.toFixed(8)).toBe(basis);
    }
  });

  it("closes a full exit to exactly zero, not to a residue", () => {
    const state = emptyPosition();
    applyBuy(state, money("0.3333333333"), money("1.000000"), MONEY_ZERO);
    applySell(state, money("0.1111111111"), money(3), MONEY_ZERO);
    applySell(state, state.shares, money(3), MONEY_ZERO);
    expect(state.shares.isZero()).toBe(true);
    expect(state.averageCostValue.isZero()).toBe(true);
    expect(costTotal(state).isZero()).toBe(true);
  });

  it("removes the whole basis on a full exit rather than a proportional approximation", () => {
    const state = emptyPosition();
    applyBuy(state, money("0.0001679656"), money("0.025000"), MONEY_ZERO);
    const { costRemoved } = applySell(
      state,
      state.shares,
      money(200),
      MONEY_ZERO,
    );
    expect(costRemoved.toFixed(6)).toBe("0.025000");
  });

  it("keeps sub-half-cent profit and loss signed, which decides winner/loser counts", () => {
    const win = position({
      shares: MONEY_ZERO,
      averageCostValue: MONEY_ZERO,
      costTotalValue: MONEY_ZERO,
    });
    applyBuy(win, money(1), money("10.000000"), MONEY_ZERO);
    const gained = applySell(win, money(1), money("10.004"), MONEY_ZERO);
    expect(gained.realizedPnl.gt(MONEY_ZERO)).toBe(true);
    expect(gained.realizedPnl.toFixed(6)).toBe("0.004000");

    const lose = position({
      shares: MONEY_ZERO,
      averageCostValue: MONEY_ZERO,
      costTotalValue: MONEY_ZERO,
    });
    applyBuy(lose, money(1), money("10.000000"), MONEY_ZERO);
    const lost = applySell(lose, money(1), money("9.996"), MONEY_ZERO);
    expect(lost.realizedPnl.lt(MONEY_ZERO)).toBe(true);
    expect(lost.realizedPnl.toFixed(6)).toBe("-0.004000");
  });

  it("holds C08-scale magnitudes a float64 ledger cannot", () => {
    const state = emptyPosition();
    // The largest single trade the matrix observed, against the largest share count.
    applyBuy(
      state,
      money("2415434113.5728870000"),
      money("2611478558.520000"),
      MONEY_ZERO,
    );
    expect(state.shares.toFixed(10)).toBe("2415434113.5728870000");
    // The cost total is carried exactly; an eight-decimal basis alone would have lost $10.44 here.
    expect(costTotal(state).toFixed(6)).toBe("2611478558.520000");
  });
});
