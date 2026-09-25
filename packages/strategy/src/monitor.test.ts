import {
  STRATEGY_SCHEMA_VERSION,
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame, type EvaluationFrame } from "./frame.js";
import { seriesOperand } from "./operands.js";
import {
  evaluateLevelWithoutPosition,
  evaluateSignalWithoutPosition,
  monitorStrategyLevels,
  signalNeedsPositionState,
} from "./monitor.js";

/**
 * What a Monitor evaluates, and how it evaluates one level of it.
 *
 * Two separate rules are under test. `monitorStrategyLevels` decides *which* levels a Monitor
 * evaluates at all: `Gain` and `Loss` need position state a Monitor does not have, so a level
 * depending on either is excluded whole — never partially evaluated, and never attempted and
 * recorded as undecidable. `evaluateSignalWithoutPosition` then decides one of those levels, where
 * `NOT_EVALUABLE` keeps its own meaning: a Monitor-supported metric whose input was unavailable.
 *
 * Backtests are unaffected; they evaluate Gain and Loss against live position state.
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

const lossAbove10: StrategySignal = {
  conditions: [
    {
      id: "c1",
      metric: { kind: "LOSS" },
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 10 },
    },
  ],
};

/** `Price IS_ABOVE EMA50 AND Gain IS_ABOVE 25%` — the whole-level rule's worked example. */
const priceAboveEmaAndGain: StrategySignal = {
  conditions: [...priceAboveEma.conditions, ...gainAbove25.conditions],
};

/** A market-derived condition gated by a position-dependent Trigger. */
const priceAboveEmaWithGainTrigger: StrategySignal = {
  conditions: [...priceAboveEma.conditions],
  trigger: {
    id: "t1",
    metric: { kind: "GAIN" },
    operator: "CROSSES_ABOVE",
    value: { kind: "PERCENT", value: 25 },
  },
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

/** The level a Monitor addresses, with the fingerprint and event/state kind resolved canonically. */
function level(
  id: string,
  kind: "BUY" | "SELL" | "FINAL_EXIT",
  rules: readonly StrategySignal[],
) {
  return {
    id,
    kind,
    rules,
    ruleIds: rules.length === 1 ? [id] : rules.map((_, index) => `${id}-${index}`),
    fingerprint:
      rules.length === 1
        ? strategySignalFingerprint(rules[0] as StrategySignal)
        : strategyFinalExitFingerprint({
            id,
            rules: rules.map((signal, index) => ({
              id: `${id}-${index}`,
              signal,
            })),
          }),
    hasTrigger: rules.every((signal) => signal.trigger !== undefined),
  };
}

describe("monitorStrategyLevels", () => {
  it("walks BUY, SELL and FINAL EXIT in the definition's own order", () => {
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "b1", signal: priceAboveEma, percentage: 50 },
        { id: "b2", signal: priceCrossesAboveEma, percentage: 50 },
      ],
      sellLevels: [{ id: "s1", signal: gainAbove25, percentage: 25 }],
      finalExit: { id: "f1", rules: [{ id: "f1", signal: priceAboveEma }] },
    };

    // The Gain SELL level is absent: a Monitor holds no position, so it is not part of what a
    // Monitor evaluates. Everything else keeps the definition's own order.
    expect(monitorStrategyLevels(definition)).toEqual([
      level("b1", "BUY", [priceAboveEma]),
      level("b2", "BUY", [priceCrossesAboveEma]),
      level("f1", "FINAL_EXIT", [priceAboveEma]),
    ]);
  });

  /**
   * Two Relative Volume periods are two levels, and a Monitor keys durable state by the level's own
   * fingerprint — so identical fingerprints would have let `RVOL 10` and `RVOL 20` latch on each
   * other's state, one silently resolving the other's Signal on every scan.
   */
  it("gives Relative Volume levels of different periods different fingerprints", () => {
    const rvolAbove = (period: 10 | 20 | 50): StrategySignal => ({
      conditions: [
        {
          id: `c${period}`,
          metric: { kind: "RELATIVE_VOLUME", period },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: 2 },
        },
      ],
    });
    const levels = monitorStrategyLevels({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "b10", signal: rvolAbove(10), percentage: 50 },
        { id: "b20", signal: rvolAbove(20), percentage: 25 },
        { id: "b50", signal: rvolAbove(50), percentage: 25 },
      ],
      sellLevels: [],
    });

    expect(levels).toHaveLength(3);
    expect(new Set(levels.map((entry) => entry.fingerprint)).size).toBe(3);
    // Every level is evaluated: Relative Volume needs no position state.
    expect(levels.map((entry) => entry.id)).toEqual(["b10", "b20", "b50"]);
  });

  it("excludes a level whose condition is Gain or Loss", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          { id: "b1", signal: gainAbove25, percentage: 50 },
          { id: "b2", signal: lossAbove10, percentage: 50 },
        ],
        sellLevels: [],
      }),
    ).toEqual([]);
  });

  /**
   * The whole level goes, not just the offending condition.
   *
   * Evaluating `Price IS_ABOVE EMA50` on its own is a different rule than the user wrote, and would
   * emit Signals the Strategy never asked for.
   */
  it("excludes the whole level when Gain is ANDed with a market condition", () => {
    const levels = monitorStrategyLevels({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "b1", signal: priceAboveEmaAndGain, percentage: 100 }],
      sellLevels: [],
    });

    expect(levels).toEqual([]);
    // Specifically: nothing resembling the market half survived on its own.
    expect(levels.flatMap((entry) => entry.rules)).not.toContainEqual(
      priceAboveEma,
    );
  });

  it("excludes a level whose Trigger is position-dependent", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          { id: "b1", signal: priceAboveEmaWithGainTrigger, percentage: 100 },
        ],
        sellLevels: [],
      }),
    ).toEqual([]);
  });

  it("keeps the evaluable levels of a mixed strategy and drops only the rest", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "b1", signal: priceAboveEma, percentage: 100 }],
        sellLevels: [{ id: "s1", signal: gainAbove25, percentage: 25 }],
      }),
    ).toEqual([level("b1", "BUY", [priceAboveEma])]);
  });

  /**
   * The degenerate case, for completeness of this function's own contract.
   *
   * A *valid* Strategy cannot actually reach it: the canonical grammar refuses `Gain` and `Loss` in
   * a BUY level because they depend on an open position, and requires at least one BUY level — so
   * every Strategy the product accepts has at least one Monitor-evaluable level. This asserts that
   * the function still answers honestly for a document that got here another way, rather than
   * falling back to returning everything.
   */
  it("returns nothing at all when every level is position-dependent", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "b1", signal: gainAbove25, percentage: 100 }],
        sellLevels: [{ id: "s1", signal: lossAbove10, percentage: 25 }],
        finalExit: { id: "f1", rules: [{ id: "f1", signal: lossAbove10 }] },
      }),
    ).toEqual([]);
  });

  it("omits FINAL EXIT when the strategy has none", () => {
    expect(
      monitorStrategyLevels({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "b1", signal: priceAboveEma, percentage: 100 }],
        sellLevels: [],
      }),
    ).toEqual([level("b1", "BUY", [priceAboveEma])]);
  });
});

/**
 * FINAL EXIT with more than one Exit Rule, as a Monitor sees it.
 *
 * A Monitor is not a portfolio: it reports whether a level *matches right now*. FINAL EXIT stays
 * one level with one id, one durable state row and one Signal lifecycle, so the whole question this
 * section answers is "what is the level's single result, and when does its state reset?".
 */
describe("FINAL EXIT with alternative Exit Rules", () => {
  const priceBelowEma: StrategySignal = {
    conditions: [
      {
        id: "c2",
        metric: { kind: "PRICE" },
        operator: "IS_BELOW",
        value: { kind: "SERIES", seriesId: EMA50 },
      },
    ],
  };

  function definitionWithRules(
    rules: readonly StrategySignal[],
  ): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      // Deliberately not one of the exit-rule signals, so "nothing resembling an excluded rule
      // survived" is a real assertion rather than a coincidence of the fixture.
      buyLevels: [
        { id: "b1", signal: priceCrossesAboveEma, percentage: 100 },
      ],
      sellLevels: [],
      finalExit: {
        id: "f1",
        rules: rules.map((signal, index) => ({
          id: `f1-rule-${index + 1}`,
          signal,
        })),
      },
    };
  }

  function finalExitLevel(rules: readonly StrategySignal[]) {
    const level = monitorStrategyLevels(definitionWithRules(rules)).find(
      (entry) => entry.kind === "FINAL_EXIT",
    );
    if (!level) {
      throw new Error("FINAL EXIT was not returned");
    }
    return level;
  }

  it("carries every rule under one level id", () => {
    const level = finalExitLevel([priceAboveEma, priceBelowEma]);

    expect(level.id).toBe("f1");
    expect(level.rules).toEqual([priceAboveEma, priceBelowEma]);
    // Each alternative keeps its own rule-local lifecycle identity.
    expect(level.ruleIds).toEqual(["f1-rule-1", "f1-rule-2"]);
  });

  it("matches when any rule matches, and reports one result", () => {
    // Price 110 against EMA 105: rule 1 (above) is TRUE, rule 2 (below) is FALSE.
    const frame = frameOf([100, 110], [105, 105]);

    expect(
      evaluateLevelWithoutPosition(
        finalExitLevel([priceAboveEma, priceBelowEma]).rules,
        frame,
        1,
      ),
    ).toBe(Evaluability.TRUE);
    // The order of the alternatives changes nothing.
    expect(
      evaluateLevelWithoutPosition(
        finalExitLevel([priceBelowEma, priceAboveEma]).rules,
        frame,
        1,
      ),
    ).toBe(Evaluability.TRUE);
  });

  it("does not match when no rule matches", () => {
    // Price exactly at the EMA: strictly above and strictly below are both FALSE.
    expect(
      evaluateLevelWithoutPosition(
        finalExitLevel([priceAboveEma, priceBelowEma]).rules,
        frameOf([100, 105], [105, 105]),
        1,
      ),
    ).toBe(Evaluability.FALSE);
  });

  /** A rule that definitively matched decides the level, whatever another rule could not read. */
  it("reports a match even when another rule is undecidable", () => {
    const frame = frameOf([100, 110], [105, 105]);
    expect(
      evaluateLevelWithoutPosition(
        [priceAboveEma, priceCrossesAboveEma],
        frame,
        0,
      ),
    ).toBe(Evaluability.NOT_EVALUABLE);
    // Index 1 has a previous value, so the crossing is decidable and the condition is TRUE.
    expect(
      evaluateLevelWithoutPosition(
        [priceAboveEma, priceCrossesAboveEma],
        frame,
        1,
      ),
    ).toBe(Evaluability.TRUE);
  });

  /** Undecidable is never quietly downgraded to "did not match". */
  it("stays undecidable when nothing matched and something could not be read", () => {
    // Price 110 against EMA 105: `is below` is definitively FALSE, and at index 0 the crossing has
    // no previous value to compare against, so the level as a whole is undecided rather than FALSE.
    expect(
      evaluateLevelWithoutPosition(
        [priceBelowEma, priceCrossesAboveEma],
        frameOf([110, 110], [105, 105]),
        0,
      ),
    ).toBe(Evaluability.NOT_EVALUABLE);
  });

  it("fingerprints the level over all of its rules", () => {
    const one = finalExitLevel([priceAboveEma]);
    const two = finalExitLevel([priceAboveEma, priceBelowEma]);
    const edited = finalExitLevel([priceAboveEma, priceCrossesAboveEma]);

    expect(new Set([one.fingerprint, two.fingerprint, edited.fingerprint]).size).toBe(3);
    // A single-rule level keeps the fingerprint that logic always had, so a Monitor's transition
    // state survives the schema upgrade untouched.
    expect(one.fingerprint).toBe(strategySignalFingerprint(priceAboveEma));
  });

  /**
   * Whether a match is an event or a state.
   *
   * Every alternative triggered means the level can only ever match on a transition date, so it is
   * an event. Mixed means a condition-only rule can stay true for days — treating that as an event
   * would re-emit a Signal on every session, which is precisely the Signal spam the condition/event
   * distinction exists to prevent.
   */
  it("is an event only when every rule is triggered", () => {
    expect(finalExitLevel([priceCrossesAboveEma]).hasTrigger).toBe(true);
    expect(
      finalExitLevel([priceCrossesAboveEma, priceCrossesAboveEma]).hasTrigger,
    ).toBe(true);
    expect(finalExitLevel([priceAboveEma]).hasTrigger).toBe(false);
    expect(
      finalExitLevel([priceCrossesAboveEma, priceAboveEma]).hasTrigger,
    ).toBe(false);
  });

  /**
   * Whole-level exclusion, applied to a disjunction.
   *
   * Keeping only the market-derived rules would leave a level that matches on strictly fewer days
   * than the user wrote, and a Monitor reporting "no match" from a subset of someone's logic is the
   * same misreport as evaluating half a conjunction.
   */
  it("excludes the whole level when any rule depends on position state", () => {
    const levels = monitorStrategyLevels(
      definitionWithRules([priceAboveEma, gainAbove25]),
    );

    expect(levels.map((level) => level.kind)).toEqual(["BUY"]);
    expect(levels.flatMap((level) => level.rules)).not.toContainEqual(
      priceAboveEma,
    );
  });

  it("keeps the level when every rule is market-derived", () => {
    expect(
      monitorStrategyLevels(
        definitionWithRules([priceAboveEma, priceBelowEma]),
      ).map((level) => level.kind),
    ).toEqual(["BUY", "FINAL_EXIT"]);
  });
});
