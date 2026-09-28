import {
  ACTOR_SCOPE_KINDS,
  ALTERNATIVE_DATA_LOOKBACKS,
  BUY_LEVEL_PERCENTAGES,
  CONDITION_OPERATORS,
  CONGRESS_CHAMBER_FILTERS,
  CONGRESS_MEASURES,
  CONGRESS_OWNERS,
  INSIDER_MEASURES,
  INSIDER_ROLES,
  RELATIVE_VOLUME_PERIODS,
  SELECTABLE_SERIES_CATALOG,
  SELL_LEVEL_PERCENTAGES,
  STRATEGY_LEGACY_SCHEMA_VERSION,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_MAX_BUY_LEVELS,
  STRATEGY_MAX_CONDITIONS_PER_SIGNAL,
  STRATEGY_MAX_EXIT_RULES,
  STRATEGY_MAX_SELL_LEVELS,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_PREDICATE_PARTS,
  STRATEGY_SCHEMA_VERSION,
  STRATEGY_VALIDATION_CODES,
  TRIGGER_OPERATORS,
  defaultConditionOperatorFor,
  defaultTriggerOperatorFor,
  defaultValueFor,
  normalizeStrategyDefinition,
  strategyMetricOptions,
  validateStrategyDefinition,
  valueSpecFor,
  type StrategyIssueField,
  type StrategyIssuePart,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyPredicatePart,
  type StrategyValueKind,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { loadOpenApiDocument } from "./openapi-document";

/**
 * The Strategy half of `docs/openapi.yaml`, held to the canonical model it documents.
 *
 * `openapi.contract.test.ts` proves the document lists the routes that exist; nothing proved that
 * its Strategy schemas describe the documents those routes accept and return, and they had fallen
 * behind the model — no Relative Volume or alternative-data metric, no `MULTIPLE` or `MONEY` value,
 * nine validation codes and the Exit Rule issue path missing. A client written against the
 * specification would have refused a strategy the API itself had just returned.
 *
 * So every vocabulary here is read from `@intrinsic/contracts`, never retyped, and the document is
 * then checked against **real canonical documents** rather than against itself: every metric the
 * registry offers, in every level kind and both halves of a Signal, at its fullest configuration,
 * normalized exactly as the API stores it and serialized exactly as the API sends it.
 */

type Schema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly oneOf?: readonly Schema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
};

const document = loadOpenApiDocument();

/** Follows `$ref` JSON pointers inside the document, including ones into another schema's properties. */
function resolve(schema: Schema): Schema {
  let current = schema;
  while (current.$ref !== undefined) {
    current = current.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        document,
      ) as Schema;
  }
  return current;
}

function schema(name: string): Schema {
  const found = (document.components?.schemas as Record<string, Schema>)[name];
  if (!found) {
    throw new Error(`docs/openapi.yaml has no \`${name}\` schema`);
  }
  return resolve(found);
}

function property(owner: Schema, name: string): Schema {
  const found = resolve(owner).properties?.[name];
  if (!found) {
    throw new Error(`the schema has no \`${name}\` property`);
  }
  return resolve(found);
}

/** The discriminated variants of a `oneOf` schema, keyed by their `kind` constant. */
function variants(owner: Schema): Map<unknown, Schema> {
  return new Map(
    (resolve(owner).oneOf ?? []).map((variant) => [
      property(variant, "kind").const,
      resolve(variant),
    ]),
  );
}

/**
 * Whether `schema` describes `value`, for the JSON Schema subset this document uses.
 *
 * Objects are read as **closed**: a key the schema does not document fails. The document does not
 * say `additionalProperties: false`, but the question here is whether it names everything the API
 * actually sends, and an undocumented key is exactly the drift being guarded against.
 */
function describes(candidate: Schema, value: unknown): boolean {
  const current = resolve(candidate);
  if (current.oneOf) {
    return (
      current.oneOf.filter((variant) => describes(variant, value)).length === 1
    );
  }
  if (current.const !== undefined && value !== current.const) {
    return false;
  }
  if (current.enum && !current.enum.includes(value)) {
    return false;
  }
  switch (current.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      const properties = current.properties ?? {};
      return (
        (current.required ?? []).every((key) => key in record) &&
        Object.entries(record).every(
          ([key, entry]) =>
            properties[key] !== undefined && describes(properties[key], entry),
        )
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (current.minItems ?? 0) &&
        value.length <= (current.maxItems ?? Number.POSITIVE_INFINITY) &&
        value.every((entry) =>
          current.items ? describes(current.items, entry) : true,
        )
      );
    case "string":
      return typeof value === "string";
    case "integer":
      return (
        Number.isInteger(value) &&
        (current.minimum === undefined || (value as number) >= current.minimum)
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (current.minimum === undefined || value >= current.minimum)
      );
    case undefined:
      return true;
    default:
      return false;
  }
}

// Written as records so the compiler, not this file, decides whether a list is complete: a part,
// field or value kind added to the model without being added here fails `pnpm typecheck`.
const ISSUE_PARTS: Record<StrategyIssuePart, true> = {
  STRATEGY: true,
  NAME: true,
  DESCRIPTION: true,
  LEVEL: true,
  EXIT_RULE: true,
  PERCENTAGE: true,
  CONDITION: true,
  TRIGGER: true,
};
const ISSUE_FIELDS: Record<StrategyIssueField, true> = {
  METRIC: true,
  OPERATOR: true,
  VALUE: true,
};
const VALUE_KINDS: Record<StrategyValueKind, true> = {
  SERIES: true,
  NUMBER: true,
  PERCENT: true,
  MULTIPLE: true,
  MONEY: true,
};

const A_GROUP_ID = "4b8d0f3e-2c1a-4e7b-9a6d-5f0c3b2a1e9d";

/** The metric at its fullest configuration: every optional filter present, and a narrowed scope. */
function fullest(metric: StrategyMetric): StrategyMetric {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
      return { ...metric, lookback: 180, roles: [...INSIDER_ROLES] };
    case "CONGRESS_ACTIVITY":
      return {
        ...metric,
        lookback: 180,
        scope: { kind: "GROUP", groupId: A_GROUP_ID },
        chamber: "HOUSE",
        owners: [...CONGRESS_OWNERS],
      };
    default:
      return metric;
  }
}

/** A canonical document carrying `metric` in `levelKind`, as a Condition or as the Trigger. */
function documentWith(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart,
  metric: StrategyMetric,
): unknown {
  const predicate = {
    id: "predicate-1",
    metric,
    operator:
      part === "TRIGGER"
        ? defaultTriggerOperatorFor(metric)
        : defaultConditionOperatorFor(metric),
    value: defaultValueFor(metric),
  };
  const signal =
    part === "TRIGGER"
      ? { conditions: [], trigger: predicate }
      : { conditions: [predicate] };
  const anchor = {
    conditions: [
      {
        id: "anchor-1",
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    ],
  };
  const definition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: levelKind === "BUY" ? signal : anchor,
      },
    ],
    sellLevels:
      levelKind === "SELL" ? [{ id: "sell-1", percentage: 50, signal }] : [],
    ...(levelKind === "FINAL_EXIT"
      ? { finalExit: { id: "exit-1", rules: [{ id: "rule-1", signal }] } }
      : {}),
  };
  // Stored exactly as the API stores it, and read exactly as a client receives it.
  return JSON.parse(JSON.stringify(normalizeStrategyDefinition(definition)));
}

function everyOfferedMetric(): {
  levelKind: StrategyLevelKind;
  part: StrategyPredicatePart;
  metric: StrategyMetric;
}[] {
  return STRATEGY_LEVEL_KINDS.flatMap((levelKind) =>
    STRATEGY_PREDICATE_PARTS.flatMap((part) =>
      strategyMetricOptions(levelKind, part).flatMap((option) => [
        { levelKind, part, metric: option.metric },
        { levelKind, part, metric: fullest(option.metric) },
      ]),
    ),
  );
}

describe("OpenAPI Strategy schemas describe the canonical Strategy model", () => {
  const metric = schema("StrategyMetric");
  const value = schema("StrategyValue");

  it("documents every metric kind the model defines, and no other", () => {
    expect([...variants(metric).keys()].sort()).toEqual(
      Object.keys(STRATEGY_METRIC_DEFINITIONS).sort(),
    );
  });

  it("documents every value kind the model defines, and every one the registry compares with", () => {
    const documented = [...variants(value).keys()].sort();
    expect(documented).toEqual(Object.keys(VALUE_KINDS).sort());
    const used = new Set(
      everyOfferedMetric().map(
        ({ metric: offered }) => valueSpecFor(offered).kind,
      ),
    );
    expect([...used].sort()).toEqual(documented);
  });

  it("documents each metric's parameters in the model's own vocabularies", () => {
    const byKind = variants(metric);
    expect(property(byKind.get("RELATIVE_VOLUME")!, "period").enum).toEqual(
      RELATIVE_VOLUME_PERIODS,
    );
    const insider = byKind.get("INSIDER_ACTIVITY")!;
    const congress = byKind.get("CONGRESS_ACTIVITY")!;
    expect(property(insider, "measure").enum).toEqual(INSIDER_MEASURES);
    expect(property(congress, "measure").enum).toEqual(CONGRESS_MEASURES);
    expect(property(insider, "lookback").enum).toEqual(
      ALTERNATIVE_DATA_LOOKBACKS,
    );
    expect(property(congress, "lookback").enum).toEqual(
      ALTERNATIVE_DATA_LOOKBACKS,
    );
    expect(resolve(property(insider, "roles").items!).enum).toEqual(
      INSIDER_ROLES,
    );
    expect(resolve(property(congress, "owners").items!).enum).toEqual(
      CONGRESS_OWNERS,
    );
    expect(property(congress, "chamber").enum).toEqual(
      CONGRESS_CHAMBER_FILTERS,
    );
    expect([...variants(property(congress, "scope")).keys()]).toEqual(
      ACTOR_SCOPE_KINDS,
    );
    // A filter is never an empty list: absent means "everyone", so an empty one is refused.
    expect(property(insider, "roles").minItems).toBe(1);
    expect(property(congress, "owners").minItems).toBe(1);
    expect(schema("SelectableSeriesId").enum).toEqual(
      SELECTABLE_SERIES_CATALOG.map((entry) => entry.id),
    );
  });

  it("describes every metric the registry offers, in every level kind and half of a Signal, at its fullest configuration", () => {
    const definition = schema("StrategyDefinition");
    const offered = everyOfferedMetric();
    // Every kind reaches this check, so no variant is documented without a real document behind it.
    expect(
      new Set(offered.map(({ metric: candidate }) => candidate.kind)),
    ).toEqual(new Set(Object.keys(STRATEGY_METRIC_DEFINITIONS)));
    for (const { levelKind, part, metric: candidate } of offered) {
      const sent = documentWith(levelKind, part, candidate);
      expect(
        describes(definition, sent),
        `${levelKind} ${part} ${JSON.stringify(candidate)}`,
      ).toBe(true);
    }
  });

  it("documents exactly the canonical operators, with no inclusive comparison", () => {
    const condition = property(schema("StrategyCondition"), "operator");
    const trigger = property(schema("StrategyTrigger"), "operator");
    expect(condition.enum).toEqual(CONDITION_OPERATORS);
    expect(trigger.enum).toEqual(TRIGGER_OPERATORS);
    for (const removed of ["IS_AT_LEAST", "IS_AT_MOST"]) {
      expect(condition.enum).not.toContain(removed);
      expect(trigger.enum).not.toContain(removed);
    }

    // Both halves refuse a document still naming one: the specification and the model.
    const sent = documentWith("BUY", "CONDITION", {
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
    }) as { buyLevels: { signal: { conditions: { operator: string }[] } }[] };
    sent.buyLevels[0]!.signal.conditions[0]!.operator = "IS_AT_LEAST";
    expect(describes(schema("StrategyDefinition"), sent)).toBe(false);
    expect(
      validateStrategyDefinition(sent).map((issue) => issue.code),
    ).toContain("OPERATOR_NOT_SUPPORTED");
  });

  it("keeps the refusals its prose names", () => {
    const codesFor = (candidate: unknown) =>
      validateStrategyDefinition(candidate).map((issue) => issue.code);
    const withBuySignal = (signal: unknown) => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "buy-1", percentage: 100, signal }],
      sellLevels: [],
    });
    const trigger = (metricValue: StrategyMetric) => ({
      conditions: [],
      trigger: {
        id: "t1",
        metric: metricValue,
        operator: "CROSSES_ABOVE",
        value: defaultValueFor(metricValue),
      },
    });
    // "Condition only": Relative Volume and the alternative-data metrics have no trigger form.
    for (const conditionOnly of [
      { kind: "RELATIVE_VOLUME", period: 20 },
      { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 20 },
      {
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 30,
        scope: { kind: "ANY" },
        chamber: "ANY",
      },
    ] as const satisfies readonly StrategyMetric[]) {
      expect(codesFor(withBuySignal(trigger(conditionOnly)))).toContain(
        "METRIC_NOT_ALLOWED_IN_PART",
      );
    }
    // `IS_CLOSE_TO` is offered only for the price-scaled metrics.
    expect(
      codesFor(
        withBuySignal({
          conditions: [
            {
              id: "c1",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_CLOSE_TO",
              value: { kind: "NUMBER", value: 30 },
            },
          ],
        }),
      ),
    ).toContain("OPERATOR_NOT_SUPPORTED");
    // An identifier outside the catalog.
    expect(
      codesFor(
        withBuySignal({
          conditions: [
            {
              id: "c1",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "sma50d" },
            },
          ],
        }),
      ),
    ).toContain("SERIES_UNKNOWN");
  });

  it("documents every validation code and issue path the model can report", () => {
    const issue = schema("StrategyValidationIssue");
    expect(property(issue, "code").enum).toEqual(STRATEGY_VALIDATION_CODES);
    const path = property(issue, "path");
    expect([...(property(path, "part").enum ?? [])].sort()).toEqual(
      Object.keys(ISSUE_PARTS).sort(),
    );
    expect([...(property(path, "field").enum ?? [])].sort()).toEqual(
      Object.keys(ISSUE_FIELDS).sort(),
    );
    expect(Object.keys(resolve(path).properties ?? {}).sort()).toEqual(
      [
        "conditionIndex",
        "field",
        "levelIndex",
        "levelKind",
        "part",
        "ruleIndex",
      ].sort(),
    );
  });

  it("documents the model's structural limits and schema versions", () => {
    const definition = schema("StrategyDefinition");
    const buyLevels = property(definition, "buyLevels");
    const sellLevels = property(definition, "sellLevels");
    const rules = property(property(definition, "finalExit"), "rules");
    expect(buyLevels.maxItems).toBe(STRATEGY_MAX_BUY_LEVELS);
    expect(sellLevels.maxItems).toBe(STRATEGY_MAX_SELL_LEVELS);
    expect(rules.maxItems).toBe(STRATEGY_MAX_EXIT_RULES);
    expect(property(schema("StrategySignal"), "conditions").maxItems).toBe(
      STRATEGY_MAX_CONDITIONS_PER_SIGNAL,
    );
    expect(property(resolve(buyLevels.items!), "percentage").enum).toEqual(
      BUY_LEVEL_PERCENTAGES,
    );
    expect(property(resolve(sellLevels.items!), "percentage").enum).toEqual(
      SELL_LEVEL_PERCENTAGES,
    );
    expect(property(definition, "schemaVersion").enum).toEqual([
      STRATEGY_SCHEMA_VERSION,
    ]);
    expect(
      property(schema("LegacyStrategyDefinitionV1"), "schemaVersion").enum,
    ).toEqual([STRATEGY_LEGACY_SCHEMA_VERSION]);
  });
});
