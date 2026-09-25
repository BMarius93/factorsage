import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import {
  collectOperands,
  marginOfSafetyOperand,
  PRICE_OPERAND,
  readOperand,
  relativeVolumeOperand,
  seriesOperand,
} from "@intrinsic/strategy";
import { STRATEGY_SCHEMA_VERSION } from "@intrinsic/contracts";
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

describe("relative volume is read, never recalculated", () => {
  it("reads the materialized value for the period the metric names", () => {
    // The three periods live on one row, and each operand must read its own column: a projector
    // that fell back to a single "relative volume" field would answer 2.5 for all three.
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 11)],
      derived: [
        derived("2020-01-02", { rvol10: 1.1, rvol20: 1.2, rvol50: 1.3 }),
        derived("2020-01-03", { rvol10: 2.5, rvol20: 1.9, rvol50: 1.6 }),
      ],
      operands: [
        relativeVolumeOperand(10),
        relativeVolumeOperand(20),
        relativeVolumeOperand(50),
      ],
      periodStart: "2020-01-01",
    });

    expect(readOperand(frame, relativeVolumeOperand(10), 1)).toBe(2.5);
    expect(readOperand(frame, relativeVolumeOperand(20), 1)).toBe(1.9);
    expect(readOperand(frame, relativeVolumeOperand(50), 1)).toBe(1.6);
  });

  it("does not derive a value from the bar's own volume", () => {
    // The price rows carry a volume; the derived row carries no `rvol20`. The column must be
    // absent rather than recomputed here — evaluation reads what ingestion materialized, and a
    // projector that quietly divided volumes would be a second RVOL implementation.
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 11)],
      derived: [derived("2020-01-02"), derived("2020-01-03")],
      operands: [relativeVolumeOperand(20)],
      periodStart: "2020-01-01",
    });

    expect(readOperand(frame, relativeVolumeOperand(20), 1)).toBeNaN();
  });

  it("is NOT_EVALUABLE during warm-up rather than defaulting to a neutral 1x", () => {
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10), price("2020-01-03", 11)],
      derived: [derived("2020-01-02"), derived("2020-01-03", { rvol20: 2.2 })],
      operands: [relativeVolumeOperand(20)],
      periodStart: "2020-01-01",
    });

    expect(readOperand(frame, relativeVolumeOperand(20), 0)).toBeNaN();
    expect(readOperand(frame, relativeVolumeOperand(20), 1)).toBe(2.2);
  });

  it("keeps a real zero reading distinct from absence", () => {
    const { frame } = projectEvaluationFrame({
      security,
      prices: [price("2020-01-02", 10)],
      derived: [derived("2020-01-02", { rvol20: 0 })],
      operands: [relativeVolumeOperand(20)],
      periodStart: "2020-01-01",
    });

    expect(readOperand(frame, relativeVolumeOperand(20), 0)).toBe(0);
  });

  it("projects exactly the periods a strategy names, and no others", () => {
    // Only the referenced column is materialized, which is what keeps a long multi-security run
    // in tens of megabytes; a strategy naming RVOL 20 must not pull RVOL 10 and RVOL 50 with it.
    const operands = collectOperands({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 25,
          signal: {
            conditions: [
              {
                id: "condition-1",
                metric: { kind: "RELATIVE_VOLUME", period: 20 },
                operator: "IS_ABOVE",
                value: { kind: "MULTIPLE", value: 2 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });

    expect(operands).toEqual([PRICE_OPERAND, relativeVolumeOperand(20)].sort());
  });
});
