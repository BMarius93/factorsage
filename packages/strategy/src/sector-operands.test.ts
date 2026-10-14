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
  collectSectorOperands,
  decodeEtfOperand,
  decodeSectorOperand,
  isEtfOperand,
  isSectorOperand,
  metricOperand,
  sectorOperand,
  valueOperand,
} from "./operands.js";
import { evaluateMarketCondition } from "./predicates.js";

const SECTOR = { kind: "STOCK_SECTOR" } as const;
const XLK = { kind: "ETF", code: "ETF_XLK" } as const;

function definitionOf(conditions: StrategyCondition[]): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 25, signal: { conditions } }],
    sellLevels: [],
  };
}

describe("Stock's Sector operand keys", () => {
  it("builds the sector family over the stock encoding, naming no fund", () => {
    expect(
      metricOperand({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: SECTOR }),
    ).toBe("sector:series:RSI_14D");
    expect(metricOperand({ kind: "PRICE", source: SECTOR })).toBe("sector:price");
    expect(
      metricOperand({ kind: "RELATIVE_VOLUME", period: 50, source: SECTOR }),
    ).toBe("sector:relative-volume:50");
    expect(valueOperand({ kind: "SERIES", seriesId: "SMA_200D" }, SECTOR)).toBe(
      "sector:series:SMA_200D",
    );
    expect(valueOperand({ kind: "NUMBER", value: 50 }, SECTOR)).toBeNull();
    expect(sectorOperand("series:EMA_20D")).toBe("sector:series:EMA_20D");
  });

  it("decodes only its own family, and the ETF decoder never claims it", () => {
    expect(decodeSectorOperand("sector:series:RSI_14D")).toBe("series:RSI_14D");
    expect(decodeSectorOperand("sector:")).toBeNull();
    expect(decodeSectorOperand("series:RSI_14D")).toBeNull();
    expect(decodeSectorOperand("etf:ETF_XLK:price")).toBeNull();
    expect(isSectorOperand("sector:price")).toBe(true);
    expect(isSectorOperand("etf:ETF_XLK:price")).toBe(false);
    expect(isEtfOperand("sector:price")).toBe(false);
    expect(decodeEtfOperand("sector:price")).toBeNull();
  });

  it("partitions collection three ways: stock per security, named ETFs per code, sector once", () => {
    const definition = definitionOf([
      {
        id: "c-stock",
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      },
      {
        id: "c-xlk",
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      },
      {
        id: "c-sector-ma",
        metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: SECTOR },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        id: "c-sector-price",
        metric: { kind: "PRICE", source: SECTOR },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_50D" },
      },
    ]);
    // The sector rules widen neither the per-security load nor any named ETF's columns.
    expect(collectOperands(definition)).toEqual(["price", "series:RSI_14D"]);
    expect(collectEtfOperands(definition)).toEqual(
      new Map([["ETF_XLK", ["etf:ETF_XLK:series:RSI_14D"]]]),
    );
    expect(collectSectorOperands(definition)).toEqual([
      "sector:price",
      "sector:series:SMA_200D",
      "sector:series:SMA_50D",
    ]);
    expect(
      collectSectorOperands(
        definitionOf([
          {
            id: "c-1",
            metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK },
            operator: "IS_ABOVE",
            value: { kind: "NUMBER", value: 50 },
          },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("evaluating a Stock's Sector condition against joined columns", () => {
  const condition: StrategyCondition = {
    id: "c-1",
    metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: SECTOR },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value: 50 },
  };

  it("reads the sector column, never the stock's or a named ETF's column of the same identity", () => {
    const frame = createEvaluationFrame({
      securityId: "security-1",
      symbol: "ALFA",
      name: "Alfa Corp",
      dates: ["2026-01-05", "2026-01-06", "2026-01-07"],
      closes: Float64Array.from([100, 101, 102]),
      columns: new Map([
        ["series:RSI_14D", Float64Array.from([20, 20, 20])],
        ["etf:ETF_XLK:series:RSI_14D", Float64Array.from([20, 20, 20])],
        ["sector:series:RSI_14D", Float64Array.from([80, Number.NaN, 40])],
      ]),
      periodStartIndex: 0,
    });
    expect(evaluateMarketCondition(condition, frame, 0)).toBe(Evaluability.TRUE);
    // No finalized session of the stock's sector ETF that day: not evaluable, never carried.
    expect(evaluateMarketCondition(condition, frame, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
    expect(evaluateMarketCondition(condition, frame, 2)).toBe(Evaluability.FALSE);
  });

  it("is not evaluable on every session when the stock's sector resolved to no fund", () => {
    // What the frame join writes for a missing or unsupported sector: an all-NaN column.
    const frame = createEvaluationFrame({
      securityId: "security-2",
      symbol: "NOSECTOR",
      name: "No Sector Corp",
      dates: ["2026-01-05", "2026-01-06"],
      closes: Float64Array.from([10, 11]),
      columns: new Map([
        ["series:RSI_14D", Float64Array.from([90, 90])],
        ["sector:series:RSI_14D", Float64Array.from([Number.NaN, Number.NaN])],
      ]),
      periodStartIndex: 0,
    });
    for (const index of [0, 1]) {
      expect(evaluateMarketCondition(condition, frame, index)).toBe(
        Evaluability.NOT_EVALUABLE,
      );
    }
  });

  it("compares a sector moving average with the same sector fund's value series", () => {
    const frame = createEvaluationFrame({
      securityId: "security-1",
      symbol: "ALFA",
      name: "Alfa Corp",
      dates: ["2026-01-05"],
      closes: Float64Array.from([100]),
      columns: new Map([
        ["series:SMA_200D", Float64Array.from([1000])],
        ["sector:series:SMA_50D", Float64Array.from([60])],
        ["sector:series:SMA_200D", Float64Array.from([50])],
      ]),
      periodStartIndex: 0,
    });
    expect(
      evaluateMarketCondition(
        {
          id: "c-2",
          metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: SECTOR },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
        frame,
        0,
      ),
    ).toBe(Evaluability.TRUE);
  });
});
