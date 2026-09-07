import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import {
  marginOfSafetyOperand,
  PRICE_OPERAND,
  readOperand,
  seriesOperand,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { projectEvaluationFrame } from "./evaluation-frame.js";

const security: Security = {
  id: "security-1",
  symbol: "TEST",
  name: "Test Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

function price(date: string, close: number): DailyPrice {
  return {
    securityId: security.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

function derived(
  date: string,
  values: Partial<DailyDerivedState> = {},
): DailyDerivedState {
  return { securityId: security.id, date, ...values };
}

describe("evaluation frame projection", () => {
  it("uses the price rows as the eligible-trading-day axis, ascending", () => {
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-03", 12), price("2020-01-02", 11)],
      derived: [],
      operands: [PRICE_OPERAND],
      periodStart: "2020-01-01",
    });

    expect(frame.dates).toEqual(["2020-01-02", "2020-01-03"]);
    expect(readOperand(frame, PRICE_OPERAND, 0)).toBe(11);
    expect(readOperand(frame, PRICE_OPERAND, 1)).toBe(12);
  });

  it("marks the first index inside the requested period, keeping earlier context rows readable", () => {
    const { frame } = projectEvaluationFrame({
      security,
      prices: [
        price("2019-12-30", 10),
        price("2019-12-31", 11),
        price("2020-01-02", 12),
      ],
      derived: [],
      operands: [PRICE_OPERAND],
      periodStart: "2020-01-01",
    });

    expect(frame.periodStartIndex).toBe(2);
    expect(frame.dates).toHaveLength(3);
  });

  it("projects only the requested operands and leaves an unavailable value absent, never zero", () => {
    const key = seriesOperand("RSI_14D");
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 10)],
      derived: [derived("2020-01-02"), derived("2020-01-03", { rsi14d: 0 })],
      operands: [PRICE_OPERAND, key],
      periodStart: "2020-01-02",
    });

    expect(Number.isNaN(readOperand(frame, key, 0))).toBe(true);
    // Zero is a real RSI reading (an only-losses window), so it must survive projection intact.
    expect(readOperand(frame, key, 1)).toBe(0);
    expect(readOperand(frame, seriesOperand("SMA_50D"), 1)).toBeNaN();
  });

  it("withholds an intrinsic model value that has no provenance instant of its own", () => {
    const key = seriesOperand("DCF_FCFF");
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 10)],
      derived: [
        // A value present without its own instant is a no-look-ahead violation waiting to happen.
        derived("2020-01-02", { intrinsicValues: { DCF_FCFF: 42 } }),
        derived("2020-01-03", {
          intrinsicValues: { DCF_FCFF: 42 },
          dcfFcffSourceAsOf: "2019-12-01T00:00:00.000Z",
        }),
      ],
      operands: [key],
      periodStart: "2020-01-02",
    });

    expect(readOperand(frame, key, 0)).toBeNaN();
    expect(readOperand(frame, key, 1)).toBe(42);
  });

  it("withholds a blend whose component provenance is incomplete", () => {
    const key = seriesOperand("BALANCED");
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 10)],
      derived: [
        derived("2020-01-02", {
          intrinsicValueBlends: { BALANCED: 50 },
          dcfFcffSourceAsOf: "2019-12-01T00:00:00.000Z",
        }),
        derived("2020-01-03", {
          intrinsicValues: { DCF_FCFF: 40, RESIDUAL_INCOME: 60, GRAHAM: 50 },
          intrinsicValueBlends: { BALANCED: 50 },
          dcfFcffSourceAsOf: "2019-12-01T00:00:00.000Z",
          residualIncomeSourceAsOf: "2019-12-01T00:00:00.000Z",
          grahamSourceAsOf: "2019-12-01T00:00:00.000Z",
          ddmSourceAsOf: "2019-12-01T00:00:00.000Z",
        }),
      ],
      operands: [key],
      periodStart: "2020-01-02",
    });

    expect(frame.columns.get(key)?.[0]).toBeNaN();
    expect(frame.columns.get(key)?.[1]).toBe(50);
  });

  it("materializes Margin of Safety against intrinsic value and refuses a non-positive one", () => {
    const key = marginOfSafetyOperand("DCF_FCFF");
    const instant = "2019-12-01T00:00:00.000Z";
    const { frame } = projectEvaluationFrame({
      security,
      prices: [
        price("2020-01-02", 75),
        price("2020-01-03", 120),
        price("2020-01-06", 50),
      ],
      derived: [
        derived("2020-01-02", {
          intrinsicValues: { DCF_FCFF: 100 },
          dcfFcffSourceAsOf: instant,
        }),
        derived("2020-01-03", {
          intrinsicValues: { DCF_FCFF: 100 },
          dcfFcffSourceAsOf: instant,
        }),
        derived("2020-01-06", {
          intrinsicValues: { DCF_FCFF: 0 },
          dcfFcffSourceAsOf: instant,
        }),
      ],
      operands: [key],
      periodStart: "2020-01-02",
    });

    // (100 - 75) / 100 * 100. The denominator is intrinsic value, never price.
    expect(readOperand(frame, key, 0)).toBeCloseTo(25, 9);
    expect(readOperand(frame, key, 1)).toBeCloseTo(-20, 9);
    // A non-positive intrinsic value is NOT_EVALUABLE, never a large positive margin.
    expect(readOperand(frame, key, 2)).toBeNaN();
  });

  it("reports a trading day that has no derived row instead of inventing one", () => {
    const { frame, diagnostics } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 10)],
      derived: [derived("2020-01-02", { sma20d: 9 })],
      operands: [seriesOperand("SMA_20D")],
      periodStart: "2020-01-02",
    });

    expect(diagnostics.datesWithoutDerivedState).toBe(1);
    expect(readOperand(frame, seriesOperand("SMA_20D"), 0)).toBe(9);
    expect(readOperand(frame, seriesOperand("SMA_20D"), 1)).toBeNaN();
    expect(frame.dates).toHaveLength(2);
  });
});
