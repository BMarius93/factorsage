import { describe, expect, it } from "vitest";
import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS,
  type FundamentalMetricId,
} from "./fundamental-metrics.js";
import {
  checkStrategyValue,
  conditionOperatorsFor,
  defaultConditionOperatorFor,
  defaultStrategyMetric,
  defaultValueFor,
  describeCondition,
  describeMetricConfiguration,
  describeStrategy,
  normalizeStrategyDefinition,
  rekeyStrategyDefinition,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_METRIC_CATEGORIES,
  STRATEGY_METRIC_CATEGORY_LABELS,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_METRIC_HELP,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyFinalExitFingerprint,
  strategyMetricCategories,
  strategyMetricCategory,
  strategyMetricHelp,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategySignalFingerprint,
  strategyValueLabel,
  triggerOperatorsFor,
  upgradeStrategyDefinitionDocument,
  validateStrategyDefinition,
  valueSpecFor,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategySignal,
  type StrategyValidationIssue,
  type StrategyValue,
} from "./strategies.js";

/**
 * The fifteen Fundamental Metrics as Strategy Conditions.
 *
 * `docs/decisions/fundamental-metrics-v1.md` § Strategy semantics: Condition metrics only, the
 * existing strict comparison pair, a `PERCENT` Value in percentage points or a `MULTIPLE` Value,
 * and the metric's identity inside the fingerprint so two metrics never share a definition hash or a
 * Monitor latch. Stored and submitted documents are runtime data, so every rule is proven through
 * the validator rather than trusted to the types.
 */

function fundamental(metricId: FundamentalMetricId): StrategyMetric {
  return { kind: "FUNDAMENTAL", metricId };
}

function percent(value: number): StrategyValue {
  return { kind: "PERCENT", value };
}

function multiple(value: number): StrategyValue {
  return { kind: "MULTIPLE", value };
}

/** The Value a metric's own unit takes, at `value`. */
function valueOfUnit(
  metricId: FundamentalMetricId,
  value: number,
): StrategyValue {
  const unit = FUNDAMENTAL_METRIC_CATALOG.find(
    (entry) => entry.id === metricId,
  )!.unit;
  return unit === "PERCENT" ? percent(value) : multiple(value);
}

function condition(
  metric: StrategyMetric,
  operator: ConditionOperator,
  value: StrategyValue,
  id = "condition-1",
): StrategyCondition {
  return { id, metric, operator, value };
}

function definitionOf(
  buySignal: StrategySignal,
  extra: Partial<StrategyDefinition> = {},
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", signal: buySignal, percentage: 25 }],
    sellLevels: [],
    ...extra,
  };
}

/** A saveable strategy carrying `levelSignal` in the given level kind. */
function inLevel(
  levelKind: StrategyLevelKind,
  levelSignal: StrategySignal,
): StrategyDefinition {
  if (levelKind === "BUY") {
    return definitionOf(levelSignal);
  }
  const base = definitionOf({
    conditions: [
      {
        id: "buy-anchor",
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    ],
  });
  return levelKind === "SELL"
    ? {
        ...base,
        sellLevels: [{ id: "sell-1", percentage: 50, signal: levelSignal }],
      }
    : {
        ...base,
        finalExit: {
          id: "exit-1",
          rules: [{ id: "exit-rule-1", signal: levelSignal }],
        },
      };
}

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function rawDefinition(metric: unknown, value: unknown = percent(15)): unknown {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 25,
        signal: {
          conditions: [
            { id: "condition-1", metric, operator: "IS_ABOVE", value },
          ],
        },
      },
    ],
    sellLevels: [],
  };
}

const PERCENT_IDS = FUNDAMENTAL_METRIC_CATALOG.filter(
  (entry) => entry.unit === "PERCENT",
).map((entry) => entry.id);
const MULTIPLE_IDS = FUNDAMENTAL_METRIC_CATALOG.filter(
  (entry) => entry.unit === "MULTIPLE",
).map((entry) => entry.id);

describe("the Fundamentals category", () => {
  it("is its own category, labelled Fundamentals, directly after Valuation and distinct from it", () => {
    expect(STRATEGY_METRIC_CATEGORY_LABELS.FUNDAMENTALS).toBe("Fundamentals");
    expect(STRATEGY_METRIC_CATEGORIES.indexOf("FUNDAMENTALS")).toBe(
      STRATEGY_METRIC_CATEGORIES.indexOf("VALUATION") + 1,
    );
    expect(STRATEGY_METRIC_DEFINITIONS.FUNDAMENTAL.category).toBe(
      "FUNDAMENTALS",
    );
    // Valuation keeps Margin of Safety and nothing fundamental.
    expect(STRATEGY_METRIC_DEFINITIONS.MARGIN_OF_SAFETY.category).toBe(
      "VALUATION",
    );
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(strategyMetricCategory(fundamental(id))).toBe("FUNDAMENTALS");
    }
  });

  it("appears exactly once in every level kind's Condition categories, and never in a Trigger's", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const conditionIds = strategyMetricCategories(levelKind, "CONDITION").map(
        (category) => category.id,
      );
      expect(
        conditionIds.filter((id) => id === "FUNDAMENTALS"),
        levelKind,
      ).toHaveLength(1);
      const triggerIds = strategyMetricCategories(levelKind, "TRIGGER").map(
        (category) => category.id,
      );
      expect(triggerIds, levelKind).not.toContain("FUNDAMENTALS");
      expect(
        strategyMetricOptions(levelKind, "TRIGGER").some(
          (option) => option.metric.kind === "FUNDAMENTAL",
        ),
        levelKind,
      ).toBe(false);
    }
  });

  it("offers the fifteen metrics in catalog order, each with its catalog label, in every level", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const category = strategyMetricCategories(levelKind, "CONDITION").find(
        (candidate) => candidate.id === "FUNDAMENTALS",
      );
      expect(category?.label).toBe("Fundamentals");
      expect(category?.options.map((option) => option.metric)).toEqual(
        FUNDAMENTAL_METRIC_IDS.map(fundamental),
      );
      expect(category?.options.map((option) => option.label)).toEqual(
        FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.label),
      );
    }
  });

  it("starts a new Fundamentals row on the first metric, at a rule it can save", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const metric = defaultStrategyMetric(
        levelKind,
        "CONDITION",
        "FUNDAMENTALS",
      );
      expect(metric).toEqual(fundamental("REVENUE_GROWTH_TTM_YOY"));
      expect(defaultStrategyMetric(levelKind, "TRIGGER", "FUNDAMENTALS")).toBe(
        undefined,
      );
      const row = condition(
        metric!,
        defaultConditionOperatorFor(metric!),
        defaultValueFor(metric!)!,
      );
      expect(
        validateStrategyDefinition(inLevel(levelKind, { conditions: [row] })),
        levelKind,
      ).toEqual([]);
    }
  });

  it("gives every metric its own select key, colliding with no other option", () => {
    const keys = FUNDAMENTAL_METRIC_IDS.map((id) =>
      strategyMetricKey(fundamental(id)),
    );
    expect(keys).toEqual(
      FUNDAMENTAL_METRIC_IDS.map((id) => `FUNDAMENTAL:${id}`),
    );
    const everyKey = strategyMetricOptions("SELL").map((option) =>
      strategyMetricKey(option.metric),
    );
    expect(new Set(everyKey).size).toBe(everyKey.length);
  });
});

describe("Fundamental Metrics as Conditions only", () => {
  it("offers the strict comparison pair and no Trigger operator", () => {
    expect(STRATEGY_METRIC_DEFINITIONS.FUNDAMENTAL.conditionOperators).toEqual([
      "IS_ABOVE",
      "IS_BELOW",
    ]);
    expect(STRATEGY_METRIC_DEFINITIONS.FUNDAMENTAL.triggerOperators).toEqual(
      [],
    );
    expect(STRATEGY_METRIC_DEFINITIONS.FUNDAMENTAL.allowedIn).toEqual([
      "BUY",
      "SELL",
      "FINAL_EXIT",
    ]);
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(conditionOperatorsFor(fundamental(id)), id).toEqual([
        "IS_ABOVE",
        "IS_BELOW",
      ]);
      expect(triggerOperatorsFor(fundamental(id)), id).toEqual([]);
      expect(defaultConditionOperatorFor(fundamental(id)), id).toBe("IS_ABOVE");
    }
  });

  it("accepts is above and is below for every metric, in every level kind", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const id of FUNDAMENTAL_METRIC_IDS) {
        for (const operator of ["IS_ABOVE", "IS_BELOW"] as const) {
          const issues = validateStrategyDefinition(
            inLevel(levelKind, {
              conditions: [
                condition(fundamental(id), operator, valueOfUnit(id, 1)),
              ],
            }),
          );
          expect(issues, `${levelKind} ${id} ${operator}`).toEqual([]);
        }
      }
    }
  });

  it("refuses is close to for every metric", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      const issues = validateStrategyDefinition(
        definitionOf({
          conditions: [
            condition(fundamental(id), "IS_CLOSE_TO", valueOfUnit(id, 1)),
          ],
        }),
      );
      expect(codesOf(issues), id).toEqual(["OPERATOR_NOT_SUPPORTED"]);
      expect(issues[0]?.path.field).toBe("OPERATOR");
    }
  });

  it("refuses every metric as a Trigger, in every level kind and under every operator", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const id of FUNDAMENTAL_METRIC_IDS) {
        for (const operator of ["CROSSES_ABOVE", "CROSSES_BELOW", "IS_ABOVE"]) {
          const issues = validateStrategyDefinition(
            inLevel(levelKind, {
              conditions: [],
              trigger: {
                id: "trigger-1",
                metric: fundamental(id),
                operator,
                value: valueOfUnit(id, 1),
              } as never,
            }),
          );
          const issue = issues.find(
            (candidate) => candidate.code === "METRIC_NOT_ALLOWED_IN_PART",
          );
          expect(issue, `${levelKind} ${id} ${operator}`).toBeDefined();
          expect(issue?.path.part).toBe("TRIGGER");
          expect(issue?.path.field).toBe("METRIC");
          expect(issue?.message).toContain(
            strategyMetricLabel(fundamental(id)),
          );
        }
      }
    }
  });

  it("refuses a Fundamental Trigger even beside valid Conditions", () => {
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [
          condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15)),
        ],
        trigger: {
          id: "trigger-1",
          metric: fundamental("DEBT_TO_EQUITY"),
          operator: "CROSSES_BELOW",
          value: multiple(1),
        },
      }),
    );
    expect(codesOf(issues)).toEqual(["METRIC_NOT_ALLOWED_IN_PART"]);
  });
});

describe("Fundamental Metric values", () => {
  it("compares a percentage metric with a PERCENT and a ratio with a MULTIPLE, and nothing else", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      const metric = fundamental(id);
      const own = valueOfUnit(id, 1);
      expect(checkStrategyValue(metric, own), id).toEqual({ compatible: true });
      const others: StrategyValue[] = [
        own.kind === "PERCENT" ? multiple(1) : percent(1),
        { kind: "NUMBER", value: 1 },
        { kind: "MONEY", value: 1 },
        { kind: "SERIES", seriesId: "SMA_200D" },
      ];
      for (const other of others) {
        const result = checkStrategyValue(metric, other);
        expect(result.compatible, `${id} ${other.kind}`).toBe(false);
        expect(
          result.compatible ? null : result.code,
          `${id} ${other.kind}`,
        ).toBe("VALUE_KIND_MISMATCH");
      }
    }
    expect(PERCENT_IDS).toHaveLength(10);
    expect(MULTIPLE_IDS).toHaveLength(5);
  });

  it("uses the unit's own spec: percentage points with no scaling, a multiple with an input step", () => {
    expect(valueSpecFor(fundamental("ROIC_TTM"))).toEqual({ kind: "PERCENT" });
    expect(valueSpecFor(fundamental("REVENUE_GROWTH_TTM_YOY"))).toEqual({
      kind: "PERCENT",
      min: -100,
    });
    expect(valueSpecFor(fundamental("DEBT_TO_EQUITY"))).toEqual({
      kind: "MULTIPLE",
      min: 0,
      step: 0.1,
    });
    expect(valueSpecFor(fundamental("NET_DEBT_TO_EBITDA_TTM"))).toEqual({
      kind: "MULTIPLE",
      step: 0.1,
    });
  });

  it("bounds a threshold only where the metric's own mathematics does", () => {
    const accepts = (id: FundamentalMetricId, value: number) =>
      checkStrategyValue(fundamental(id), valueOfUnit(id, value)).compatible;

    // Growth compares two positive windows, so it is always above -100%.
    for (const id of [
      "REVENUE_GROWTH_TTM_YOY",
      "EPS_GROWTH_TTM_YOY",
      "FCF_GROWTH_TTM_YOY",
    ] as const) {
      expect(accepts(id, -100), id).toBe(true);
      expect(accepts(id, -100.01), id).toBe(false);
      expect(accepts(id, 500), id).toBe(true);
    }
    // Margins and returns are signed without bound: a loss-making business is a legitimate rule.
    for (const id of [
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ROIC_TTM",
      "ROE_TTM",
      "ROA_TTM",
    ] as const) {
      expect(accepts(id, -250), id).toBe(true);
      expect(accepts(id, 250), id).toBe(true);
    }
    // Ratios of non-negative quantities have a floor of zero, inclusive.
    for (const id of [
      "DEBT_TO_EQUITY",
      "CURRENT_RATIO",
      "ASSET_TURNOVER_TTM",
    ] as const) {
      expect(accepts(id, 0), id).toBe(true);
      expect(accepts(id, -0.01), id).toBe(false);
      expect(accepts(id, 40), id).toBe(true);
    }
    // Net cash makes Net Debt / EBITDA negative, and a negative EBIT makes coverage negative.
    for (const id of [
      "NET_DEBT_TO_EBITDA_TTM",
      "INTEREST_COVERAGE_TTM",
    ] as const) {
      expect(accepts(id, -3), id).toBe(true);
      expect(accepts(id, 12), id).toBe(true);
    }
    // No step is enforced: 0.75 is a valid Debt / Equity threshold.
    expect(accepts("DEBT_TO_EQUITY", 0.75)).toBe(true);
    // A threshold is always a finite number.
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      for (const value of [Number.NaN, Infinity, -Infinity]) {
        const result = checkStrategyValue(
          fundamental(id),
          valueOfUnit(id, value),
        );
        expect(result.compatible ? null : result.code, `${id} ${value}`).toBe(
          "VALUE_OUT_OF_DOMAIN",
        );
      }
    }
  });

  it("starts a percentage at the neutral 0% and a multiple at the neutral 1.0x", () => {
    for (const id of PERCENT_IDS) {
      expect(defaultValueFor(fundamental(id)), id).toEqual(percent(0));
    }
    for (const id of MULTIPLE_IDS) {
      expect(defaultValueFor(fundamental(id)), id).toEqual(multiple(1));
    }
  });

  it("keeps a Value across a change between two metrics of one unit, and never across units", () => {
    // The Builder asks exactly this question when the metric changes; the unit decides it.
    expect(
      checkStrategyValue(fundamental("ROE_TTM"), percent(15)).compatible,
    ).toBe(true);
    expect(
      checkStrategyValue(fundamental("DEBT_TO_EQUITY"), percent(15)).compatible,
    ).toBe(false);
    expect(
      checkStrategyValue(fundamental("ROIC_TTM"), multiple(1.5)).compatible,
    ).toBe(false);
    // One unit, two domains: a negative coverage threshold is not a valid leverage threshold.
    expect(
      checkStrategyValue(fundamental("DEBT_TO_EQUITY"), multiple(-2))
        .compatible,
    ).toBe(false);
  });
});

describe("a Fundamental Metric in a stored or submitted document", () => {
  it("accepts exactly the catalog's identities", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(
        validateStrategyDefinition(
          rawDefinition(
            { kind: "FUNDAMENTAL", metricId: id },
            valueOfUnit(id, 1),
          ),
        ),
        id,
      ).toEqual([]);
    }
  });

  it("refuses an identity the catalog does not define, however close it looks", () => {
    for (const metricId of [
      "PE_TTM",
      "roic_ttm",
      "Roic_Ttm",
      "ROIC TTM",
      "roicTtm",
      "ROIC",
      " ROIC_TTM",
      "",
      42,
      null,
      true,
      ["ROIC_TTM"],
      { id: "ROIC_TTM" },
    ]) {
      const issues = validateStrategyDefinition(
        rawDefinition({ kind: "FUNDAMENTAL", metricId }),
      );
      expect(codesOf(issues), JSON.stringify(metricId)).toEqual([
        "FUNDAMENTAL_METRIC_UNSUPPORTED",
      ]);
      expect(issues[0]?.path.field).toBe("METRIC");
    }
    const missing = validateStrategyDefinition(
      rawDefinition({ kind: "FUNDAMENTAL" }),
    );
    expect(codesOf(missing)).toEqual(["FUNDAMENTAL_METRIC_UNSUPPORTED"]);
  });

  it("refuses anything carried beside the identity, rather than storing a label or a field", () => {
    for (const extra of [
      { label: "ROIC TTM" },
      { group: "QUALITY" },
      { unit: "PERCENT" },
      { field: "roicTtm" },
      { seriesId: "SMA_200D" },
    ]) {
      const issues = validateStrategyDefinition(
        rawDefinition({ kind: "FUNDAMENTAL", metricId: "ROIC_TTM", ...extra }),
      );
      expect(codesOf(issues), JSON.stringify(extra)).toEqual(["UNKNOWN_FIELD"]);
    }
  });

  it("refuses a kind spelled any other way", () => {
    for (const kind of ["FUNDAMENTALS", "fundamental", "Fundamental"]) {
      expect(
        codesOf(
          validateStrategyDefinition(
            rawDefinition({ kind, metricId: "ROIC_TTM" }),
          ),
        ),
        kind,
      ).toEqual(["SHAPE_INVALID"]);
    }
  });

  it("canonicalizes to the identity alone, idempotently, preserving order", () => {
    const definition = definitionOf({
      conditions: [
        condition(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(1), "c1"),
        condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c2"),
      ],
    });
    const normalized = normalizeStrategyDefinition(
      JSON.parse(JSON.stringify(definition)),
    );
    expect(normalized.buyLevels[0]?.signal.conditions).toEqual([
      {
        id: "c1",
        metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
        operator: "IS_BELOW",
        value: { kind: "MULTIPLE", value: 1 },
      },
      {
        id: "c2",
        metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
        operator: "IS_ABOVE",
        value: { kind: "PERCENT", value: 15 },
      },
    ]);
    expect(normalizeStrategyDefinition(normalized)).toEqual(normalized);
  });

  it("needs no new schema version: the version 2 grammar carries it and version 1 still upcasts", () => {
    expect(STRATEGY_SCHEMA_VERSION).toBe(2);
    const buySignal: StrategySignal = {
      conditions: [
        condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "buy-c1"),
      ],
    };
    const signal: StrategySignal = {
      conditions: [
        condition(fundamental("ROIC_TTM"), "IS_BELOW", percent(5), "exit-c1"),
      ],
    };
    const legacy = {
      schemaVersion: 1,
      buyLevels: [{ id: "buy-1", percentage: 25, signal: buySignal }],
      sellLevels: [],
      finalExit: { id: "exit-1", signal },
    };
    const upgraded = upgradeStrategyDefinitionDocument(legacy);
    expect(validateStrategyDefinition(upgraded)).toEqual([]);
    const current = normalizeStrategyDefinition(legacy);
    expect(current.schemaVersion).toBe(2);
    expect(current.finalExit?.rules).toEqual([{ id: "exit-1", signal }]);
    // One alternative is that alternative: the upcast and the single rule fingerprint alike.
    expect(strategyFinalExitFingerprint(current.finalExit!)).toBe(
      strategySignalFingerprint(signal),
    );
  });
});

describe("describing a Fundamental Condition", () => {
  it("reads the product's worked examples back as written", () => {
    const say = (
      id: FundamentalMetricId,
      operator: ConditionOperator,
      value: StrategyValue,
    ) => describeCondition(condition(fundamental(id), operator, value));

    expect(say("ROIC_TTM", "IS_ABOVE", percent(15))).toBe(
      "ROIC TTM is above 15%",
    );
    expect(say("REVENUE_GROWTH_TTM_YOY", "IS_ABOVE", percent(10))).toBe(
      "Revenue Growth TTM YoY is above 10%",
    );
    // A multiple keeps the product's one-decimal `x` convention.
    expect(say("DEBT_TO_EQUITY", "IS_BELOW", multiple(1))).toBe(
      "Debt / Equity is below 1.0x",
    );
    expect(say("CURRENT_RATIO", "IS_ABOVE", multiple(1.5))).toBe(
      "Current Ratio is above 1.5x",
    );
    expect(say("INTEREST_COVERAGE_TTM", "IS_ABOVE", multiple(5))).toBe(
      "Interest Coverage TTM is above 5.0x",
    );
    expect(say("NET_DEBT_TO_EBITDA_TTM", "IS_BELOW", multiple(-0.5))).toBe(
      "Net Debt / EBITDA TTM is below -0.5x",
    );
    expect(say("GROSS_MARGIN_TTM", "IS_ABOVE", percent(22.5))).toBe(
      "Gross Margin TTM is above 22.5%",
    );
  });

  it("names every metric by its catalog label, with no configuration and no storage field", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const metric = fundamental(entry.id);
      expect(strategyMetricLabel(metric)).toBe(entry.label);
      expect(describeMetricConfiguration(metric)).toBeNull();
      const text = describeCondition(
        condition(metric, "IS_ABOVE", valueOfUnit(entry.id, 3)),
      );
      expect(text.startsWith(`${entry.label} is above `)).toBe(true);
      expect(text).not.toContain(entry.id);
      expect(text).not.toMatch(/Ttm|Yoy|debtToEquity|currentRatio|\(/);
      expect(text.endsWith(entry.unit === "PERCENT" ? "3%" : "3.0x")).toBe(
        true,
      );
    }
  });

  it("appears in the Strategy logic as an ordinary line", () => {
    const lines = describeStrategy(
      definitionOf({
        conditions: [
          condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c1"),
          condition(
            fundamental("DEBT_TO_EQUITY"),
            "IS_BELOW",
            multiple(1),
            "c2",
          ),
        ],
      }),
    );
    expect(lines).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 25 },
      { kind: "CONDITION", text: "ROIC TTM is above 15%" },
      {
        kind: "CONDITION",
        connector: "AND",
        text: "Debt / Equity is below 1.0x",
      },
    ]);
  });

  it("prints a multiple exactly, never rounded to a different rule (regression)", () => {
    // Before this change `0.75x` printed as `0.8x` and `1.25x` as `1.3x`: the preview, trade reasons
    // and the Dashboard described a threshold the evaluator never compared against.
    expect(strategyValueLabel(multiple(0.75))).toBe("0.75x");
    expect(strategyValueLabel(multiple(1.25))).toBe("1.25x");
    expect(strategyValueLabel(multiple(0.05))).toBe("0.05x");
    expect(strategyValueLabel(multiple(2.45))).toBe("2.45x");
    expect(
      describeCondition(
        condition(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(0.75)),
      ),
    ).toBe("Debt / Equity is below 0.75x");
    // The one-decimal convention is unchanged for whole and one-decimal thresholds.
    expect(strategyValueLabel(multiple(2))).toBe("2.0x");
    expect(strategyValueLabel(multiple(10))).toBe("10.0x");
    expect(strategyValueLabel(multiple(1.5))).toBe("1.5x");
    expect(strategyValueLabel(multiple(-2))).toBe("-2.0x");
    expect(strategyValueLabel(multiple(-0.5))).toBe("-0.5x");
    expect(strategyValueLabel(multiple(0))).toBe("0.0x");
  });
});

describe("a Fundamental Metric's identity in the fingerprint", () => {
  const signalWith = (
    id: FundamentalMetricId,
    value: number,
  ): StrategySignal => ({
    conditions: [
      condition(fundamental(id), "IS_ABOVE", valueOfUnit(id, value)),
    ],
  });

  it("separates the named pairs that share a unit, an operator and a threshold", () => {
    const pairs: [FundamentalMetricId, FundamentalMetricId, number][] = [
      ["ROIC_TTM", "ROE_TTM", 15],
      ["ROIC_TTM", "REVENUE_GROWTH_TTM_YOY", 15],
      ["REVENUE_GROWTH_TTM_YOY", "EPS_GROWTH_TTM_YOY", 10],
      ["DEBT_TO_EQUITY", "CURRENT_RATIO", 1],
    ];
    for (const [left, right, value] of pairs) {
      expect(
        strategySignalFingerprint(signalWith(left, value)),
        `${left} vs ${right}`,
      ).not.toBe(strategySignalFingerprint(signalWith(right, value)));
      expect(
        strategyDefinitionFingerprint(definitionOf(signalWith(left, value))),
        `${left} vs ${right}`,
      ).not.toBe(
        strategyDefinitionFingerprint(definitionOf(signalWith(right, value))),
      );
    }
  });

  it("gives all fifteen metrics fifteen different fingerprints under one rule", () => {
    const fingerprints = FUNDAMENTAL_METRIC_IDS.map((id) =>
      strategySignalFingerprint(signalWith(id, 1)),
    );
    expect(new Set(fingerprints).size).toBe(15);
  });

  it("serializes the identity as the metric's third element, byte for byte", () => {
    // Pinned: this string is what a persisted `definitionHash` is a digest of.
    expect(
      strategyDefinitionFingerprint(definitionOf(signalWith("ROIC_TTM", 15))),
    ).toBe(
      '[1,[[25,[[[["FUNDAMENTAL",null,"ROIC_TTM"],"IS_ABOVE",["PERCENT",15]]],null]]],[],null]',
    );
    expect(strategySignalFingerprint(signalWith("DEBT_TO_EQUITY", 1))).toBe(
      '[[[["FUNDAMENTAL",null,"DEBT_TO_EQUITY"],"IS_ABOVE",["MULTIPLE",1]]],null]',
    );
  });

  it("carries neither the label nor the group, only the stable identity", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const fingerprint = strategySignalFingerprint(signalWith(entry.id, 1));
      expect(fingerprint).toContain(`"${entry.id}"`);
      expect(fingerprint).not.toContain(entry.label);
      // As a serialized token: `GROWTH` is legitimately part of the identity `EPS_GROWTH_TTM_YOY`.
      expect(fingerprint).not.toContain(`"${entry.group}"`);
    }
  });

  it("is stable across a serialize-and-reload, a canonicalization and a re-keying", () => {
    const definition = definitionOf({
      conditions: [
        condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c1"),
        condition(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(1), "c2"),
      ],
    });
    const fingerprint = strategyDefinitionFingerprint(definition);
    const reloaded = normalizeStrategyDefinition(
      JSON.parse(JSON.stringify(definition)),
    );
    expect(strategyDefinitionFingerprint(reloaded)).toBe(fingerprint);
    let next = 0;
    const rekeyed = rekeyStrategyDefinition(
      reloaded,
      () => `fresh-${(next += 1)}`,
    );
    expect(strategyDefinitionFingerprint(rekeyed)).toBe(fingerprint);
    expect(rekeyed.buyLevels[0]?.signal.conditions[0]?.id).not.toBe("c1");
  });
});

describe("duplicate detection with Fundamental Metrics", () => {
  it("accepts two metrics under the same rule, and all ten a Signal can hold", () => {
    expect(
      validateStrategyDefinition(
        definitionOf({
          conditions: [
            condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c1"),
            condition(fundamental("ROE_TTM"), "IS_ABOVE", percent(15), "c2"),
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      validateStrategyDefinition(
        definitionOf({
          conditions: FUNDAMENTAL_METRIC_IDS.slice(0, 10).map((id, index) =>
            condition(
              fundamental(id),
              "IS_ABOVE",
              valueOfUnit(id, 1),
              `c${index}`,
            ),
          ),
        }),
      ),
    ).toEqual([]);
  });

  it("still rejects the same metric and rule written twice, at the repeat", () => {
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [
          condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c1"),
          condition(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15), "c2"),
        ],
      }),
    );
    expect(codesOf(issues)).toEqual(["DUPLICATE_CONDITION"]);
    expect(issues[0]?.path.conditionIndex).toBe(1);
  });

  it("separates the metrics in FINAL EXIT duplicate detection too", () => {
    const rule = (id: FundamentalMetricId, ruleId: string) => ({
      id: ruleId,
      signal: {
        conditions: [
          condition(fundamental(id), "IS_BELOW", percent(5), `${ruleId}-c`),
        ],
      },
    });
    const withRules = (rules: ReturnType<typeof rule>[]) =>
      validateStrategyDefinition(
        definitionOf(
          {
            conditions: [
              condition({ kind: "PRICE" }, "IS_ABOVE", {
                kind: "SERIES",
                seriesId: "SMA_200D",
              }),
            ],
          },
          { finalExit: { id: "exit-1", rules } },
        ),
      );
    expect(withRules([rule("ROIC_TTM", "r1"), rule("ROA_TTM", "r2")])).toEqual(
      [],
    );
    expect(
      codesOf(withRules([rule("ROIC_TTM", "r1"), rule("ROIC_TTM", "r2")])),
    ).toEqual(["DUPLICATE_EXIT_RULE"]);
  });
});

describe("explaining a Fundamental Metric", () => {
  it("leads with the metric's own summary and formula, then its unit, then the shared rules", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const help = strategyMetricHelp(fundamental(entry.id));
      expect(help.summary).toBe(entry.summary);
      expect(help.formula).toBe(entry.formula);
      expect(help.detail).toBe(STRATEGY_METRIC_HELP.FUNDAMENTAL.detail);
      expect(help.notEvaluableWhen).toBe(
        STRATEGY_METRIC_HELP.FUNDAMENTAL.notEvaluableWhen,
      );
      const [unitNote, ...rest] = help.notes ?? [];
      expect(unitNote).toContain(
        entry.unit === "PERCENT" ? "percentage points" : "raw multiple",
      );
      expect(rest).toEqual(STRATEGY_METRIC_HELP.FUNDAMENTAL.notes);
    }
  });

  it("says a fundamental is point-in-time, a condition only, and unavailable rather than zero", () => {
    const help = STRATEGY_METRIC_HELP.FUNDAMENTAL;
    expect(help.detail).toContain("point-in-time");
    expect(help.detail).toContain("condition only");
    expect(help.notEvaluableWhen).toContain("never zero");
    expect(help.notes?.join(" ")).toContain(
      "four consecutive reported fiscal quarters",
    );
  });

  it("leaves every other metric's help exactly as its kind's entry", () => {
    for (const option of strategyMetricOptions("SELL")) {
      if (option.metric.kind === "FUNDAMENTAL") {
        continue;
      }
      expect(strategyMetricHelp(option.metric)).toBe(
        STRATEGY_METRIC_HELP[option.metric.kind],
      );
    }
  });
});
