import { describe, expect, it } from "vitest";
import { CanonicalDefinitionError } from "./issues.js";
import type { MutableJson } from "./fixtures.test-helper.js";
import {
  canonicalMembersDigest,
  deserializeList,
  serializeList,
  type ListMemberInput,
} from "./list-codec.js";
import type { CanonicalListDocument, CanonicalProvenance } from "./types.js";
import { validateDefinition } from "./validate.js";

const BUILT_IN: CanonicalProvenance = {
  origin: "built_in",
  evidence: "system_content",
  builtIn: {
    systemKey: "sp500-historical-pit",
    name: "S&P 500 — Historical PIT",
    premium: true,
  },
};
const CUSTOM: CanonicalProvenance = {
  origin: "custom",
  evidence: "authored_record",
};

const MEMBERS: ListMemberInput[] = [
  {
    security: { symbol: "MSFT", exchange: "NASDAQ" },
    buyWindow: { mode: "FULL", ranges: [] },
  },
  {
    // Out of order, overlapping and adjacent: normalized on the way in.
    security: { symbol: "AAPL", exchange: "NASDAQ" },
    buyWindow: {
      mode: "CUSTOM",
      ranges: [
        { startDate: "2012-05-01", endDate: null },
        { startDate: "2001-03-10", endDate: "2005-01-31" },
        { startDate: "2005-02-01", endDate: "2008-07-15" },
      ],
    },
  },
  {
    security: { symbol: "BRK.B", exchange: "NYSE" },
    buyWindow: {
      mode: "CUSTOM",
      ranges: [{ startDate: "2010-02-16", endDate: "2019-12-31" }],
    },
  },
];

function members(): CanonicalListDocument {
  return serializeList({
    metadata: { name: "Core holdings", description: "My long-term names." },
    provenance: CUSTOM,
    membership: { kind: "members", members: MEMBERS },
  });
}

const SECURITY_IDS = new Map([
  ["AAPL|NASDAQ", "sec-aapl"],
  ["MSFT|NASDAQ", "sec-msft"],
  ["BRK.B|NYSE", "sec-brk"],
]);

function resolveSecurity(security: {
  symbol: string;
  exchange: string;
}): string | undefined {
  return SECURITY_IDS.get(`${security.symbol}|${security.exchange}`);
}

/** A reconstructed index universe of the size the S&P 500 PIT List holds: 735 members, 761 periods. */
function indexMembers(): ListMemberInput[] {
  const result: ListMemberInput[] = [];
  for (let index = 0; index < 735; index += 1) {
    const symbol = `S${String(index).padStart(4, "0")}`;
    const year = 1996 + (index % 28);
    const ranges =
      index < 26
        ? [
            { startDate: `${year}-03-01`, endDate: `${year + 1}-06-30` },
            { startDate: `${year + 2}-01-02`, endDate: null },
          ]
        : [
            {
              startDate: `${year}-01-02`,
              endDate: index % 3 === 0 ? null : `${year + 3}-12-31`,
            },
          ];
    result.push({
      security: { symbol, exchange: index % 2 ? "NYSE" : "NASDAQ" },
      buyWindow: { mode: "CUSTOM", ranges },
    });
  }
  return result;
}

function pit(
  membersInput: readonly ListMemberInput[] = indexMembers(),
): CanonicalListDocument {
  return serializeList({
    metadata: { name: "S&P 500 — Historical PIT" },
    provenance: BUILT_IN,
    membership: {
      kind: "point_in_time_index",
      index: "SP500",
      period: { startDate: "2000-01-03", endDate: "2020-12-31" },
      members: membersInput,
    },
  });
}

function codesOf(error: unknown): string[] {
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

describe("serializeList", () => {
  it("writes members by symbol and exchange, sorted, with canonical windows", () => {
    const document = members();
    expect(validateDefinition(document).valid).toBe(true);
    expect(document.metadata).toEqual({
      name: "Core holdings",
      description: "My long-term names.",
    });
    expect(document.definition.membership).toEqual({
      kind: "members",
      members: [
        {
          security: { symbol: "AAPL", exchange: "NASDAQ" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [
              { startDate: "2001-03-10", endDate: "2008-07-15" },
              { startDate: "2012-05-01", endDate: null },
            ],
          },
        },
        {
          security: { symbol: "BRK.B", exchange: "NYSE" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [{ startDate: "2010-02-16", endDate: "2019-12-31" }],
          },
        },
        {
          security: { symbol: "MSFT", exchange: "NASDAQ" },
          buyWindow: { mode: "FULL" },
        },
      ],
    });
  });

  it("is deterministic whatever order the members arrive in", () => {
    const reversed = serializeList({
      metadata: { name: "Core holdings", description: "My long-term names." },
      provenance: CUSTOM,
      membership: { kind: "members", members: [...MEMBERS].reverse() },
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(members()));
  });

  it("refuses a duplicated security and an invalid window instead of merging or dropping them", () => {
    expect(
      codesOf(
        thrown(() =>
          serializeList({
            metadata: { name: "Dupes" },
            provenance: CUSTOM,
            membership: {
              kind: "members",
              members: [
                MEMBERS[0] as ListMemberInput,
                MEMBERS[0] as ListMemberInput,
              ],
            },
          }),
        ),
      ),
    ).toEqual(["SECURITY_DUPLICATE"]);
    expect(
      codesOf(
        thrown(() =>
          serializeList({
            metadata: { name: "Bad" },
            provenance: CUSTOM,
            membership: {
              kind: "members",
              members: [
                {
                  security: { symbol: "X", exchange: "NYSE" },
                  buyWindow: {
                    mode: "CUSTOM",
                    ranges: [{ startDate: "2020-02-31", endDate: null }],
                  },
                },
                {
                  security: { symbol: "Y", exchange: "NYSE" },
                  buyWindow: {
                    mode: "FULL",
                    ranges: [{ startDate: "2020-01-02", endDate: null }],
                  },
                },
              ],
            },
          }),
        ),
      ),
    ).toEqual(["BUY_WINDOW_INVALID", "BUY_WINDOW_INVALID"]);
  });
});

describe("deserializeList", () => {
  it("round-trips List → JSON → List with every window intact", () => {
    const list = deserializeList(members(), { resolveSecurity });
    expect(list.name).toBe("Core holdings");
    expect(list.description).toBe("My long-term names.");
    expect(list.members).toEqual([
      {
        securityId: "sec-aapl",
        security: { symbol: "AAPL", exchange: "NASDAQ" },
        buyWindow: {
          mode: "CUSTOM",
          ranges: [
            { startDate: "2001-03-10", endDate: "2008-07-15" },
            { startDate: "2012-05-01", endDate: null },
          ],
        },
      },
      {
        securityId: "sec-brk",
        security: { symbol: "BRK.B", exchange: "NYSE" },
        buyWindow: {
          mode: "CUSTOM",
          ranges: [{ startDate: "2010-02-16", endDate: "2019-12-31" }],
        },
      },
      {
        securityId: "sec-msft",
        security: { symbol: "MSFT", exchange: "NASDAQ" },
        buyWindow: { mode: "FULL", ranges: [] },
      },
    ]);
    const again = serializeList({
      metadata: { name: list.name, description: list.description },
      provenance: list.provenance,
      membership: { kind: "members", members: list.members },
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(members()));
  });

  it("refuses every security this database cannot resolve, naming each", () => {
    const error = thrown(() =>
      deserializeList(members(), {
        resolveSecurity: (security) =>
          security.symbol === "MSFT" ? "sec-msft" : undefined,
      }),
    ) as CanonicalDefinitionError;
    expect(error.issues.map((issue) => issue.code)).toEqual([
      "SECURITY_UNRESOLVED",
      "SECURITY_UNRESOLVED",
    ]);
    expect(error.issues.map((issue) => issue.message).join(" ")).toContain(
      "AAPL on NASDAQ",
    );
  });
});

describe("a point-in-time universe", () => {
  it("is a compact pinned reference, not a copy of its membership", () => {
    const document = pit();
    const membership = document.definition.membership;
    expect(membership).toMatchObject({
      kind: "point_in_time_index",
      index: "SP500",
      universe: "sp500-historical-pit",
      membershipFloor: "1996-01-02",
      period: { startDate: "2000-01-03", endDate: "2020-12-31" },
      membership: { securities: 735, windows: 761 },
    });
    if (membership.kind !== "point_in_time_index") {
      throw new Error("expected a reference");
    }
    expect(membership.membership.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(membership.membership.peakSimultaneousMembers).toBeGreaterThan(0);
    expect(membership.membership.peakSimultaneousMembers).toBeLessThanOrEqual(
      735,
    );
    // About half a kilobyte, against roughly 60 KB for the same membership written out.
    const bytes = JSON.stringify(document).length;
    expect(bytes).toBeLessThan(1_000);
    const inline = JSON.stringify(
      serializeList({
        metadata: { name: "copy" },
        provenance: CUSTOM,
        membership: { kind: "members", members: indexMembers() },
      }),
    ).length;
    expect(inline).toBeGreaterThan(50 * bytes);
    expect(validateDefinition(document).valid).toBe(true);
  });

  it("pins the exact membership: the same members always digest the same, any change does not", () => {
    const digest = (input: readonly ListMemberInput[]) => {
      const membership = pit(input).definition.membership;
      return membership.kind === "point_in_time_index"
        ? membership.membership.digest
        : "";
    };
    const base = indexMembers();
    expect(digest([...base].reverse())).toBe(digest(base));
    const shifted = indexMembers();
    const first = shifted[0] as ListMemberInput;
    shifted[0] = {
      ...first,
      buyWindow: {
        mode: "CUSTOM",
        ranges: [
          { startDate: "1996-03-02", endDate: "1997-06-30" },
          { startDate: "1998-01-02", endDate: null },
        ],
      },
    };
    expect(digest(shifted)).not.toBe(digest(base));
    expect(digest(base.slice(1))).not.toBe(digest(base));
  });

  it("reconstructs only from a source holding the pinned membership", () => {
    const document = pit();
    const list = deserializeList(document, {
      resolveSecurity: (security) => `id-${security.symbol}`,
      resolveIndexMembership: () => indexMembers(),
    });
    expect(list.members).toHaveLength(735);
    expect(list.universe).toMatchObject({
      index: "SP500",
      universe: "sp500-historical-pit",
    });
    expect(list.members[0]?.buyWindow.mode).toBe("CUSTOM");
  });

  it("refuses to reconstruct when no source can supply the pinned membership", () => {
    expect(
      codesOf(
        thrown(() => deserializeList(pit(), { resolveSecurity: () => "id" })),
      ),
    ).toEqual(["INDEX_MEMBERSHIP_UNAVAILABLE"]);
    expect(
      codesOf(
        thrown(() =>
          deserializeList(pit(), {
            resolveSecurity: () => "id",
            resolveIndexMembership: () => undefined,
          }),
        ),
      ),
    ).toEqual(["INDEX_MEMBERSHIP_UNAVAILABLE"]);
  });

  it("never resolves to today's constituents or a moved projection", () => {
    // Today's constituents: the same securities, each eligible on every date.
    const today = indexMembers().map((member) => ({
      ...member,
      buyWindow: { mode: "FULL" as const, ranges: [] },
    }));
    const corrected = indexMembers().slice(0, 734);
    for (const source of [today, corrected]) {
      expect(
        codesOf(
          thrown(() =>
            deserializeList(pit(), {
              resolveSecurity: () => "id",
              resolveIndexMembership: () => source,
            }),
          ),
        ),
      ).toEqual(["INDEX_MEMBERSHIP_MISMATCH"]);
    }
  });

  it("refuses an index no universe is defined for, and a reference that misnames its universe", () => {
    expect(
      codesOf(
        thrown(() =>
          serializeList({
            metadata: { name: "Nasdaq PIT" },
            provenance: CUSTOM,
            membership: {
              kind: "point_in_time_index",
              index: "NDX",
              members: [],
            },
          }),
        ),
      ),
    ).toEqual(["INDEX_UNIVERSE_UNSUPPORTED"]);
    const document = JSON.parse(JSON.stringify(pit()));
    document.definition.membership.universe = "nasdaq-historical-pit";
    document.definition.membership.membership.digest = "md5:abc";
    const result = validateDefinition(document);
    expect(
      result.valid ? [] : result.issues.map((issue) => issue.code),
    ).toEqual(["INDEX_UNIVERSE_UNSUPPORTED", "SHAPE_INVALID"]);
  });

  it("digests a membership from its canonical form", () => {
    const document = members();
    if (document.definition.membership.kind !== "members") {
      throw new Error("expected members");
    }
    expect(canonicalMembersDigest(document.definition.membership.members)).toBe(
      canonicalMembersDigest(
        JSON.parse(JSON.stringify(document.definition.membership.members)),
      ),
    );
  });
});

describe("validating a canonical list", () => {
  function mutated(change: (document: MutableJson) => void): string[] {
    const document = JSON.parse(JSON.stringify(members())) as MutableJson;
    change(document);
    const result = validateDefinition(document);
    return result.valid ? [] : result.issues.map((issue) => issue.code);
  }

  it("requires windows already in canonical form", () => {
    expect(
      mutated((document) =>
        document.definition.membership.members[0].buyWindow.ranges.reverse(),
      ),
    ).toEqual(["BUY_WINDOW_NOT_CANONICAL"]);
    expect(
      mutated(
        (document) =>
          (document.definition.membership.members[1].buyWindow.ranges = [
            { startDate: "2010-02-16", endDate: "2012-01-01" },
            { startDate: "2012-01-02", endDate: "2019-12-31" },
          ]),
      ),
    ).toEqual(["BUY_WINDOW_NOT_CANONICAL"]);
    expect(
      mutated(
        (document) =>
          (document.definition.membership.members[2].buyWindow.ranges = []),
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
    expect(
      mutated(
        (document) =>
          (document.definition.membership.members[1].buyWindow.ranges =
            Array.from({ length: 101 }, (_, index) => ({
              startDate: `${1900 + index}-01-01`,
              endDate: `${1900 + index}-06-30`,
            }))),
      ),
    ).toEqual(["BUY_WINDOW_INVALID"]);
  });

  it("requires members sorted, each once, by a portable reference", () => {
    expect(
      mutated((document) => document.definition.membership.members.reverse()),
    ).toEqual(["MEMBERS_NOT_CANONICAL", "MEMBERS_NOT_CANONICAL"]);
    expect(
      mutated((document) =>
        document.definition.membership.members.push(
          document.definition.membership.members[2],
        ),
      ),
    ).toEqual(["SECURITY_DUPLICATE"]);
    expect(
      mutated(
        (document) =>
          (document.definition.membership.members[0].security.securityId =
            "uuid"),
      ),
    ).toEqual(["UNKNOWN_FIELD"]);
    expect(
      mutated(
        (document) =>
          (document.definition.membership.members[0].security.symbol = ""),
      ),
    ).toEqual(["SECURITY_INVALID"]);
  });

  it("refuses a strategy-only provenance version on a list", () => {
    expect(
      mutated(
        (document) =>
          (document.provenance = {
            origin: "derived",
            evidence: "copy_record",
            derivedFrom: {
              systemKey: "sp500-growth-leaders",
              name: "S&P 500 Growth Leaders",
              version: 2,
            },
          }),
      ),
    ).toEqual(["PROVENANCE_INVALID"]);
  });
});
