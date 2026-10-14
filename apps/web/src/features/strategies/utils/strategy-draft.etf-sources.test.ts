import {
  STRATEGY_ETF_SOURCES,
  STRATEGY_LEVEL_KINDS,
  checkStrategyValue,
  conditionOperatorsFor,
  strategyMetricKey,
  strategyMetricOptions,
  strategyMetricSource,
  strategyMetricUnderSource,
  validateStrategy,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategyMetricSource,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  chooseMetricOutcome,
  draftPayload,
  emptyDraft,
  mergeMetricChangeResets,
  metricChangeNotice,
  metricChangeResets,
  metricResetNotice,
  strategyDraftReducer,
  type PredicateRef,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "./strategy-draft";

/**
 * A rule's data source through the draft reducer: what a change of source keeps, what it resets,
 * and that it never touches another rule.
 */

const SPY: StrategyMetricSource = { kind: "ETF", code: "SP500" };
const XLK: StrategyMetricSource = { kind: "ETF", code: "ETF_XLK" };
const GLD: StrategyMetricSource = { kind: "ETF", code: "ETF_GLD" };

function apply(
  state: StrategyDraftState,
  ...actions: StrategyDraftAction[]
): StrategyDraftState {
  return actions.reduce(strategyDraftReducer, state);
}

const BUY = { levelKind: "BUY", levelIndex: 0 } as const;
const row = (conditionIndex: number): PredicateRef => ({
  ...BUY,
  part: "CONDITION",
  conditionIndex,
});

function conditions(state: StrategyDraftState): StrategyCondition[] {
  return state.definition.buyLevels[0]?.signal.conditions ?? [];
}

/** A BUY level holding `count` rules, each a distinct stock metric so none repeats another. */
function buyLevelWith(...metrics: StrategyMetric[]): StrategyDraftState {
  let state = apply(emptyDraft(), { type: "addLevel", levelKind: "BUY" });
  metrics.forEach((metric, index) => {
    if (index > 0) {
      state = apply(state, { type: "addCondition", ref: BUY });
    }
    state = apply(state, { type: "setMetric", ref: row(index), metric });
  });
  return state;
}

/** The same move the Metric picker makes for a change of data source. */
function moveSource(
  state: StrategyDraftState,
  conditionIndex: number,
  source: StrategyMetricSource | undefined,
): StrategyDraftState {
  const current = conditions(state)[conditionIndex]!;
  const metric = strategyMetricUnderSource(
    "BUY",
    "CONDITION",
    current.metric,
    source,
  );
  if (!metric) {
    throw new Error("the source does not offer this metric");
  }
  return apply(state, {
    type: "chooseMetric",
    ref: row(conditionIndex),
    metric,
  });
}

describe("a rule's data source in the draft", () => {
  it("starts every new rule on the stock", () => {
    const state = apply(
      emptyDraft(),
      { type: "addLevel", levelKind: "BUY" },
      { type: "addCondition", ref: BUY },
      { type: "addLevel", levelKind: "SELL" },
      { type: "addLevel", levelKind: "FINAL_EXIT" },
    );
    const metrics = [
      ...conditions(state),
      ...(state.definition.sellLevels[0]?.signal.conditions ?? []),
      ...(state.definition.finalExit?.rules[0]?.signal.conditions ?? []),
    ].map((condition) => condition.metric);
    expect(metrics).toHaveLength(4);
    for (const metric of metrics) {
      expect(strategyMetricSource(metric)).toBeUndefined();
      expect(Object.keys(metric)).not.toContain("source");
    }
  });

  it("moves Stock -> SPY -> XLK -> Stock on one rule and never touches the rule beside it", () => {
    const start = apply(
      buyLevelWith(
        { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        { kind: "OSCILLATOR", seriesId: "RSI_7D" },
      ),
      { type: "setOperator", ref: row(0), operator: "IS_BELOW" },
      { type: "setValue", ref: row(0), value: { kind: "NUMBER", value: 35 } },
      { type: "setValue", ref: row(1), value: { kind: "NUMBER", value: 60 } },
    );
    const neighbour = conditions(start)[1];
    const id = conditions(start)[0]!.id;

    const onSpy = moveSource(start, 0, SPY);
    const onXlk = moveSource(onSpy, 0, XLK);
    const back = moveSource(onXlk, 0, undefined);

    expect(conditions(onSpy)[0]?.metric).toEqual({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: SPY,
    });
    expect(conditions(onXlk)[0]?.metric).toEqual({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: XLK,
    });
    // The threshold and the comparison are the user's and survive every move: an RSI of 35 means
    // the same thing whichever instrument it is read from.
    for (const state of [onSpy, onXlk, back]) {
      expect(conditions(state)[0]?.id).toBe(id);
      expect(conditions(state)[0]?.operator).toBe("IS_BELOW");
      expect(conditions(state)[0]?.value).toEqual({ kind: "NUMBER", value: 35 });
      // The rule beside it is the very same object: not re-sourced, not reset, not re-keyed.
      expect(conditions(state)[1]).toBe(neighbour);
    }
    // Back on the stock it is byte-for-byte the rule it started as.
    expect(conditions(back)[0]).toEqual(conditions(start)[0]);
    expect(Object.keys(conditions(back)[0]!.metric)).not.toContain("source");
  });

  it("lets the stock and several ETFs carry the same metric in one signal", () => {
    let state = buyLevelWith(
      { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      { kind: "OSCILLATOR", seriesId: "RSI_7D" },
      { kind: "OSCILLATOR", seriesId: "RSI_21D" },
    );
    // Three rules on one identity, told apart by their source alone.
    state = apply(
      state,
      {
        type: "chooseMetric",
        ref: row(1),
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK },
      },
      {
        type: "chooseMetric",
        ref: row(2),
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: GLD },
      },
    );
    expect(conditions(state).map((condition) => strategyMetricKey(condition.metric))).toEqual([
      "OSCILLATOR:RSI_14D",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
      "ETF(ETF_GLD)|OSCILLATOR:RSI_14D",
    ]);
    expect(
      validateStrategy(draftPayload({ ...state, name: "Mixed sources" })),
    ).toEqual([]);

    // The same ETF twice is one rule written twice, and is reported as such.
    const repeated = apply(state, {
      type: "chooseMetric",
      ref: row(2),
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK },
    });
    expect(
      validateStrategy(draftPayload({ ...repeated, name: "Mixed sources" })).map(
        (issue) => issue.code,
      ),
    ).toEqual(["DUPLICATE_CONDITION"]);
  });

  it("keeps a series Value that the ETF's metric can still be compared with", () => {
    const start = apply(buyLevelWith({ kind: "PRICE" }), {
      type: "setValue",
      ref: row(0),
      value: { kind: "SERIES", seriesId: "SMA_200D" },
    });
    const moved = moveSource(start, 0, SPY);
    expect(conditions(moved)[0]).toMatchObject({
      metric: { kind: "PRICE", source: SPY },
      operator: "IS_ABOVE",
      // SPY's own SMA 200D: the Value resolves against the rule's source, not the stock's.
      value: { kind: "SERIES", seriesId: "SMA_200D" },
    });
  });

  it("resets a Value an ETF cannot be compared with, operator and all, to the metric's own rule", () => {
    const start = apply(
      buyLevelWith({ kind: "PRICE" }),
      { type: "setOperator", ref: row(0), operator: "IS_BELOW" },
      {
        type: "setValue",
        ref: row(0),
        // An intrinsic value is a statement about a company; an ETF has none.
        value: { kind: "SERIES", seriesId: "BALANCED" },
      },
    );
    const moved = moveSource(start, 0, XLK);
    const rule = conditions(moved)[0]!;
    expect(rule.metric).toEqual({ kind: "PRICE", source: XLK });
    expect(rule.operator).toBe("IS_ABOVE");
    expect(rule.value).toEqual({ kind: "SERIES", seriesId: "SMA_20D" });
    expect(checkStrategyValue(rule.metric, rule.value).compatible).toBe(true);
    // Never an invisible invalid value: the document is valid the moment the move lands.
    expect(validateStrategy(draftPayload({ ...moved, name: "ETF price" }))).toEqual(
      [],
    );
  });

  it("starts an ETF metric of another family from its own rule, discarding a stock-only one", () => {
    const start = buyLevelWith({ kind: "FUNDAMENTAL", metricId: "ROIC_TTM" });
    // A Fundamental has no ETF form, so the picker offers no move for it…
    expect(
      strategyMetricUnderSource(
        "BUY",
        "CONDITION",
        conditions(start)[0]!.metric,
        XLK,
      ),
    ).toBeUndefined();
    // …and choosing one of the ETF's metrics is an ordinary change of category.
    const chosen = apply(start, {
      type: "chooseMetric",
      ref: row(0),
      metric: { kind: "RELATIVE_VOLUME", period: 20, source: GLD },
    });
    expect(conditions(chosen)[0]).toMatchObject({
      metric: { kind: "RELATIVE_VOLUME", period: 20, source: GLD },
      operator: "IS_ABOVE",
      value: { kind: "MULTIPLE", value: 1 },
    });
  });

  it("never offers a Trigger an ETF metric: the choice leaves the rule exactly as it was", () => {
    const withTrigger = apply(buyLevelWith({ kind: "PRICE" }), {
      type: "addTrigger",
      ref: BUY,
    });
    const triggerRef: PredicateRef = { ...BUY, part: "TRIGGER" };
    for (const etf of STRATEGY_ETF_SOURCES) {
      const onTrigger = apply(withTrigger, {
        type: "chooseMetric",
        ref: triggerRef,
        metric: { kind: "PRICE", source: { kind: "ETF", code: etf.code } },
      });
      expect(onTrigger).toBe(withTrigger);
    }
  });

  it("cannot make a stock-only metric read an ETF: a forged source is refused when the rule is judged", () => {
    // The reducer moves typed metrics and the canonical validator is the boundary that judges them,
    // so a source forged onto a Fundamental is never evaluated as an ETF rule — it is not a rule.
    const forged = apply(buyLevelWith({ kind: "PRICE" }), {
      type: "chooseMetric",
      ref: row(0),
      metric: {
        kind: "FUNDAMENTAL",
        metricId: "ROIC_TTM",
        source: XLK,
      } as unknown as StrategyMetric,
    });
    expect(
      validateStrategy(draftPayload({ ...forged, name: "Forged" })).map(
        (issue) => issue.code,
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
  });

  it("reaches all 20 x 21 ETF metrics from a stock rule, each landing valid in every level kind", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const ref: PredicateRef =
        levelKind === "FINAL_EXIT"
          ? { levelKind, ruleIndex: 0, part: "CONDITION", conditionIndex: 0 }
          : { levelKind, levelIndex: 0, part: "CONDITION", conditionIndex: 0 };
      const base = apply(
        emptyDraft(),
        { type: "addLevel", levelKind: "BUY" },
        ...(levelKind === "BUY"
          ? []
          : [{ type: "addLevel", levelKind } as const]),
      );
      let reached = 0;
      for (const etf of STRATEGY_ETF_SOURCES) {
        const options = strategyMetricOptions(levelKind, "CONDITION", {
          kind: "ETF",
          code: etf.code,
        });
        expect(options).toHaveLength(21);
        for (const option of options) {
          const next = apply(base, {
            type: "chooseMetric",
            ref,
            metric: option.metric,
          });
          const signal =
            levelKind === "BUY"
              ? next.definition.buyLevels[0]?.signal
              : levelKind === "SELL"
                ? next.definition.sellLevels[0]?.signal
                : next.definition.finalExit?.rules[0]?.signal;
          const rule = signal?.conditions[0];
          expect(rule?.metric).toEqual(option.metric);
          expect(conditionOperatorsFor(option.metric)).toContain(rule?.operator);
          expect(
            checkStrategyValue(option.metric, rule!.value).compatible,
          ).toBe(true);
          // The whole document, as it would be saved.
          expect(
            validateStrategy(draftPayload({ ...next, name: "Every ETF metric" })),
          ).toEqual([]);
          reached += 1;
        }
      }
      expect(reached).toBe(420);
    }
  });
});

describe("the outcome a rule announces", () => {
  const ref = row(0);
  const stockRsi: StrategyCondition = {
    id: "c1",
    metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    operator: "IS_BELOW",
    value: { kind: "NUMBER", value: 35 },
  };

  it("is exactly what the reducer applies", () => {
    const state = apply(
      buyLevelWith({ kind: "PRICE" }),
      { type: "setOperator", ref, operator: "IS_BELOW" },
      {
        type: "setValue",
        ref,
        value: { kind: "SERIES", seriesId: "BALANCED" },
      },
    );
    const before = conditions(state)[0]!;
    const chosen: StrategyMetric = { kind: "PRICE", source: XLK };
    const outcome = chooseMetricOutcome(ref, before, chosen)!;
    const after = conditions(
      apply(state, { type: "chooseMetric", ref, metric: chosen }),
    )[0]!;
    expect({
      metric: after.metric,
      operator: after.operator,
      value: after.value,
    }).toEqual(outcome);
  });

  it("is null for the rule's own metric and for a metric that is not offered", () => {
    expect(chooseMetricOutcome(ref, stockRsi, stockRsi.metric)).toBeNull();
    expect(
      chooseMetricOutcome(ref, stockRsi, { kind: "GAIN" }),
    ).toBeNull();
  });

  it("says nothing when the operator and the Value both survive", () => {
    const outcome = chooseMetricOutcome(ref, stockRsi, {
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: XLK,
    })!;
    expect(metricChangeNotice("CONDITION", stockRsi, outcome)).toBeNull();
  });

  it("names what was replaced, and the rule it now matches", () => {
    const priceBelowBalanced: StrategyCondition = {
      id: "c1",
      metric: { kind: "PRICE" },
      operator: "IS_BELOW",
      value: { kind: "SERIES", seriesId: "BALANCED" },
    };
    const toEtf = chooseMetricOutcome(ref, priceBelowBalanced, {
      kind: "PRICE",
      source: XLK,
    })!;
    expect(metricChangeNotice("CONDITION", priceBelowBalanced, toEtf)).toBe(
      "Condition and value were reset to match XLK · Price.",
    );

    // Only the Value: the default operator happens to be the one the rule already had.
    const priceAbove: StrategyCondition = {
      ...priceBelowBalanced,
      operator: "IS_ABOVE",
    };
    const valueOnly = chooseMetricOutcome(ref, priceAbove, {
      kind: "PRICE",
      source: SPY,
    })!;
    expect(metricChangeNotice("CONDITION", priceAbove, valueOnly)).toBe(
      "Value was reset to match SPY · Price.",
    );

    // A stock change of category is announced the same way.
    const toRsi = chooseMetricOutcome(ref, priceBelowBalanced, {
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
    })!;
    expect(metricChangeNotice("CONDITION", priceBelowBalanced, toRsi)).toBe(
      "Condition and value were reset to match RSI 14D.",
    );
  });

  it("keeps a reset on record through a later change that replaced nothing", () => {
    const priceAboveDcf: StrategyCondition = {
      id: "c1",
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: "DCF_FCFF" },
    };
    // Stock -> XLK: an intrinsic value is not a Value an ETF's Price can take.
    const onXlk = chooseMetricOutcome(ref, priceAboveDcf, {
      kind: "PRICE",
      source: XLK,
    })!;
    const first = mergeMetricChangeResets(
      null,
      metricChangeResets(priceAboveDcf, onXlk),
    );
    expect(first).toEqual({ operator: false, value: true });
    // XLK -> SPY: the same rule on another fund, with nothing to replace …
    const onSpy = chooseMetricOutcome(ref, onXlk, {
      kind: "PRICE",
      source: SPY,
    })!;
    expect(metricChangeResets(onXlk, onSpy)).toEqual({
      operator: false,
      value: false,
    });
    // … which must not retract what the first step did: the Value the user wrote is still gone,
    // and the sentence names the rule as it reads now.
    const both = mergeMetricChangeResets(
      first,
      metricChangeResets(onXlk, onSpy),
    );
    expect(both).toEqual({ operator: false, value: true });
    expect(metricResetNotice("CONDITION", both, onSpy.metric)).toBe(
      "Value was reset to match SPY · Price.",
    );
    // A later change that replaces the operator as well adds to it.
    expect(
      mergeMetricChangeResets(both, { operator: true, value: false }),
    ).toEqual({ operator: true, value: true });
    // Nothing replaced by any step is nothing to say.
    expect(
      mergeMetricChangeResets(null, { operator: false, value: false }),
    ).toBeNull();
    expect(metricResetNotice("CONDITION", null, onSpy.metric)).toBeNull();
  });

  it("speaks of a trigger in a trigger row", () => {
    const triggerRef: PredicateRef = { ...BUY, part: "TRIGGER" };
    const before = {
      metric: { kind: "PRICE" } as StrategyMetric,
      operator: "CROSSES_BELOW",
      value: { kind: "SERIES", seriesId: "SMA_200D" } as const,
    };
    const outcome = chooseMetricOutcome(triggerRef, before, {
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
    })!;
    expect(metricChangeNotice("TRIGGER", before, outcome)).toBe(
      "Trigger and value were reset to match RSI 14D.",
    );
  });
});

/** The definition a draft holds is what is saved, source included. */
describe("the saved document", () => {
  it("carries each rule's source through the payload, and nothing for a stock rule", () => {
    const state = apply(
      buyLevelWith(
        { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        { kind: "PRICE" },
      ),
      {
        type: "chooseMetric",
        ref: row(1),
        metric: { kind: "PRICE", source: SPY },
      },
    );
    const definition: StrategyDefinition = draftPayload({
      ...state,
      name: "Mixed",
    }).definition;
    const [stock, etf] = definition.buyLevels[0]!.signal.conditions;
    expect(JSON.parse(JSON.stringify(stock!.metric))).toEqual({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
    });
    expect(JSON.parse(JSON.stringify(etf!.metric))).toEqual({
      kind: "PRICE",
      source: { kind: "ETF", code: "SP500" },
    });
  });
});
