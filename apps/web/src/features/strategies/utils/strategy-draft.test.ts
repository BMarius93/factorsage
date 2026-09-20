import {
  STRATEGY_MAX_EXIT_RULES,
  conditionOperatorsFor,
  strategyMetricOptions,
  validateStrategy,
  valueSpecFor,
  type StrategyDefinition,
  type StrategyMetric,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { draftIssues } from "../hooks/use-strategy-draft";
import {
  authoredDefinition,
  draftFrom,
  draftPayload,
  emptyDraft,
  strategyDraftReducer,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "./strategy-draft";

function apply(
  state: StrategyDraftState,
  ...actions: StrategyDraftAction[]
): StrategyDraftState {
  return actions.reduce(strategyDraftReducer, state);
}

function withOneBuyLevel(): StrategyDraftState {
  return apply(emptyDraft(), { type: "addLevel", levelKind: "BUY" });
}

const BUY_ROW = {
  levelKind: "BUY",
  levelIndex: 0,
  part: "CONDITION",
  conditionIndex: 0,
} as const;

function firstCondition(definition: StrategyDefinition) {
  return definition.buyLevels[0]?.signal.conditions[0];
}

describe("strategy draft reducer", () => {
  it("opens a new level with one usable condition rather than an empty signal", () => {
    const state = withOneBuyLevel();
    const level = state.definition.buyLevels[0];
    expect(level?.percentage).toBe(25);
    expect(level?.signal.conditions).toHaveLength(1);
    expect(level?.signal.trigger).toBeUndefined();
    expect(firstCondition(state.definition)?.metric).toEqual({ kind: "PRICE" });
  });

  it("gives every row a unique id, which the canonical validator requires", () => {
    const state = apply(
      withOneBuyLevel(),
      { type: "addCondition", ref: { levelKind: "BUY", levelIndex: 0 } },
      { type: "addTrigger", ref: { levelKind: "BUY", levelIndex: 0 } },
      { type: "addLevel", levelKind: "SELL" },
      { type: "addLevel", levelKind: "FINAL_EXIT" },
    );
    const ids = [
      ...state.definition.buyLevels.map((level) => level.id),
      ...state.definition.sellLevels.map((level) => level.id),
      ...(state.definition.finalExit ? [state.definition.finalExit.id] : []),
      ...state.definition.buyLevels.flatMap((level) => [
        ...level.signal.conditions.map((row) => row.id),
        ...(level.signal.trigger ? [level.signal.trigger.id] : []),
      ]),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps existing row ids when other rows change, because a level id is Monitor identity", () => {
    // A Monitor keys its durable state by level id across Strategy versions. Editing a rule, adding a
    // level or adding a trigger must therefore never regenerate the ids already saved: a re-keyed
    // level would look removed-and-added and re-emit a Signal for a match that never stopped.
    const before = apply(withOneBuyLevel(), {
      type: "addLevel",
      levelKind: "SELL",
    });
    const buyId = before.definition.buyLevels[0]?.id;
    const conditionId = firstCondition(before.definition)?.id;
    const sellId = before.definition.sellLevels[0]?.id;
    const metric = strategyMetricOptions("BUY").find(
      (option) =>
        option.metric.kind !== firstCondition(before.definition)?.metric.kind,
    )?.metric;
    expect(metric).toBeDefined();

    const after = apply(
      before,
      { type: "setMetric", ref: BUY_ROW, metric: metric as StrategyMetric },
      { type: "addLevel", levelKind: "BUY" },
      { type: "addTrigger", ref: { levelKind: "SELL", levelIndex: 0 } },
      { type: "addLevel", levelKind: "FINAL_EXIT" },
    );

    expect(after.definition.buyLevels[0]?.id).toBe(buyId);
    expect(firstCondition(after.definition)?.id).toBe(conditionId);
    expect(after.definition.sellLevels[0]?.id).toBe(sellId);
    expect(after.definition.buyLevels[1]?.id).not.toBe(buyId);
  });

  it("replaces an operator the new metric does not support", () => {
    const closeTo = apply(withOneBuyLevel(), {
      type: "setOperator",
      ref: BUY_ROW,
      operator: "IS_CLOSE_TO",
    });
    expect(firstCondition(closeTo.definition)?.operator).toBe("IS_CLOSE_TO");

    // RSI supports `is above` and `is below` only, so the operator cannot survive the change.
    const rsi = apply(closeTo, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    });
    const row = firstCondition(rsi.definition);
    expect(row?.operator).toBe("IS_ABOVE");
    expect(conditionOperatorsFor(row!.metric)).toContain(row?.operator);
  });

  it("replaces a value the new metric cannot be compared with", () => {
    const state = apply(withOneBuyLevel(), {
      type: "setValue",
      ref: BUY_ROW,
      value: { kind: "SERIES", seriesId: "EMA_200D" },
    });
    expect(firstCondition(state.definition)?.value).toEqual({
      kind: "SERIES",
      seriesId: "EMA_200D",
    });

    const rsi = apply(state, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    });
    // A series value is meaningless for RSI; the registry's own default takes its place.
    expect(firstCondition(rsi.definition)?.value).toEqual({
      kind: "NUMBER",
      value: 50,
    });
  });

  it("keeps a value the new metric can still be compared with", () => {
    const state = apply(
      withOneBuyLevel(),
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
      },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    );
    const moved = apply(state, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
    });
    // SMA 200D is still a same-timeframe comparison for SMA 50D, so it survives.
    expect(firstCondition(moved.definition)?.value).toEqual({
      kind: "SERIES",
      seriesId: "SMA_200D",
    });
  });

  it("replaces a self-comparison the registry would reject", () => {
    const state = apply(
      withOneBuyLevel(),
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
      },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_200D" },
      },
    );
    const row = firstCondition(state.definition);
    expect(row?.value).not.toEqual({ kind: "SERIES", seriesId: "SMA_200D" });
    const spec = valueSpecFor(row!.metric);
    expect(
      spec.kind === "SERIES" &&
        row?.value.kind === "SERIES" &&
        spec.seriesIds.includes(row.value.seriesId),
    ).toBe(true);
  });

  it("starts every metric the registry offers a level from a compatible value", () => {
    for (const option of strategyMetricOptions("SELL")) {
      const state = apply(
        emptyDraft(),
        { type: "addLevel", levelKind: "SELL" },
        {
          type: "setMetric",
          ref: {
            levelKind: "SELL",
            levelIndex: 0,
            part: "CONDITION",
            conditionIndex: 0,
          },
          metric: option.metric,
        },
      );
      const row = state.definition.sellLevels[0]?.signal.conditions[0];
      expect(row?.metric).toEqual(option.metric);
      expect(row?.value).toBeDefined();
    }
  });

  it("adds at most one trigger and removes it again", () => {
    const ref = { levelKind: "BUY", levelIndex: 0 } as const;
    const added = apply(
      withOneBuyLevel(),
      { type: "addTrigger", ref },
      { type: "addTrigger", ref },
    );
    expect(added.definition.buyLevels[0]?.signal.trigger).toBeDefined();
    const removed = apply(added, { type: "removeTrigger", ref });
    expect(removed.definition.buyLevels[0]?.signal.trigger).toBeUndefined();
  });

  it("reorders levels and preserves the order in the saved payload", () => {
    const state = apply(
      withOneBuyLevel(),
      { type: "addLevel", levelKind: "BUY" },
      {
        type: "setPercentage",
        ref: { levelKind: "BUY", levelIndex: 1 },
        percentage: 100,
      },
      {
        type: "moveLevel",
        ref: { levelKind: "BUY", levelIndex: 1 },
        direction: -1,
      },
    );
    expect(state.definition.buyLevels.map((level) => level.percentage)).toEqual(
      [100, 25],
    );
    // Moving past the ends is a no-op rather than a wrap-around.
    const clamped = apply(state, {
      type: "moveLevel",
      ref: { levelKind: "BUY", levelIndex: 0 },
      direction: -1,
    });
    expect(
      clamped.definition.buyLevels.map((level) => level.percentage),
    ).toEqual([100, 25]);
  });

  it("never gives FINAL EXIT a percentage", () => {
    const state = apply(
      emptyDraft(),
      { type: "addLevel", levelKind: "FINAL_EXIT" },
      {
        type: "setPercentage",
        ref: { levelKind: "FINAL_EXIT" },
        percentage: 100,
      },
    );
    expect(state.definition.finalExit).toBeDefined();
    expect(state.definition.finalExit).not.toHaveProperty("percentage");
  });

  it("removes FINAL EXIT without leaving an empty key behind", () => {
    const state = apply(
      emptyDraft(),
      { type: "addLevel", levelKind: "FINAL_EXIT" },
      { type: "removeLevel", ref: { levelKind: "FINAL_EXIT" } },
    );
    expect("finalExit" in state.definition).toBe(false);
  });

  it("drops a blank description from the saved payload and trims the name", () => {
    const state = apply(
      withOneBuyLevel(),
      { type: "setName", name: "  Value  " },
      { type: "setDescription", description: "   " },
    );
    const payload = draftPayload(state);
    expect(payload.name).toBe("Value");
    expect("description" in payload).toBe(false);
  });

  it("carries no backtest configuration in the document it would save", () => {
    const payload = draftPayload(withOneBuyLevel());
    expect(Object.keys(payload).sort()).toEqual(["definition", "name"]);
    expect(Object.keys(payload.definition).sort()).toEqual([
      "buyLevels",
      "schemaVersion",
      "sellLevels",
    ]);
  });

  it("offers no position-dependent metric in a BUY level", () => {
    const buyKinds = strategyMetricOptions("BUY").map(
      (option) => option.metric.kind,
    );
    expect(buyKinds).not.toContain("GAIN");
    expect(buyKinds).not.toContain("LOSS");
    const sellKinds: StrategyMetric["kind"][] = strategyMetricOptions(
      "SELL",
    ).map((option) => option.metric.kind);
    expect(sellKinds).toContain("GAIN");
  });
});

/**
 * FINAL EXIT's Exit Rules in the editor: one action, alternatives inside it.
 *
 * The reducer is where "editing rule 1 must not touch rule 2" is actually decided. Structural
 * sharing is the mechanism — an untouched rule keeps its *identity*, not merely an equal value — so
 * these assertions use `toBe` where identity is the point.
 */
describe("final exit rules", () => {
  const FINAL_EXIT = { levelKind: "FINAL_EXIT" } as const;

  function withFinalExit(rules = 1): StrategyDraftState {
    const state = apply(withOneBuyLevel(), {
      type: "addLevel",
      levelKind: "FINAL_EXIT",
    });
    return apply(
      state,
      ...Array.from({ length: rules - 1 }, () => ({
        type: "addExitRule" as const,
      })),
    );
  }

  function rulesOf(state: StrategyDraftState) {
    return state.definition.finalExit?.rules ?? [];
  }

  it("opens FINAL EXIT with exactly one usable exit rule", () => {
    const rules = rulesOf(withFinalExit());
    expect(rules).toHaveLength(1);
    expect(rules[0]?.signal.conditions).toHaveLength(1);
  });

  it("adds a second and a third rule, each with its own identity", () => {
    const state = withFinalExit(3);
    const ids = rulesOf(state).map((rule) => rule.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // Rule ids never collide with the level's own, or with any condition's.
    expect(ids).not.toContain(state.definition.finalExit?.id);
  });

  it("stops at the shared maximum rather than growing without bound", () => {
    let state = withFinalExit();
    for (let index = 0; index < STRATEGY_MAX_EXIT_RULES + 5; index += 1) {
      state = strategyDraftReducer(state, { type: "addExitRule" });
    }
    expect(rulesOf(state)).toHaveLength(STRATEGY_MAX_EXIT_RULES);
  });

  it("edits rule 1 without touching rule 2", () => {
    const before = withFinalExit(2);
    const untouched = rulesOf(before)[1];

    const after = apply(before, {
      type: "setOperator",
      ref: { ...FINAL_EXIT, ruleIndex: 0, part: "CONDITION", conditionIndex: 0 },
      operator: "IS_BELOW",
    });

    expect(rulesOf(after)[0]?.signal.conditions[0]?.operator).toBe("IS_BELOW");
    // Not merely equal: the same object, so nothing re-rendered or re-keyed rule 2.
    expect(rulesOf(after)[1]).toBe(untouched);
    expect(rulesOf(after)[0]?.id).toBe(rulesOf(before)[0]?.id);
  });

  it("edits rule 2 without touching rule 1", () => {
    const before = withFinalExit(2);
    const untouched = rulesOf(before)[0];

    const after = apply(before, {
      type: "addCondition",
      ref: { ...FINAL_EXIT, ruleIndex: 1 },
    });

    expect(rulesOf(after)[1]?.signal.conditions).toHaveLength(2);
    expect(rulesOf(after)[0]).toBe(untouched);
  });

  it("gives each rule its own trigger", () => {
    const state = apply(withFinalExit(2), {
      type: "addTrigger",
      ref: { ...FINAL_EXIT, ruleIndex: 0 },
    });

    expect(rulesOf(state)[0]?.signal.trigger).toBeDefined();
    expect(rulesOf(state)[1]?.signal.trigger).toBeUndefined();
  });

  it("removes rule 2 and leaves rule 1 exactly as it was", () => {
    const before = withFinalExit(2);
    const kept = rulesOf(before)[0];

    const after = apply(before, { type: "removeExitRule", ruleIndex: 1 });

    expect(rulesOf(after)).toHaveLength(1);
    expect(rulesOf(after)[0]).toBe(kept);
  });

  it("removes the middle rule of three and leaves the outer two, in order", () => {
    const before = withFinalExit(3);
    const [first, , third] = rulesOf(before);

    const after = apply(before, { type: "removeExitRule", ruleIndex: 1 });

    expect(rulesOf(after)).toEqual([first, third]);
  });

  it("removes the first rule when there is more than one, leaving no stale data", () => {
    const before = withFinalExit(2);
    const second = rulesOf(before)[1];

    const after = apply(before, { type: "removeExitRule", ruleIndex: 0 });

    expect(rulesOf(after)).toEqual([second]);
  });

  /** FINAL EXIT with no way to match is not a document the product allows. */
  it("refuses to remove the last rule; removing FINAL EXIT is what that means", () => {
    const state = withFinalExit();
    expect(
      rulesOf(strategyDraftReducer(state, { type: "removeExitRule", ruleIndex: 0 })),
    ).toHaveLength(1);

    const removed = apply(state, { type: "removeLevel", ref: FINAL_EXIT });
    expect(removed.definition.finalExit).toBeUndefined();
    expect(removed.definition).not.toHaveProperty("finalExit");
  });

  it("ignores rule actions when there is no FINAL EXIT at all", () => {
    const state = withOneBuyLevel();
    expect(strategyDraftReducer(state, { type: "addExitRule" })).toBe(state);
    expect(
      strategyDraftReducer(state, { type: "removeExitRule", ruleIndex: 0 }),
    ).toBe(state);
  });

  it("saves a valid multi-rule document the canonical validator accepts", () => {
    const state = apply(withFinalExit(2), {
      type: "setOperator",
      ref: { ...FINAL_EXIT, ruleIndex: 1, part: "CONDITION", conditionIndex: 0 },
      operator: "IS_BELOW",
    });

    // Distinct rules, so nothing is a duplicate; a real save would be rejected otherwise.
    expect(
      validateStrategy({ ...draftPayload(state), name: "Two ways out" }),
    ).toEqual([]);
  });
});

describe("rows waiting for a metric (UI-013)", () => {
  it("marks every row an Add creates as unset, and authors it once a metric is chosen", () => {
    let state = strategyDraftReducer(emptyDraft(), {
      type: "addLevel",
      levelKind: "BUY",
    });
    const rowId = state.definition.buyLevels[0]!.signal.conditions[0]!.id;
    expect(state.unset).toEqual([rowId]);

    state = strategyDraftReducer(state, {
      type: "addCondition",
      ref: { levelKind: "BUY", levelIndex: 0 },
    });
    expect(state.unset).toHaveLength(2);

    state = strategyDraftReducer(state, {
      type: "setMetric",
      ref: { levelKind: "BUY", levelIndex: 0, part: "CONDITION", conditionIndex: 0 },
      metric: { kind: "PRICE" },
    });
    expect(state.unset).not.toContain(rowId);
    expect(state.unset).toHaveLength(1);
  });

  it("leaves unset rows out of the authored document, never out of the draft", () => {
    const state = strategyDraftReducer(emptyDraft(), {
      type: "addLevel",
      levelKind: "BUY",
    });
    expect(state.definition.buyLevels[0]!.signal.conditions).toHaveLength(1);
    expect(authoredDefinition(state).buyLevels[0]!.signal.conditions).toHaveLength(0);
  });

  it("forgets the ids of removed rows", () => {
    let state = strategyDraftReducer(emptyDraft(), {
      type: "addLevel",
      levelKind: "BUY",
    });
    state = strategyDraftReducer(state, {
      type: "removeLevel",
      ref: { levelKind: "BUY", levelIndex: 0 },
    });
    expect(state.unset).toEqual([]);
  });

  it("asks for the metric instead of judging a placeholder", () => {
    let state = strategyDraftReducer(emptyDraft(), { type: "setName", name: "x" });
    state = strategyDraftReducer(state, { type: "addLevel", levelKind: "BUY" });
    state = strategyDraftReducer(state, {
      type: "addCondition",
      ref: { levelKind: "BUY", levelIndex: 0 },
    });
    const issues = draftIssues(state);
    // Two identical placeholders would otherwise be a DUPLICATE_CONDITION the user never wrote.
    expect(issues.map((issue) => issue.message)).toEqual([
      "Choose a metric.",
      "Choose a metric.",
    ]);
    expect(issues.every((issue) => issue.path.field === "METRIC")).toBe(true);
  });

  it("leaves a loaded strategy exactly as saved", () => {
    const draft = draftFrom({
      ownership: "USER",
      canEdit: true,
      id: "s1",
      name: "Saved",
      buyLevelCount: 1,
      sellLevelCount: 0,
      hasFinalExit: false,
      versionNumber: 1,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      definition: {
        schemaVersion: 2,
        buyLevels: [
          {
            id: "b1",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      },
    });
    expect(draft.unset).toEqual([]);
    expect(authoredDefinition(draft)).toBe(draft.definition);
  });
});
