import {
  STRATEGY_MAX_EXIT_RULES,
  conditionOperatorsFor,
  strategyMetricCategories,
  strategyMetricCategory,
  strategyMetricKey,
  strategyMetricOptions,
  validateStrategy,
  valueSpecFor,
  type StrategyDefinition,
  type StrategyMetric,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  draftFrom,
  draftPayload,
  emptyDraft,
  rowWithId,
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

  it("finds a row by its id wherever it sits, and still after a row before it is removed", () => {
    // The explanation panel follows a row by id, so a removal above it never hands the explanation
    // to whichever row moves into the old position.
    const ref = { levelKind: "BUY", levelIndex: 0 } as const;
    const state = apply(
      withOneBuyLevel(),
      { type: "addCondition", ref },
      { type: "addTrigger", ref },
      { type: "addLevel", levelKind: "FINAL_EXIT" },
    );
    const buy = state.definition.buyLevels[0]!.signal;
    const second = buy.conditions[1]!;
    const trigger = buy.trigger!;
    const exitRow = state.definition.finalExit!.rules[0]!.signal.conditions[0]!;
    expect(rowWithId(state.definition, second.id)).toBe(second);
    expect(rowWithId(state.definition, trigger.id)).toBe(trigger);
    expect(rowWithId(state.definition, exitRow.id)).toBe(exitRow);
    expect(rowWithId(state.definition, "no-such-row")).toBeUndefined();

    const removed = apply(state, { type: "removeCondition", ref: BUY_ROW });
    expect(removed.definition.buyLevels[0]!.signal.conditions[0]!.id).toBe(
      second.id,
    );
    expect(rowWithId(removed.definition, second.id)).toBe(second);
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

describe("category and metric", () => {
  const INSIDER_SELLERS_180D: StrategyMetric = {
    kind: "INSIDER_ACTIVITY",
    measure: "SELLERS",
    lookback: 180,
    roles: ["CEO", "CFO"],
  };

  it("starts every new row on the first category's first metric, never on an empty one", () => {
    const state = apply(
      withOneBuyLevel(),
      { type: "addCondition", ref: { levelKind: "BUY", levelIndex: 0 } },
      { type: "addTrigger", ref: { levelKind: "BUY", levelIndex: 0 } },
      { type: "addLevel", levelKind: "SELL" },
      { type: "addLevel", levelKind: "FINAL_EXIT" },
    );
    const buy = state.definition.buyLevels[0]!.signal;
    for (const row of [
      ...buy.conditions,
      buy.trigger!,
      ...state.definition.sellLevels[0]!.signal.conditions,
      ...state.definition.finalExit!.rules[0]!.signal.conditions,
    ]) {
      expect(row.metric).toEqual({ kind: "PRICE" });
      expect(strategyMetricCategory(row.metric)).toBe("PRICE");
    }
    expect(buy.conditions[0]).toMatchObject({
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: "SMA_20D" },
    });
    expect(buy.trigger).toMatchObject({
      operator: "CROSSES_ABOVE",
      value: { kind: "SERIES", seriesId: "SMA_20D" },
    });
  });

  it("installs the first metric of a chosen category, reconciling operator and value", () => {
    const rsi = apply(withOneBuyLevel(), {
      type: "setCategory",
      ref: BUY_ROW,
      category: "OSCILLATORS",
    });
    expect(firstCondition(rsi.definition)).toMatchObject({
      metric: { kind: "OSCILLATOR", seriesId: "RSI_7D" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    });

    const insider = apply(rsi, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "INSIDER_ACTIVITY",
    });
    expect(firstCondition(insider.definition)?.metric).toEqual({
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
    });
  });

  it("ignores a category the row's level or half of a signal does not offer", () => {
    const state = apply(withOneBuyLevel(), {
      type: "addTrigger",
      ref: { levelKind: "BUY", levelIndex: 0 },
    });
    // Volume is condition-only and Position does not exist before a buy.
    expect(
      strategyDraftReducer(state, {
        type: "setCategory",
        ref: { levelKind: "BUY", levelIndex: 0, part: "TRIGGER" },
        category: "VOLUME",
      }),
    ).toBe(state);
    expect(
      strategyDraftReducer(state, {
        type: "setCategory",
        ref: BUY_ROW,
        category: "POSITION",
      }),
    ).toBe(state);
  });

  it("does nothing when the category chosen is the row's own", () => {
    const configured = apply(withOneBuyLevel(), {
      type: "setMetric",
      ref: BUY_ROW,
      metric: INSIDER_SELLERS_180D,
    });
    expect(
      strategyDraftReducer(configured, {
        type: "setCategory",
        ref: BUY_ROW,
        category: "INSIDER_ACTIVITY",
      }),
    ).toBe(configured);
  });

  it("starts a new category on its own rule, never on the previous rule's operator or threshold", () => {
    // `Price is below SMA 200D` must not become `Insider buyers is below 0`, which is never true,
    // and an insider count of 3 must not become an RSI level of 3.
    const below = apply(
      withOneBuyLevel(),
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      { type: "setCategory", ref: BUY_ROW, category: "INSIDER_ACTIVITY" },
    );
    expect(firstCondition(below.definition)).toMatchObject({
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 0 },
    });
    const rsi = apply(
      below,
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      { type: "setValue", ref: BUY_ROW, value: { kind: "NUMBER", value: 3 } },
      { type: "setCategory", ref: BUY_ROW, category: "OSCILLATORS" },
    );
    expect(firstCondition(rsi.definition)).toMatchObject({
      metric: { kind: "OSCILLATOR", seriesId: "RSI_7D" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    });
  });

  it("keeps the operator and threshold across metrics of one category when the threshold still fits", () => {
    const rsi = apply(
      withOneBuyLevel(),
      { type: "setCategory", ref: BUY_ROW, category: "OSCILLATORS" },
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      { type: "setValue", ref: BUY_ROW, value: { kind: "NUMBER", value: 30 } },
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      },
    );
    expect(firstCondition(rsi.definition)).toMatchObject({
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "IS_BELOW",
      value: { kind: "NUMBER", value: 30 },
    });
  });

  it("replaces the operator together with a threshold the new metric cannot take", () => {
    // `Gain is below -50%` cannot become `Loss is below 0%` — Loss is never negative — so the
    // replacement is Loss's own starting rule.
    const sellRow = {
      levelKind: "SELL",
      levelIndex: 0,
      part: "CONDITION",
      conditionIndex: 0,
    } as const;
    const state = apply(
      withOneBuyLevel(),
      { type: "addLevel", levelKind: "SELL" },
      { type: "setMetric", ref: sellRow, metric: { kind: "GAIN" } },
      { type: "setOperator", ref: sellRow, operator: "IS_BELOW" },
      {
        type: "setValue",
        ref: sellRow,
        value: { kind: "PERCENT", value: -50 },
      },
      { type: "setMetric", ref: sellRow, metric: { kind: "LOSS" } },
    );
    expect(state.definition.sellLevels[0]?.signal.conditions[0]).toMatchObject({
      metric: { kind: "LOSS" },
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 0 },
    });
  });

  it("C: never carries a configured metric's configuration into another category", () => {
    const configured = apply(withOneBuyLevel(), {
      type: "setMetric",
      ref: BUY_ROW,
      metric: INSIDER_SELLERS_180D,
    });
    expect(firstCondition(configured.definition)?.metric).toEqual(
      INSIDER_SELLERS_180D,
    );

    const congress = apply(configured, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "CONGRESSIONAL_TRADING",
    });
    expect(firstCondition(congress.definition)?.metric).toEqual({
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 30,
      scope: { kind: "ANY" },
      chamber: "ANY",
    });

    // Coming back is a fresh start too: the 180D and the role filter are gone, not remembered.
    const back = apply(congress, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "INSIDER_ACTIVITY",
    });
    expect(firstCondition(back.definition)?.metric).toEqual({
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
    });

    const price = apply(configured, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "PRICE",
    });
    expect(firstCondition(price.definition)?.metric).toEqual({ kind: "PRICE" });
  });

  it("starts a newly chosen metric of the same category at its own default configuration", () => {
    const configured = apply(withOneBuyLevel(), {
      type: "setMetric",
      ref: BUY_ROW,
      metric: INSIDER_SELLERS_180D,
    });
    const buyers = strategyMetricCategories("BUY")
      .find((category) => category.id === "INSIDER_ACTIVITY")!
      .options.find(
        (option) =>
          strategyMetricKey(option.metric) === "INSIDER_ACTIVITY:BUYERS",
      )!.metric;
    const state = apply(configured, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: buyers,
    });
    expect(firstCondition(state.definition)?.metric).toEqual({
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
    });
  });

  it("keeps identity, category, operator and value when only the configuration changes", () => {
    const configured = apply(
      withOneBuyLevel(),
      { type: "setCategory", ref: BUY_ROW, category: "INSIDER_ACTIVITY" },
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      { type: "setValue", ref: BUY_ROW, value: { kind: "NUMBER", value: 3 } },
    );
    // What the Configure dialog dispatches: the same metric, reconfigured.
    const reconfigured = apply(configured, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 180 },
    });
    const before = firstCondition(configured.definition)!;
    const after = firstCondition(reconfigured.definition)!;
    expect(strategyMetricKey(after.metric)).toBe(
      strategyMetricKey(before.metric),
    );
    expect(strategyMetricCategory(after.metric)).toBe("INSIDER_ACTIVITY");
    expect(after.operator).toBe("IS_BELOW");
    expect(after.value).toEqual({ kind: "NUMBER", value: 3 });
    expect(after.id).toBe(before.id);
  });

  it("never reaches a row whose category and metric disagree", () => {
    let state = apply(withOneBuyLevel(), {
      type: "addLevel",
      levelKind: "SELL",
    });
    const ref = {
      levelKind: "SELL",
      levelIndex: 0,
      part: "CONDITION",
      conditionIndex: 0,
    } as const;
    for (const category of strategyMetricCategories("SELL")) {
      state = apply(state, { type: "setCategory", ref, category: category.id });
      const metric =
        state.definition.sellLevels[0]!.signal.conditions[0]!.metric;
      expect(strategyMetricCategory(metric)).toBe(category.id);
      for (const option of category.options) {
        state = apply(state, { type: "setMetric", ref, metric: option.metric });
        expect(
          strategyMetricCategory(
            state.definition.sellLevels[0]!.signal.conditions[0]!.metric,
          ),
        ).toBe(category.id);
      }
    }
  });

  it("reports a new row that repeats another as a duplicate rather than removing it", () => {
    // Every new row is a complete rule, so a second one added beside the first says the same thing
    // until it is edited. The canonical validator names it; nothing silently deletes it.
    const state = apply(
      withOneBuyLevel(),
      { type: "setName", name: "Two of the same" },
      { type: "addCondition", ref: { levelKind: "BUY", levelIndex: 0 } },
    );
    const issues = validateStrategy(draftPayload(state));
    expect(issues.map((issue) => issue.code)).toEqual(["DUPLICATE_CONDITION"]);
    expect(issues[0]?.path).toMatchObject({
      part: "CONDITION",
      conditionIndex: 1,
    });
  });

  it("leaves a loaded strategy exactly as saved", () => {
    const definition: StrategyDefinition = {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: INSIDER_SELLERS_180D,
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 2 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
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
      definition,
    });
    expect(draft.definition).toBe(definition);
    expect(draftPayload(draft).definition).toBe(definition);
  });
});
