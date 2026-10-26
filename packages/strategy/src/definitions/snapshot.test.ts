import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTOR_KHANNA,
  ACTOR_PELOSI,
  ACTOR_TUBERVILLE,
  everyFamilyDefinition,
} from "./fixtures.test-helper.js";
import { CanonicalDefinitionError } from "./issues.js";
import { deserializeList } from "./list-codec.js";
import {
  serializeSnapshotList,
  serializeSnapshotStrategy,
  snapshotIndexMembershipResolver,
} from "./snapshot.js";

const PROVENANCE = { origin: "custom", evidence: "authored_record" } as const;

function snapshot(
  overrides: Partial<BacktestRunSnapshot> = {},
): BacktestRunSnapshot {
  return {
    snapshotVersion: 2,
    submittedAt: "2026-10-20T10:00:00.000Z",
    strategy: {
      strategyId: "strategy-uuid",
      name: "Frozen name",
      versionId: "version-uuid",
      versionNumber: 3,
      definitionHash: "hash",
      definition: everyFamilyDefinition(),
    },
    stockList: { stockListId: "list-uuid", name: "Frozen list" },
    securities: [
      {
        securityId: "sec-msft",
        symbol: "MSFT",
        name: "Microsoft",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: "FULL",
        buyWindows: [],
      },
      {
        securityId: "sec-aapl",
        symbol: "AAPL",
        name: "Apple",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: "CUSTOM",
        buyWindows: [{ startDate: "2010-01-04", endDate: null }],
      },
    ],
    actors: [
      {
        actorId: ACTOR_PELOSI,
        externalId: "P000197",
        displayName: "Nancy Pelosi",
      },
      {
        actorId: ACTOR_TUBERVILLE,
        externalId: "T000278",
        displayName: "Tommy Tuberville",
      },
      {
        actorId: ACTOR_KHANNA,
        externalId: "K000389",
        displayName: "Ro Khanna",
      },
    ],
    period: { startDate: "2015-01-02", endDate: "2024-12-31" },
    ...overrides,
  } as unknown as BacktestRunSnapshot;
}

describe("the definitions a run executed", () => {
  it("serializes the frozen strategy with its frozen name and actors", () => {
    const document = serializeSnapshotStrategy(snapshot(), PROVENANCE);
    expect(document.metadata).toEqual({ name: "Frozen name" });
    expect(document.actors?.map((actor) => actor.name)).toEqual([
      "Ro Khanna",
      "Nancy Pelosi",
      "Tommy Tuberville",
    ]);
  });

  it("embeds a legacy group from the membership the run froze", () => {
    const definition = everyFamilyDefinition();
    const rule = definition.finalExit?.rules[2]?.signal.conditions[0];
    if (rule?.metric.kind !== "CONGRESS_ACTIVITY") {
      throw new Error("fixture drifted");
    }
    rule.metric = {
      ...rule.metric,
      scope: { kind: "GROUP", groupId: "group-uuid" },
    };
    const frozen = snapshot({
      strategy: { ...snapshot().strategy, definition },
      actors: [
        {
          actorId: ACTOR_KHANNA,
          externalId: "K000389",
          displayName: "Ro Khanna",
        },
      ],
      actorGroups: [
        {
          groupId: "group-uuid",
          name: "Watched members",
          members: [
            {
              actorId: ACTOR_TUBERVILLE,
              externalId: "T000278",
              displayName: "Tommy Tuberville",
            },
            {
              actorId: ACTOR_PELOSI,
              externalId: "P000197",
              displayName: "Nancy Pelosi",
            },
          ],
        },
      ],
    });
    const document = serializeSnapshotStrategy(frozen, PROVENANCE);
    expect(
      document.definition.finalExit?.rules[2]?.signal.conditions[0]?.metric,
    ).toMatchObject({
      scope: { kind: "ACTORS", actors: ["P000197", "T000278"] },
    });
    expect(JSON.stringify(document)).not.toContain("group-uuid");
  });

  it("writes an ordinary list's frozen members", () => {
    const document = serializeSnapshotList(snapshot(), PROVENANCE);
    expect(document.metadata).toEqual({ name: "Frozen list" });
    expect(document.definition.membership).toEqual({
      kind: "members",
      members: [
        {
          security: { symbol: "AAPL", exchange: "NASDAQ" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [{ startDate: "2010-01-04", endDate: null }],
          },
        },
        {
          security: { symbol: "MSFT", exchange: "NASDAQ" },
          buyWindow: { mode: "FULL" },
        },
      ],
    });
  });

  it("pins a point-in-time universe to the membership the run froze, and reconstructs it from the snapshot", () => {
    const frozen = snapshot({
      stockList: {
        stockListId: "pit-uuid",
        name: "S&P 500 — Historical PIT",
        universe: {
          kind: "POINT_IN_TIME_INDEX",
          indexKey: "SP500",
          peakSimultaneousMembers: 1,
        },
      },
      securities: [
        {
          securityId: "sec-ge",
          symbol: "GE",
          name: "General Electric",
          exchangeCode: "NYSE",
          currency: "USD",
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "1996-01-02", endDate: "2018-06-25" }],
        },
        {
          securityId: "sec-wba",
          symbol: "WBA",
          name: "Walgreens",
          exchangeCode: "NASDAQ",
          currency: "USD",
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "2018-06-26", endDate: null }],
        },
      ],
    });
    const document = serializeSnapshotList(frozen, PROVENANCE);
    expect(document.definition.membership).toMatchObject({
      kind: "point_in_time_index",
      period: { startDate: "2015-01-02", endDate: "2024-12-31" },
      membership: { securities: 2, windows: 2, peakSimultaneousMembers: 1 },
    });
    expect(JSON.stringify(document)).not.toMatch(/GE|WBA|General Electric/);

    const list = deserializeList(document, {
      resolveSecurity: (security) => `id-${security.symbol}`,
      resolveIndexMembership: snapshotIndexMembershipResolver(frozen),
    });
    expect(list.members.map((member) => member.securityId)).toEqual([
      "id-GE",
      "id-WBA",
    ]);

    // A snapshot whose frozen windows disagree with the universe size it recorded is refused.
    const inconsistent = snapshot({
      ...frozen,
      stockList: {
        ...frozen.stockList,
        universe: {
          kind: "POINT_IN_TIME_INDEX",
          indexKey: "SP500",
          peakSimultaneousMembers: 2,
        },
      },
    });
    expect(() => serializeSnapshotList(inconsistent, PROVENANCE)).toThrow(
      CanonicalDefinitionError,
    );
  });
});
