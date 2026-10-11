import {
  FmpProviderError,
  FmpTransientError,
  type FmpCongressMemberDirectoryPort,
  type FmpCongressMemberPage,
  type MappedFmpCongressMember,
} from "@intrinsic/fmp";
import { describe, expect, it } from "vitest";
import {
  CanonicalCongressMemberCatalogService,
  CONGRESS_MEMBER_DIRECTORY_MAX_PAGES,
  planCongressMemberCatalog,
  type CongressMemberCatalogChanges,
  type CongressMemberCatalogIdentity,
  type CongressMemberCatalogStore,
  type CongressMemberCatalogSyncState,
  type CongressMemberCatalogSyncSummary,
} from "./congress-member-catalog.js";

/**
 * The member catalog's synchronization, with a scripted directory and an in-memory catalog.
 *
 * What is proven here is the decision logic: how the directory is walked, what a run refuses, what
 * one whole directory changes, and that a refused run changes nothing. The same behaviour against
 * PostgreSQL — canonical ids, the claim, the guarded label write — is
 * `congress-member-catalog.integration.test.ts`.
 */

function member(
  externalId: string,
  overrides: Partial<MappedFmpCongressMember> = {},
): MappedFmpCongressMember {
  return {
    externalId,
    name: `Member ${externalId}`,
    chamber: "HOUSE",
    positionRaw: "Representative",
    state: "CA",
    inOffice: true,
    ...overrides,
  };
}

const former = (
  externalId: string,
  overrides: Partial<MappedFmpCongressMember> = {},
): MappedFmpCongressMember =>
  member(externalId, { inOffice: false, ...overrides });

/** `count` in-office members with sequential bioguide-shaped ids. */
function members(count: number, letter = "A"): MappedFmpCongressMember[] {
  return Array.from({ length: count }, (_, index) =>
    member(`${letter}${String(index + 1).padStart(6, "0")}`),
  );
}

type Page = MappedFmpCongressMember[] | Error;

/**
 * A directory that answers from scripted pages, in office and former separately. A page past the
 * end of a script is the empty page the real endpoint returns there.
 */
class ScriptedDirectory implements FmpCongressMemberDirectoryPort {
  readonly requests: { inOffice: boolean; page: number }[] = [];
  /** Rows the payload "carried" for a page, when that differs from the rows that were mapped. */
  providerRowCounts = new Map<string, number>();

  constructor(
    public inOffice: Page[],
    public former: Page[],
  ) {}

  async getCongressMemberProfiles(input: {
    inOffice: boolean;
    page: number;
  }): Promise<FmpCongressMemberPage> {
    this.requests.push(input);
    const page = (input.inOffice ? this.inOffice : this.former)[input.page];
    if (page instanceof Error) {
      throw page;
    }
    const rows = page ?? [];
    return {
      providerRowCount:
        this.providerRowCounts.get(`${input.inOffice}:${input.page}`) ??
        rows.length,
      rows,
    };
  }
}

/** The catalog and its state row, in memory, with the store's own guarantees. */
class MemoryCatalog implements CongressMemberCatalogStore {
  identities = new Map<
    string,
    CongressMemberCatalogIdentity & { id: string }
  >();
  claimedBy: string | null = null;
  leaseExpiresAt: number | null = null;
  runSequence = 0;
  lastCompletedAt: string | null = null;
  lastFailedAt: string | null = null;
  lastError: string | null = null;
  consecutiveFailures = 0;
  lastSummary: CongressMemberCatalogSyncSummary | null = null;
  writes = 0;
  failWrites = false;
  private nextId = 1;

  seed(
    identity: Partial<CongressMemberCatalogIdentity> & { externalId: string },
  ) {
    this.identities.set(identity.externalId, {
      id: `uuid-${this.nextId++}`,
      displayName: `Member ${identity.externalId}`,
      profileName: null,
      chamber: "HOUSE",
      state: "CA",
      hasDisclosures: false,
      ...identity,
    });
  }

  snapshot(): string {
    return JSON.stringify([...this.identities.values()]);
  }

  async getCatalogSyncState(
    now: Date,
  ): Promise<CongressMemberCatalogSyncState | null> {
    if (this.runSequence === 0) {
      return null;
    }
    return {
      running:
        this.claimedBy !== null &&
        this.leaseExpiresAt !== null &&
        this.leaseExpiresAt >= now.getTime(),
      runSequence: this.runSequence,
      lastStartedAt: null,
      lastCompletedAt: this.lastCompletedAt,
      lastFailedAt: this.lastFailedAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
    };
  }

  async claimCatalogSync(input: { owner: string; now: Date; leaseMs: number }) {
    if (
      this.leaseExpiresAt !== null &&
      this.leaseExpiresAt >= input.now.getTime()
    ) {
      return null;
    }
    this.claimedBy = input.owner;
    this.leaseExpiresAt = input.now.getTime() + input.leaseMs;
    this.runSequence += 1;
    return { runSequence: this.runSequence };
  }

  async renewCatalogSyncClaim(input: {
    owner: string;
    now: Date;
    leaseMs: number;
  }) {
    if (
      this.claimedBy !== input.owner ||
      this.leaseExpiresAt === null ||
      this.leaseExpiresAt < input.now.getTime()
    ) {
      return false;
    }
    this.leaseExpiresAt = input.now.getTime() + input.leaseMs;
    return true;
  }

  async completeCatalogSync(input: {
    owner: string;
    now: Date;
    summary: CongressMemberCatalogSyncSummary;
  }) {
    if (this.claimedBy !== input.owner) {
      return false;
    }
    this.claimedBy = null;
    this.leaseExpiresAt = null;
    this.lastCompletedAt = input.now.toISOString();
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSummary = input.summary;
    return true;
  }

  async failCatalogSync(input: { owner: string; now: Date; error: string }) {
    if (this.claimedBy !== input.owner) {
      return false;
    }
    this.claimedBy = null;
    this.leaseExpiresAt = null;
    this.lastFailedAt = input.now.toISOString();
    this.consecutiveFailures += 1;
    this.lastError = input.error;
    return true;
  }

  async readCatalogIdentities() {
    return [...this.identities.values()].map(({ id: _id, ...identity }) => ({
      ...identity,
    }));
  }

  async applyCatalogChanges(changes: CongressMemberCatalogChanges) {
    if (this.failWrites) {
      throw new Error("connection reset");
    }
    this.writes += 1;
    let created = 0;
    let updated = 0;
    let relabelled = 0;
    for (const entry of changes.create) {
      if (this.identities.has(entry.externalId)) {
        continue;
      }
      this.identities.set(entry.externalId, {
        id: `uuid-${this.nextId++}`,
        externalId: entry.externalId,
        displayName: entry.displayName,
        profileName: entry.profileName,
        chamber: entry.chamber,
        state: entry.state ?? null,
        hasDisclosures: false,
      });
      created += 1;
    }
    for (const entry of changes.update) {
      const identity = this.identities.get(entry.externalId);
      if (!identity) {
        continue;
      }
      let wrote = false;
      if (entry.profileName !== undefined) {
        identity.profileName = entry.profileName;
        wrote = true;
      }
      if (entry.label && !identity.hasDisclosures) {
        Object.assign(identity, entry.label);
        relabelled += 1;
        wrote = true;
      }
      if (wrote) {
        updated += 1;
      }
    }
    return { created, updated, relabelled };
  }
}

function serviceOf(
  catalog: MemoryCatalog,
  directory: FmpCongressMemberDirectoryPort,
  clock: { now: Date } = { now: new Date("2026-10-11T12:00:00.000Z") },
  owner = "test-run",
) {
  return new CanonicalCongressMemberCatalogService(catalog, directory, {
    owner,
    now: () => clock.now,
  });
}

async function completed(
  service: CanonicalCongressMemberCatalogService,
): Promise<CongressMemberCatalogSyncSummary> {
  const result = await service.sync();
  if (result.outcome !== "COMPLETED") {
    throw new Error(`expected COMPLETED, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

describe("walking the member directory", () => {
  it("fills an empty catalog from both halves, before any disclosure exists", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [
        [
          member("P000197", { name: "Nancy Pelosi" }),
          member("T000278", {
            name: "Tommy Tuberville",
            chamber: "SENATE",
            state: "AL",
          }),
        ],
      ],
      [
        [
          former("C000174", {
            name: "Thomas Richard Carper",
            chamber: "SENATE",
            state: "DE",
          }),
        ],
      ],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({
      received: 3,
      inOffice: 2,
      former: 1,
      created: 3,
      updated: 0,
      unchanged: 0,
      declined: 0,
      retained: 0,
    });
    expect(
      [...catalog.identities.values()].map((identity) => [
        identity.externalId,
        identity.displayName,
        identity.profileName,
        identity.chamber,
        identity.state,
        identity.hasDisclosures,
      ]),
    ).toEqual([
      [
        "C000174",
        "Thomas Richard Carper",
        "Thomas Richard Carper",
        "SENATE",
        "DE",
        false,
      ],
      ["P000197", "Nancy Pelosi", "Nancy Pelosi", "HOUSE", "CA", false],
      [
        "T000278",
        "Tommy Tuberville",
        "Tommy Tuberville",
        "SENATE",
        "AL",
        false,
      ],
    ]);
  });

  it("reads every page of each half and stops at the first empty one", async () => {
    // The shape verified live on 2026-10-11: 500 + 40 in office, 500 + 221 former.
    const catalog = new MemoryCatalog();
    const inOffice = members(540, "A");
    const formerMembers = members(721, "B").map((entry) => ({
      ...entry,
      inOffice: false,
    }));
    const directory = new ScriptedDirectory(
      [inOffice.slice(0, 500), inOffice.slice(500)],
      [formerMembers.slice(0, 500), formerMembers.slice(500)],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(directory.requests).toEqual([
      { inOffice: true, page: 0 },
      { inOffice: true, page: 1 },
      { inOffice: true, page: 2 },
      { inOffice: false, page: 0 },
      { inOffice: false, page: 1 },
      { inOffice: false, page: 2 },
    ]);
    expect(summary).toMatchObject({
      providerRequests: 6,
      received: 1261,
      inOffice: 540,
      former: 721,
      created: 1261,
    });
    expect(catalog.identities.size).toBe(1261);
  });

  it("does not take a short page for the last one, so a lowered page cap truncates nothing", async () => {
    // The provider's page size is a fact about today. Had the walk stopped at "fewer rows than
    // 500", the day the cap became 200 the directory would have been cut to its first page.
    const catalog = new MemoryCatalog();
    const everyone = members(540);
    const directory = new ScriptedDirectory(
      [everyone.slice(0, 200), everyone.slice(200, 400), everyone.slice(400)],
      [[former("B000001")]],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary.inOffice).toBe(540);
    expect(
      directory.requests.filter((request) => request.inOffice),
    ).toHaveLength(4);
  });

  it("continues past a page whose rows carried no identifier", async () => {
    // The payload held rows, the mapper kept none: that is not the end of the directory.
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [[], [member("A000001")]],
      [[former("B000001")]],
    );
    directory.providerRowCounts.set("true:0", 3);

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary.inOffice).toBe(1);
    expect(catalog.identities.has("A000001")).toBe(true);
  });
});

describe("what one directory changes", () => {
  it("keeps the canonical row of a member a disclosure already named, and records the directory's spelling", async () => {
    const catalog = new MemoryCatalog();
    catalog.seed({
      externalId: "C001075",
      displayName: "William Cassidy",
      chamber: "SENATE",
      state: "LA",
      hasDisclosures: true,
    });
    const before = catalog.identities.get("C001075")?.id;
    const directory = new ScriptedDirectory(
      [
        [
          member("C001075", {
            name: "Bill Cassidy",
            chamber: "SENATE",
            state: "LA",
          }),
        ],
      ],
      [[former("B000001")]],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({ created: 1, updated: 1, relabelled: 0 });
    expect(catalog.identities.get("C001075")).toMatchObject({
      id: before,
      // The label stays the disclosures' own; the directory's spelling is kept beside it.
      displayName: "William Cassidy",
      profileName: "Bill Cassidy",
    });
  });

  it("never relabels a member a disclosure has named, even when chamber and state disagree", async () => {
    // Adam Schiff's disclosures are House disclosures; the directory's latest position is Senator.
    const catalog = new MemoryCatalog();
    catalog.seed({
      externalId: "S001150",
      displayName: "Adam B. Schiff",
      chamber: "HOUSE",
      state: "CA",
      hasDisclosures: true,
    });
    const directory = new ScriptedDirectory(
      [
        [
          member("S001150", {
            name: "Adam B. Schiff",
            chamber: "SENATE",
            state: "CA",
          }),
        ],
      ],
      [[former("B000001")]],
    );

    await completed(serviceOf(catalog, directory));

    expect(catalog.identities.get("S001150")).toMatchObject({
      chamber: "HOUSE",
      displayName: "Adam B. Schiff",
      profileName: "Adam B. Schiff",
    });
  });

  it("follows the directory for a member no disclosure has named", async () => {
    const catalog = new MemoryCatalog();
    catalog.seed({
      externalId: "A000001",
      displayName: "Old Spelling",
      profileName: "Old Spelling",
      chamber: "HOUSE",
      state: "CA",
    });
    const before = catalog.identities.get("A000001")?.id;
    const directory = new ScriptedDirectory(
      [
        [
          member("A000001", {
            name: "New Spelling",
            chamber: "SENATE",
            state: "NV",
          }),
        ],
      ],
      [[former("B000001")]],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({ updated: 1, relabelled: 1 });
    expect(catalog.identities.get("A000001")).toMatchObject({
      id: before,
      displayName: "New Spelling",
      profileName: "New Spelling",
      chamber: "SENATE",
      state: "NV",
    });
  });

  it("changes nothing on a second run over the same directory", async () => {
    const catalog = new MemoryCatalog();
    catalog.seed({
      externalId: "C001075",
      displayName: "William Cassidy",
      hasDisclosures: true,
    });
    const pages = (): ScriptedDirectory =>
      new ScriptedDirectory(
        [[member("C001075", { name: "Bill Cassidy" }), member("A000001")]],
        [[former("B000001")]],
      );

    const first = await completed(serviceOf(catalog, pages()));
    const afterFirst = catalog.snapshot();
    const second = await completed(serviceOf(catalog, pages()));

    expect(first).toMatchObject({ created: 2, updated: 1, unchanged: 0 });
    expect(second).toMatchObject({
      received: 3,
      created: 0,
      updated: 0,
      relabelled: 0,
      unchanged: 3,
    });
    expect(catalog.snapshot()).toBe(afterFirst);
    expect(catalog.identities.size).toBe(3);
  });

  it("keeps every member the directory no longer lists", async () => {
    const catalog = new MemoryCatalog();
    const first = new ScriptedDirectory(
      [[member("A000001"), member("A000002")]],
      [[former("B000001")]],
    );
    await completed(serviceOf(catalog, first));
    const retiredId = catalog.identities.get("A000002")?.id;

    // A000002 is gone from both halves; a member from disclosures was never in either.
    catalog.seed({ externalId: "Z000009", hasDisclosures: true });
    const second = new ScriptedDirectory(
      [[member("A000001")]],
      [[former("B000001")]],
    );
    const summary = await completed(serviceOf(catalog, second));

    expect(summary).toMatchObject({ received: 2, retained: 2, created: 0 });
    expect(catalog.identities.get("A000002")?.id).toBe(retiredId);
    expect(catalog.identities.has("Z000009")).toBe(true);
    expect(catalog.identities.size).toBe(4);
  });

  it("moves a member who left office without touching their identity", async () => {
    const catalog = new MemoryCatalog();
    await completed(
      serviceOf(
        catalog,
        new ScriptedDirectory(
          [[member("A000001"), member("A000002")]],
          [[former("B000001")]],
        ),
      ),
    );
    const id = catalog.identities.get("A000002")?.id;

    const summary = await completed(
      serviceOf(
        catalog,
        new ScriptedDirectory(
          [[member("A000001")]],
          [[former("B000001"), former("A000002")]],
        ),
      ),
    );

    expect(summary).toMatchObject({
      inOffice: 1,
      former: 2,
      unchanged: 3,
      retained: 0,
    });
    expect(catalog.identities.get("A000002")?.id).toBe(id);
  });

  it("counts every identity the directory held exactly once", async () => {
    const catalog = new MemoryCatalog();
    catalog.seed({ externalId: "A000001", hasDisclosures: true });
    catalog.seed({ externalId: "A000002", profileName: "Member A000002" });
    const directory = new ScriptedDirectory(
      [
        [
          member("A000001", { name: "Directory Spelling" }),
          member("A000002"),
          member("A000003"),
          member("not-a-bioguide"),
          member("A000004", { name: undefined }),
        ],
      ],
      [
        [
          former("V000137", {
            chamber: undefined,
            positionRaw: "Vice President",
            state: "US",
          }),
        ],
      ],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({
      received: 6,
      created: 1,
      updated: 1,
      unchanged: 1,
      declined: 3,
    });
    expect(
      summary.created + summary.updated + summary.unchanged + summary.declined,
    ).toBe(summary.received);
  });
});

describe("what a run declines", () => {
  it("makes no identity from an identifier that is not a bioguide id", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [
        [
          member("A000001"),
          member("Nancy Pelosi"),
          member("p000197"),
          member("12345"),
        ],
      ],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: {
        created: 2,
        declined: 3,
        declinedByReason: { MALFORMED_ID: 3 },
      },
    });
    expect([...catalog.identities.keys()].sort()).toEqual([
      "A000001",
      "B000001",
    ]);
  });

  it("declines a new member whose latest position is not a seat in Congress, and says which", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [
        [
          member("A000001"),
          member("V000137", {
            name: "James David Vance",
            chamber: undefined,
            positionRaw: "Vice President",
            state: "US",
          }),
        ],
      ],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { declinedByReason: { NO_CHAMBER: 1 } },
      declined: [
        {
          externalId: "V000137",
          reason: "NO_CHAMBER",
          position: "Vice President",
        },
      ],
    });
    expect(catalog.identities.has("V000137")).toBe(false);
  });

  it("keeps such a member where their disclosures filed them, and still records the spelling", async () => {
    const catalog = new MemoryCatalog();
    catalog.seed({
      externalId: "V000137",
      displayName: "JD Vance",
      chamber: "SENATE",
      state: "OH",
      hasDisclosures: true,
    });
    const directory = new ScriptedDirectory(
      [
        [
          member("V000137", {
            name: "James David Vance",
            chamber: undefined,
            positionRaw: "Vice President",
            state: "US",
          }),
        ],
      ],
      [[former("B000001")]],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({ updated: 1, relabelled: 0, declined: 0 });
    expect(catalog.identities.get("V000137")).toMatchObject({
      displayName: "JD Vance",
      profileName: "James David Vance",
      chamber: "SENATE",
      state: "OH",
    });
  });

  it("writes neither version of an identifier the directory lists twice in disagreement", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [
        [member("A000001"), member("A000002", { name: "One Spelling" })],
        [member("A000002", { name: "Another Spelling" }), member("A000003")],
      ],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { received: 4, declinedByReason: { CONFLICTING_ROWS: 1 } },
    });
    expect(catalog.identities.has("A000002")).toBe(false);
  });

  it("declines a member listed as both in office and former rather than choosing", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [[member("A000001"), member("A000002")]],
      [[former("B000001"), former("A000002")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { declinedByReason: { CONFLICTING_ROWS: 1 } },
    });
    expect(catalog.identities.has("A000002")).toBe(false);
  });

  it("counts a row the directory repeated identically once", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [
        [member("A000001"), member("A000002")],
        [member("A000002"), member("A000003")],
      ],
      [[former("B000001")]],
    );

    const summary = await completed(serviceOf(catalog, directory));

    expect(summary).toMatchObject({ received: 4, created: 4, repeatedRows: 1 });
  });

  it("declines a row with no name instead of labelling a member with their identifier", async () => {
    const catalog = new MemoryCatalog();
    const directory = new ScriptedDirectory(
      [[member("A000001", { name: undefined }), member("A000002")]],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { declinedByReason: { UNNAMED: 1 } },
    });
    expect(catalog.identities.has("A000001")).toBe(false);
  });
});

describe("a run that cannot read the whole directory writes nothing", () => {
  /** A catalog that a complete run has already filled, so "nothing changed" has something to hold. */
  async function synchronized(): Promise<{
    catalog: MemoryCatalog;
    before: string;
    completedAt: string | null;
  }> {
    const catalog = new MemoryCatalog();
    catalog.seed({ externalId: "Z000009", hasDisclosures: true });
    await completed(
      serviceOf(
        catalog,
        new ScriptedDirectory([[member("A000001")]], [[former("B000001")]]),
        { now: new Date("2026-10-01T00:00:00.000Z") },
      ),
    );
    return {
      catalog,
      before: catalog.snapshot(),
      completedAt: catalog.lastCompletedAt,
    };
  }

  it.each([
    [
      "the first page fails",
      () =>
        new ScriptedDirectory(
          [new FmpTransientError(503)],
          [[former("B000001")]],
        ),
      { code: "PROVIDER_UNAVAILABLE", providerRequests: 1 },
    ],
    [
      "a later page of the first half fails",
      () =>
        new ScriptedDirectory(
          [[member("A000001"), member("A000002")], new FmpTransientError(503)],
          [[former("B000001")]],
        ),
      { code: "PROVIDER_UNAVAILABLE", providerRequests: 2 },
    ],
    [
      "the second half fails after the first was read whole",
      () =>
        new ScriptedDirectory(
          [[member("A000001"), member("A000002")]],
          [[former("B000001")], new FmpTransientError(503)],
        ),
      { code: "PROVIDER_UNAVAILABLE", providerRequests: 4 },
    ],
    [
      "the subscription refuses the endpoint",
      // HTTP 402 "Restricted Endpoint" is how this provider refuses a dataset a plan lacks.
      () =>
        new ScriptedDirectory(
          [
            new FmpProviderError(
              "Stock data provider rejected the request",
              402,
            ),
          ],
          [],
        ),
      { code: "PROVIDER_UNAVAILABLE", providerRequests: 1 },
    ],
    [
      "the members in office come back empty",
      () => new ScriptedDirectory([], [[former("B000001")]]),
      { code: "DIRECTORY_EMPTY", providerRequests: 1 },
    ],
    [
      "the former members come back empty",
      () => new ScriptedDirectory([[member("A000001"), member("A000002")]], []),
      { code: "DIRECTORY_EMPTY", providerRequests: 3 },
    ],
    [
      "the provider ignores the filter and answers in-office members for the former half",
      () =>
        new ScriptedDirectory(
          [[member("A000001"), member("A000002")]],
          [[member("A000001"), member("A000002")]],
        ),
      { code: "DIRECTORY_FILTER_NOT_HONOURED", providerRequests: 3 },
    ],
    [
      "a row no longer states whether the member is in office",
      () =>
        new ScriptedDirectory(
          [[member("A000001"), member("A000002", { inOffice: undefined })]],
          [[former("B000001")]],
        ),
      { code: "DIRECTORY_FILTER_NOT_HONOURED", providerRequests: 1 },
    ],
    [
      "the provider ignores the page number and repeats the first page",
      () => {
        const page = [member("A000001"), member("A000002")];
        return new ScriptedDirectory([page, page, page], [[former("B000001")]]);
      },
      { code: "DIRECTORY_PAGING_NOT_ADVANCING", providerRequests: 2 },
    ],
  ] as const)("when %s", async (_name, script, expected) => {
    const { catalog, before, completedAt } = await synchronized();
    const directory = script();

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({ outcome: "FAILED", ...expected });
    // The catalog is exactly what the last complete run left, new members and labels alike.
    expect(catalog.snapshot()).toBe(before);
    expect(catalog.writes).toBe(1);
    // And the state still says when the directory was last whole, beside why this run was not.
    expect(catalog.lastCompletedAt).toBe(completedAt);
    expect(catalog.consecutiveFailures).toBe(1);
    expect(catalog.lastError).toContain(expected.code);
    expect(catalog.claimedBy).toBeNull();
  });

  it("stops at the page bound instead of asking a directory that never ends forever", async () => {
    const { catalog, before } = await synchronized();
    const endless: FmpCongressMemberDirectoryPort = {
      getCongressMemberProfiles: async ({ page }) => ({
        providerRowCount: 1,
        rows: [member(`A${String(page + 1).padStart(6, "0")}`)],
      }),
    };

    const result = await serviceOf(catalog, endless).sync();

    expect(result).toMatchObject({
      outcome: "FAILED",
      code: "DIRECTORY_TOO_LARGE",
      providerRequests: CONGRESS_MEMBER_DIRECTORY_MAX_PAGES,
    });
    expect(catalog.snapshot()).toBe(before);
  });

  it("stores why it failed without a provider payload or a credential", async () => {
    const { catalog } = await synchronized();
    const directory = new ScriptedDirectory(
      [
        new FmpTransientError(503, {
          cause: new Error("apikey=super-secret body={...}"),
        }),
      ],
      [],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(catalog.lastError).toBe(
      "PROVIDER_UNAVAILABLE: FmpTransientError (HTTP 503): Stock data provider is temporarily unavailable",
    );
    expect(JSON.stringify({ ...result, cause: undefined })).not.toContain(
      "super-secret",
    );
    // The original error is handed to the caller's logger, and only there.
    expect(result).toHaveProperty("cause");
  });

  it("reports a failed write as a failed run and leaves the catalog as it was", async () => {
    const { catalog, before, completedAt } = await synchronized();
    catalog.failWrites = true;
    const directory = new ScriptedDirectory(
      [[member("A000001"), member("A000002")]],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory).sync();

    expect(result).toMatchObject({ outcome: "FAILED", code: "WRITE_FAILED" });
    expect(catalog.snapshot()).toBe(before);
    expect(catalog.lastCompletedAt).toBe(completedAt);
  });

  it("recovers on the next run: a complete one clears the failure", async () => {
    const { catalog } = await synchronized();
    await serviceOf(
      catalog,
      new ScriptedDirectory([new FmpTransientError(503)], []),
    ).sync();
    expect(catalog.consecutiveFailures).toBe(1);

    const summary = await completed(
      serviceOf(
        catalog,
        new ScriptedDirectory(
          [[member("A000001"), member("A000002")]],
          [[former("B000001")]],
        ),
        { now: new Date("2026-10-12T00:00:00.000Z") },
      ),
    );

    expect(summary.created).toBe(1);
    expect(catalog.consecutiveFailures).toBe(0);
    expect(catalog.lastError).toBeNull();
    expect(catalog.lastCompletedAt).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("one run at a time", () => {
  it("refuses to start beside a run that holds the claim, without asking the provider", async () => {
    const catalog = new MemoryCatalog();
    const clock = { now: new Date("2026-10-11T12:00:00.000Z") };
    let second:
      | Awaited<ReturnType<CanonicalCongressMemberCatalogService["sync"]>>
      | undefined;
    const secondDirectory = new ScriptedDirectory(
      [[member("A000009")]],
      [[former("B000009")]],
    );
    // The first run is mid-read when the second one starts.
    const firstDirectory: FmpCongressMemberDirectoryPort = {
      getCongressMemberProfiles: async ({ inOffice, page }) => {
        if (inOffice && page === 0) {
          second = await serviceOf(
            catalog,
            secondDirectory,
            clock,
            "second",
          ).sync();
        }
        const rows =
          page > 0 ? [] : [inOffice ? member("A000001") : former("B000001")];
        return { providerRowCount: rows.length, rows };
      },
    };

    const first = await serviceOf(
      catalog,
      firstDirectory,
      clock,
      "first",
    ).sync();

    expect(second).toEqual({ outcome: "ALREADY_RUNNING" });
    expect(secondDirectory.requests).toHaveLength(0);
    expect(first.outcome).toBe("COMPLETED");
    expect([...catalog.identities.keys()].sort()).toEqual([
      "A000001",
      "B000001",
    ]);
    expect(catalog.runSequence).toBe(1);
  });

  it("lets the next run start once a dead run's lease has expired", async () => {
    const catalog = new MemoryCatalog();
    const clock = { now: new Date("2026-10-11T12:00:00.000Z") };
    // A run claimed and then died: no completion, no failure.
    await catalog.claimCatalogSync({
      owner: "dead",
      now: clock.now,
      leaseMs: 600_000,
    });
    const directory = (): ScriptedDirectory =>
      new ScriptedDirectory([[member("A000001")]], [[former("B000001")]]);

    expect(await serviceOf(catalog, directory(), clock, "next").sync()).toEqual(
      {
        outcome: "ALREADY_RUNNING",
      },
    );
    expect((await catalog.getCatalogSyncState(clock.now))?.running).toBe(true);

    clock.now = new Date("2026-10-11T12:10:01.000Z");
    expect((await catalog.getCatalogSyncState(clock.now))?.running).toBe(false);
    const result = await serviceOf(catalog, directory(), clock, "next").sync();
    expect(result.outcome).toBe("COMPLETED");
  });

  it("writes nothing when its own claim expired while it was reading", async () => {
    const catalog = new MemoryCatalog();
    const clock = { now: new Date("2026-10-11T12:00:00.000Z") };
    const slow: FmpCongressMemberDirectoryPort = {
      getCongressMemberProfiles: async ({ inOffice, page }) => {
        // The provider took longer than the lease, and another run took the claim meanwhile.
        clock.now = new Date(clock.now.getTime() + 6 * 60_000);
        if (!inOffice && page === 1) {
          await catalog.claimCatalogSync({
            owner: "replacement",
            now: clock.now,
            leaseMs: 600_000,
          });
        }
        const rows =
          page > 0 ? [] : [inOffice ? member("A000001") : former("B000001")];
        return { providerRowCount: rows.length, rows };
      },
    };

    const result = await serviceOf(catalog, slow, clock, "slow").sync();

    expect(result).toMatchObject({ outcome: "FAILED", code: "CLAIM_LOST" });
    expect(catalog.identities.size).toBe(0);
    expect(catalog.writes).toBe(0);
    // The replacement's claim is untouched: the slow run released nothing that was not its own.
    expect(catalog.claimedBy).toBe("replacement");
  });
});

describe("a catalog that is fresh enough", () => {
  it("asks the provider nothing inside the window, and synchronizes outside it", async () => {
    const catalog = new MemoryCatalog();
    const clock = { now: new Date("2026-10-11T12:00:00.000Z") };
    const directory = new ScriptedDirectory(
      [[member("A000001")]],
      [[former("B000001")]],
    );
    const service = serviceOf(catalog, directory, clock);
    const week = 7 * 24 * 60 * 60_000;

    // Never synchronized: the window cannot be satisfied, so it runs.
    expect(
      (await service.sync({ unlessCompletedWithinMs: week })).outcome,
    ).toBe("COMPLETED");
    const requests = directory.requests.length;

    clock.now = new Date("2026-10-17T12:00:00.000Z");
    expect(await service.sync({ unlessCompletedWithinMs: week })).toEqual({
      outcome: "UP_TO_DATE",
      lastCompletedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(directory.requests).toHaveLength(requests);
    expect(catalog.runSequence).toBe(1);

    clock.now = new Date("2026-10-18T12:00:01.000Z");
    expect(
      (await service.sync({ unlessCompletedWithinMs: week })).outcome,
    ).toBe("COMPLETED");
    expect(directory.requests.length).toBeGreaterThan(requests);
  });

  it("does not count a failed run as fresh", async () => {
    const catalog = new MemoryCatalog();
    const clock = { now: new Date("2026-10-11T12:00:00.000Z") };
    await serviceOf(
      catalog,
      new ScriptedDirectory([new FmpTransientError(503)], []),
      clock,
    ).sync();
    const directory = new ScriptedDirectory(
      [[member("A000001")]],
      [[former("B000001")]],
    );

    const result = await serviceOf(catalog, directory, clock).sync({
      unlessCompletedWithinMs: 7 * 24 * 60 * 60_000,
    });

    expect(result.outcome).toBe("COMPLETED");
  });
});

describe("planCongressMemberCatalog", () => {
  it("plans in identifier order, whatever order the directory answered in", () => {
    const entry = (externalId: string) =>
      [externalId, { member: member(externalId), conflicting: false }] as const;
    const forward = planCongressMemberCatalog(
      new Map([entry("A000001"), entry("C000003"), entry("B000002")]),
      [],
    );
    const backward = planCongressMemberCatalog(
      new Map([entry("B000002"), entry("C000003"), entry("A000001")]),
      [],
    );
    expect(forward).toEqual(backward);
    expect(forward.changes.create.map((create) => create.externalId)).toEqual([
      "A000001",
      "B000002",
      "C000003",
    ]);
  });

  it("files a new member's state only beside a seat", () => {
    const plan = planCongressMemberCatalog(
      new Map([
        [
          "A000001",
          {
            member: member("A000001", { state: undefined }),
            conflicting: false,
          },
        ],
      ]),
      [],
    );
    expect(plan.changes.create[0]).toEqual({
      externalId: "A000001",
      displayName: "Member A000001",
      profileName: "Member A000001",
      chamber: "HOUSE",
    });
  });
});
