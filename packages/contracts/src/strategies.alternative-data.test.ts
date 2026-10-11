import { describe, expect, it } from "vitest";
import {
  ACTOR_SCOPE_KINDS,
  ACTOR_SCOPE_MAX_ACTORS,
  ALTERNATIVE_DATA_LOOKBACKS,
  alternativeDataMetricFingerprint,
  alternativeDataMetricSignature,
  CONGRESS_MEASURES,
  collectActorGroupIds,
  collectActorIds,
  defaultAlternativeDataMetric,
  describeAlternativeDataConfiguration,
  INSIDER_MEASURES,
  parseAlternativeDataMetricSignature,
  SELECTABLE_ACTOR_SCOPE_KINDS,
  type ActorScope,
  type AlternativeDataMetric,
} from "./alternative-data.js";
import {
  ActorGroupScopeUnresolvedError,
  asAlternativeDataMetric,
  defaultConditionOperatorFor,
  defaultStrategyMetric,
  defaultValueFor,
  describeCondition,
  describeMetricConfiguration,
  describeStrategy,
  embedActorGroupScopes,
  normalizeStrategyDefinition,
  rekeyStrategyDefinition,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_METRIC_HELP,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyMetricCategories,
  strategyMetricCategory,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategySignalFingerprint,
  strategyValueLabel,
  StrategyValidationError,
  validateStrategyDefinition,
  valueSpecFor,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategyValidationCode,
} from "./strategies.js";

/**
 * The alternative-data half of the Strategy model.
 *
 * Its sibling `strategies.test.ts` pins the pre-existing catalog; this suite covers what the
 * alternative-data slice adds and — just as importantly — proves it changed nothing that already
 * existed: the operator vocabulary of every other metric, and the fingerprint of every definition
 * that does not name one of these metrics.
 */

function insider(
  overrides: Partial<Extract<AlternativeDataMetric, { kind: "INSIDER_ACTIVITY" }>> = {},
): StrategyMetric {
  return {
    kind: "INSIDER_ACTIVITY",
    measure: "BUYERS",
    lookback: 20,
    ...overrides,
  };
}

function congress(
  overrides: Partial<Extract<AlternativeDataMetric, { kind: "CONGRESS_ACTIVITY" }>> = {},
): StrategyMetric {
  return {
    kind: "CONGRESS_ACTIVITY",
    measure: "PURCHASES",
    lookback: 30,
    scope: { kind: "ANY" },
    chamber: "ANY",
    ...overrides,
  };
}

function definitionWith(condition: StrategyCondition): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "b1", percentage: 100, signal: { conditions: [condition] } }],
    sellLevels: [],
  };
}

function codesOf(definition: unknown): StrategyValidationCode[] {
  return validateStrategyDefinition(definition).map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("the alternative-data metric catalog", () => {
  it("offers one metric per measure, named by its identity, in every level kind", () => {
    for (const levelKind of ["BUY", "SELL", "FINAL_EXIT"] as const) {
      const categories = strategyMetricCategories(levelKind);
      const labelsOf = (id: string) =>
        categories
          .find((category) => category.id === id)
          ?.options.map((option) => option.label);
      // One entry per measure and never one per configuration: the lookback, scope and filters are
      // edited after the metric is chosen, so no label carries them.
      expect(labelsOf("INSIDER_ACTIVITY")).toEqual([
        "Insider buyers",
        "Insider sellers",
        "Insider purchase value",
        "Insider sale value",
      ]);
      expect(labelsOf("CONGRESSIONAL_TRADING")).toEqual([
        "Congress purchases",
        "Congress sales",
        "Congress buyers",
        "Congress sellers",
        "Congress minimum disclosed purchase value",
      ]);
      expect(
        categories.find((category) => category.id === "INSIDER_ACTIVITY")
          ?.label,
      ).toBe("Insider activity");
      expect(
        categories.find((category) => category.id === "CONGRESSIONAL_TRADING")
          ?.label,
      ).toBe("Congressional trading");
    }
  });

  it("offers no institutional option at all", () => {
    // V1 ships Insider Activity and Congressional Trading only: the provider subscription does not
    // cover Form 13F, so no institutional measure, group or selector section exists to be selected.
    const categories = new Set(
      strategyMetricOptions("BUY").map((option) => option.category),
    );
    expect(categories.has("INSIDER_ACTIVITY")).toBe(true);
    expect(categories.has("CONGRESSIONAL_TRADING")).toBe(true);
    expect([...categories]).not.toContain("INSTITUTIONAL_ACTIVITY");
  });

  it("offers none of them as a Trigger", () => {
    for (const levelKind of ["BUY", "SELL", "FINAL_EXIT"] as const) {
      const kinds = new Set(
        strategyMetricOptions(levelKind, "TRIGGER").map(
          (option) => option.metric.kind,
        ),
      );
      expect(kinds.has("INSIDER_ACTIVITY")).toBe(false);
      expect(kinds.has("CONGRESS_ACTIVITY")).toBe(false);
    }
  });

  it("offers these metrics the strict comparison pair and nothing else", () => {
    for (const kind of ["INSIDER_ACTIVITY", "CONGRESS_ACTIVITY"] as const) {
      expect(STRATEGY_METRIC_DEFINITIONS[kind].conditionOperators).toEqual([
        "IS_ABOVE",
        "IS_BELOW",
      ]);
    }
  });

  it("starts a fresh row on `is above 0`: any such activity at all", () => {
    expect(defaultConditionOperatorFor(insider())).toBe("IS_ABOVE");
    expect(defaultValueFor(insider())).toEqual({ kind: "NUMBER", value: 0 });
    expect(defaultConditionOperatorFor(congress())).toBe("IS_ABOVE");
    expect(defaultValueFor(congress())).toEqual({ kind: "NUMBER", value: 0 });
  });

  it("belongs to its own category, derived from its kind", () => {
    expect(strategyMetricCategory(insider({ lookback: 180 }))).toBe(
      "INSIDER_ACTIVITY",
    );
    expect(strategyMetricCategory(congress({ chamber: "HOUSE" }))).toBe(
      "CONGRESSIONAL_TRADING",
    );
  });

  it("keys the metric by its identity only, so configuring it never deselects it", () => {
    expect(strategyMetricKey(insider())).toBe("INSIDER_ACTIVITY:BUYERS");
    expect(strategyMetricKey(insider({ lookback: 120, roles: ["CEO"] }))).toBe(
      "INSIDER_ACTIVITY:BUYERS",
    );
    expect(
      strategyMetricKey(
        congress({ scope: { kind: "GROUP", groupId: "g1" }, chamber: "SENATE" }),
      ),
    ).toBe("CONGRESS_ACTIVITY:PURCHASES");
    // Two measures of one kind never collide.
    expect(strategyMetricKey(insider({ measure: "SELLERS" }))).not.toBe(
      strategyMetricKey(insider()),
    );
  });

  it("never carries configuration in the label: the lookback is configuration", () => {
    expect(strategyMetricLabel(insider({ lookback: 60 }))).toBe(
      "Insider buyers",
    );
    expect(
      strategyMetricLabel(insider({ lookback: 180, roles: ["CEO"] })),
    ).toBe("Insider buyers");
    expect(
      strategyMetricLabel(
        congress({ lookback: 250, chamber: "SENATE", owners: ["SELF"] }),
      ),
    ).toBe("Congress purchases");
  });

  it("explains every kind", () => {
    for (const kind of ["INSIDER_ACTIVITY", "CONGRESS_ACTIVITY"] as const) {
      const help = STRATEGY_METRIC_HELP[kind];
      expect(help.summary.length).toBeGreaterThan(0);
      expect(help.notEvaluableWhen?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Units and values
// ---------------------------------------------------------------------------

describe("alternative-data value domains", () => {
  it("gives a count metric a whole-number threshold", () => {
    expect(valueSpecFor(insider())).toEqual({
      kind: "NUMBER",
      min: 0,
      max: 1_000,
      step: 1,
      integer: true,
    });
    expect(defaultValueFor(insider())).toEqual({ kind: "NUMBER", value: 0 });
  });

  it("gives a value metric a money threshold, unbounded above", () => {
    expect(valueSpecFor(insider({ measure: "PURCHASE_VALUE" }))).toEqual({
      kind: "MONEY",
      min: 0,
      step: 1_000,
    });
    expect(defaultValueFor(insider({ measure: "PURCHASE_VALUE" }))).toEqual({
      kind: "MONEY",
      value: 0,
    });
  });

  it("renders money grouped, with no decimals", () => {
    expect(strategyValueLabel({ kind: "MONEY", value: 1_000_000 })).toBe(
      "$1,000,000",
    );
    expect(strategyValueLabel({ kind: "MONEY", value: 250_000.4 })).toBe(
      "$250,000",
    );
  });

  it("rejects a fractional count and a money threshold below zero", () => {
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider(),
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 2.5 },
        }),
      ),
    ).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider({ measure: "PURCHASE_VALUE" }),
          operator: "IS_ABOVE",
          value: { kind: "MONEY", value: -1 },
        }),
      ),
    ).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });

  it("rejects the wrong unit for the measure", () => {
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider({ measure: "PURCHASE_VALUE" }),
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 5 },
        }),
      ),
    ).toEqual(["VALUE_KIND_MISMATCH"]);
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider(),
          operator: "IS_ABOVE",
          value: { kind: "MONEY", value: 5 },
        }),
      ),
    ).toEqual(["VALUE_KIND_MISMATCH"]);
  });
});

// ---------------------------------------------------------------------------
// Validation of configuration
// ---------------------------------------------------------------------------

describe("alternative-data configuration validation", () => {
  const valid = (metric: unknown) =>
    codesOf({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric,
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 2 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });

  it("accepts every measure of every kind at its default configuration", () => {
    for (const [kind, measures] of [
      ["INSIDER_ACTIVITY", INSIDER_MEASURES],
      ["CONGRESS_ACTIVITY", CONGRESS_MEASURES],
    ] as const) {
      for (const measure of measures) {
        const metric = defaultAlternativeDataMetric(kind, measure);
        expect(metric).toBeDefined();
        const value = defaultValueFor(metric as StrategyMetric);
        expect(
          codesOf(
            definitionWith({
              id: "c1",
              metric: metric as StrategyMetric,
              operator: defaultConditionOperatorFor(metric as StrategyMetric),
              value: value as never,
            }),
          ),
          `${kind}/${measure}`,
        ).toEqual([]);
      }
    }
  });

  it("refuses a measure the domain does not define", () => {
    expect(valid({ kind: "INSIDER_ACTIVITY", measure: "SHORTS", lookback: 20 })).toEqual([
      "MEASURE_UNSUPPORTED",
    ]);
    // A congressional measure is not an insider one.
    expect(
      valid({ kind: "INSIDER_ACTIVITY", measure: "PURCHASES", lookback: 20 }),
    ).toEqual(["MEASURE_UNSUPPORTED"]);
  });

  it("refuses a lookback outside the preset list rather than rounding it", () => {
    expect(
      valid({ kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 21 }),
    ).toEqual(["LOOKBACK_UNSUPPORTED"]);
    for (const lookback of ALTERNATIVE_DATA_LOOKBACKS) {
      expect(
        valid({ kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback }),
      ).toEqual([]);
    }
  });

  it("refuses a scope on the insider kind, which has none", () => {
    expect(
      valid({
        kind: "INSIDER_ACTIVITY",
        measure: "BUYERS",
        lookback: 20,
        scope: { kind: "ANY" },
      }),
    ).toEqual(["UNKNOWN_FIELD"]);
  });

  it("requires a scope on the kind that has one", () => {
    expect(
      valid({ kind: "CONGRESS_ACTIVITY", measure: "PURCHASES", lookback: 30, chamber: "ANY" }),
    ).toEqual(["SCOPE_INVALID"]);
  });

  it("refuses a scope missing its identifier, and one carrying the wrong one", () => {
    expect(
      valid({
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 30,
        chamber: "ANY",
        scope: { kind: "GROUP" },
      }),
    ).toEqual(["SCOPE_INVALID"]);
    expect(
      valid({
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 30,
        chamber: "ANY",
        scope: { kind: "GROUP", actorId: "a1" },
      }),
    ).toEqual(["UNKNOWN_FIELD", "SCOPE_INVALID"]);
  });

  it("refuses an unknown chamber, owner or role rather than dropping the filter", () => {
    // Dropping one would silently widen a rule the user narrowed.
    expect(
      valid({
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 30,
        scope: { kind: "ANY" },
        chamber: "LORDS",
      }),
    ).toEqual(["FILTER_INVALID"]);
    expect(
      valid({
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 30,
        scope: { kind: "ANY" },
        chamber: "ANY",
        owners: ["SELF", "COUSIN"],
      }),
    ).toEqual(["FILTER_INVALID"]);
    expect(
      valid({
        kind: "INSIDER_ACTIVITY",
        measure: "BUYERS",
        lookback: 20,
        roles: ["CHIEF_VIBES_OFFICER"],
      }),
    ).toEqual(["FILTER_INVALID"]);
  });

  it("refuses an empty filter list, which would admit nobody", () => {
    expect(
      valid({
        kind: "INSIDER_ACTIVITY",
        measure: "BUYERS",
        lookback: 20,
        roles: [],
      }),
    ).toEqual(["FILTER_INVALID"]);
  });

  it("refuses a trigger built from one of these metrics", () => {
    expect(
      codesOf({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          {
            id: "b1",
            percentage: 100,
            signal: {
              conditions: [],
              trigger: {
                id: "t1",
                metric: insider(),
                operator: "CROSSES_ABOVE",
                value: { kind: "NUMBER", value: 2 },
              },
            },
          },
        ],
        sellLevels: [],
      }),
    ).toEqual(["METRIC_NOT_ALLOWED_IN_PART"]);
  });

  it("refuses the removed inclusive operators rather than mapping them to a strict one", () => {
    // `is at least 2` is not `is above 2`, so a document still naming one is refused, never
    // reinterpreted — whichever measure or unit it counts.
    for (const metric of [
      insider(),
      insider({ measure: "SALE_VALUE" }),
      congress(),
      congress({ measure: "MINIMUM_PURCHASE_VALUE" }),
    ]) {
      for (const operator of ["IS_AT_LEAST", "IS_AT_MOST"]) {
        const issues = validateStrategyDefinition(
          definitionWith({
            id: "c1",
            metric,
            operator,
            value: defaultValueFor(metric),
          } as unknown as StrategyCondition),
        );
        expect(issues.map((issue) => issue.code)).toEqual([
          "OPERATOR_NOT_SUPPORTED",
        ]);
        expect(issues[0]?.message).toContain("Available: is above, is below.");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Normalization and identity
// ---------------------------------------------------------------------------

describe("alternative-data normalization", () => {
  it("canonicalizes filter order, so one rule written two ways persists once", () => {
    const left = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: insider({ roles: ["DIRECTOR", "CEO"] }),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 2 },
      }),
    );
    const right = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: insider({ roles: ["CEO", "DIRECTOR"] }),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 2 },
      }),
    );
    expect(left).toEqual(right);
    const metric = asAlternativeDataMetric(
      left.buyLevels[0]?.signal.conditions[0]?.metric as StrategyMetric,
    );
    expect(metric).toEqual({
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
      roles: ["CEO", "DIRECTOR"],
    });
  });

  it("is idempotent", () => {
    const once = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: congress({
          scope: { kind: "GROUP", groupId: "g1" },
          chamber: "SENATE",
          owners: ["SPOUSE", "SELF"],
        }),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 2 },
      }),
    );
    expect(normalizeStrategyDefinition(once)).toEqual(once);
  });

  it("round-trips through JSON unchanged", () => {
    const definition = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: congress({
          measure: "MINIMUM_PURCHASE_VALUE",
          lookback: 90,
          scope: { kind: "ACTOR", actorId: "a1" },
          owners: ["SELF"],
        }),
        operator: "IS_ABOVE",
        value: { kind: "MONEY", value: 25_000 },
      }),
    );
    expect(
      normalizeStrategyDefinition(JSON.parse(JSON.stringify(definition))),
    ).toEqual(definition);
  });
});

describe("alternative-data identity", () => {
  it("distinguishes every configurable field in the metric signature", () => {
    const base = insider() as AlternativeDataMetric;
    const signatures = new Set(
      [
        base,
        { ...base, measure: "SELLERS" },
        { ...base, lookback: 60 },
        { ...base, roles: ["CEO"] },
        { ...base, roles: ["CFO"] },
        { ...base, roles: ["CEO", "CFO"] },
      ].map((metric) => alternativeDataMetricSignature(metric as AlternativeDataMetric)),
    );
    expect(signatures.size).toBe(6);
  });

  it("gives one configuration one signature, whatever order it was written in", () => {
    expect(
      alternativeDataMetricSignature(
        congress({ owners: ["SPOUSE", "SELF"] }) as AlternativeDataMetric,
      ),
    ).toBe(
      alternativeDataMetricSignature(
        congress({ owners: ["SELF", "SPOUSE"] }) as AlternativeDataMetric,
      ),
    );
  });

  it("treats two measures of one kind as different conditions, not duplicates", () => {
    expect(
      codesOf({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          {
            id: "b1",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c1",
                  metric: insider(),
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 2 },
                },
                {
                  id: "c2",
                  metric: insider({ measure: "SELLERS" }),
                  operator: "IS_BELOW",
                  value: { kind: "NUMBER", value: 1 },
                },
                {
                  id: "c3",
                  metric: insider({ lookback: 60 }),
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 2 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      }),
    ).toEqual([]);
  });

  it("still rejects the same configured metric twice", () => {
    expect(
      codesOf({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [
          {
            id: "b1",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c1",
                  metric: insider(),
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 2 },
                },
                {
                  id: "c2",
                  metric: insider(),
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 2 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      }),
    ).toEqual(["DUPLICATE_CONDITION"]);
  });

  it("fingerprints a configuration change as a change of logic", () => {
    const signalFor = (metric: StrategyMetric) => ({
      conditions: [
        {
          id: "c1",
          metric,
          operator: "IS_ABOVE" as const,
          value: { kind: "NUMBER" as const, value: 2 },
        },
      ],
    });
    const fingerprints = new Set(
      [
        insider(),
        insider({ lookback: 60 }),
        insider({ measure: "SELLERS" }),
        insider({ roles: ["CEO"] }),
        congress(),
        congress({ scope: { kind: "GROUP", groupId: "g1" } }),
        congress({ scope: { kind: "GROUP", groupId: "g2" } }),
        congress({ chamber: "SENATE" }),
        congress({ owners: ["SELF"] }),
      ].map((metric) => strategySignalFingerprint(signalFor(metric))),
    );
    expect(fingerprints.size).toBe(9);
  });

  it("leaves the fingerprint of a definition without these metrics byte-identical", () => {
    // The backwards-compatibility guarantee: a stored `definitionHash` and a Monitor latch may not
    // move because this feature shipped.
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
              {
                id: "c2",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
            ],
            trigger: {
              id: "t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
          },
        },
      ],
      sellLevels: [],
    };
    expect(strategyDefinitionFingerprint(definition)).toBe(
      '[1,[[50,[[[["PRICE",null],"IS_BELOW",["SERIES","SMA_200D"]],[["OSCILLATOR","RSI_14D"],"IS_BELOW",["NUMBER",30]]],[["PRICE",null],"CROSSES_ABOVE",["SERIES","EMA_50D"]]]]],[],null]',
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("alternative-data rendering", () => {
  it("reads as the metric, the comparison and the value, then the configuration", () => {
    expect(
      describeCondition({
        id: "c1",
        metric: insider(),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 1 },
      }),
    ).toBe("Insider buyers is above 1 (20D)");
    expect(
      describeCondition({
        id: "c2",
        metric: congress(),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 1 },
      }),
    ).toBe("Congress purchases is above 1 (30D)");
    expect(
      describeCondition({
        id: "c3",
        metric: congress({ measure: "MINIMUM_PURCHASE_VALUE" }),
        operator: "IS_ABOVE",
        value: { kind: "MONEY", value: 50_000 },
      }),
    ).toBe("Congress minimum disclosed purchase value is above $50,000 (30D)");
  });

  it("summarizes the lookback always, and then only what was actually narrowed", () => {
    expect(
      describeAlternativeDataConfiguration(insider() as AlternativeDataMetric),
    ).toBe("20D");
    expect(
      describeAlternativeDataConfiguration(
        insider({
          lookback: 180,
          roles: ["CEO", "CFO", "DIRECTOR"],
        }) as AlternativeDataMetric,
      ),
    ).toBe("180D · CEO, CFO, Director");
    expect(
      describeAlternativeDataConfiguration(
        congress({
          scope: { kind: "GROUP", groupId: "g1" },
          chamber: "SENATE",
          owners: ["SELF", "SPOUSE"],
        }) as AlternativeDataMetric,
        { groupName: "Congress Watchlist" },
      ),
    ).toBe("30D · Congress Watchlist · Senate · Self, Spouse");
    expect(
      describeAlternativeDataConfiguration(
        congress({
          scope: { kind: "GROUP", groupId: "g1" },
        }) as AlternativeDataMetric,
        { groupName: "Congress Watchlist" },
      ),
    ).toBe("30D · Congress Watchlist");
  });

  it("describes no configuration for a metric that takes none", () => {
    expect(describeMetricConfiguration({ kind: "PRICE" })).toBeNull();
    expect(
      describeMetricConfiguration({ kind: "RELATIVE_VOLUME", period: 20 }),
    ).toBeNull();
    expect(
      describeMetricConfiguration({ kind: "OSCILLATOR", seriesId: "RSI_14D" }),
    ).toBeNull();
  });

  it("falls back to a neutral label when the name has not been resolved", () => {
    expect(
      describeMetricConfiguration(
        congress({ scope: { kind: "GROUP", groupId: "g1" } }),
      ),
    ).toBe("30D · Selected group");
    // A legacy single-actor scope is described exactly as the one-entry selection it means.
    expect(
      describeMetricConfiguration(
        congress({ scope: { kind: "ACTOR", actorId: "a1" } }),
      ),
    ).toBe("30D · 1 selected member");
  });

  it("carries the configuration onto the Strategy Logic line as its own part", () => {
    const lines = describeStrategy(
      definitionWith({
        id: "c1",
        metric: congress({ scope: { kind: "GROUP", groupId: "g1" } }),
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 1 },
      }),
      { groups: { g1: "Congress Watchlist" } },
    );
    expect(lines).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 100 },
      {
        kind: "CONDITION",
        text: "Congress purchases is above 1",
        configuration: "30D · Congress Watchlist",
      },
    ]);
  });

  it("adds no configuration field to a line whose metric has none", () => {
    const lines = describeStrategy(
      definitionWith({
        id: "c1",
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        operator: "IS_BELOW",
        value: { kind: "NUMBER", value: 30 },
      }),
    );
    expect(lines[1]).toEqual({
      kind: "CONDITION",
      text: "RSI 14D is below 30",
    });
  });
});

// ---------------------------------------------------------------------------
// Identity versus configuration — the regressions behind the Category / Metric selector
// ---------------------------------------------------------------------------

describe("metric identity versus configuration", () => {
  /** Every representation the product derives from one configured Condition. */
  function representations(condition: StrategyCondition) {
    const definition = definitionWith(condition);
    const normalized = normalizeStrategyDefinition(definition);
    const persisted = normalizeStrategyDefinition(
      JSON.parse(JSON.stringify(normalized)),
    );
    const line = describeStrategy(persisted)[1];
    return {
      category: strategyMetricCategory(condition.metric),
      key: strategyMetricKey(condition.metric),
      label: strategyMetricLabel(condition.metric),
      configuration: describeMetricConfiguration(condition.metric),
      sentence: describeCondition(condition),
      line,
      persistedMetric: persisted.buyLevels[0]?.signal.conditions[0]?.metric,
      normalized,
      persisted,
    };
  }

  it("A: Insider activity -> Insider sellers configured to 180D agrees on 180D everywhere", () => {
    const condition: StrategyCondition = {
      id: "c1",
      metric: insider({
        measure: "SELLERS",
        lookback: 180,
        roles: ["CFO", "CEO"],
      }),
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 2 },
    };
    const view = representations(condition);
    expect(view.category).toBe("INSIDER_ACTIVITY");
    // Identity: the same before and after configuration, and never carrying a lookback.
    expect(view.key).toBe("INSIDER_ACTIVITY:SELLERS");
    expect(view.label).toBe("Insider sellers");
    expect(view.key).toBe(strategyMetricKey(insider({ measure: "SELLERS" })));
    // Configuration: one summary, in role order, with the configured lookback — never a default.
    expect(view.configuration).toBe("180D · CEO, CFO");
    expect(view.sentence).toBe("Insider sellers is above 2 (180D · CEO, CFO)");
    expect(view.line).toEqual({
      kind: "CONDITION",
      text: "Insider sellers is above 2",
      configuration: "180D · CEO, CFO",
    });
    expect(view.persistedMetric).toEqual({
      kind: "INSIDER_ACTIVITY",
      measure: "SELLERS",
      lookback: 180,
      roles: ["CEO", "CFO"],
    });
    for (const text of [
      view.configuration,
      view.sentence,
      JSON.stringify(view.line),
    ]) {
      expect(text).not.toContain("20D");
    }
  });

  it("B: Congressional trading -> Congress purchases configured to 180D + House agrees everywhere", () => {
    const condition: StrategyCondition = {
      id: "c1",
      metric: congress({ lookback: 180, chamber: "HOUSE" }),
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 0 },
    };
    const view = representations(condition);
    expect(view.category).toBe("CONGRESSIONAL_TRADING");
    expect(view.key).toBe("CONGRESS_ACTIVITY:PURCHASES");
    expect(view.label).toBe("Congress purchases");
    expect(view.configuration).toBe("180D · House");
    expect(view.sentence).toBe("Congress purchases is above 0 (180D · House)");
    expect(view.line).toEqual({
      kind: "CONDITION",
      text: "Congress purchases is above 0",
      configuration: "180D · House",
    });
    expect(view.persistedMetric).toEqual({
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 180,
      scope: { kind: "ANY" },
      chamber: "HOUSE",
    });
    // Persistence and reload change nothing, including the logic identity the version hash keys on.
    expect(view.persisted).toEqual(view.normalized);
    expect(strategyDefinitionFingerprint(view.persisted)).toBe(
      strategyDefinitionFingerprint(view.normalized),
    );
  });

  it("C: each category's first metric carries only its own default configuration", () => {
    // What a change of category installs. That no previous configuration survives the change is
    // proven where a row has one to lose: the draft reducer and the Builder component tests.
    for (const category of strategyMetricCategories("SELL")) {
      const metric = defaultStrategyMetric("SELL", "CONDITION", category.id);
      expect(metric, category.id).toBeDefined();
      expect(strategyMetricCategory(metric as StrategyMetric)).toBe(
        category.id,
      );
      const keys = Object.keys(metric as object);
      if (category.id === "INSIDER_ACTIVITY") {
        expect(metric).toEqual({
          kind: "INSIDER_ACTIVITY",
          measure: "BUYERS",
          lookback: 20,
        });
      } else if (category.id === "CONGRESSIONAL_TRADING") {
        expect(metric).toEqual({
          kind: "CONGRESS_ACTIVITY",
          measure: "PURCHASES",
          lookback: 30,
          scope: { kind: "ANY" },
          chamber: "ANY",
        });
      } else {
        for (const configurationKey of [
          "lookback",
          "roles",
          "scope",
          "chamber",
          "owners",
        ]) {
          expect(keys, category.id).not.toContain(configurationKey);
        }
      }
    }
  });

  it("fingerprints configuration, never presentation", () => {
    const signalOf = (metric: StrategyMetric) => ({
      conditions: [
        {
          id: "c1",
          metric,
          operator: "IS_ABOVE" as const,
          value: { kind: "NUMBER" as const, value: 2 },
        },
      ],
    });
    // Distinct configurations are distinct logic.
    expect(
      strategySignalFingerprint(signalOf(insider({ lookback: 180 }))),
    ).not.toBe(strategySignalFingerprint(signalOf(insider({ lookback: 20 }))));
    expect(
      strategySignalFingerprint(signalOf(congress({ chamber: "HOUSE" }))),
    ).not.toBe(strategySignalFingerprint(signalOf(congress())));
    // The same configuration written in another order is the same logic.
    expect(
      strategySignalFingerprint(
        signalOf(
          normalizeStrategyDefinition(
            definitionWith({
              ...signalOf(insider({ roles: ["CFO", "CEO"] })).conditions[0]!,
            }),
          ).buyLevels[0]!.signal.conditions[0]!.metric,
        ),
      ),
    ).toBe(
      strategySignalFingerprint(signalOf(insider({ roles: ["CEO", "CFO"] }))),
    );
    // No label, category or configuration summary is part of the fingerprint at all.
    const fingerprint = strategySignalFingerprint(
      signalOf(insider({ measure: "SELLERS", lookback: 180, roles: ["CEO"] })),
    );
    for (const presentation of [
      "Insider sellers",
      "Insider activity",
      "INSIDER_ACTIVITY:SELLERS",
      "180D",
    ]) {
      expect(fingerprint).not.toContain(presentation);
    }
  });

  it("E: round-trips builder -> contract -> persistence -> read -> builder with no drift", () => {
    const authored: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: insider({
                  measure: "SELLERS",
                  lookback: 180,
                  roles: ["CEO", "CFO"],
                }),
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 1 },
              },
              {
                id: "c2",
                metric: congress({
                  lookback: 180,
                  chamber: "HOUSE",
                  owners: ["SPOUSE", "SELF"],
                }),
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 2 },
              },
              {
                id: "c3",
                metric: { kind: "PRICE" },
                operator: "IS_CLOSE_TO",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
            trigger: {
              id: "t1",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "CROSSES_ABOVE",
              value: { kind: "NUMBER", value: 30 },
            },
          },
        },
      ],
      sellLevels: [],
    };
    // What the API stores, and what a later read hands back to the Builder.
    const stored = JSON.stringify(normalizeStrategyDefinition(authored));
    const reread = normalizeStrategyDefinition(JSON.parse(stored));
    const resaved = normalizeStrategyDefinition(
      JSON.parse(JSON.stringify(reread)),
    );
    expect(resaved).toEqual(reread);
    expect(JSON.stringify(resaved)).toBe(stored);
    expect(strategyDefinitionFingerprint(reread)).toBe(
      strategyDefinitionFingerprint(normalizeStrategyDefinition(authored)),
    );
    expect(describeStrategy(reread)).toEqual(describeStrategy(authored));
    // A duplicate is the same logic under new identities: every fingerprint is unchanged.
    let next = 0;
    const duplicate = rekeyStrategyDefinition(
      reread,
      () => `copy-${(next += 1)}`,
    );
    expect(strategyDefinitionFingerprint(duplicate)).toBe(
      strategyDefinitionFingerprint(reread),
    );
    expect(describeStrategy(duplicate)).toEqual(describeStrategy(reread));
    expect(duplicate.buyLevels[0]?.signal.conditions[0]?.id).not.toBe("c1");
  });
});

// ---------------------------------------------------------------------------
// Scope references
// ---------------------------------------------------------------------------

describe("scope reference collection", () => {
  const metrics = [
    insider({ roles: ["CEO"] }),
    congress({ scope: { kind: "GROUP", groupId: "g2" } }),
    congress({ scope: { kind: "GROUP", groupId: "g1" }, chamber: "HOUSE" }),
    congress({ scope: { kind: "GROUP", groupId: "g1" }, chamber: "SENATE" }),
    congress({ scope: { kind: "ACTOR", actorId: "a9" } }),
    congress({ owners: ["SELF"] }),
  ].map((metric) => asAlternativeDataMetric(metric) as AlternativeDataMetric);

  it("collects group ids deduplicated and sorted", () => {
    expect(collectActorGroupIds(metrics)).toEqual(["g1", "g2"]);
  });

  it("collects specific actor ids deduplicated and sorted", () => {
    expect(collectActorIds(metrics)).toEqual(["a9"]);
  });

  it("collects nothing from a definition that references neither", () => {
    expect(collectActorGroupIds([])).toEqual([]);
    expect(
      collectActorGroupIds([
        asAlternativeDataMetric(congress()) as AlternativeDataMetric,
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signature round trip
// ---------------------------------------------------------------------------

describe("parseAlternativeDataMetricSignature", () => {
  const configured: AlternativeDataMetric[] = [
    insider() as AlternativeDataMetric,
    insider({ measure: "SALE_VALUE", lookback: 180 }) as AlternativeDataMetric,
    insider({ roles: ["CEO", "CFO", "DIRECTOR"] }) as AlternativeDataMetric,
    congress() as AlternativeDataMetric,
    congress({
      measure: "MINIMUM_PURCHASE_VALUE",
      lookback: 90,
      scope: { kind: "ACTOR", actorId: "actor-1" },
      chamber: "SENATE",
      owners: ["SELF", "SPOUSE"],
    }) as AlternativeDataMetric,
    congress({ scope: { kind: "GROUP", groupId: "group-1" } }) as AlternativeDataMetric,
    congress({
      measure: "SELLERS",
      lookback: 250,
      scope: { kind: "GROUP", groupId: "group-2" },
      chamber: "HOUSE",
      owners: ["SELF", "SPOUSE", "JOINT"],
    }) as AlternativeDataMetric,
  ];

  it("round-trips every configured metric to its canonical form", () => {
    for (const metric of configured) {
      const signature = alternativeDataMetricSignature(metric);
      // Canonical, because a legacy single `ACTOR` reads back as the one-entry selection it means;
      // every other shape here is already canonical and reads back unchanged.
      const canonical = asAlternativeDataMetric(
        normalizeStrategyDefinition(
          definitionWith({
            id: "c1",
            metric,
            operator: "IS_ABOVE",
            value:
              metric.measure === "MINIMUM_PURCHASE_VALUE" ||
              metric.measure === "PURCHASE_VALUE" ||
              metric.measure === "SALE_VALUE"
                ? { kind: "MONEY", value: 1_000 }
                : { kind: "NUMBER", value: 1 },
          }),
        ).buyLevels[0]!.signal.conditions[0]!.metric,
      );
      expect(
        parseAlternativeDataMetricSignature(signature),
        signature,
      ).toEqual(canonical);
      expect(alternativeDataMetricSignature(canonical!)).toBe(signature);
    }
  });

  it("refuses text that is not a signature", () => {
    for (const text of [
      "",
      "nonsense",
      "INSIDER_ACTIVITY|BUYERS",
      "INSIDER_ACTIVITY|BUYERS|21|-|-",
      "INSIDER_ACTIVITY|SHORTS|20|-|-",
      "INSIDER_ACTIVITY|BUYERS|20|any|-",
      "INSIDER_ACTIVITY|BUYERS|20|-|CHIEF_VIBES",
      "CONGRESS_ACTIVITY|PURCHASES|30|any|LORDS|-",
      "CONGRESS_ACTIVITY|PURCHASES|30|group:|ANY|-",
      "INSTITUTIONAL_ACTIVITY|BUYERS|60|any",
      "CONGRESS_ACTIVITY|PURCHASES|30|any",
    ]) {
      expect(parseAlternativeDataMetricSignature(text), text).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Direct selection: the ACTORS scope
// ---------------------------------------------------------------------------

/** Canonical-looking actor ids, deliberately not in sorted order as written. */
const ACTOR_A = "0a000000-0000-4000-8000-00000000000a";
const ACTOR_B = "0b000000-0000-4000-8000-00000000000b";
const ACTOR_C = "0c000000-0000-4000-8000-00000000000c";

function selection(...actorIds: string[]): ActorScope {
  return { kind: "ACTORS", actorIds };
}

function conditionOn(
  metric: StrategyMetric,
  id = "c1",
  value = 2,
): StrategyCondition {
  return {
    id,
    metric,
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value },
  };
}

function scopeOf(definition: StrategyDefinition): ActorScope | undefined {
  const metric = definition.buyLevels[0]!.signal.conditions[0]!.metric;
  return metric.kind === "CONGRESS_ACTIVITY" ? metric.scope : undefined;
}

describe("the scope vocabulary", () => {
  it("keeps the legacy shapes readable beside the current ones", () => {
    expect(ACTOR_SCOPE_KINDS).toEqual(["ANY", "ACTORS", "ACTOR", "GROUP"]);
    for (const scope of [
      { kind: "ANY" },
      selection(ACTOR_A),
      { kind: "ACTOR", actorId: ACTOR_A },
      { kind: "GROUP", groupId: "g1" },
    ] as ActorScope[]) {
      expect(
        codesOf(definitionWith(conditionOn(congress({ scope })))),
        scope.kind,
      ).toEqual([]);
    }
  });

  it("offers the Builder only the current shapes", () => {
    expect(SELECTABLE_ACTOR_SCOPE_KINDS).toEqual(["ANY", "ACTORS"]);
  });

  it("refuses a scope kind it does not define", () => {
    expect(
      codesOf(
        definitionWith(
          conditionOn(
            congress({ scope: { kind: "COMMITTEE" } as unknown as ActorScope }),
          ),
        ),
      ),
    ).toEqual(["SCOPE_INVALID"]);
  });
});

describe("validating a selection", () => {
  const codesFor = (scope: unknown): StrategyValidationCode[] =>
    codesOf(
      definitionWith(conditionOn(congress({ scope: scope as ActorScope }))),
    );

  it("accepts one member and accepts the maximum", () => {
    expect(codesFor(selection(ACTOR_A))).toEqual([]);
    const most = Array.from(
      { length: ACTOR_SCOPE_MAX_ACTORS },
      (_, index) => `actor-${String(index).padStart(3, "0")}`,
    );
    expect(codesFor(selection(...most))).toEqual([]);
  });

  it("refuses an empty selection rather than reading it as anyone or as nobody", () => {
    expect(codesFor({ kind: "ACTORS", actorIds: [] })).toEqual([
      "SCOPE_INVALID",
    ]);
    expect(codesFor({ kind: "ACTORS" })).toEqual(["SCOPE_INVALID"]);
    expect(codesFor({ kind: "ACTORS", actorIds: "a1" })).toEqual([
      "SCOPE_INVALID",
    ]);
  });

  it("refuses more distinct members than the bound, and counts a repeat once", () => {
    const tooMany = Array.from(
      { length: ACTOR_SCOPE_MAX_ACTORS + 1 },
      (_, index) => `actor-${String(index).padStart(3, "0")}`,
    );
    expect(codesFor(selection(...tooMany))).toEqual(["SCOPE_INVALID"]);
    // 251 entries naming 250 members is 250 members.
    expect(
      codesFor(selection(...tooMany.slice(0, -1), tooMany[0] as string)),
    ).toEqual([]);
  });

  it("refuses an identifier that could never be one", () => {
    for (const bad of [
      "",
      "has space",
      "a|b",
      "a+b",
      42,
      null,
      { id: "a1" },
    ]) {
      expect(
        codesFor({ kind: "ACTORS", actorIds: [ACTOR_A, bad] }),
        String(bad),
      ).toEqual(["SCOPE_INVALID"]);
    }
  });

  it("refuses a field belonging to another scope shape", () => {
    expect(
      codesFor({ kind: "ACTORS", actorIds: [ACTOR_A], groupId: "g1" }),
    ).toEqual(["UNKNOWN_FIELD"]);
    expect(
      codesFor({ kind: "ACTORS", actorIds: [ACTOR_A], actorId: ACTOR_A }),
    ).toEqual(["UNKNOWN_FIELD"]);
  });

  it("says what to do about an empty selection", () => {
    expect(
      validateStrategyDefinition(
        definitionWith(
          conditionOn(congress({ scope: { kind: "ACTORS", actorIds: [] } })),
        ),
      ).map((issue) => issue.message),
    ).toEqual([
      "Choose at least one member of Congress, or count every member.",
    ]);
  });
});

describe("normalizing a selection", () => {
  const normalizedScope = (scope: ActorScope) =>
    scopeOf(
      normalizeStrategyDefinition(
        definitionWith(conditionOn(congress({ scope }))),
      ),
    );

  it("sorts and de-duplicates, so one selection persists once however it was written", () => {
    expect(normalizedScope(selection(ACTOR_C, ACTOR_A, ACTOR_B, ACTOR_A))).toEqual(
      selection(ACTOR_A, ACTOR_B, ACTOR_C),
    );
  });

  it("is idempotent", () => {
    const once = normalizeStrategyDefinition(
      definitionWith(
        conditionOn(congress({ scope: selection(ACTOR_B, ACTOR_A) })),
      ),
    );
    expect(normalizeStrategyDefinition(once)).toEqual(once);
  });

  it("rewrites a legacy single actor to the one-entry selection it means", () => {
    expect(normalizedScope({ kind: "ACTOR", actorId: ACTOR_A })).toEqual(
      selection(ACTOR_A),
    );
  });

  it("keeps a legacy group exactly as stored", () => {
    expect(normalizedScope({ kind: "GROUP", groupId: "g1" })).toEqual({
      kind: "GROUP",
      groupId: "g1",
    });
  });
});

/**
 * Serializations captured from the build of `main` **before** the selection scope existed
 * (commit b3529476), for one definition written three ways. They are literals on purpose: a stored
 * `StrategyVersion.definitionHash` is a digest of the third string, and a Monitor's durable level
 * state is keyed by the second, so if either moves for a document that already exists, every such
 * strategy silently gains a version and every such Monitor level resets.
 */
const LEGACY_ACTOR_ID = "6f1b0a1e-8a6c-4c1a-9f0e-2b6c4d8e1a33";
const LEGACY_GROUP_ID = "4b8d0f3e-2c1a-4e7b-9a6d-5f0c3b2a1e9d";

const LEGACY_SERIALIZATIONS = [
  {
    scope: { kind: "ANY" },
    signature: "CONGRESS_ACTIVITY|PURCHASES|30|any|ANY|-",
    signal:
      '[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|any|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]',
    definition:
      '[1,[[100,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|any|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]],[[50,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SALES|30|any|SENATE|SELF+SPOUSE"],"IS_ABOVE",["NUMBER",2]]],null]]],[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SELLERS|250|any|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]',
  },
  {
    scope: { kind: "ACTOR", actorId: LEGACY_ACTOR_ID },
    signature: `CONGRESS_ACTIVITY|PURCHASES|30|actor:${LEGACY_ACTOR_ID}|ANY|-`,
    signal: `[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|actor:${LEGACY_ACTOR_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]`,
    definition: `[1,[[100,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|actor:${LEGACY_ACTOR_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]],[[50,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SALES|30|actor:${LEGACY_ACTOR_ID}|SENATE|SELF+SPOUSE"],"IS_ABOVE",["NUMBER",2]]],null]]],[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SELLERS|250|actor:${LEGACY_ACTOR_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]`,
  },
  {
    scope: { kind: "GROUP", groupId: LEGACY_GROUP_ID },
    signature: `CONGRESS_ACTIVITY|PURCHASES|30|group:${LEGACY_GROUP_ID}|ANY|-`,
    signal: `[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|group:${LEGACY_GROUP_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]`,
    definition: `[1,[[100,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|PURCHASES|30|group:${LEGACY_GROUP_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]],[[50,[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SALES|30|group:${LEGACY_GROUP_ID}|SENATE|SELF+SPOUSE"],"IS_ABOVE",["NUMBER",2]]],null]]],[[[["CONGRESS_ACTIVITY",null,"CONGRESS_ACTIVITY|SELLERS|250|group:${LEGACY_GROUP_ID}|ANY|-"],"IS_ABOVE",["NUMBER",2]]],null]]`,
  },
] as const satisfies readonly {
  scope: ActorScope;
  signature: string;
  signal: string;
  definition: string;
}[];

/** One definition using a scope in a BUY level, a SELL level and FINAL EXIT, each configured differently. */
function threeLevelDefinition(scope: ActorScope): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "b1",
        percentage: 100,
        signal: { conditions: [conditionOn(congress({ scope }), "c-buy")] },
      },
    ],
    sellLevels: [
      {
        id: "s1",
        percentage: 50,
        signal: {
          conditions: [
            conditionOn(
              congress({
                scope,
                measure: "SALES",
                chamber: "SENATE",
                owners: ["SELF", "SPOUSE"],
              }),
              "c-sell",
            ),
          ],
        },
      },
    ],
    finalExit: {
      id: "f1",
      rules: [
        {
          id: "f1",
          signal: {
            conditions: [
              conditionOn(
                congress({ scope, measure: "SELLERS", lookback: 250 }),
                "c-exit",
              ),
            ],
          },
        },
      ],
    },
  };
}

describe("no stored hash moves", () => {
  it.each(LEGACY_SERIALIZATIONS)(
    "serializes a stored $scope.kind scope exactly as main did",
    ({ scope, signature, signal, definition }) => {
      const metric = congress({ scope }) as AlternativeDataMetric;
      expect(alternativeDataMetricSignature(metric)).toBe(signature);
      expect(alternativeDataMetricFingerprint(metric)).toBe(signature);
      expect(
        strategySignalFingerprint({ conditions: [conditionOn(metric)] }),
      ).toBe(signal);
      expect(strategyDefinitionFingerprint(threeLevelDefinition(scope))).toBe(
        definition,
      );
      // And the same once the document has been through the read path, which rewrites a legacy
      // single actor to a one-entry selection: the fingerprint must not notice.
      expect(
        strategyDefinitionFingerprint(
          normalizeStrategyDefinition(threeLevelDefinition(scope)),
        ),
      ).toBe(definition);
    },
  );

  it("gives a one-member selection the single-actor serialization it replaces", () => {
    const legacy = LEGACY_SERIALIZATIONS[1];
    const selected = selection(LEGACY_ACTOR_ID);
    const metric = congress({ scope: selected }) as AlternativeDataMetric;
    expect(alternativeDataMetricSignature(metric)).toBe(legacy.signature);
    expect(
      strategySignalFingerprint({ conditions: [conditionOn(metric)] }),
    ).toBe(legacy.signal);
    expect(strategyDefinitionFingerprint(threeLevelDefinition(selected))).toBe(
      legacy.definition,
    );
  });
});

describe("the identity of a multi-member selection", () => {
  const metricFor = (scope: ActorScope) =>
    congress({ scope }) as AlternativeDataMetric;

  it("serializes the canonical list, whatever order and repeats it was written with", () => {
    const canonical = `CONGRESS_ACTIVITY|PURCHASES|30|actors:${ACTOR_A}+${ACTOR_B}+${ACTOR_C}|ANY|-`;
    for (const scope of [
      selection(ACTOR_A, ACTOR_B, ACTOR_C),
      selection(ACTOR_C, ACTOR_B, ACTOR_A),
      selection(ACTOR_B, ACTOR_A, ACTOR_C, ACTOR_A, ACTOR_B),
    ]) {
      expect(alternativeDataMetricSignature(metricFor(scope))).toBe(canonical);
    }
  });

  it("round-trips the signature to the canonical metric", () => {
    const metric = metricFor(selection(ACTOR_C, ACTOR_A));
    expect(
      parseAlternativeDataMetricSignature(alternativeDataMetricSignature(metric)),
    ).toEqual(metricFor(selection(ACTOR_A, ACTOR_C)));
  });

  it("refuses a multi-member key that is not the canonical one", () => {
    const key = (scope: string) => `CONGRESS_ACTIVITY|PURCHASES|30|${scope}|ANY|-`;
    for (const text of [
      key("actors:"),
      key(`actors:${ACTOR_A}`),
      key(`actors:${ACTOR_B}+${ACTOR_A}`),
      key(`actors:${ACTOR_A}+${ACTOR_A}`),
      key(`actors:${ACTOR_A}+`),
      key("actor:"),
      key("actors:a b+c"),
    ]) {
      expect(parseAlternativeDataMetricSignature(text), text).toBeUndefined();
    }
  });

  it("fingerprints a digest rather than the list, so the persisted string stays short", () => {
    const fingerprint = alternativeDataMetricFingerprint(
      metricFor(selection(ACTOR_A, ACTOR_B, ACTOR_C)),
    );
    expect(fingerprint).toMatch(
      /^CONGRESS_ACTIVITY\|PURCHASES\|30\|actors:3:[0-9a-f]{64}\|ANY\|-$/,
    );
    expect(fingerprint).not.toContain(ACTOR_A);

    const most = Array.from(
      { length: ACTOR_SCOPE_MAX_ACTORS },
      (_, index) =>
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const widest = metricFor(selection(...most));
    // The key a frame column is addressed by holds every id; the string a Monitor persists per
    // state row does not.
    expect(alternativeDataMetricSignature(widest).length).toBeGreaterThan(9_000);
    expect(alternativeDataMetricFingerprint(widest).length).toBeLessThan(120);
    expect(
      strategySignalFingerprint({ conditions: [conditionOn(widest)] }).length,
    ).toBeLessThan(200);
  });

  it("fingerprints one selection one way and two selections two ways", () => {
    const fingerprintOf = (scope: ActorScope) =>
      strategySignalFingerprint({
        conditions: [conditionOn(metricFor(scope))],
      });
    expect(fingerprintOf(selection(ACTOR_B, ACTOR_A, ACTOR_A))).toBe(
      fingerprintOf(selection(ACTOR_A, ACTOR_B)),
    );
    const distinct = new Set(
      [
        { kind: "ANY" } as ActorScope,
        selection(ACTOR_A),
        selection(ACTOR_B),
        selection(ACTOR_A, ACTOR_B),
        selection(ACTOR_A, ACTOR_C),
        selection(ACTOR_B, ACTOR_C),
        selection(ACTOR_A, ACTOR_B, ACTOR_C),
      ].map(fingerprintOf),
    );
    expect(distinct.size).toBe(7);
  });

  it("refuses to serialize a scope it cannot interpret instead of reading it as nobody", () => {
    expect(() =>
      alternativeDataMetricSignature(
        metricFor({ kind: "COMMITTEE" } as unknown as ActorScope),
      ),
    ).toThrow(/Unsupported actor scope kind 'COMMITTEE'/);
    expect(() =>
      alternativeDataMetricFingerprint(
        metricFor({ kind: "COMMITTEE" } as unknown as ActorScope),
      ),
    ).toThrow(/Unsupported actor scope kind/);
    expect(() =>
      alternativeDataMetricSignature(metricFor({ kind: "ACTORS", actorIds: [] })),
    ).toThrow(/at least one actor/);
  });
});

describe("independent selections in one signal", () => {
  const twoConditions = (
    first: ActorScope,
    second: ActorScope,
  ): StrategyDefinition => ({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "b1",
        percentage: 100,
        signal: {
          conditions: [
            conditionOn(congress({ scope: first }), "c1", 0),
            conditionOn(congress({ scope: second }), "c2", 0),
          ],
        },
      },
    ],
    sellLevels: [],
  });

  it("lets two rules of one metric select different members", () => {
    expect(codesOf(twoConditions(selection(ACTOR_A), selection(ACTOR_B)))).toEqual(
      [],
    );
    expect(
      codesOf(
        twoConditions(selection(ACTOR_A, ACTOR_B), selection(ACTOR_A, ACTOR_C)),
      ),
    ).toEqual([]);
  });

  it("still sees one selection written twice as one rule written twice", () => {
    expect(
      codesOf(
        twoConditions(selection(ACTOR_A, ACTOR_B), selection(ACTOR_B, ACTOR_A)),
      ),
    ).toEqual(["DUPLICATE_CONDITION"]);
    // A legacy single actor and the selection that replaces it are the same rule too.
    expect(
      codesOf(
        twoConditions({ kind: "ACTOR", actorId: ACTOR_A }, selection(ACTOR_A)),
      ),
    ).toEqual(["DUPLICATE_CONDITION"]);
  });
});

describe("describing a selection", () => {
  const names = {
    actors: {
      [ACTOR_A]: "Tommy Tuberville",
      [ACTOR_B]: "Nancy Pelosi",
      [ACTOR_C]: "Ro Khanna",
    },
  };
  /** `null` for a surface that has resolved no name at all. */
  const describe_ = (scope: ActorScope, known: typeof names | null = names) =>
    describeMetricConfiguration(congress({ scope }), known ?? undefined);

  it("names one member and two members outright", () => {
    expect(describe_(selection(ACTOR_A))).toBe("30D · Tommy Tuberville");
    expect(describe_(selection(ACTOR_A, ACTOR_B))).toBe(
      "30D · Nancy Pelosi, Tommy Tuberville",
    );
  });

  it("names the first two alphabetically and counts the rest", () => {
    expect(describe_(selection(ACTOR_A, ACTOR_B, ACTOR_C))).toBe(
      "30D · Nancy Pelosi, Ro Khanna +1",
    );
  });

  it("counts a member whose name is not resolved rather than inventing one", () => {
    expect(describe_(selection(ACTOR_A, "unknown-1", "unknown-2"))).toBe(
      "30D · Tommy Tuberville +2",
    );
    expect(describe_(selection(ACTOR_A, ACTOR_B), null)).toBe(
      "30D · 2 selected members",
    );
    expect(describe_(selection(ACTOR_A), null)).toBe("30D · 1 selected member");
  });

  it("describes a legacy single actor by name, like the selection it means", () => {
    expect(describe_({ kind: "ACTOR", actorId: ACTOR_B })).toBe(
      "30D · Nancy Pelosi",
    );
  });

  it("puts the selection before the chamber and owner filters", () => {
    expect(
      describeCondition(
        conditionOn(
          congress({
            scope: selection(ACTOR_A, ACTOR_B),
            chamber: "SENATE",
            owners: ["SPOUSE", "SELF"],
          }),
          "c1",
          1,
        ),
        names,
      ),
    ).toBe(
      "Congress purchases is above 1 (30D · Nancy Pelosi, Tommy Tuberville · Senate · Self, Spouse)",
    );
  });

  it("collects every directly selected member, from both shapes, once", () => {
    const metrics = [
      congress({ scope: selection(ACTOR_C, ACTOR_A) }),
      congress({ scope: { kind: "ACTOR", actorId: ACTOR_B } }),
      congress({ scope: selection(ACTOR_A) }),
      congress({ scope: { kind: "GROUP", groupId: "g1" } }),
      congress(),
    ].map((metric) => asAlternativeDataMetric(metric) as AlternativeDataMetric);
    expect(collectActorIds(metrics)).toEqual([ACTOR_A, ACTOR_B, ACTOR_C]);
    expect(collectActorGroupIds(metrics)).toEqual(["g1"]);
  });
});

describe("embedding a group's members into a definition", () => {
  const group = (groupId: string): ActorScope => ({ kind: "GROUP", groupId });

  it("replaces the group in every level and leaves everything else as written", () => {
    const converted = embedActorGroupScopes(
      threeLevelDefinition(group("g1")),
      new Map([["g1", [ACTOR_C, ACTOR_A, ACTOR_B]]]),
    );
    expect(converted).toEqual(
      normalizeStrategyDefinition(
        threeLevelDefinition(selection(ACTOR_A, ACTOR_B, ACTOR_C)),
      ),
    );
    // Row identities survive: it is the same strategy with one scope rewritten.
    expect(converted.buyLevels[0]!.id).toBe("b1");
    expect(converted.buyLevels[0]!.signal.conditions[0]!.id).toBe("c-buy");
    expect(converted.finalExit!.rules[0]!.signal.conditions[0]!.id).toBe(
      "c-exit",
    );
  });

  it("changes the logic fingerprint, which is what appends a version and resets a Monitor level", () => {
    const before = threeLevelDefinition(group("g1"));
    const after = embedActorGroupScopes(before, new Map([["g1", [ACTOR_A]]]));
    expect(strategyDefinitionFingerprint(after)).not.toBe(
      strategyDefinitionFingerprint(before),
    );
  });

  it("leaves a definition with no group scope untouched", () => {
    const definition = normalizeStrategyDefinition(
      threeLevelDefinition(selection(ACTOR_A, ACTOR_B)),
    );
    expect(embedActorGroupScopes(definition, new Map())).toEqual(definition);
  });

  it("never embeds an unresolved or an empty group as nobody", () => {
    const definition = threeLevelDefinition(group("g1"));
    expect(() => embedActorGroupScopes(definition, new Map())).toThrow(
      ActorGroupScopeUnresolvedError,
    );
    try {
      embedActorGroupScopes(definition, new Map([["g1", []]]));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ActorGroupScopeUnresolvedError);
      expect((error as ActorGroupScopeUnresolvedError).reason).toBe("EMPTY");
      expect((error as ActorGroupScopeUnresolvedError).groupId).toBe("g1");
    }
  });

  it("refuses a conversion that would leave an invalid definition", () => {
    // Two rules that differ only in the group they name, where both groups hold the same members:
    // embedded, they are one rule written twice.
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              conditionOn(congress({ scope: group("g1") }), "c1"),
              conditionOn(congress({ scope: group("g2") }), "c2"),
            ],
          },
        },
      ],
      sellLevels: [],
    };
    expect(() =>
      embedActorGroupScopes(
        definition,
        new Map([
          ["g1", [ACTOR_A, ACTOR_B]],
          ["g2", [ACTOR_B, ACTOR_A]],
        ]),
      ),
    ).toThrow(StrategyValidationError);
  });
});
