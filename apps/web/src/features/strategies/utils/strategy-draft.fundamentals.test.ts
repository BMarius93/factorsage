import {
  checkStrategyValue,
  conditionOperatorsFor,
  FUNDAMENTAL_METRIC_CATALOG,
  STRATEGY_SCHEMA_VERSION,
  validateStrategyDefinition,
  type FundamentalMetricId,
  type StrategyCondition,
  type StrategyDetailResponse,
  type StrategyMetric,
  type StrategyValue,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  draftFrom,
  draftPayload,
  emptyDraft,
  rowAt,
  strategyDraftReducer,
  type PredicateRef,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "./strategy-draft";

/**
 * The draft reducer with Fundamental Metrics.
 *
 * Nothing here is Fundamentals-specific in the reducer: a category change installs the category's
 * first metric at its own starting rule, and a metric change keeps an operator and Value only where
 * the canonical registry says the new metric can carry them. These cases prove that the registry's
 * answers for the new family leave no stale or incompatible Value behind.
 */

function apply(
  state: StrategyDraftState,
  ...actions: StrategyDraftAction[]
): StrategyDraftState {
  return actions.reduce(strategyDraftReducer, state);
}

const BUY_ROW: PredicateRef = {
  levelKind: "BUY",
  levelIndex: 0,
  part: "CONDITION",
  conditionIndex: 0,
};
const BUY_TRIGGER: PredicateRef = {
  levelKind: "BUY",
  levelIndex: 0,
  part: "TRIGGER",
};

function fundamental(metricId: FundamentalMetricId): StrategyMetric {
  return { kind: "FUNDAMENTAL", metricId };
}

function unitOf(metricId: FundamentalMetricId) {
  return FUNDAMENTAL_METRIC_CATALOG.find((entry) => entry.id === metricId)!
    .unit;
}

function withOneBuyLevel(): StrategyDraftState {
  return apply(emptyDraft(), { type: "addLevel", levelKind: "BUY" });
}

function buyRow(state: StrategyDraftState) {
  return rowAt(state.definition, BUY_ROW) as StrategyCondition;
}

describe("the Fundamentals category in the draft", () => {
  it("installs the first metric at its own starting rule, which saves", () => {
    const state = apply(withOneBuyLevel(), {
      type: "setCategory",
      ref: BUY_ROW,
      category: "FUNDAMENTALS",
    });
    expect(buyRow(state)).toMatchObject({
      metric: fundamental("REVENUE_GROWTH_TTM_YOY"),
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 0 },
    });
    expect(validateStrategyDefinition(state.definition)).toEqual([]);
  });

  it("switches Fundamentals -> Price -> Fundamentals leaving nothing of either behind", () => {
    const fundamentals = apply(
      withOneBuyLevel(),
      { type: "setCategory", ref: BUY_ROW, category: "FUNDAMENTALS" },
      { type: "setMetric", ref: BUY_ROW, metric: fundamental("ROIC_TTM") },
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "PERCENT", value: 15 },
      },
    );
    const price = apply(fundamentals, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "PRICE",
    });
    expect(buyRow(price)).toMatchObject({
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
    });
    expect(buyRow(price).value.kind).toBe("SERIES");
    expect(validateStrategyDefinition(price.definition)).toEqual([]);

    const back = apply(price, {
      type: "setCategory",
      ref: BUY_ROW,
      category: "FUNDAMENTALS",
    });
    // A category change starts over: not ROIC, not `is below`, not 15%.
    expect(buyRow(back)).toMatchObject({
      metric: fundamental("REVENUE_GROWTH_TTM_YOY"),
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 0 },
    });
  });

  it("keeps a rule across two percentage metrics, and starts over for a ratio", () => {
    const roic = apply(
      withOneBuyLevel(),
      { type: "setCategory", ref: BUY_ROW, category: "FUNDAMENTALS" },
      { type: "setMetric", ref: BUY_ROW, metric: fundamental("ROIC_TTM") },
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "PERCENT", value: 15 },
      },
    );
    const roe = apply(roic, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: fundamental("ROE_TTM"),
    });
    expect(buyRow(roe)).toMatchObject({
      metric: fundamental("ROE_TTM"),
      operator: "IS_BELOW",
      value: { kind: "PERCENT", value: 15 },
    });

    // 15% is not a Debt / Equity threshold: the operator and the Value start over together.
    const leverage = apply(roe, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: fundamental("DEBT_TO_EQUITY"),
    });
    expect(buyRow(leverage)).toMatchObject({
      metric: fundamental("DEBT_TO_EQUITY"),
      operator: "IS_ABOVE",
      value: { kind: "MULTIPLE", value: 1 },
    });

    // Between two ratios a fitting threshold survives, two decimals included.
    const liquidity = apply(
      leverage,
      { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "MULTIPLE", value: 0.75 },
      },
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: fundamental("CURRENT_RATIO"),
      },
    );
    expect(buyRow(liquidity)).toMatchObject({
      metric: fundamental("CURRENT_RATIO"),
      operator: "IS_BELOW",
      value: { kind: "MULTIPLE", value: 0.75 },
    });
  });

  it("drops a signed ratio's negative threshold when the next ratio has a floor", () => {
    const coverage = apply(
      withOneBuyLevel(),
      {
        type: "setMetric",
        ref: BUY_ROW,
        metric: fundamental("INTEREST_COVERAGE_TTM"),
      },
      {
        type: "setValue",
        ref: BUY_ROW,
        value: { kind: "MULTIPLE", value: -2 },
      },
    );
    expect(validateStrategyDefinition(coverage.definition)).toEqual([]);
    const leverage = apply(coverage, {
      type: "setMetric",
      ref: BUY_ROW,
      metric: fundamental("DEBT_TO_EQUITY"),
    });
    expect(buyRow(leverage).value).toEqual({ kind: "MULTIPLE", value: 1 });
    expect(validateStrategyDefinition(leverage.definition)).toEqual([]);
  });

  it("never leaves an incompatible Value behind, across every pair of the fifteen", () => {
    const sample = (metricId: FundamentalMetricId): StrategyValue =>
      unitOf(metricId) === "PERCENT"
        ? { kind: "PERCENT", value: 7.5 }
        : { kind: "MULTIPLE", value: 2.25 };
    for (const from of FUNDAMENTAL_METRIC_CATALOG) {
      for (const to of FUNDAMENTAL_METRIC_CATALOG) {
        const state = apply(
          withOneBuyLevel(),
          { type: "setMetric", ref: BUY_ROW, metric: fundamental(from.id) },
          { type: "setOperator", ref: BUY_ROW, operator: "IS_BELOW" },
          { type: "setValue", ref: BUY_ROW, value: sample(from.id) },
          { type: "setMetric", ref: BUY_ROW, metric: fundamental(to.id) },
        );
        const row = buyRow(state);
        const context = `${from.id} -> ${to.id}`;
        expect(row.metric, context).toEqual(fundamental(to.id));
        expect(checkStrategyValue(row.metric, row.value), context).toEqual({
          compatible: true,
        });
        expect(conditionOperatorsFor(row.metric), context).toContain(
          row.operator,
        );
        // Kept exactly when the unit is the same; otherwise the new metric's own starting rule.
        if (from.unit === to.unit) {
          expect(row.value, context).toEqual(sample(from.id));
          expect(row.operator, context).toBe("IS_BELOW");
        } else {
          expect(row.value, context).toEqual(
            to.unit === "PERCENT"
              ? { kind: "PERCENT", value: 0 }
              : { kind: "MULTIPLE", value: 1 },
          );
          expect(row.operator, context).toBe("IS_ABOVE");
        }
        expect(validateStrategyDefinition(state.definition), context).toEqual(
          [],
        );
      }
    }
  });

  it("replaces a hand-dispatched `is close to`, which no Fundamental offers", () => {
    const state = apply(
      withOneBuyLevel(),
      { type: "setMetric", ref: BUY_ROW, metric: fundamental("ROA_TTM") },
      { type: "setOperator", ref: BUY_ROW, operator: "IS_CLOSE_TO" },
    );
    expect(buyRow(state).operator).toBe("IS_ABOVE");
  });
});

describe("a Trigger row and Fundamentals", () => {
  function withTrigger(): StrategyDraftState {
    return apply(withOneBuyLevel(), {
      type: "addTrigger",
      ref: { levelKind: "BUY", levelIndex: 0 },
    });
  }

  it("has no Fundamentals category to choose: choosing it changes nothing", () => {
    const before = withTrigger();
    const after = apply(before, {
      type: "setCategory",
      ref: BUY_TRIGGER,
      category: "FUNDAMENTALS",
    });
    expect(after).toBe(before);
  });

  it("marks a hand-dispatched Fundamental Trigger invalid rather than accepting it quietly", () => {
    const state = apply(withTrigger(), {
      type: "setMetric",
      ref: BUY_TRIGGER,
      metric: fundamental("ROIC_TTM"),
    });
    const issues = validateStrategyDefinition(state.definition);
    expect(issues.map((issue) => issue.code)).toContain(
      "METRIC_NOT_ALLOWED_IN_PART",
    );
    expect(
      issues.find((issue) => issue.code === "METRIC_NOT_ALLOWED_IN_PART")?.path,
    ).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "TRIGGER",
      field: "METRIC",
    });
  });

  it("leaves a Fundamental Condition beside the Trigger untouched", () => {
    const state = apply(
      withTrigger(),
      { type: "setMetric", ref: BUY_ROW, metric: fundamental("ROIC_TTM") },
      { type: "setCategory", ref: BUY_TRIGGER, category: "MOVING_AVERAGES" },
    );
    expect(buyRow(state).metric).toEqual(fundamental("ROIC_TTM"));
    expect(validateStrategyDefinition(state.definition)).toEqual([]);
  });
});

describe("editing a saved Fundamental strategy", () => {
  function saved(): StrategyDetailResponse {
    return {
      ownership: "USER",
      canEdit: true,
      id: "s-fundamentals",
      name: "Quality at a fair leverage",
      buyLevelCount: 2,
      sellLevelCount: 0,
      hasFinalExit: true,
      versionNumber: 3,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z",
      definition: {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          {
            id: "b1",
            percentage: 50,
            signal: {
              conditions: [
                {
                  id: "c1",
                  metric: fundamental("ROIC_TTM"),
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 15 },
                },
                {
                  id: "c2",
                  metric: fundamental("DEBT_TO_EQUITY"),
                  operator: "IS_BELOW",
                  value: { kind: "MULTIPLE", value: 0.75 },
                },
              ],
            },
          },
          {
            id: "b2",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c3",
                  metric: fundamental("REVENUE_GROWTH_TTM_YOY"),
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 10 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
        finalExit: {
          id: "x1",
          rules: [
            {
              id: "r1",
              signal: {
                conditions: [
                  {
                    id: "c4",
                    metric: fundamental("NET_MARGIN_TTM"),
                    operator: "IS_BELOW",
                    value: { kind: "PERCENT", value: 0 },
                  },
                ],
              },
            },
          ],
        },
      },
    };
  }

  it("loads and would save exactly what was stored", () => {
    const draft = draftFrom(saved());
    expect(draftPayload(draft).definition).toEqual(saved().definition);
    expect(validateStrategyDefinition(draft.definition)).toEqual([]);
  });

  it("changes only the edited Value", () => {
    const edited = apply(draftFrom(saved()), {
      type: "setValue",
      ref: { ...BUY_ROW, conditionIndex: 1 },
      value: { kind: "MULTIPLE", value: 0.5 },
    });
    const conditions = edited.definition.buyLevels[0]!.signal.conditions;
    expect(conditions[0]).toEqual(
      saved().definition.buyLevels[0]!.signal.conditions[0],
    );
    expect(conditions[1]).toEqual({
      id: "c2",
      metric: fundamental("DEBT_TO_EQUITY"),
      operator: "IS_BELOW",
      value: { kind: "MULTIPLE", value: 0.5 },
    });
    expect(edited.definition.finalExit).toEqual(saved().definition.finalExit);
  });

  it("moves, removes and adds around Fundamental rows without disturbing them", () => {
    const original = saved().definition;
    const moved = apply(draftFrom(saved()), {
      type: "moveLevel",
      ref: { levelKind: "BUY", levelIndex: 1 },
      direction: -1,
    });
    expect(moved.definition.buyLevels.map((level) => level.id)).toEqual([
      "b2",
      "b1",
    ]);
    expect(moved.definition.buyLevels[1]).toEqual(original.buyLevels[0]);

    const removed = apply(draftFrom(saved()), {
      type: "removeCondition",
      ref: { ...BUY_ROW, conditionIndex: 0 },
    });
    expect(removed.definition.buyLevels[0]!.signal.conditions).toEqual([
      original.buyLevels[0]!.signal.conditions[1],
    ]);

    const withRule = apply(draftFrom(saved()), { type: "addExitRule" });
    expect(withRule.definition.finalExit!.rules[0]).toEqual(
      original.finalExit!.rules[0],
    );
    expect(withRule.definition.finalExit!.rules).toHaveLength(2);
    const withoutRule = apply(withRule, {
      type: "removeExitRule",
      ruleIndex: 1,
    });
    expect(withoutRule.definition.finalExit).toEqual(original.finalExit);
    expect(validateStrategyDefinition(withoutRule.definition)).toEqual([]);
  });
});
