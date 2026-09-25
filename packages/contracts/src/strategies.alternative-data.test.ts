import { describe, expect, it } from "vitest";
import {
  ALTERNATIVE_DATA_LOOKBACKS,
  alternativeDataMetricSignature,
  CONGRESS_MEASURES,
  collectActorGroupIds,
  collectActorIds,
  defaultAlternativeDataMetric,
  describeAlternativeDataConfiguration,
  INSIDER_MEASURES,
  INSTITUTIONAL_MEASURES,
  parseAlternativeDataMetricSignature,
  type AlternativeDataMetric,
} from "./alternative-data.js";
import {
  asAlternativeDataMetric,
  defaultConditionOperatorFor,
  defaultValueFor,
  describeCondition,
  describePredicateScope,
  describeStrategy,
  normalizeStrategyDefinition,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_METRIC_HELP,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategySignalFingerprint,
  strategyValueLabel,
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

function institutional(
  overrides: Partial<
    Extract<AlternativeDataMetric, { kind: "INSTITUTIONAL_ACTIVITY" }>
  > = {},
): StrategyMetric {
  return {
    kind: "INSTITUTIONAL_ACTIVITY",
    measure: "BUYERS",
    lookback: 60,
    scope: { kind: "ANY" },
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
  it("offers one option per measure, grouped, in every level kind", () => {
    for (const levelKind of ["BUY", "SELL", "FINAL_EXIT"] as const) {
      const options = strategyMetricOptions(levelKind);
      expect(
        options
          .filter((option) => option.group === "INSIDER_ACTIVITY")
          .map((option) => option.label),
      ).toEqual([
        "Insider buyers 20D",
        "Insider sellers 20D",
        "Insider purchase value 20D",
        "Insider sale value 20D",
      ]);
      expect(
        options
          .filter((option) => option.group === "CONGRESSIONAL_TRADING")
          .map((option) => option.label),
      ).toEqual([
        "Congress purchases 30D",
        "Congress sales 30D",
        "Congress buyers 30D",
        "Congress sellers 30D",
        "Congress minimum disclosed purchase value 30D",
      ]);
      expect(
        options
          .filter((option) => option.group === "INSTITUTIONAL_ACTIVITY")
          .map((option) => option.label),
      ).toEqual([
        "Institutional buyers 60D",
        "Institutional reducers 60D",
        "Institutional new positions 60D",
        "Institutional exits 60D",
        "Institutional position change 60D",
      ]);
    }
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
      expect(kinds.has("INSTITUTIONAL_ACTIVITY")).toBe(false);
    }
  });

  it("gives the inclusive operators to these metrics and to nothing else", () => {
    for (const kind of [
      "INSIDER_ACTIVITY",
      "CONGRESS_ACTIVITY",
      "INSTITUTIONAL_ACTIVITY",
    ] as const) {
      expect(STRATEGY_METRIC_DEFINITIONS[kind].conditionOperators).toEqual([
        "IS_AT_LEAST",
        "IS_AT_MOST",
        "IS_ABOVE",
        "IS_BELOW",
      ]);
    }
    for (const kind of [
      "PRICE",
      "MOVING_AVERAGE",
      "OSCILLATOR",
      "RELATIVE_VOLUME",
      "MARGIN_OF_SAFETY",
      "GAIN",
      "LOSS",
    ] as const) {
      const operators = STRATEGY_METRIC_DEFINITIONS[kind].conditionOperators;
      expect(operators).not.toContain("IS_AT_LEAST");
      expect(operators).not.toContain("IS_AT_MOST");
    }
  });

  it("starts a fresh row on the inclusive operator the product's examples use", () => {
    expect(defaultConditionOperatorFor(insider())).toBe("IS_AT_LEAST");
  });

  it("keys the select by measure only, so configuring a metric never deselects it", () => {
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

  it("carries the lookback in the label, because it changes what the number means", () => {
    expect(strategyMetricLabel(insider({ lookback: 60 }))).toBe(
      "Insider buyers 60D",
    );
  });

  it("explains every kind", () => {
    for (const kind of [
      "INSIDER_ACTIVITY",
      "CONGRESS_ACTIVITY",
      "INSTITUTIONAL_ACTIVITY",
    ] as const) {
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
    expect(defaultValueFor(insider())).toEqual({ kind: "NUMBER", value: 1 });
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

  it("gives position change a signed percentage floored at -100", () => {
    expect(
      valueSpecFor(institutional({ measure: "POSITION_CHANGE" })),
    ).toEqual({ kind: "PERCENT", min: -100 });
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
          operator: "IS_AT_LEAST",
          value: { kind: "NUMBER", value: 2.5 },
        }),
      ),
    ).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider({ measure: "PURCHASE_VALUE" }),
          operator: "IS_AT_LEAST",
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
          operator: "IS_AT_LEAST",
          value: { kind: "NUMBER", value: 5 },
        }),
      ),
    ).toEqual(["VALUE_KIND_MISMATCH"]);
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: insider(),
          operator: "IS_AT_LEAST",
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
                operator: "IS_AT_LEAST",
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
      ["INSTITUTIONAL_ACTIVITY", INSTITUTIONAL_MEASURES],
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
              operator: "IS_AT_LEAST",
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

  it("requires a scope on the kinds that have one", () => {
    expect(
      valid({ kind: "CONGRESS_ACTIVITY", measure: "PURCHASES", lookback: 30, chamber: "ANY" }),
    ).toEqual(["SCOPE_INVALID"]);
    expect(
      valid({ kind: "INSTITUTIONAL_ACTIVITY", measure: "BUYERS", lookback: 60 }),
    ).toEqual(["SCOPE_INVALID"]);
  });

  it("refuses a scope missing its identifier, and one carrying the wrong one", () => {
    expect(
      valid({
        kind: "INSTITUTIONAL_ACTIVITY",
        measure: "BUYERS",
        lookback: 60,
        scope: { kind: "GROUP" },
      }),
    ).toEqual(["SCOPE_INVALID"]);
    expect(
      valid({
        kind: "INSTITUTIONAL_ACTIVITY",
        measure: "BUYERS",
        lookback: 60,
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

  it("refuses an inclusive operator on a metric that does not offer one", () => {
    expect(
      codesOf(
        definitionWith({
          id: "c1",
          metric: { kind: "PRICE" },
          operator: "IS_AT_LEAST",
          value: { kind: "SERIES", seriesId: "SMA_50D" },
        }),
      ),
    ).toEqual(["OPERATOR_NOT_SUPPORTED"]);
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
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 2 },
      }),
    );
    const right = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: insider({ roles: ["CEO", "DIRECTOR"] }),
        operator: "IS_AT_LEAST",
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
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 2 },
      }),
    );
    expect(normalizeStrategyDefinition(once)).toEqual(once);
  });

  it("round-trips through JSON unchanged", () => {
    const definition = normalizeStrategyDefinition(
      definitionWith({
        id: "c1",
        metric: institutional({
          measure: "POSITION_CHANGE",
          lookback: 90,
          scope: { kind: "ACTOR", actorId: "a1" },
        }),
        operator: "IS_AT_LEAST",
        value: { kind: "PERCENT", value: 25 },
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
                  operator: "IS_AT_LEAST",
                  value: { kind: "NUMBER", value: 2 },
                },
                {
                  id: "c2",
                  metric: insider({ measure: "SELLERS" }),
                  operator: "IS_AT_MOST",
                  value: { kind: "NUMBER", value: 0 },
                },
                {
                  id: "c3",
                  metric: insider({ lookback: 60 }),
                  operator: "IS_AT_LEAST",
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
                  operator: "IS_AT_LEAST",
                  value: { kind: "NUMBER", value: 2 },
                },
                {
                  id: "c2",
                  metric: insider(),
                  operator: "IS_AT_LEAST",
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
          operator: "IS_AT_LEAST" as const,
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
        institutional(),
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
  it("reads as the product's own examples", () => {
    expect(
      describeCondition({
        id: "c1",
        metric: insider(),
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 2 },
      }),
    ).toBe("Insider buyers 20D is at least 2");
    expect(
      describeCondition({
        id: "c2",
        metric: institutional({ lookback: 60 }),
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 3 },
      }),
    ).toBe("Institutional buyers 60D is at least 3");
    expect(
      describeCondition({
        id: "c3",
        metric: institutional({ measure: "POSITION_CHANGE" }),
        operator: "IS_AT_LEAST",
        value: { kind: "PERCENT", value: 25 },
      }),
    ).toBe("Institutional position change 60D is at least 25%");
  });

  it("summarizes only what was actually narrowed", () => {
    expect(describeAlternativeDataConfiguration(insider() as AlternativeDataMetric)).toBeNull();
    expect(
      describeAlternativeDataConfiguration(
        insider({ roles: ["CEO", "CFO", "DIRECTOR"] }) as AlternativeDataMetric,
      ),
    ).toBe("CEO, CFO, Director");
    expect(
      describeAlternativeDataConfiguration(
        congress({
          scope: { kind: "GROUP", groupId: "g1" },
          chamber: "SENATE",
          owners: ["SELF", "SPOUSE"],
        }) as AlternativeDataMetric,
        { groupName: "Congress Watchlist" },
      ),
    ).toBe("Congress Watchlist · Senate · Self, Spouse");
    expect(
      describeAlternativeDataConfiguration(
        institutional({
          scope: { kind: "GROUP", groupId: "g1" },
        }) as AlternativeDataMetric,
        { groupName: "Superinvestors" },
      ),
    ).toBe("Superinvestors");
  });

  it("falls back to a neutral label when the name has not been resolved", () => {
    expect(
      describePredicateScope({
        id: "c1",
        metric: institutional({ scope: { kind: "GROUP", groupId: "g1" } }),
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 3 },
      }),
    ).toBe("Selected group");
  });

  it("carries the summary onto the Strategy Logic line and nowhere else", () => {
    const lines = describeStrategy(
      definitionWith({
        id: "c1",
        metric: institutional({ scope: { kind: "GROUP", groupId: "g1" } }),
        operator: "IS_AT_LEAST",
        value: { kind: "NUMBER", value: 3 },
      }),
      { groups: { g1: "Superinvestors" } },
    );
    expect(lines).toEqual([
      { kind: "LEVEL", levelKind: "BUY", index: 1, percentage: 100 },
      {
        kind: "CONDITION",
        text: "Institutional buyers 60D is at least 3",
        scope: "Superinvestors",
      },
    ]);
  });

  it("adds no scope field to a line that has nothing narrowed", () => {
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
// Scope references
// ---------------------------------------------------------------------------

describe("scope reference collection", () => {
  const metrics = [
    insider({ roles: ["CEO"] }),
    congress({ scope: { kind: "GROUP", groupId: "g2" } }),
    congress({ scope: { kind: "GROUP", groupId: "g1" }, chamber: "HOUSE" }),
    institutional({ scope: { kind: "GROUP", groupId: "g1" } }),
    institutional({ scope: { kind: "ACTOR", actorId: "a9" } }),
    institutional(),
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
        asAlternativeDataMetric(institutional()) as AlternativeDataMetric,
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
    institutional() as AlternativeDataMetric,
    institutional({
      measure: "POSITION_CHANGE",
      lookback: 250,
      scope: { kind: "GROUP", groupId: "group-2" },
    }) as AlternativeDataMetric,
  ];

  it("round-trips every configured metric", () => {
    for (const metric of configured) {
      const signature = alternativeDataMetricSignature(metric);
      expect(
        parseAlternativeDataMetricSignature(signature),
        signature,
      ).toEqual(metric);
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
      "INSTITUTIONAL_ACTIVITY|BUYERS|60|any|ANY|-",
      "INSTITUTIONAL_ACTIVITY|BUYERS|60",
    ]) {
      expect(parseAlternativeDataMetricSignature(text), text).toBeUndefined();
    }
  });
});
