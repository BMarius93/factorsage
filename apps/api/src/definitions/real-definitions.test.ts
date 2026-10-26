import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
} from "@intrinsic/contracts";
import {
  deserializeList,
  deserializeStrategy,
  describeDefinition,
  serializeList,
  serializeStrategy,
  validateDefinition,
  type StrategyActorIdentity,
} from "@intrinsic/strategy";
import {
  QA_MATRIX_ACTOR_GROUP_MEMBERS,
  QA_MATRIX_AUDIT_ACTOR,
  QA_MATRIX_ETF_STRATEGIES,
  QA_MATRIX_FUNDAMENTAL_STRATEGIES,
  QA_MATRIX_SECTOR_STRATEGIES,
  QA_MATRIX_STRATEGIES,
  qaMatrixAuditStrategies,
  qaMatrixFixtures,
  qaMatrixSecurity,
  type QaMatrixStrategyFixture,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LISTS,
  BUILT_IN_STRATEGIES,
  memberWindows,
} from "../builtins/builtin-catalog";

/**
 * The codec over FactorSage's own definitions: the built-in catalog and every QA-matrix fixture —
 * fifty strategies across every metric family, legacy Congress scopes included, and the eleven
 * matrix Lists with their boundary, multi-period and open-ended windows. Each must survive
 * `Strategy → JSON → Strategy` with the platform's fingerprint unchanged, `List → JSON → List` with
 * every window intact, validate, and describe itself.
 */

const AUDIT_ACTOR_ID = "actor-k000389";
const AUDIT_GROUP_ID = "group-congress-watchlist";
const actorIdOf = (externalId: string) => `actor-${externalId.toLowerCase()}`;

const ACTORS = new Map<string, StrategyActorIdentity>(
  [QA_MATRIX_AUDIT_ACTOR.externalId, ...QA_MATRIX_ACTOR_GROUP_MEMBERS].map(
    (externalId) => [
      actorIdOf(externalId),
      {
        externalId,
        displayName:
          externalId === QA_MATRIX_AUDIT_ACTOR.externalId
            ? QA_MATRIX_AUDIT_ACTOR.displayName
            : `Member ${externalId}`,
      },
    ],
  ),
);
const ACTOR_GROUPS = new Map([
  [AUDIT_GROUP_ID, QA_MATRIX_ACTOR_GROUP_MEMBERS.map(actorIdOf)],
]);

const STRATEGIES: readonly {
  name: string;
  definition: unknown;
  legacyGroups: boolean;
}[] = [
  ...BUILT_IN_STRATEGIES.map((strategy) => ({
    name: strategy.name,
    definition: strategy.definition,
    legacyGroups: false,
  })),
  ...[
    ...QA_MATRIX_STRATEGIES,
    ...qaMatrixAuditStrategies({
      actorId: AUDIT_ACTOR_ID,
      groupId: AUDIT_GROUP_ID,
    }),
    ...QA_MATRIX_FUNDAMENTAL_STRATEGIES,
    ...QA_MATRIX_ETF_STRATEGIES,
    ...QA_MATRIX_SECTOR_STRATEGIES,
  ].map((fixture: QaMatrixStrategyFixture) => ({
    name: fixture.name,
    definition: fixture.definition,
    legacyGroups: JSON.stringify(fixture.definition).includes('"GROUP"'),
  })),
];

function serializeFixture(name: string, definition: unknown) {
  return serializeStrategy({
    metadata: { name },
    provenance: { origin: "custom", evidence: "authored_record" },
    definition,
    actors: ACTORS,
    actorGroups: ACTOR_GROUPS,
  });
}

describe("every real strategy definition", () => {
  it("covers the built-ins and all five QA-matrix strategy dimensions", () => {
    expect(STRATEGIES.length).toBe(BUILT_IN_STRATEGIES.length + 50);
    expect(STRATEGIES.some((strategy) => strategy.legacyGroups)).toBe(true);
  });

  it.each(STRATEGIES.map((strategy) => [strategy.name, strategy] as const))(
    "%s round-trips, validates and describes itself",
    (_name, strategy) => {
      const document = serializeFixture(strategy.name, strategy.definition);
      expect(validateDefinition(document).valid).toBe(true);
      expect(
        JSON.stringify(serializeFixture(strategy.name, strategy.definition)),
      ).toBe(JSON.stringify(document));

      const actorByBioguide = new Map(
        [...ACTORS].map(([actorId, identity]) => [
          identity.externalId,
          actorId,
        ]),
      );
      const { draft } = deserializeStrategy(
        JSON.parse(JSON.stringify(document)),
        {
          resolveActor: (externalId) => actorByBioguide.get(externalId),
        },
      );
      if (strategy.legacyGroups) {
        // A legacy group reads back as the members it held: the same logic the conversion command
        // produces, so it is compared after the same embedding.
        expect(
          JSON.stringify(serializeFixture(draft.name, draft.definition)),
        ).toBe(JSON.stringify(document));
      } else {
        expect(strategyDefinitionFingerprint(draft.definition)).toBe(
          strategyDefinitionFingerprint(
            normalizeStrategyDefinition(strategy.definition),
          ),
        );
      }

      const description = describeDefinition(document);
      expect(description.short.length).toBeGreaterThan(20);
      expect(description.detailed.split("\n").length).toBeGreaterThanOrEqual(2);
      expect(`${description.short} ${description.detailed}`).not.toContain(
        strategy.name,
      );
      expect(describeDefinition(document)).toEqual(description);
    },
  );
});

describe("every real list definition", () => {
  const matrix = qaMatrixFixtures();
  const LISTS = [
    ...BUILT_IN_LISTS.map((list) => ({
      name: list.name,
      members: list.members.map((member) => ({
        // The catalog resolves symbols against the supported exchanges at bootstrap; any one
        // stands in here, where only the windows are under test.
        security: { symbol: member.symbol, exchange: "NASDAQ" },
        buyWindow: memberWindows(member),
      })),
    })),
    ...matrix.allLists.map((list) => ({
      name: list.name,
      members: list.members.map((member) => ({
        security: {
          symbol: member.symbol,
          exchange: qaMatrixSecurity(member.symbol).exchangeCode,
        },
        buyWindow: {
          mode: member.mode,
          ranges: member.ranges.map((range) => ({
            startDate: range.startDate,
            endDate: range.endDate,
          })),
        },
      })),
    })),
  ];

  it("covers the static built-ins and all eleven matrix lists", () => {
    expect(LISTS.length).toBe(BUILT_IN_LISTS.length + 11);
  });

  it.each(LISTS.map((list) => [list.name, list] as const))(
    "%s round-trips with every window intact",
    (_name, list) => {
      const document = serializeList({
        metadata: { name: list.name },
        provenance: { origin: "custom", evidence: "authored_record" },
        membership: { kind: "members", members: list.members },
      });
      expect(validateDefinition(document).valid).toBe(true);
      const read = deserializeList(JSON.parse(JSON.stringify(document)), {
        resolveSecurity: (security) =>
          `${security.symbol}@${security.exchange}`,
      });
      expect(read.members).toHaveLength(list.members.length);
      for (const member of list.members) {
        const back = read.members.find(
          (candidate) =>
            candidate.securityId ===
            `${member.security.symbol}@${member.security.exchange}`,
        );
        expect(back?.buyWindow.mode).toBe(member.buyWindow.mode);
        expect(back?.buyWindow.ranges).toEqual(
          [...member.buyWindow.ranges].sort((left, right) =>
            left.startDate < right.startDate ? -1 : 1,
          ),
        );
      }
      const { short, detailed } = describeDefinition(document);
      for (const member of list.members) {
        expect(`${short} ${detailed}`).not.toContain(
          ` ${member.security.symbol} `,
        );
      }
    },
  );

  it("keeps a plan-sized list's document small", () => {
    // The largest List any plan allows (1,000 securities), each with one open-ended window.
    const members = Array.from({ length: 1_000 }, (_, index) => ({
      security: {
        symbol: `SYM${String(index).padStart(4, "0")}`,
        exchange: "NYSE",
      },
      buyWindow: {
        mode: "CUSTOM" as const,
        ranges: [{ startDate: "2010-01-04", endDate: null }],
      },
    }));
    const startedAt = performance.now();
    const document = serializeList({
      metadata: { name: "Large" },
      provenance: { origin: "custom", evidence: "authored_record" },
      membership: { kind: "members", members },
    });
    describeDefinition(document);
    const elapsed = performance.now() - startedAt;
    // Measured at about 135 KB: roughly 135 bytes a member. A share stores one such document at
    // most, beside a strategy document of a few kilobytes.
    const bytes = Buffer.byteLength(JSON.stringify(document));
    expect(bytes).toBeLessThan(160_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});
