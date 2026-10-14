import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyCondition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame } from "./frame.js";
import {
  collectEtfOperands,
  collectOperands,
  decodeEtfOperand,
  etfOperand,
  isEtfOperand,
  metricOperand,
  valueOperand,
} from "./operands.js";
import { evaluateMarketCondition } from "./predicates.js";

const XLK = { kind: "ETF", code: "ETF_XLK" } as const;

function definitionOf(conditions: StrategyCondition[]): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 25, signal: { conditions } }],
    sellLevels: [],
  };
}

describe("ETF operand keys", () => {
  it("builds and decodes the etf key family, refusing unknown codes", () => {
    expect(
      metricOperand({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK }),
    ).toBe("etf:ETF_XLK:series:RSI_14D");
    expect(metricOperand({ kind: "PRICE", source: { kind: "ETF", code: "SP500" } })).toBe(
      "etf:SP500:price",
    );
    expect(
      metricOperand({ kind: "RELATIVE_VOLUME", period: 20, source: XLK }),
    ).toBe("etf:ETF_XLK:relative-volume:20");
    // The stock keys are byte-identical to what they always were.
    expect(metricOperand({ kind: "OSCILLATOR", seriesId: "RSI_14D" })).toBe(
      "series:RSI_14D",
    );
    expect(decodeEtfOperand("etf:ETF_XLK:series:RSI_14D")).toEqual({
      code: "ETF_XLK",
      base: "series:RSI_14D",
    });
    expect(decodeEtfOperand("series:RSI_14D")).toBeNull();
    expect(decodeEtfOperand("etf:ETF_NOPE:price")).toBeNull();
    expect(decodeEtfOperand("etf:XLK:price")).toBeNull();
    expect(isEtfOperand("etf:anything")).toBe(true);
  });

  it("resolves a SERIES Value against the metric's own source", () => {
    expect(valueOperand({ kind: "SERIES", seriesId: "SMA_200D" })).toBe(
      "series:SMA_200D",
    );
    expect(valueOperand({ kind: "SERIES", seriesId: "SMA_200D" }, XLK)).toBe(
      "etf:ETF_XLK:series:SMA_200D",
    );
    expect(valueOperand({ kind: "NUMBER", value: 50 }, XLK)).toBeNull();
  });

  it("partitions collection: stock keys per security, ETF keys per source", () => {
    const definition = definitionOf([
      {
        id: "c-stock",
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      },
      {
        id: "c-xlk",
        metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        id: "c-gld",
        metric: {
          kind: "RELATIVE_VOLUME",
          period: 20,
          source: { kind: "ETF", code: "ETF_GLD" },
        },
        operator: "IS_ABOVE",
        value: { kind: "MULTIPLE", value: 1.5 },
      },
    ]);
    // Per-security loading sees only the stock's own columns — twenty ETF conditions could not
    // widen a security's load or reach the per-security projectors.
    expect(collectOperands(definition)).toEqual(["price", "series:RSI_14D"]);
    expect(collectEtfOperands(definition)).toEqual(
      new Map([
        ["ETF_GLD", ["etf:ETF_GLD:relative-volume:20"]],
        [
          "ETF_XLK",
          ["etf:ETF_XLK:series:SMA_200D", "etf:ETF_XLK:series:SMA_50D"],
        ],
      ]),
    );
  });
});

describe("evaluating an ETF condition against joined columns", () => {
  const frame = createEvaluationFrame({
    securityId: "security-1",
    symbol: "ALFA",
    name: "Alfa Corp",
    dates: ["2026-01-05", "2026-01-06", "2026-01-07"],
    closes: Float64Array.from([100, 101, 102]),
    columns: new Map([
      ["series:RSI_14D", Float64Array.from([20, 20, 20])],
      ["etf:ETF_XLK:series:RSI_14D", Float64Array.from([80, Number.NaN, 80])],
      ["etf:ETF_XLK:series:SMA_50D", Float64Array.from([60, 61, 62])],
      ["etf:ETF_XLK:series:SMA_200D", Float64Array.from([50, 51, 52])],
    ]),
    periodStartIndex: 0,
  });

  it("reads the ETF column, never the stock's column of the same identity", () => {
    const condition: StrategyCondition = {
      id: "c-1",
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    };
    // The stock's own RSI is 20 on every session; only the ETF's 80 can satisfy this.
    expect(evaluateMarketCondition(condition, frame, 0)).toBe(Evaluability.TRUE);
    // A session the ETF has no finalized bar for is NOT_EVALUABLE, never carried forward.
    expect(evaluateMarketCondition(condition, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
    expect(evaluateMarketCondition(condition, frame, 2)).toBe(Evaluability.TRUE);

    const stockCondition: StrategyCondition = {
      id: "c-2",
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    };
    // And the stock condition still reads the stock: 20 is not above 50.
    expect(evaluateMarketCondition(stockCondition, frame, 0)).toBe(
      Evaluability.FALSE,
    );
  });

  it("compares an ETF moving average with the same ETF's value series", () => {
    const condition: StrategyCondition = {
      id: "c-3",
      metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: "SMA_200D" },
    };
    // XLK's SMA 50D (60) above XLK's SMA 200D (50): the Value resolved on the same ETF. The
    // frame deliberately carries no stock `series:SMA_200D`, so resolving the Value against the
    // stock would have read NaN and reported NOT_EVALUABLE instead.
    expect(evaluateMarketCondition(condition, frame, 0)).toBe(Evaluability.TRUE);
  });

  it("round-trips the key builder: etfOperand is what decode reverses", () => {
    const key = etfOperand("ETF_XLK", "series:RSI_14D");
    expect(decodeEtfOperand(key)).toEqual({
      code: "ETF_XLK",
      base: "series:RSI_14D",
    });
  });
});
