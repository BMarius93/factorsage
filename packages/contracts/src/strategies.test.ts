import { describe, expect, it } from "vitest";
import {
  comparableMovingAverages,
  findSelectableSeries,
  INTRINSIC_VALUE_SERIES,
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  PRICE_COMPARABLE_SERIES,
  SELECTABLE_SERIES_CATALOG,
  type SelectableSeriesId,
} from "./selectable-series.js";
import {
  BUY_LEVEL_PERCENTAGES,
  CONDITION_OPERATORS,
  conditionOperatorsFor,
  defaultValueFor,
  describeStrategy,
  emptyStrategyDefinition,
  IS_CLOSE_TO_TOLERANCE,
  normalizeStrategyDefinition,
  SELL_LEVEL_PERCENTAGES,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_METRIC_HELP,
  STRATEGY_METRIC_KINDS,
  STRATEGY_OPERATOR_HELP,
  STRATEGY_SCHEMA_VERSION,
  strategyMetricLabel,
  strategyMetricOptions,
  strategyValueLabel,
  StrategyValidationError,
  TRIGGER_OPERATORS,
  triggerOperatorsFor,
  validateStrategy,
  validateStrategyDefinition,
  valueSpecFor,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValidationIssue,
  type StrategyValue,
} from "./strategies.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function series(seriesId: SelectableSeriesId): StrategyValue {
  return { kind: "SERIES", seriesId };
}

function percent(value: number): StrategyValue {
  return { kind: "PERCENT", value };
}

/**
 * Rows carry stable ids that must be unique across a definition, so fixtures mint their own unless
 * a test is specifically about identifiers and passes one.
 */
let nextFixtureId = 0;

function fixtureId(prefix: string): string {
  nextFixtureId += 1;
  return `${prefix}-${nextFixtureId}`;
}

function condition(
  metric: StrategyMetric,
  operator: StrategyCondition["operator"],
  value: StrategyValue,
  id = fixtureId("condition"),
): StrategyCondition {
  return { id, metric, operator, value };
}

function trigger(
  metric: StrategyMetric,
  operator: StrategyTrigger["operator"],
  value: StrategyValue,
  id = fixtureId("trigger"),
): StrategyTrigger {
  return { id, metric, operator, value };
}

function signal(
  conditions: StrategyCondition[],
  triggerRow?: StrategyTrigger,
): StrategySignal {
  return triggerRow
    ? { conditions, trigger: triggerRow }
    : { conditions: conditions };
}

/** A valid, uninteresting BUY-safe condition; a fresh row each call, so ids never collide. */
function priceAboveEma200D(): StrategyCondition {
  return condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"));
}

/** One BUY level over the given signal; the minimum a saveable strategy needs. */
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

/** A strategy whose only rule is the one under test, in a BUY level. */
function definitionWith(row: StrategyCondition): StrategyDefinition {
  return definitionOf(signal([row]));
}

/**
 * The same, in whichever level kind is under test. A BUY level stays present so the strategy is
 * otherwise saveable and the only issues reported are the ones the test is about.
 */
function definitionInLevel(
  levelKind: StrategyLevelKind,
  levelSignal: StrategySignal,
): StrategyDefinition {
  if (levelKind === "BUY") {
    return definitionOf(levelSignal);
  }
  const base = definitionOf(signal([priceAboveEma200D()]));
  return levelKind === "SELL"
    ? {
        ...base,
        sellLevels: [{ id: "sell-1", percentage: 25, signal: levelSignal }],
      }
    : { ...base, finalExit: { id: "exit-1", signal: levelSignal } };
}

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/** A complete strategy exercising every metric kind and both operator families. */
function completeDefinition(): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 25,
        signal: signal(
          [
            condition({ kind: "PRICE" }, "IS_BELOW", series("BALANCED"), "c1"),
            condition(
              { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              "IS_BELOW",
              { kind: "NUMBER", value: 30 },
              "c2",
            ),
            condition(
              { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
              "IS_ABOVE",
              percent(25),
              "c3",
            ),
          ],
          trigger({ kind: "PRICE" }, "CROSSES_ABOVE", series("EMA_50D"), "t1"),
        ),
      },
      {
        id: "buy-2",
        percentage: 50,
        signal: signal([
          condition(
            { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
            "IS_ABOVE",
            series("SMA_200D"),
            "c4",
          ),
        ]),
      },
    ],
    sellLevels: [
      {
        id: "sell-1",
        percentage: 50,
        signal: signal([
          condition({ kind: "GAIN" }, "IS_ABOVE", percent(25), "c5"),
        ]),
      },
    ],
    finalExit: {
      id: "exit-1",
      signal: signal(
        [],
        trigger({ kind: "LOSS" }, "CROSSES_ABOVE", percent(10), "t2"),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe("strategy metric registry", () => {
  it("defines every metric kind with operators, a value source and at least one level", () => {
    for (const kind of STRATEGY_METRIC_KINDS) {
      const definition = STRATEGY_METRIC_DEFINITIONS[kind];
      expect(definition.kind).toBe(kind);
      expect(definition.conditionOperators.length).toBeGreaterThan(0);
      expect(definition.triggerOperators.length).toBeGreaterThan(0);
      expect(definition.allowedIn.length).toBeGreaterThan(0);
      // Either a static value spec, or per-instance resolution — never neither, never both.
      expect(
        definition.valueSource !== undefined || definition.value !== undefined,
      ).toBe(true);
      expect(
        definition.valueSource !== undefined && definition.value !== undefined,
      ).toBe(false);
    }
  });

  it("orders exactly the metric kinds the registry defines", () => {
    // `Record<StrategyMetricKind, ...>` proves the registry is complete; only this proves the
    // canonical ordering array is, so a new metric cannot be silently missing from every select.
    expect(Object.keys(STRATEGY_METRIC_DEFINITIONS)).toEqual([
      ...STRATEGY_METRIC_KINDS,
    ]);
  });

  it("references only canonical catalog series", () => {
    for (const kind of STRATEGY_METRIC_KINDS) {
      const definition = STRATEGY_METRIC_DEFINITIONS[kind];
      for (const seriesId of definition.parameterSeriesIds ?? []) {
        expect(findSelectableSeries(seriesId)).toBeDefined();
      }
      if (definition.value?.kind === "SERIES") {
        for (const seriesId of definition.value.seriesIds) {
          expect(findSelectableSeries(seriesId)).toBeDefined();
        }
      }
    }
  });

  it("parameterizes the catalog-backed metrics from the catalog's own projections", () => {
    expect(
      STRATEGY_METRIC_DEFINITIONS.MOVING_AVERAGE.parameterSeriesIds,
    ).toEqual(MOVING_AVERAGE_SERIES.map((entry) => entry.id));
    expect(STRATEGY_METRIC_DEFINITIONS.OSCILLATOR.parameterSeriesIds).toEqual(
      OSCILLATOR_SERIES.map((entry) => entry.id),
    );
    expect(
      STRATEGY_METRIC_DEFINITIONS.MARGIN_OF_SAFETY.parameterSeriesIds,
    ).toEqual(INTRINSIC_VALUE_SERIES.map((entry) => entry.id));
  });

  it("offers Price exactly the price-scaled catalog entries and no oscillator", () => {
    const priceValues = valueSpecFor({ kind: "PRICE" });
    expect(priceValues.kind).toBe("SERIES");
    expect(priceValues.kind === "SERIES" && priceValues.seriesIds).toEqual(
      PRICE_COMPARABLE_SERIES.map((entry) => entry.id),
    );
  });

  it("exposes `is close to` for Price and moving averages, and for nothing else", () => {
    const withCloseTo = STRATEGY_METRIC_KINDS.filter((kind) =>
      STRATEGY_METRIC_DEFINITIONS[kind].conditionOperators.includes(
        "IS_CLOSE_TO",
      ),
    );
    expect(withCloseTo).toEqual(["PRICE", "MOVING_AVERAGE"]);
    expect(IS_CLOSE_TO_TOLERANCE).toBe(0.02);
  });

  it("keeps Gain and Loss out of BUY and in SELL and FINAL EXIT", () => {
    const buyKinds = new Set(
      strategyMetricOptions("BUY").map((option) => option.metric.kind),
    );
    expect(buyKinds.has("GAIN")).toBe(false);
    expect(buyKinds.has("LOSS")).toBe(false);
    for (const levelKind of ["SELL", "FINAL_EXIT"] as const) {
      const kinds = new Set(
        strategyMetricOptions(levelKind).map((option) => option.metric.kind),
      );
      expect(kinds.has("GAIN")).toBe(true);
      expect(kinds.has("LOSS")).toBe(true);
    }
  });

  it("lists metric options grouped, in canonical catalog order", () => {
    const options = strategyMetricOptions("SELL");
    expect(
      options
        .filter((option) => option.group === "MOVING_AVERAGES")
        .map((option) => option.label),
    ).toEqual(MOVING_AVERAGE_SERIES.map((entry) => entry.label));
    // Grouping never reorders: the group of each option is non-decreasing in canonical order.
    const groupOrder = options.map((option) =>
      [
        "PRICE",
        "MOVING_AVERAGES",
        "OSCILLATORS",
        "VALUATION",
        "POSITION",
      ].indexOf(option.group),
    );
    expect(groupOrder).toEqual([...groupOrder].sort((a, b) => a - b));
  });

  it("labels every catalog-backed identity with the catalog's own label", () => {
    for (const option of strategyMetricOptions("SELL")) {
      const seriesId =
        option.metric.kind === "MARGIN_OF_SAFETY"
          ? option.metric.sourceId
          : option.metric.kind === "MOVING_AVERAGE" ||
              option.metric.kind === "OSCILLATOR"
            ? option.metric.seriesId
            : undefined;
      if (!seriesId) {
        continue;
      }
      const catalogLabel = findSelectableSeries(seriesId)?.label ?? "";
      expect(option.label).toBe(
        option.metric.kind === "MARGIN_OF_SAFETY"
          ? `Margin of Safety (${catalogLabel})`
          : catalogLabel,
      );
    }
    for (const entry of SELECTABLE_SERIES_CATALOG) {
      expect(strategyValueLabel(series(entry.id))).toBe(entry.label);
    }
  });

  it("carries product help for every metric kind and operator", () => {
    for (const kind of STRATEGY_METRIC_KINDS) {
      expect(STRATEGY_METRIC_HELP[kind].summary.length).toBeGreaterThan(0);
      expect(STRATEGY_METRIC_HELP[kind].detail.length).toBeGreaterThan(0);
    }
    for (const operator of [...CONDITION_OPERATORS, ...TRIGGER_OPERATORS]) {
      expect(STRATEGY_OPERATOR_HELP[operator].summary.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("never names one catalog series in help shared by a whole metric family", () => {
    // One help entry serves all three RSI periods and all seven intrinsic sources, so naming a
    // series would show the wrong one beside every other member of the family.
    const text = STRATEGY_METRIC_KINDS.flatMap((kind) => {
      const help = STRATEGY_METRIC_HELP[kind];
      return [
        help.summary,
        help.detail,
        help.formula ?? "",
        help.notEvaluableWhen ?? "",
        ...(help.notes ?? []),
        ...(help.examples ?? []).flatMap((example) => [
          example.given,
          example.result,
          example.meaning,
        ]),
      ];
    }).join(" ");
    for (const entry of SELECTABLE_SERIES_CATALOG) {
      expect(text).not.toContain(entry.label);
    }
  });

  it("explains Margin of Safety with Intrinsic Value as the denominator", () => {
    const help = STRATEGY_METRIC_HELP.MARGIN_OF_SAFETY;
    expect(help.formula).toBe(
      "Margin of Safety = (Intrinsic Value - Price) / Intrinsic Value * 100",
    );
    expect(help.examples?.map((example) => example.result)).toEqual([
      "25%",
      "0%",
      "-20%",
    ]);
    expect(help.notEvaluableWhen).toContain("zero or negative");
    expect(help.notes?.join(" ")).toContain("33.33%");
  });

  it("starts every metric from a value its own registry entry permits", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const option of strategyMetricOptions(levelKind)) {
        const value = defaultValueFor(option.metric);
        expect(value).toBeDefined();
        const [operator] = conditionOperatorsFor(option.metric);
        expect(
          validateStrategyDefinition(
            definitionInLevel(
              levelKind,
              signal([
                condition(
                  option.metric,
                  operator ?? "IS_ABOVE",
                  value as StrategyValue,
                ),
              ]),
            ),
          ),
        ).toEqual([]);
      }
    }
    expect(
      defaultValueFor({ kind: "OSCILLATOR", seriesId: "RSI_14D" }),
    ).toEqual({ kind: "NUMBER", value: 50 });
    expect(defaultValueFor({ kind: "GAIN" })).toEqual({
      kind: "PERCENT",
      value: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Moving averages as Metrics
// ---------------------------------------------------------------------------

describe("moving-average compatibility", () => {
  it("resolves values through the catalog helper for every moving average", () => {
    for (const entry of MOVING_AVERAGE_SERIES) {
      const spec = valueSpecFor({
        kind: "MOVING_AVERAGE",
        seriesId: entry.id,
      });
      expect(spec.kind).toBe("SERIES");
      expect(spec.kind === "SERIES" && spec.seriesIds).toEqual(
        comparableMovingAverages(entry.id).map((candidate) => candidate.id),
      );
      expect(spec.kind === "SERIES" && spec.seriesIds).not.toContain(entry.id);
    }
  });

  it("accepts a same-timeframe pair and rejects a self-comparison", () => {
    expect(
      validateStrategyDefinition(
        definitionWith(
          condition(
            { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
            "IS_ABOVE",
            series("SMA_200D"),
          ),
        ),
      ),
    ).toEqual([]);

    const selfComparison = validateStrategyDefinition(
      definitionWith(
        condition(
          { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
          "IS_ABOVE",
          series("SMA_50D"),
        ),
      ),
    );
    expect(selfComparison).toHaveLength(1);
    expect(selfComparison[0]?.code).toBe("SERIES_NOT_COMPARABLE");
    expect(selfComparison[0]?.message).toContain("itself");
    expect(selfComparison[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "CONDITION",
      conditionIndex: 0,
      field: "VALUE",
    });
  });

  it("rejects a daily-versus-weekly comparison", () => {
    const issues = validateStrategyDefinition(
      definitionWith(
        condition(
          { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
          "IS_BELOW",
          series("SMA_200W"),
        ),
      ),
    );
    expect(codesOf(issues)).toEqual(["SERIES_NOT_COMPARABLE"]);
  });

  it("rejects an RSI series used as a moving-average metric", () => {
    const issues = validateStrategyDefinition(
      definitionWith(
        condition(
          { kind: "MOVING_AVERAGE", seriesId: "RSI_14D" },
          "IS_ABOVE",
          series("SMA_50D"),
        ),
      ),
    );
    expect(codesOf(issues)).toEqual(["METRIC_SERIES_UNSUPPORTED"]);
  });
});

// ---------------------------------------------------------------------------
// Strategy shape and signal grammar
// ---------------------------------------------------------------------------

describe("strategy shape", () => {
  it("accepts a complete strategy with BUY, SELL and FINAL EXIT levels", () => {
    expect(validateStrategyDefinition(completeDefinition())).toEqual([]);
    expect(
      validateStrategy({
        name: "Value strategy",
        description: "Buy the discount, sell the gain.",
        definition: completeDefinition(),
      }),
    ).toEqual([]);
  });

  it("accepts a buy-and-hold strategy with no SELL level and no FINAL EXIT", () => {
    expect(
      validateStrategyDefinition(definitionOf(signal([priceAboveEma200D()]))),
    ).toEqual([]);
  });

  it("rejects an empty strategy for having no BUY level", () => {
    const issues = validateStrategyDefinition(emptyStrategyDefinition());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("BUY_LEVEL_REQUIRED");
    expect(issues[0]?.path).toEqual({ levelKind: "BUY", part: "STRATEGY" });
  });

  it("rejects a strategy that only sells", () => {
    const issues = validateStrategyDefinition({
      ...definitionInLevel(
        "SELL",
        signal([condition({ kind: "GAIN" }, "IS_ABOVE", percent(10))]),
      ),
      buyLevels: [],
    });
    expect(codesOf(issues)).toEqual(["BUY_LEVEL_REQUIRED"]);
  });

  it("requires a name but does not require it to be unique", () => {
    const definition = definitionOf(signal([priceAboveEma200D()]));
    expect(codesOf(validateStrategy({ name: "  ", definition }))).toEqual([
      "NAME_REQUIRED",
    ]);
    expect(
      codesOf(validateStrategy({ name: "a".repeat(121), definition })),
    ).toEqual(["NAME_TOO_LONG"]);
    // Two strategies may carry the same name; identity is the strategy id.
    expect(validateStrategy({ name: "Value Strategy", definition })).toEqual(
      [],
    );
    expect(validateStrategy({ name: "Value Strategy", definition })).toEqual(
      [],
    );
  });

  it("rejects a description beyond its shared limit", () => {
    expect(
      codesOf(
        validateStrategy({
          name: "Long",
          description: "d".repeat(501),
          definition: definitionOf(signal([priceAboveEma200D()])),
        }),
      ),
    ).toEqual(["DESCRIPTION_TOO_LONG"]);
  });
});

describe("signal grammar", () => {
  it("rejects a signal with neither a condition nor a trigger", () => {
    const issues = validateStrategyDefinition(definitionOf(signal([])));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("SIGNAL_EMPTY");
    expect(issues[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "LEVEL",
    });
  });

  it("accepts a signal that is only a trigger", () => {
    expect(
      validateStrategyDefinition(
        definitionOf(
          signal(
            [],
            trigger({ kind: "PRICE" }, "CROSSES_ABOVE", series("EMA_50D")),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("makes a second trigger unrepresentable rather than rejectable", () => {
    // The product rule "at most one Trigger" is the type's single optional field, so a signal
    // carries no plural trigger key at all; a document that invents one is an unknown field.
    const oneTrigger = signal(
      [],
      trigger({ kind: "PRICE" }, "CROSSES_ABOVE", series("EMA_50D")),
    );
    expect(Object.keys(oneTrigger).sort()).toEqual(["conditions", "trigger"]);
    const issues = validateStrategyDefinition(
      definitionOf({
        ...oneTrigger,
        triggers: [
          trigger({ kind: "PRICE" }, "CROSSES_BELOW", series("EMA_50D")),
        ],
      } as StrategySignal),
    );
    expect(codesOf(issues)).toEqual(["UNKNOWN_FIELD"]);
  });

  it("rejects more conditions than the shared limit allows", () => {
    const conditions = MOVING_AVERAGE_SERIES.slice(0, 11).map((entry, index) =>
      condition(
        { kind: "PRICE" },
        "IS_ABOVE",
        series(entry.id),
        `condition-${index}`,
      ),
    );
    expect(
      codesOf(validateStrategyDefinition(definitionOf(signal(conditions)))),
    ).toEqual(["TOO_MANY_CONDITIONS"]);
  });
});

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

describe("operator compatibility", () => {
  it("accepts `is close to` for Price and a moving average", () => {
    expect(
      validateStrategyDefinition(
        definitionWith(
          condition({ kind: "PRICE" }, "IS_CLOSE_TO", series("EMA_200D")),
        ),
      ),
    ).toEqual([]);
    expect(
      validateStrategyDefinition(
        definitionWith(
          condition(
            { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
            "IS_CLOSE_TO",
            series("SMA_200D"),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects `is close to` for RSI, Margin of Safety, Gain and Loss", () => {
    const rows: [StrategyMetric, StrategyValue][] = [
      [
        { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        { kind: "NUMBER", value: 30 },
      ],
      [{ kind: "MARGIN_OF_SAFETY", sourceId: "GRAHAM" }, percent(25)],
      [{ kind: "GAIN" }, percent(25)],
      [{ kind: "LOSS" }, percent(10)],
    ];
    for (const [metric, value] of rows) {
      const issues = validateStrategyDefinition(
        definitionInLevel(
          metric.kind === "GAIN" || metric.kind === "LOSS" ? "SELL" : "BUY",
          signal([condition(metric, "IS_CLOSE_TO", value)]),
        ),
      );
      expect(codesOf(issues)).toEqual(["OPERATOR_NOT_SUPPORTED"]);
      expect(issues[0]?.path.field).toBe("OPERATOR");
    }
  });

  it("keeps condition and trigger operators in separate vocabularies", () => {
    for (const kind of STRATEGY_METRIC_KINDS) {
      const definition = STRATEGY_METRIC_DEFINITIONS[kind];
      expect(definition.triggerOperators).toEqual([
        "CROSSES_ABOVE",
        "CROSSES_BELOW",
      ]);
      for (const operator of definition.conditionOperators) {
        expect(CONDITION_OPERATORS).toContain(operator);
      }
    }
    // A trigger operator in a condition row is not a supported condition operator.
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          {
            id: "condition-1",
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: series("EMA_50D"),
          } as unknown as StrategyCondition,
        ]),
      ),
    );
    expect(codesOf(issues)).toEqual(["OPERATOR_NOT_SUPPORTED"]);
  });

  it("offers every metric the same operators through the registry accessors", () => {
    const metric: StrategyMetric = { kind: "OSCILLATOR", seriesId: "RSI_7D" };
    expect(conditionOperatorsFor(metric)).toEqual(["IS_ABOVE", "IS_BELOW"]);
    expect(triggerOperatorsFor(metric)).toEqual([
      "CROSSES_ABOVE",
      "CROSSES_BELOW",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Value domains
// ---------------------------------------------------------------------------

describe("value domains", () => {
  function rsiIssues(value: number): string[] {
    return codesOf(
      validateStrategyDefinition(
        definitionWith(
          condition({ kind: "OSCILLATOR", seriesId: "RSI_14D" }, "IS_BELOW", {
            kind: "NUMBER",
            value,
          }),
        ),
      ),
    );
  }

  it("holds RSI thresholds inside 1 through 100", () => {
    expect(rsiIssues(1)).toEqual([]);
    expect(rsiIssues(100)).toEqual([]);
    expect(rsiIssues(30.5)).toEqual([]);
    expect(rsiIssues(0)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(rsiIssues(100.01)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(rsiIssues(Number.POSITIVE_INFINITY)).toEqual([
      "VALUE_OUT_OF_DOMAIN",
    ]);
    expect(rsiIssues(Number.NaN)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });

  it("compares RSI with a typed number, never with a series or a percentage", () => {
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionWith(
            condition(
              { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              "IS_BELOW",
              percent(30),
            ),
          ),
        ),
      ),
    ).toEqual(["VALUE_KIND_MISMATCH"]);
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionWith(
            condition({ kind: "PRICE" }, "IS_ABOVE", {
              kind: "NUMBER",
              value: 30,
            }),
          ),
        ),
      ),
    ).toEqual(["VALUE_KIND_MISMATCH"]);
  });

  it("bounds Margin of Safety at 100 with no lower bound and decimals allowed", () => {
    const mosIssues = (value: number): string[] =>
      codesOf(
        validateStrategyDefinition(
          definitionWith(
            condition(
              { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
              "IS_ABOVE",
              percent(value),
            ),
          ),
        ),
      );
    expect(mosIssues(-250)).toEqual([]);
    expect(mosIssues(0)).toEqual([]);
    expect(mosIssues(22.5)).toEqual([]);
    expect(mosIssues(100)).toEqual([]);
    expect(mosIssues(100.01)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });

  it("bounds Gain at -100 with no upper bound and decimals allowed", () => {
    const gainIssues = (value: number): string[] =>
      codesOf(
        validateStrategyDefinition(
          definitionInLevel(
            "SELL",
            signal([condition({ kind: "GAIN" }, "IS_ABOVE", percent(value))]),
          ),
        ),
      );
    expect(gainIssues(-100)).toEqual([]);
    expect(gainIssues(-10.25)).toEqual([]);
    expect(gainIssues(1000)).toEqual([]);
    expect(gainIssues(-100.01)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });

  it("bounds Loss to 0 through 100 with decimals allowed", () => {
    const lossIssues = (value: number): string[] =>
      codesOf(
        validateStrategyDefinition(
          definitionInLevel(
            "FINAL_EXIT",
            signal([condition({ kind: "LOSS" }, "IS_ABOVE", percent(value))]),
          ),
        ),
      );
    expect(lossIssues(0)).toEqual([]);
    expect(lossIssues(7.25)).toEqual([]);
    expect(lossIssues(100)).toEqual([]);
    expect(lossIssues(-0.01)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(lossIssues(100.01)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });
});

// ---------------------------------------------------------------------------
// Level rules
// ---------------------------------------------------------------------------

describe("level rules", () => {
  it("rejects Gain and Loss in a BUY level with a path pointing at the metric", () => {
    for (const metric of [
      { kind: "GAIN" },
      { kind: "LOSS" },
    ] as StrategyMetric[]) {
      const issues = validateStrategyDefinition(
        definitionWith(condition(metric, "IS_ABOVE", percent(10))),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe("METRIC_NOT_ALLOWED_IN_LEVEL");
      expect(issues[0]?.path).toEqual({
        levelKind: "BUY",
        levelIndex: 0,
        part: "CONDITION",
        conditionIndex: 0,
        field: "METRIC",
      });
    }
  });

  it("rejects a Gain trigger in a BUY level", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([], trigger({ kind: "GAIN" }, "CROSSES_ABOVE", percent(25))),
      ),
    );
    expect(codesOf(issues)).toEqual(["METRIC_NOT_ALLOWED_IN_LEVEL"]);
    expect(issues[0]?.path.part).toBe("TRIGGER");
  });

  it("accepts only the canonical BUY and SELL percentages", () => {
    for (const percentage of BUY_LEVEL_PERCENTAGES) {
      expect(
        validateStrategyDefinition({
          schemaVersion: STRATEGY_SCHEMA_VERSION,
          buyLevels: [
            { id: "buy-1", percentage, signal: signal([priceAboveEma200D()]) },
          ],
          sellLevels: [],
        }),
      ).toEqual([]);
    }
    for (const percentage of SELL_LEVEL_PERCENTAGES) {
      const definition = definitionInLevel(
        "SELL",
        signal([priceAboveEma200D()]),
      );
      expect(
        validateStrategyDefinition({
          ...definition,
          sellLevels: definition.sellLevels.map((level) => ({
            ...level,
            percentage,
          })),
        }),
      ).toEqual([]);
    }
  });

  it("rejects a 100% SELL level, which is FINAL EXIT rather than a partial sell", () => {
    const issues = validateStrategyDefinition({
      ...definitionInLevel("SELL", signal([priceAboveEma200D()])),
      sellLevels: [
        {
          id: "sell-1",
          percentage: 100,
          signal: signal([priceAboveEma200D()]),
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PERCENTAGE_INVALID");
    expect(issues[0]?.path).toEqual({
      levelKind: "SELL",
      levelIndex: 0,
      part: "PERCENTAGE",
    });
  });

  it("rejects an invalid BUY percentage", () => {
    expect(
      codesOf(
        validateStrategyDefinition({
          schemaVersion: STRATEGY_SCHEMA_VERSION,
          buyLevels: [
            {
              id: "buy-1",
              percentage: 30,
              signal: signal([priceAboveEma200D()]),
            },
          ],
          sellLevels: [],
        }),
      ),
    ).toEqual(["PERCENTAGE_INVALID"]);
  });

  it("gives FINAL EXIT a signal and no percentage", () => {
    const valid = validateStrategyDefinition(
      definitionInLevel("FINAL_EXIT", signal([priceAboveEma200D()])),
    );
    expect(valid).toEqual([]);

    const withPercentage = validateStrategyDefinition({
      ...definitionInLevel("FINAL_EXIT", signal([priceAboveEma200D()])),
      finalExit: {
        id: "exit-1",
        percentage: 100,
        signal: signal([priceAboveEma200D()]),
      },
    });
    expect(withPercentage).toHaveLength(1);
    expect(withPercentage[0]?.code).toBe("UNKNOWN_FIELD");
    expect(withPercentage[0]?.path).toEqual({
      levelKind: "FINAL_EXIT",
      part: "PERCENTAGE",
    });
    expect(withPercentage[0]?.message).toContain("entire remaining position");
  });

  it("rejects more levels than the shared limit allows", () => {
    const buyLevels = Array.from({ length: 11 }, (_unused, index) => ({
      id: `buy-${index}`,
      percentage: 25,
      signal: signal([priceAboveEma200D()]),
    }));
    expect(
      codesOf(
        validateStrategyDefinition({
          schemaVersion: STRATEGY_SCHEMA_VERSION,
          buyLevels,
          sellLevels: [],
        }),
      ),
    ).toEqual(["TOO_MANY_LEVELS"]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate conditions
// ---------------------------------------------------------------------------

describe("duplicate conditions", () => {
  it("rejects two semantically identical conditions and points at the duplicate", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "a"),
          condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "b"),
        ]),
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_CONDITION");
    expect(issues[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "CONDITION",
      conditionIndex: 1,
    });
  });

  it("treats identity as semantic, not as row or value formatting", () => {
    // 22.50 and 22.5 are the same number, so these are the same condition.
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          condition(
            { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
            "IS_ABOVE",
            percent(22.5),
            "a",
          ),
          condition(
            { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
            "IS_ABOVE",
            percent(22.5),
            "b",
          ),
        ]),
      ),
    );
    expect(codesOf(issues)).toEqual(["DUPLICATE_CONDITION"]);
  });

  it("never silently removes a duplicate", () => {
    const definition = definitionOf(
      signal([
        condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "a"),
        condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "b"),
      ]),
    );
    expect(() => normalizeStrategyDefinition(definition)).toThrow(
      StrategyValidationError,
    );
    expect(definition.buyLevels[0]?.signal.conditions).toHaveLength(2);
  });

  it("does not treat different metrics, operators or values as duplicates", () => {
    expect(
      validateStrategyDefinition(
        definitionOf(
          signal([
            condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "a"),
            condition({ kind: "PRICE" }, "IS_BELOW", series("EMA_200D"), "b"),
            condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_50D"), "c"),
            condition(
              { kind: "MARGIN_OF_SAFETY", sourceId: "GRAHAM" },
              "IS_ABOVE",
              percent(25),
              "d",
            ),
            condition(
              { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
              "IS_ABOVE",
              percent(25),
              "e",
            ),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("does not treat a condition and a trigger over the same metric as duplicates", () => {
    expect(
      validateStrategyDefinition(
        definitionOf(
          signal(
            [condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_50D"), "a")],
            trigger({ kind: "PRICE" }, "CROSSES_ABOVE", series("EMA_50D"), "t"),
          ),
        ),
      ),
    ).toEqual([]);
  });
});

describe("stable identifiers", () => {
  it("accepts a definition whose level and predicate ids are each unique", () => {
    expect(validateStrategyDefinition(completeDefinition())).toEqual([]);
  });

  it("rejects two BUY levels sharing an id, pointing at the later one", () => {
    const issues = validateStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "level-1",
          percentage: 25,
          signal: signal([priceAboveEma200D()]),
        },
        {
          id: "level-1",
          percentage: 50,
          signal: signal([
            condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_50D"), "c2"),
          ]),
        },
      ],
      sellLevels: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_ID");
    expect(issues[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 1,
      part: "LEVEL",
    });
  });

  it("rejects a level id reused across BUY and SELL", () => {
    const issues = validateStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "level-1",
          percentage: 25,
          signal: signal([priceAboveEma200D()]),
        },
      ],
      sellLevels: [
        {
          id: "level-1",
          percentage: 25,
          signal: signal([
            condition({ kind: "GAIN" }, "IS_ABOVE", percent(10), "c2"),
          ]),
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_ID");
    expect(issues[0]?.path).toEqual({
      levelKind: "SELL",
      levelIndex: 0,
      part: "LEVEL",
    });
  });

  it("rejects a level id reused by FINAL EXIT", () => {
    const issues = validateStrategyDefinition({
      ...definitionInLevel("FINAL_EXIT", signal([priceAboveEma200D()])),
      finalExit: { id: "buy-1", signal: signal([priceAboveEma200D()]) },
    });
    expect(codesOf(issues)).toContain("DUPLICATE_ID");
    expect(issues.find((issue) => issue.code === "DUPLICATE_ID")?.path).toEqual(
      { levelKind: "FINAL_EXIT", part: "LEVEL" },
    );
  });

  it("rejects two conditions sharing an id, separately from a semantic duplicate", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "row-1"),
          condition({ kind: "PRICE" }, "IS_BELOW", series("EMA_50D"), "row-1"),
        ]),
      ),
    );
    // The rules are independent: these two rows are different conditions that merely collide on
    // their identifier, so only the id rule fires.
    expect(codesOf(issues)).toEqual(["DUPLICATE_ID"]);
    expect(issues[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "CONDITION",
      conditionIndex: 1,
    });
  });

  it("reports both rules when two rows are semantically identical and share an id", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "row-1"),
          condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "row-1"),
        ]),
      ),
    );
    expect(codesOf(issues).sort()).toEqual([
      "DUPLICATE_CONDITION",
      "DUPLICATE_ID",
    ]);
  });

  it("rejects a condition id colliding with the trigger id in the same signal", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal(
          [
            condition(
              { kind: "PRICE" },
              "IS_ABOVE",
              series("EMA_200D"),
              "row-1",
            ),
          ],
          trigger(
            { kind: "PRICE" },
            "CROSSES_ABOVE",
            series("EMA_50D"),
            "row-1",
          ),
        ),
      ),
    );
    expect(codesOf(issues)).toEqual(["DUPLICATE_ID"]);
    expect(issues[0]?.path).toEqual({
      levelKind: "BUY",
      levelIndex: 0,
      part: "TRIGGER",
    });
  });

  it("rejects a predicate id reused in a different level", () => {
    const issues = validateStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 25,
          signal: signal([
            condition(
              { kind: "PRICE" },
              "IS_ABOVE",
              series("EMA_200D"),
              "row-1",
            ),
          ]),
        },
        {
          id: "buy-2",
          percentage: 50,
          signal: signal([
            condition(
              { kind: "PRICE" },
              "IS_BELOW",
              series("EMA_50D"),
              "row-1",
            ),
          ]),
        },
      ],
      sellLevels: [],
    });
    expect(codesOf(issues)).toEqual(["DUPLICATE_ID"]);
    expect(issues[0]?.path.levelIndex).toBe(1);
  });

  it("keeps level and predicate identifiers in separate namespaces", () => {
    expect(
      validateStrategyDefinition(
        definitionOf(
          signal([
            condition(
              { kind: "PRICE" },
              "IS_ABOVE",
              series("EMA_200D"),
              "buy-1",
            ),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("never regenerates or drops a duplicate identifier", () => {
    const definition = definitionOf(
      signal([
        condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "row-1"),
        condition({ kind: "PRICE" }, "IS_BELOW", series("EMA_50D"), "row-1"),
      ]),
    );
    expect(() => normalizeStrategyDefinition(definition)).toThrow(
      StrategyValidationError,
    );
    expect(
      definition.buyLevels[0]?.signal.conditions.map((row) => row.id),
    ).toEqual(["row-1", "row-1"]);
  });
});

// ---------------------------------------------------------------------------
// Unknown identifiers and foreign fields
// ---------------------------------------------------------------------------

describe("unknown identifiers and foreign fields", () => {
  it("rejects a series id outside the canonical catalog", () => {
    const metricIssues = validateStrategyDefinition(
      definitionWith(
        condition(
          { kind: "MOVING_AVERAGE", seriesId: "SMA_42D" as SelectableSeriesId },
          "IS_ABOVE",
          series("SMA_200D"),
        ),
      ),
    );
    expect(codesOf(metricIssues)).toEqual(["SERIES_UNKNOWN"]);
    expect(metricIssues[0]?.path.field).toBe("METRIC");

    const valueIssues = validateStrategyDefinition(
      definitionWith(
        condition(
          { kind: "PRICE" },
          "IS_ABOVE",
          series("MADE_UP" as SelectableSeriesId),
        ),
      ),
    );
    expect(codesOf(valueIssues)).toEqual(["SERIES_UNKNOWN"]);
    expect(valueIssues[0]?.path.field).toBe("VALUE");
  });

  it("rejects an unknown metric kind", () => {
    const issues = validateStrategyDefinition(
      definitionOf(
        signal([
          {
            id: "condition-1",
            metric: { kind: "VOLUME" },
            operator: "IS_ABOVE",
            value: { kind: "NUMBER", value: 10 },
          } as unknown as StrategyCondition,
        ]),
      ),
    );
    expect(codesOf(issues)).toEqual(["SHAPE_INVALID"]);
    expect(issues[0]?.message).toContain("VOLUME");
  });

  it("rejects an oscillator used where Price expects a price-scaled series", () => {
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionWith(
            condition({ kind: "PRICE" }, "IS_ABOVE", series("RSI_14D")),
          ),
        ),
      ),
    ).toEqual(["SERIES_NOT_COMPARABLE"]);
  });

  it("rejects backtest execution fields inside a strategy definition", () => {
    for (const key of [
      "stockListId",
      "maximumPositions",
      "initialCapital",
      "monthlyContribution",
      "startDate",
    ]) {
      const issues = validateStrategyDefinition({
        ...definitionOf(signal([priceAboveEma200D()])),
        [key]: 10,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe("UNKNOWN_FIELD");
      expect(issues[0]?.path).toEqual({ part: "STRATEGY" });
      expect(issues[0]?.message).toContain(key);
      expect(issues[0]?.message).toContain("backtest configuration");
    }
  });

  it("rejects a backtest field on the strategy itself", () => {
    const issues = validateStrategy({
      name: "With a list",
      definition: definitionOf(signal([priceAboveEma200D()])),
      stockListId: "list-1",
    });
    expect(codesOf(issues)).toEqual(["UNKNOWN_FIELD"]);
  });

  it("rejects a wrong or missing schema version", () => {
    expect(
      codesOf(
        validateStrategyDefinition({
          ...definitionOf(signal([priceAboveEma200D()])),
          schemaVersion: 2,
        }),
      ),
    ).toEqual(["SHAPE_INVALID"]);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalization", () => {
  it("is idempotent and preserves level and condition order exactly", () => {
    const once = normalizeStrategyDefinition(completeDefinition());
    const twice = normalizeStrategyDefinition(once);
    expect(twice).toEqual(once);
    expect(once.buyLevels.map((level) => level.id)).toEqual(["buy-1", "buy-2"]);
    expect(once.buyLevels[0]?.signal.conditions.map((row) => row.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("throws a StrategyValidationError carrying the same issues the validator reports", () => {
    const definition = emptyStrategyDefinition();
    try {
      normalizeStrategyDefinition(definition);
      expect.unreachable("normalization should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StrategyValidationError);
      expect((error as StrategyValidationError).issues).toEqual(
        validateStrategyDefinition(definition),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------

describe("describeStrategy", () => {
  it("renders a deterministic structured preview of every level", () => {
    const lines = describeStrategy(completeDefinition());
    expect(lines).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 25 },
      { kind: "CONDITION", text: "Price is below Balanced" },
      { kind: "CONDITION", text: "RSI 14D is below 30", connector: "AND" },
      {
        kind: "CONDITION",
        text: "Margin of Safety (DCF (FCFF)) is above 25%",
        connector: "AND",
      },
      {
        kind: "TRIGGER",
        text: "Price crosses above EMA 50D",
        connector: "AND",
      },
      { kind: "LEVEL", levelKind: "BUY", index: 2, percentage: 50 },
      { kind: "CONDITION", text: "EMA 50D is above SMA 200D" },
      { kind: "LEVEL", levelKind: "SELL", index: 1, percentage: 50 },
      { kind: "CONDITION", text: "Gain is above 25%" },
      { kind: "LEVEL", levelKind: "FINAL_EXIT" },
      { kind: "TRIGGER", text: "Loss crosses above 10%" },
    ]);
    expect(describeStrategy(completeDefinition())).toEqual(lines);
  });

  it("keeps the AND connector before a trigger that follows conditions", () => {
    const lines = describeStrategy(
      definitionOf(
        signal(
          [
            condition({ kind: "PRICE" }, "IS_ABOVE", series("EMA_200D"), "c1"),
            condition(
              { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              "IS_BELOW",
              { kind: "NUMBER", value: 30 },
              "c2",
            ),
          ],
          trigger({ kind: "PRICE" }, "CROSSES_ABOVE", series("EMA_50D"), "t1"),
        ),
      ),
    );
    expect(lines).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 25 },
      { kind: "CONDITION", text: "Price is above EMA 200D" },
      { kind: "CONDITION", text: "RSI 14D is below 30", connector: "AND" },
      {
        kind: "TRIGGER",
        text: "Price crosses above EMA 50D",
        connector: "AND",
      },
    ]);
  });

  it("gives a single condition followed by a trigger the connector too", () => {
    expect(
      describeStrategy(
        definitionOf(
          signal(
            [
              condition(
                { kind: "PRICE" },
                "IS_ABOVE",
                series("EMA_200D"),
                "c1",
              ),
            ],
            trigger(
              { kind: "PRICE" },
              "CROSSES_ABOVE",
              series("EMA_50D"),
              "t1",
            ),
          ),
        ),
      ).filter((line) => line.kind === "TRIGGER"),
    ).toEqual([
      {
        kind: "TRIGGER",
        text: "Price crosses above EMA 50D",
        connector: "AND",
      },
    ]);
  });

  it("gives a trigger-only signal no connector, because it joins nothing", () => {
    expect(
      describeStrategy(
        definitionOf(
          signal(
            [],
            trigger(
              { kind: "PRICE" },
              "CROSSES_ABOVE",
              series("EMA_50D"),
              "t1",
            ),
          ),
        ),
      ),
    ).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 25 },
      { kind: "TRIGGER", text: "Price crosses above EMA 50D" },
    ]);
  });

  it("renders an explicit placeholder for an incomplete level", () => {
    expect(describeStrategy(definitionOf(signal([])))).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 25 },
      { kind: "EMPTY", levelKind: "BUY" },
    ]);
  });

  it("renders an empty strategy as no lines at all", () => {
    expect(describeStrategy(emptyStrategyDefinition())).toEqual([]);
  });

  it("reads rules as short sentences in product vocabulary", () => {
    expect(
      strategyMetricLabel({ kind: "MARGIN_OF_SAFETY", sourceId: "GRAHAM" }),
    ).toBe("Margin of Safety (Graham)");
    expect(strategyMetricLabel({ kind: "PRICE" })).toBe("Price");
    expect(
      strategyMetricLabel({ kind: "MOVING_AVERAGE", seriesId: "SMA_200W" }),
    ).toBe("SMA 200W");
    expect(strategyValueLabel({ kind: "PERCENT", value: -12.5 })).toBe(
      "-12.5%",
    );
    expect(strategyValueLabel({ kind: "NUMBER", value: 70 })).toBe("70");
  });
});
