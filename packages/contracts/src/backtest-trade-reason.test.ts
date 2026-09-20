import { describe, expect, it } from "vitest";
import { backtestTradeReason, backtestTradeReasonIndex } from "./backtests.js";
import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "./strategies.js";

/**
 * A trade log has to answer "why did this happen?" from the run's **own** snapshot.
 *
 * The descriptions are the canonical Strategy language — the same `describeCondition` /
 * `describeTrigger` the Strategy logic preview and the Dashboard's "Why" column use — so a metric
 * is never named two ways. What these cases pin is the resolution: which level, which Exit Rule,
 * and what is said when the run never recorded enough to know.
 */

function priceAbove(
  id: string,
  value: number,
): StrategySignal["conditions"][0] {
  return {
    id,
    metric: { kind: "PRICE" },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value },
  };
}

const CROSSES_SMA_20D: StrategySignal["trigger"] = {
  id: "t1",
  metric: { kind: "PRICE" },
  operator: "CROSSES_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_20D" },
};

const DEFINITION: StrategyDefinition = {
  schemaVersion: STRATEGY_SCHEMA_VERSION,
  buyLevels: [
    {
      id: "b25",
      percentage: 25,
      signal: { conditions: [priceAbove("c1", 50)] },
    },
    {
      id: "b100",
      percentage: 100,
      signal: {
        conditions: [priceAbove("c2", 10)],
        trigger: CROSSES_SMA_20D,
      },
    },
  ],
  sellLevels: [
    {
      id: "s50",
      percentage: 50,
      signal: {
        conditions: [
          {
            id: "c3",
            metric: { kind: "GAIN" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 40 },
          },
        ],
      },
    },
  ],
  finalExit: {
    id: "fx",
    rules: [
      {
        id: "fx-rule-1",
        signal: {
          conditions: [
            {
              id: "c4",
              metric: { kind: "LOSS" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 30 },
            },
          ],
        },
      },
      {
        id: "fx-rule-2",
        signal: {
          conditions: [
            {
              id: "c5",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_BELOW",
              value: { kind: "NUMBER", value: 30 },
            },
          ],
        },
      },
    ],
  },
};

const INDEX = backtestTradeReasonIndex(DEFINITION);

function reasonFor(trade: {
  action: "BUY" | "SELL" | "FINAL_EXIT";
  levelId?: string | null;
  exitRuleId?: string | null;
  source?: "STRATEGY" | "END_OF_BACKTEST";
}) {
  return backtestTradeReason(INDEX, {
    source: trade.source ?? "STRATEGY",
    action: trade.action,
    levelId: trade.levelId ?? null,
    exitRuleId: trade.exitRuleId ?? null,
  });
}

describe("backtestTradeReason", () => {
  it("describes a BUY from the conditions of the level that fired", () => {
    expect(reasonFor({ action: "BUY", levelId: "b25" })).toEqual({
      kind: "STRATEGY",
      conditions: ["Price is above 50"],
    });
  });

  it("carries the Trigger separately, so a crossing is not read as a standing condition", () => {
    expect(reasonFor({ action: "BUY", levelId: "b100" })).toEqual({
      kind: "STRATEGY",
      conditions: ["Price is above 10"],
      trigger: "Price crosses above SMA 20D",
    });
  });

  it("describes a SELL from its own level, never from the whole strategy", () => {
    expect(reasonFor({ action: "SELL", levelId: "s50" })).toEqual({
      kind: "STRATEGY",
      conditions: ["Gain is above 40%"],
    });
  });

  it("resolves a FINAL EXIT to the Exit Rule that actually matched", () => {
    expect(
      reasonFor({
        action: "FINAL_EXIT",
        levelId: "fx",
        exitRuleId: "fx-rule-2",
      }),
    ).toEqual({
      kind: "STRATEGY",
      exitRule: 2,
      conditions: ["RSI 14D is below 30"],
    });
  });

  it("never claims every OR alternative fired", () => {
    const reason = reasonFor({
      action: "FINAL_EXIT",
      levelId: "fx",
      exitRuleId: "fx-rule-1",
    });
    expect(reason).toEqual({
      kind: "STRATEGY",
      exitRule: 1,
      conditions: ["Loss is above 30%"],
    });
    expect(JSON.stringify(reason)).not.toContain("RSI");
  });

  it("says nothing rather than guessing when a multi-rule FINAL EXIT recorded no rule", () => {
    // A run executed before the engine recorded which alternative matched. Naming one would be a
    // fabrication and naming all of them would be a lie.
    expect(
      reasonFor({ action: "FINAL_EXIT", levelId: "fx", exitRuleId: null }),
    ).toBeNull();
  });

  it("still resolves a single-rule FINAL EXIT with no recorded rule, because there is no choice", () => {
    const single = backtestTradeReasonIndex({
      ...DEFINITION,
      finalExit: { id: "fx", rules: [DEFINITION.finalExit!.rules[0]!] },
    });
    expect(
      backtestTradeReason(single, {
        source: "STRATEGY",
        action: "FINAL_EXIT",
        levelId: "fx",
        exitRuleId: null,
      }),
    ).toEqual({ kind: "STRATEGY", conditions: ["Loss is above 30%"] });
  });

  it("does not number a lone Exit Rule, which is not an alternative to anything", () => {
    const single = backtestTradeReasonIndex({
      ...DEFINITION,
      finalExit: { id: "fx", rules: [DEFINITION.finalExit!.rules[0]!] },
    });
    const reason = backtestTradeReason(single, {
      source: "STRATEGY",
      action: "FINAL_EXIT",
      levelId: "fx",
      exitRuleId: "fx-rule-1",
    });
    expect(reason).not.toHaveProperty("exitRule");
  });

  it("reports an end-of-backtest liquidation as itself, whatever the action says", () => {
    expect(reasonFor({ action: "SELL", source: "END_OF_BACKTEST" })).toEqual({
      kind: "END_OF_BACKTEST",
    });
  });

  it("uses the run's snapshot, so editing the strategy afterwards changes nothing", () => {
    // The same level id, described by a *later* definition. The run's own index keeps answering
    // with what the run executed.
    const edited = backtestTradeReasonIndex({
      ...DEFINITION,
      buyLevels: [
        {
          id: "b25",
          percentage: 25,
          signal: { conditions: [priceAbove("c1", 999)] },
        },
      ],
    });
    expect(reasonFor({ action: "BUY", levelId: "b25" })).toEqual({
      kind: "STRATEGY",
      conditions: ["Price is above 50"],
    });
    expect(
      backtestTradeReason(edited, {
        source: "STRATEGY",
        action: "BUY",
        levelId: "b25",
        exitRuleId: null,
      }),
    ).toEqual({ kind: "STRATEGY", conditions: ["Price is above 999"] });
  });

  it("says nothing for a level the snapshot does not contain", () => {
    expect(reasonFor({ action: "BUY", levelId: "gone" })).toBeNull();
    expect(reasonFor({ action: "BUY", levelId: null })).toBeNull();
  });
});
