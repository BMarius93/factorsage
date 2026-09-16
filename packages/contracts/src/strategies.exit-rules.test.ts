import { describe, expect, it } from "vitest";
import {
  STRATEGY_LEGACY_SCHEMA_VERSION,
  STRATEGY_MAX_EXIT_RULES,
  STRATEGY_SCHEMA_VERSION,
  describeStrategy,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  upgradeStrategyDefinitionDocument,
  validateStrategyDefinition,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValidationIssue,
} from "./strategies.js";

/**
 * FINAL EXIT as **one** action with alternative Exit Rules: the document that expresses it, the
 * rules that keep it well-formed, and — the load-bearing part — the proof that every strategy
 * written before Exit Rules existed still means exactly what it meant.
 *
 * `ai/product/strategies.md` § FINAL EXIT is the product decision this suite checks. Evaluation is
 * not here: what `A OR B` *does* over data is proven in `@intrinsic/strategy`.
 */

function priceBelow(seriesId: "SMA_200D" | "EMA_50D", id: string): StrategyCondition {
  return {
    id,
    metric: { kind: "PRICE" },
    operator: "IS_BELOW",
    value: { kind: "SERIES", seriesId },
  };
}

function rsiAbove(value: number, id: string): StrategyCondition {
  return {
    id,
    metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value },
  };
}

function priceCrossesBelow(id: string): StrategyTrigger {
  return {
    id,
    metric: { kind: "PRICE" },
    operator: "CROSSES_BELOW",
    value: { kind: "SERIES", seriesId: "SMA_200D" },
  };
}

const BUY_LEVEL = {
  id: "buy-1",
  percentage: 25 as const,
  signal: { conditions: [priceBelow("SMA_200D", "buy-c1")] },
};

/** A version 2 definition with the given Exit Rules. */
function withRules(
  rules: readonly { id: string; signal: StrategySignal }[],
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [BUY_LEVEL],
    sellLevels: [],
    finalExit: { id: "exit-1", rules: [...rules] },
  };
}

/** Exactly what a strategy saved before Exit Rules existed looks like on disk. */
function legacyDocument(signal: StrategySignal): Record<string, unknown> {
  return {
    schemaVersion: STRATEGY_LEGACY_SCHEMA_VERSION,
    buyLevels: [BUY_LEVEL],
    sellLevels: [],
    finalExit: { id: "exit-1", signal },
  };
}

const RULE_ONE: StrategySignal = {
  conditions: [priceBelow("SMA_200D", "r1-c1"), priceBelow("EMA_50D", "r1-c2")],
};
const RULE_TWO: StrategySignal = { conditions: [rsiAbove(80, "r2-c1")] };
const RULE_THREE: StrategySignal = { conditions: [rsiAbove(75, "r3-c1")] };

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("schema version 1 documents keep working without user intervention", () => {
  const legacy = legacyDocument(RULE_ONE);

  it("reads a version 1 FINAL EXIT as one Exit Rule carrying the same signal", () => {
    const normalized = normalizeStrategyDefinition(legacy);

    expect(normalized.schemaVersion).toBe(STRATEGY_SCHEMA_VERSION);
    expect(normalized.finalExit?.rules).toHaveLength(1);
    expect(normalized.finalExit?.rules[0]?.signal).toEqual(RULE_ONE);
  });

  it("validates a version 1 document without a single issue", () => {
    expect(validateStrategyDefinition(legacy)).toEqual([]);
  });

  /**
   * A version snapshot is immutable and is read many times. If the upgrade invented an id — a UUID,
   * a counter — two reads of one row would produce two different documents, and anything comparing
   * them would report a change that never happened.
   */
  it("upgrades deterministically, reusing FINAL EXIT's own id for its single rule", () => {
    const first = normalizeStrategyDefinition(legacy);
    const second = normalizeStrategyDefinition(
      JSON.parse(JSON.stringify(legacy)) as unknown,
    );

    expect(first).toEqual(second);
    expect(first.finalExit?.rules[0]?.id).toBe("exit-1");
  });

  it("is idempotent: upgrading an already-upgraded document changes nothing", () => {
    const once = upgradeStrategyDefinitionDocument(legacy);
    expect(upgradeStrategyDefinitionDocument(once)).toEqual(once);
    expect(upgradeStrategyDefinitionDocument(withRules([{ id: "r1", signal: RULE_ONE }]))).toEqual(
      withRules([{ id: "r1", signal: RULE_ONE }]),
    );
  });

  it("passes every other field through untouched, including a broken one", () => {
    const upgraded = upgradeStrategyDefinitionDocument({
      ...legacy,
      sellLevels: [{ id: "sell-1", percentage: 33, signal: RULE_TWO }],
    }) as StrategyDefinition;

    expect(upgraded.sellLevels[0]?.percentage).toBe(33);
    // Still reported against the row that carries it, not swallowed by the upgrade.
    expect(
      codesOf(validateStrategyDefinition(upgraded)),
    ).toContain("PERCENTAGE_INVALID");
  });

  it("leaves a strategy with no FINAL EXIT alone beyond the version bump", () => {
    const upgraded = normalizeStrategyDefinition({
      schemaVersion: STRATEGY_LEGACY_SCHEMA_VERSION,
      buyLevels: [BUY_LEVEL],
      sellLevels: [],
    });
    expect(upgraded.finalExit).toBeUndefined();
  });

  /**
   * The compatibility guarantee that matters most.
   *
   * `StrategyVersion.definitionHash` is taken over this string and decides whether a save appends a
   * version. `MonitorSignalState.signalFingerprint` is the level-scoped half of it and decides
   * whether a Monitor's transition state survives a Strategy edit. If either moved, every existing
   * strategy would silently gain a version and every Monitor with a FINAL EXIT would lose its
   * latch — on deploy, with nobody having edited anything.
   */
  it("fingerprints a version 1 strategy exactly as its upgraded form", () => {
    const upgraded = normalizeStrategyDefinition(legacy);

    expect(strategyDefinitionFingerprint(upgraded)).toBe(
      strategyDefinitionFingerprint({
        ...upgraded,
        // The same logic expressed as the version 1 document did: one FINAL EXIT signal.
        finalExit: { id: "exit-1", rules: [{ id: "exit-1", signal: RULE_ONE }] },
      }),
    );
    // An OR of one alternative is that alternative, so the level fingerprint is the signal's own.
    expect(
      strategyFinalExitFingerprint({
        id: "exit-1",
        rules: [{ id: "exit-1", signal: RULE_ONE }],
      }),
    ).toBe(strategySignalFingerprint(RULE_ONE));
  });
});

describe("persisting and reloading multiple Exit Rules", () => {
  it("keeps two rules, in order, through normalization", () => {
    const normalized = normalizeStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
      ]),
    );

    expect(normalized.finalExit?.rules.map((rule) => rule.id)).toEqual([
      "r1",
      "r2",
    ]);
    expect(normalized.finalExit?.rules[0]?.signal).toEqual(RULE_ONE);
    expect(normalized.finalExit?.rules[1]?.signal).toEqual(RULE_TWO);
  });

  it("keeps three rules in the order they were written", () => {
    const normalized = normalizeStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
        { id: "r3", signal: RULE_THREE },
      ]),
    );

    expect(normalized.finalExit?.rules.map((rule) => rule.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("is idempotent, so a reload-edit-save round trip converges", () => {
    const once = normalizeStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
      ]),
    );
    expect(normalizeStrategyDefinition(once)).toEqual(once);
  });

  it("gives each rule its own optional trigger", () => {
    const normalized = normalizeStrategyDefinition(
      withRules([
        { id: "r1", signal: { ...RULE_ONE, trigger: priceCrossesBelow("r1-t") } },
        { id: "r2", signal: RULE_TWO },
      ]),
    );

    expect(normalized.finalExit?.rules[0]?.signal.trigger?.id).toBe("r1-t");
    // Rule 2 carries none, and rule 1's is not lifted to the level.
    expect(normalized.finalExit?.rules[1]?.signal.trigger).toBeUndefined();
    expect(normalized.finalExit).not.toHaveProperty("trigger");
  });
});

describe("validation of the Exit Rule list", () => {
  it("refuses a FINAL EXIT with no rules at all", () => {
    expect(codesOf(validateStrategyDefinition(withRules([])))).toEqual([
      "EXIT_RULE_REQUIRED",
    ]);
  });

  it("refuses an exit rule whose signal is empty", () => {
    const issues = validateStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: { conditions: [] } },
      ]),
    );

    expect(codesOf(issues)).toEqual(["SIGNAL_EMPTY"]);
    expect(issues[0]?.path).toEqual({
      levelKind: "FINAL_EXIT",
      ruleIndex: 1,
      part: "EXIT_RULE",
    });
  });

  it("refuses more rules than the limit", () => {
    const rules = Array.from(
      { length: STRATEGY_MAX_EXIT_RULES + 1 },
      (_value, index) => ({
        id: `r${index}`,
        signal: { conditions: [rsiAbove(index + 1, `c${index}`)] },
      }),
    );
    expect(codesOf(validateStrategyDefinition(withRules(rules)))).toEqual([
      "TOO_MANY_EXIT_RULES",
    ]);
  });

  /** ORing a rule with itself changes nothing, exactly as ANDing a condition with itself does. */
  it("refuses two rules that say the same thing, however they are keyed", () => {
    const issues = validateStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_TWO },
        { id: "r2", signal: { conditions: [rsiAbove(80, "different-id")] } },
      ]),
    );

    expect(codesOf(issues)).toEqual(["DUPLICATE_EXIT_RULE"]);
    expect(issues[0]?.path.ruleIndex).toBe(1);
    expect(issues[0]?.message).toContain("exit rule 1");
  });

  /**
   * AND is commutative, so `A AND B` and `B AND A` are the same rule.
   *
   * The documented guarantee is that two *semantically identical* Exit Rules are rejected, and
   * writing one of them the other way round does not make FINAL EXIT occur any more often — it is
   * the same mistake as writing it twice.
   */
  it("refuses two rules whose conditions are the same set in a different order", () => {
    const a = priceBelow("SMA_200D", "a");
    const b = rsiAbove(80, "b");
    const issues = validateStrategyDefinition(
      withRules([
        { id: "r1", signal: { conditions: [a, b] } },
        {
          id: "r2",
          signal: {
            conditions: [
              { ...b, id: "b-again" },
              { ...a, id: "a-again" },
            ],
          },
        },
      ]),
    );

    expect(codesOf(issues)).toEqual(["DUPLICATE_EXIT_RULE"]);
    expect(issues[0]?.path.ruleIndex).toBe(1);
  });

  /** A reordering that is not a duplicate stays accepted: the rules differ by a real predicate. */
  it("accepts reordered conditions when the rules are genuinely different", () => {
    const a = priceBelow("SMA_200D", "a");
    const b = rsiAbove(80, "b");
    const c = rsiAbove(70, "c");
    expect(
      validateStrategyDefinition(
        withRules([
          { id: "r1", signal: { conditions: [a, b] } },
          { id: "r2", signal: { conditions: [c, { ...a, id: "a2" }] } },
        ]),
      ),
    ).toEqual([]);
  });

  /** A Trigger is its own slot, so an identical condition set with a Trigger is a different rule. */
  it("does not treat a triggered rule as a duplicate of the untriggered one", () => {
    const a = priceBelow("SMA_200D", "a");
    expect(
      validateStrategyDefinition(
        withRules([
          { id: "r1", signal: { conditions: [a] } },
          {
            id: "r2",
            signal: {
              conditions: [{ ...a, id: "a2" }],
              trigger: priceCrossesBelow("t"),
            },
          },
        ]),
      ),
    ).toEqual([]);
  });

  /**
   * The order-insensitive identity is validation-only and must not leak into persistence.
   *
   * Condition order stays exactly as authored in the normalized document, and the fingerprints that
   * key `definitionHash` and a Monitor's latch keep distinguishing the two orders — changing that
   * would append a version and reset transition state for documents nobody edited.
   */
  it("keeps authored condition order, and leaves both fingerprints order-sensitive", () => {
    const a = priceBelow("SMA_200D", "a");
    const b = rsiAbove(80, "b");
    const forward = withRules([{ id: "r1", signal: { conditions: [a, b] } }]);
    const reversed = withRules([{ id: "r1", signal: { conditions: [b, a] } }]);

    // Authored order survives normalization untouched.
    expect(
      normalizeStrategyDefinition(reversed).finalExit?.rules[0]?.signal.conditions.map(
        (condition) => condition.id,
      ),
    ).toEqual(["b", "a"]);

    // And the persisted identities still tell the two documents apart.
    expect(strategyDefinitionFingerprint(forward)).not.toBe(
      strategyDefinitionFingerprint(reversed),
    );
    expect(
      strategyFinalExitFingerprint(forward.finalExit as never),
    ).not.toBe(strategyFinalExitFingerprint(reversed.finalExit as never));
  });

  it("accepts two rules that differ only in their threshold", () => {
    expect(
      validateStrategyDefinition(
        withRules([
          { id: "r1", signal: RULE_TWO },
          { id: "r2", signal: RULE_THREE },
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses two rules claiming one identifier", () => {
    expect(
      codesOf(
        validateStrategyDefinition(
          withRules([
            { id: "r1", signal: RULE_ONE },
            { id: "r1", signal: RULE_TWO },
          ]),
        ),
      ),
    ).toEqual(["DUPLICATE_ID"]);
  });

  /**
   * The supported grammar is OR of AND groups and nothing else. A rule owns `id` and `signal`, so a
   * nested rule list is not merely rejected at runtime — there is no field to put one in.
   */
  it("refuses a nested rule list inside a rule", () => {
    expect(
      codesOf(
        validateStrategyDefinition(
          withRules([
            {
              id: "r1",
              signal: RULE_ONE,
              rules: [{ id: "r1a", signal: RULE_TWO }],
            } as never,
          ]),
        ),
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
  });

  it("refuses a version 2 FINAL EXIT still written as a flat signal", () => {
    const codes = codesOf(
      validateStrategyDefinition({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [BUY_LEVEL],
        sellLevels: [],
        finalExit: { id: "exit-1", signal: RULE_ONE },
      }),
    );
    expect(codes).toContain("UNKNOWN_FIELD");
    expect(codes).toContain("SHAPE_INVALID");
  });

  it("addresses a condition inside a rule by its rule and its row", () => {
    const issues = validateStrategyDefinition(
      withRules([
        { id: "r1", signal: RULE_ONE },
        {
          id: "r2",
          signal: {
            conditions: [
              {
                id: "bad",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 900 },
              },
            ],
          },
        },
      ]),
    );

    expect(issues[0]?.path).toEqual({
      levelKind: "FINAL_EXIT",
      ruleIndex: 1,
      part: "CONDITION",
      conditionIndex: 0,
      field: "VALUE",
    });
  });

  it("keeps Gain and Loss usable inside an exit rule", () => {
    expect(
      validateStrategyDefinition(
        withRules([
          {
            id: "r1",
            signal: {
              conditions: [
                {
                  id: "g1",
                  metric: { kind: "LOSS" },
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 20 },
                },
              ],
            },
          },
          { id: "r2", signal: RULE_TWO },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("fingerprint determinism", () => {
  const twoRules = withRules([
    { id: "r1", signal: RULE_ONE },
    { id: "r2", signal: RULE_TWO },
  ]);

  it("produces the same string for the same logic, every time", () => {
    expect(strategyDefinitionFingerprint(twoRules)).toBe(
      strategyDefinitionFingerprint(
        normalizeStrategyDefinition(JSON.parse(JSON.stringify(twoRules))),
      ),
    );
  });

  it("ignores row identifiers, because re-keying a row changes no logic", () => {
    expect(
      strategyFinalExitFingerprint({
        id: "exit-1",
        rules: [
          { id: "r1", signal: RULE_ONE },
          { id: "r2", signal: RULE_TWO },
        ],
      }),
    ).toBe(
      strategyFinalExitFingerprint({
        id: "exit-renamed",
        rules: [
          { id: "whatever", signal: RULE_ONE },
          { id: "else", signal: RULE_TWO },
        ],
      }),
    );
  });

  it("changes when a rule is added, edited or removed", () => {
    const one = strategyFinalExitFingerprint({
      id: "e",
      rules: [{ id: "r1", signal: RULE_ONE }],
    });
    const two = strategyFinalExitFingerprint({
      id: "e",
      rules: [
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
      ],
    });
    const edited = strategyFinalExitFingerprint({
      id: "e",
      rules: [
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_THREE },
      ],
    });

    expect(new Set([one, two, edited]).size).toBe(3);
  });

  /** A multi-rule value can never be mistaken for a single Signal's value. */
  it("never collides a rule list with one rule's own serialization", () => {
    const pair = strategyFinalExitFingerprint({
      id: "e",
      rules: [
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
      ],
    });
    expect(pair.startsWith('["OR"')).toBe(true);
    expect(pair).not.toBe(strategySignalFingerprint(RULE_ONE));
  });
});

describe("the strategy in words", () => {
  it("prints one FINAL EXIT with its rules separated by OR", () => {
    const lines = describeStrategy(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: RULE_TWO },
      ]),
    );

    expect(lines.slice(2)).toEqual([
      { kind: "LEVEL", levelKind: "FINAL_EXIT" },
      { kind: "EXIT_RULE", index: 1 },
      { kind: "CONDITION", text: "Price is below SMA 200D" },
      {
        kind: "CONDITION",
        text: "Price is below EMA 50D",
        connector: "AND",
      },
      { kind: "EXIT_RULE", index: 2, connector: "OR" },
      { kind: "CONDITION", text: "RSI 14D is above 80" },
    ]);
    // One FINAL EXIT heading, never one per rule.
    expect(
      lines.filter(
        (line) => line.kind === "LEVEL" && line.levelKind === "FINAL_EXIT",
      ),
    ).toHaveLength(1);
  });

  it("prints a single-rule FINAL EXIT exactly as it always did", () => {
    const lines = describeStrategy(
      withRules([{ id: "r1", signal: RULE_TWO }]),
    );

    expect(lines.slice(2)).toEqual([
      { kind: "LEVEL", levelKind: "FINAL_EXIT" },
      { kind: "CONDITION", text: "RSI 14D is above 80" },
    ]);
  });

  it("shows an incomplete rule instead of silently dropping it", () => {
    const lines = describeStrategy(
      withRules([
        { id: "r1", signal: RULE_ONE },
        { id: "r2", signal: { conditions: [] } },
      ]),
    );

    expect(lines).toContainEqual({ kind: "EMPTY", levelKind: "FINAL_EXIT" });
  });
});
