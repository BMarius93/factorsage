import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTOR_IDENTITIES,
  ACTOR_KHANNA,
  ACTOR_PELOSI,
  ACTOR_TUBERVILLE,
  everyFamilyDefinition,
  type MutableJson,
} from "./fixtures.test-helper.js";
import { CanonicalDefinitionError } from "./issues.js";
import { deserializeStrategy, serializeStrategy } from "./strategy-codec.js";
import type {
  CanonicalProvenance,
  CanonicalStrategyDocument,
} from "./types.js";
import { validateDefinition } from "./validate.js";

const CUSTOM: CanonicalProvenance = {
  origin: "custom",
  evidence: "authored_record",
};

const ACTOR_BY_BIOGUIDE = new Map(
  [...ACTOR_IDENTITIES].map(([actorId, identity]) => [
    identity.externalId,
    actorId,
  ]),
);

function serialize(
  definition: unknown = everyFamilyDefinition(),
  overrides: Partial<Parameters<typeof serializeStrategy>[0]> = {},
): CanonicalStrategyDocument {
  return serializeStrategy({
    metadata: { name: "Quality at a discount" },
    provenance: CUSTOM,
    definition,
    actors: ACTOR_IDENTITIES,
    ...overrides,
  });
}

function deserialize(document: unknown) {
  return deserializeStrategy(document, {
    resolveActor: (externalId) => ACTOR_BY_BIOGUIDE.get(externalId),
  });
}

function issueCodes(error: unknown): string[] {
  expect(error).toBeInstanceOf(CanonicalDefinitionError);
  return (error as CanonicalDefinitionError).issues.map((issue) => issue.code);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("serializeStrategy", () => {
  it("writes a self-describing, versioned document with no row id", () => {
    const document = serialize();
    expect(document.format).toBe("factorsage.definition");
    expect(document.schemaVersion).toBe(1);
    expect(document.type).toBe("strategy");
    expect(Object.keys(document)).toEqual([
      "format",
      "schemaVersion",
      "type",
      "metadata",
      "provenance",
      "definition",
      "actors",
    ]);
    const json = JSON.stringify(document);
    for (const id of ["b1", "b1c1", "b1t", "s1", "fx", "fx1", "fx3c2"]) {
      expect(json).not.toContain(`"${id}"`);
    }
    expect(json).not.toContain('"id":"b');
    expect(validateDefinition(document)).toEqual({ valid: true, document });
  });

  it("is deterministic and ignores row identity", () => {
    const first = JSON.stringify(serialize());
    const second = JSON.stringify(serialize());
    expect(second).toBe(first);
    const rekeyed = JSON.parse(
      JSON.stringify(everyFamilyDefinition()).replace(
        /"id":"([^"]+)"/g,
        '"id":"x-$1"',
      ),
    );
    expect(JSON.stringify(serialize(rekeyed))).toBe(first);
  });

  it("names Congress members by bioguide id, with their names beside", () => {
    const document = serialize();
    const rules = document.definition.finalExit?.rules ?? [];
    const scopes = rules[2]?.signal.conditions.map((condition) =>
      condition.metric.kind === "CONGRESS_ACTIVITY"
        ? condition.metric.scope
        : null,
    );
    // A selection, sorted by bioguide id, and the legacy single member as the selection it means.
    expect(scopes).toEqual([
      { kind: "ACTORS", actors: ["P000197", "T000278"] },
      { kind: "ACTORS", actors: ["K000389"] },
    ]);
    expect(document.actors).toEqual([
      { id: "K000389", name: "Ro Khanna" },
      { id: "P000197", name: "Nancy Pelosi" },
      { id: "T000278", name: "Tommy Tuberville" },
    ]);
    expect(JSON.stringify(document)).not.toContain(ACTOR_PELOSI);
  });

  it("preserves level order, percentages, sources, filters, triggers and every Value", () => {
    const definition = serialize().definition;
    expect(definition.buyLevels.map((level) => level.percentage)).toEqual([
      50, 50,
    ]);
    expect(definition.buyLevels[0]?.signal.trigger).toEqual({
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "CROSSES_ABOVE",
      value: { kind: "NUMBER", value: 30 },
    });
    expect(
      definition.buyLevels[1]?.signal.conditions.map(
        (condition) => condition.metric,
      ),
    ).toEqual([
      { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
      {
        kind: "OSCILLATOR",
        seriesId: "RSI_14D",
        source: { kind: "ETF", code: "ETF_XLK" },
      },
      { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
      { kind: "PRICE" },
      {
        kind: "INSIDER_ACTIVITY",
        measure: "BUYERS",
        lookback: 90,
        roles: ["CEO", "CFO"],
      },
    ]);
    expect(definition.buyLevels[1]?.signal.conditions[3]?.operator).toBe(
      "IS_CLOSE_TO",
    );
    expect(definition.sellLevels).toEqual([
      {
        percentage: 50,
        signal: {
          conditions: [
            {
              metric: { kind: "GAIN" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 25 },
            },
            {
              metric: { kind: "RELATIVE_VOLUME", period: 20 },
              operator: "IS_ABOVE",
              value: { kind: "MULTIPLE", value: 2 },
            },
          ],
        },
      },
    ]);
    expect(definition.finalExit?.rules).toHaveLength(3);
    expect(definition.finalExit?.rules[2]?.signal.conditions[1]).toEqual({
      metric: {
        kind: "CONGRESS_ACTIVITY",
        measure: "MINIMUM_PURCHASE_VALUE",
        lookback: 60,
        scope: { kind: "ACTORS", actors: ["K000389"] },
        chamber: "HOUSE",
      },
      operator: "IS_BELOW",
      value: { kind: "MONEY", value: 50000 },
    });
  });

  it("reads a schema version 1 document as its upcast", () => {
    const v2 = everyFamilyDefinition();
    const finalExit = v2.finalExit;
    const v1 = {
      ...v2,
      schemaVersion: 1,
      finalExit: { id: "fx", signal: finalExit?.rules[0]?.signal },
    };
    const singleRule: StrategyDefinition = {
      ...v2,
      finalExit: {
        id: "fx",
        rules: [{ id: "fx", signal: finalExit?.rules[0]?.signal as never }],
      },
    };
    expect(JSON.stringify(serialize(v1))).toBe(
      JSON.stringify(serialize(singleRule)),
    );
  });

  it("embeds a legacy group scope from its frozen membership, and refuses one without it", () => {
    const definition = everyFamilyDefinition();
    const groupRule = definition.finalExit?.rules[2]?.signal.conditions[0];
    if (groupRule?.metric.kind !== "CONGRESS_ACTIVITY") {
      throw new Error("fixture drifted");
    }
    groupRule.metric = {
      ...groupRule.metric,
      scope: { kind: "GROUP", groupId: "group-1" },
    };

    const embedded = serialize(definition, {
      actorGroups: new Map([["group-1", [ACTOR_TUBERVILLE, ACTOR_PELOSI]]]),
    });
    expect(
      embedded.definition.finalExit?.rules[2]?.signal.conditions[0]?.metric,
    ).toMatchObject({
      scope: { kind: "ACTORS", actors: ["P000197", "T000278"] },
    });

    expect(issueCodes(thrown(() => serialize(definition)))).toEqual([
      "ACTOR_GROUP_UNRESOLVED",
    ]);
    expect(
      issueCodes(
        thrown(() =>
          serialize(definition, { actorGroups: new Map([["group-1", []]]) }),
        ),
      ),
    ).toEqual(["ACTOR_GROUP_UNRESOLVED"]);
  });

  it("refuses an actor whose identity was not supplied rather than dropping it", () => {
    const actors = new Map(ACTOR_IDENTITIES);
    actors.delete(ACTOR_KHANNA);
    expect(
      issueCodes(thrown(() => serialize(everyFamilyDefinition(), { actors }))),
    ).toEqual(["ACTOR_UNRESOLVED"]);
  });

  it("refuses a definition the Strategy rules refuse, at the rule's own path", () => {
    const definition = everyFamilyDefinition();
    (
      definition.buyLevels[0]?.signal.conditions[2] as { value: unknown }
    ).value = {
      kind: "SERIES",
      seriesId: "SMA_999D",
    };
    const error = thrown(() =>
      serialize(definition),
    ) as CanonicalDefinitionError;
    expect(error.issues[0]).toMatchObject({
      code: "STRATEGY_INVALID",
      path: "definition.buyLevels[0].signal.conditions[2].value",
    });
  });
});

describe("deserializeStrategy", () => {
  it("round-trips to the same logic: Strategy → JSON → Strategy keeps the fingerprint", () => {
    const original = everyFamilyDefinition();
    const { draft, provenance } = deserialize(serialize(original));
    expect(strategyDefinitionFingerprint(draft.definition)).toBe(
      strategyDefinitionFingerprint(normalizeStrategyDefinition(original)),
    );
    expect(draft.name).toBe("Quality at a discount");
    expect(provenance).toEqual(CUSTOM);
  });

  it("round-trips JSON → Strategy → JSON to the identical document", () => {
    const document = serialize();
    const { draft } = deserialize(document);
    const again = serialize(draft.definition, {
      metadata: { name: draft.name },
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(document));
  });

  it("gives rows deterministic positional ids, or fresh ones on request", () => {
    const document = serialize();
    const first = deserialize(document).draft.definition;
    expect(first.buyLevels.map((level) => level.id)).toEqual([
      "buy-1",
      "buy-2",
    ]);
    expect(
      first.buyLevels[0]?.signal.conditions.map((condition) => condition.id),
    ).toEqual(["buy-1-condition-1", "buy-1-condition-2", "buy-1-condition-3"]);
    expect(first.buyLevels[0]?.signal.trigger?.id).toBe("buy-1-trigger");
    expect(first.finalExit?.id).toBe("final-exit");
    expect(first.finalExit?.rules.map((rule) => rule.id)).toEqual([
      "final-exit-rule-1",
      "final-exit-rule-2",
      "final-exit-rule-3",
    ]);
    expect(JSON.stringify(deserialize(document).draft.definition)).toBe(
      JSON.stringify(first),
    );

    let next = 0;
    const fresh = deserializeStrategy(document, {
      resolveActor: (externalId) => ACTOR_BY_BIOGUIDE.get(externalId),
      nextId: () => `uuid-${(next += 1)}`,
    }).draft.definition;
    expect(fresh.buyLevels[0]?.id).toBe("uuid-1");
    expect(strategyDefinitionFingerprint(fresh)).toBe(
      strategyDefinitionFingerprint(first),
    );
  });

  it("refuses a bioguide id this database cannot resolve, naming each one", () => {
    const error = thrown(() =>
      deserializeStrategy(serialize(), {
        resolveActor: (externalId) =>
          externalId === "P000197"
            ? undefined
            : ACTOR_BY_BIOGUIDE.get(externalId),
      }),
    ) as CanonicalDefinitionError;
    expect(error.issues.map((issue) => issue.code)).toEqual([
      "ACTOR_UNRESOLVED",
    ]);
    expect(error.issues[0]?.message).toContain("P000197");
  });
});

describe("validating a canonical strategy", () => {
  function mutated(change: (document: MutableJson) => void): unknown {
    const document = JSON.parse(JSON.stringify(serialize())) as MutableJson;
    change(document);
    return document;
  }

  function codes(input: unknown): string[] {
    const result = validateDefinition(input);
    return result.valid ? [] : result.issues.map((issue) => issue.code);
  }

  it("refuses other formats, schema versions and types before reading anything else", () => {
    expect(codes(mutated((document) => (document.format = "other")))).toEqual([
      "FORMAT_UNSUPPORTED",
    ]);
    expect(codes(mutated((document) => (document.schemaVersion = 2)))).toEqual([
      "SCHEMA_VERSION_UNSUPPORTED",
    ]);
    expect(codes(mutated((document) => delete document.schemaVersion))).toEqual(
      ["SCHEMA_VERSION_UNSUPPORTED"],
    );
    expect(codes(mutated((document) => (document.type = "portfolio")))).toEqual(
      ["TYPE_UNSUPPORTED"],
    );
    expect(codes("not json")).toEqual(["SHAPE_INVALID"]);
    expect(codes([])).toEqual(["SHAPE_INVALID"]);
  });

  it("refuses every field it does not define instead of ignoring it", () => {
    expect(codes(mutated((document) => (document.owner = "someone")))).toEqual([
      "UNKNOWN_FIELD",
    ]);
    expect(
      codes(
        mutated(
          (document) =>
            (document.definition.buyLevels[0].signal.conditions[0].id = "x"),
        ),
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
    expect(
      codes(mutated((document) => (document.definition.maximumPositions = 10))),
    ).toEqual(["UNKNOWN_FIELD"]);
    // Inside a metric the Strategy grammar's own closed key set refuses it.
    expect(
      codes(
        mutated(
          (document) =>
            (document.definition.buyLevels[0].signal.conditions[2].metric.period = 5),
        ),
      ),
    ).toEqual(["STRATEGY_INVALID"]);
  });

  it("refuses an unsupported metric, operator or Value through the Strategy rules", () => {
    expect(
      codes(
        mutated(
          (document) =>
            (document.definition.buyLevels[0].signal.conditions[0].metric.ratioId =
              "PEG"),
        ),
      ),
    ).toEqual(["STRATEGY_INVALID"]);
    expect(
      codes(
        mutated(
          (document) =>
            (document.definition.buyLevels[0].signal.conditions[0].operator =
              "EQUALS"),
        ),
      ),
    ).toEqual(["STRATEGY_INVALID"]);
    expect(
      codes(
        mutated(
          (document) => (document.definition.sellLevels[0].percentage = 100),
        ),
      ),
    ).toEqual(["STRATEGY_INVALID"]);
    expect(
      codes(mutated((document) => (document.definition.buyLevels = []))),
    ).toContain("STRATEGY_INVALID");
  });

  it("holds Congress scopes to their portable, canonical form", () => {
    const congress = (document: MutableJson) =>
      document.definition.finalExit.rules[2].signal.conditions[0].metric;
    expect(
      codes(
        mutated(
          (document) =>
            (congress(document).scope = { kind: "GROUP", groupId: "g" }),
        ),
      ),
    ).toEqual(["SHAPE_INVALID", "ACTOR_REFERENCES_INVALID"]);
    expect(
      codes(
        mutated(
          (document) =>
            (congress(document).scope = {
              kind: "ACTORS",
              actors: ["T000278", "P000197"],
            }),
        ),
      ),
    ).toEqual(["SHAPE_INVALID", "ACTOR_REFERENCES_INVALID"]);
    expect(
      codes(
        mutated(
          (document) =>
            (congress(document).scope = {
              kind: "ACTORS",
              actorIds: ["P000197"],
            }),
        ),
      ),
    ).toContain("UNKNOWN_FIELD");
  });

  it("requires the actor references to describe exactly the selected members", () => {
    expect(codes(mutated((document) => delete document.actors))).toEqual([
      "ACTOR_REFERENCES_INVALID",
    ]);
    expect(
      codes(
        mutated((document) =>
          document.actors.push({ id: "Z000001", name: "Nobody" }),
        ),
      ),
    ).toEqual(["ACTOR_REFERENCES_INVALID"]);
    expect(codes(mutated((document) => document.actors.reverse()))).toEqual([
      "ACTOR_REFERENCES_INVALID",
    ]);
  });

  it("validates provenance and metadata", () => {
    expect(
      codes(
        mutated(
          (document) =>
            (document.provenance = {
              origin: "built_in",
              evidence: "copy_record",
            }),
        ),
      ),
    ).toEqual(["PROVENANCE_INVALID"]);
    expect(
      codes(
        mutated((document) => (document.provenance = { origin: "official" })),
      ),
    ).toEqual(["PROVENANCE_INVALID"]);
    expect(
      codes(
        mutated(
          (document) =>
            (document.provenance = {
              origin: "unknown",
              evidence: "copy_record",
            }),
        ),
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
    expect(
      codes(
        mutated(
          (document) =>
            (document.provenance = {
              origin: "derived",
              evidence: "copy_record",
              derivedFrom: {
                systemKey: "value-and-trend",
                name: "Value & Trend",
                version: "3",
              },
            }),
        ),
      ),
    ).toEqual(["PROVENANCE_INVALID"]);
    expect(
      codes(mutated((document) => (document.metadata.name = "  "))),
    ).toEqual(["SHAPE_INVALID"]);
    expect(
      codes(mutated((document) => (document.metadata.userId = "u"))),
    ).toEqual(["UNKNOWN_FIELD"]);
  });
});
