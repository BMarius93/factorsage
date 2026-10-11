import { randomUUID } from "node:crypto";
import type { ActorScope, AlternativeDataMetric } from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import {
  FmpTransientError,
  type FmpCongressMemberDirectoryPort,
  type MappedFmpCongressMember,
  type MappedFmpCongressTrade,
} from "@intrinsic/fmp";
import {
  alternativeDataColumnRequest,
  alternativeDataOperand,
  buildAlternativeDataColumn,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaAlternativeDataStore } from "./alternative-data-prisma-store.js";
import {
  CanonicalAlternativeDataService,
  type AlternativeDataProvider,
} from "./alternative-data-service.js";
import { PrismaCongressMemberCatalogStore } from "./congress-member-catalog-prisma-store.js";
import {
  CanonicalCongressMemberCatalogService,
  type CongressMemberCatalogSyncResult,
  type CongressMemberCatalogSyncSummary,
} from "./congress-member-catalog.js";

useTestDatabase();

/**
 * The member catalog's synchronization against real PostgreSQL.
 *
 * The directory is scripted — the provider's field names are proven against captured live rows in
 * `@intrinsic/fmp`, and the walk and its refusals in `congress-member-catalog.test.ts`. What only a
 * database can prove is here: that a member's canonical id survives, that a second run inserts
 * nobody twice, that a refused run leaves every row as it was, that two runs cannot hold the claim
 * together, and that a synchronization changes nothing a metric reads.
 */
describe("member catalog synchronization", () => {
  const suffix = randomUUID();
  /**
   * Bioguide-shaped identifiers no other suite and no earlier run of this one uses: a letter, a
   * slot digit and five digits drawn for this run.
   */
  const block = String(10_000 + Math.floor(Math.random() * 90_000));
  const id = (slot: number, letter = "Y"): string => `${letter}${slot}${block}`;
  const everyId = [..."XY"].flatMap((letter) =>
    Array.from({ length: 10 }, (_, slot) => id(slot, letter)),
  );
  /** This suite's own state row, so a suite sharing the database never holds its claim. */
  const syncId = `TEST-${suffix}`;
  const symbol = `CMC${suffix.slice(0, 6).toUpperCase()}`;

  let prisma: PrismaClient;
  let actors: PrismaAlternativeDataStore;
  let security: Security;
  const clock = { now: new Date("2026-10-11T12:00:00.000Z") };

  function member(
    slot: number,
    overrides: Partial<MappedFmpCongressMember> = {},
    letter = "Y",
  ): MappedFmpCongressMember {
    return {
      externalId: id(slot, letter),
      name: `Given${slot} Family${block}`,
      chamber: "HOUSE",
      positionRaw: "Representative",
      state: "CA",
      inOffice: true,
      ...overrides,
    };
  }

  type Page = MappedFmpCongressMember[] | Error;

  /** A scripted directory; `onRequest` lets a test act while a run is mid-read. */
  function directoryOf(
    inOffice: Page[],
    former: Page[],
    onRequest?: (request: { inOffice: boolean; page: number }) => Promise<void>,
  ): FmpCongressMemberDirectoryPort & { requests: number } {
    const directory = {
      requests: 0,
      async getCongressMemberProfiles(input: {
        inOffice: boolean;
        page: number;
      }) {
        directory.requests += 1;
        await onRequest?.(input);
        const page = (input.inOffice ? inOffice : former)[input.page];
        if (page instanceof Error) {
          throw page;
        }
        const rows = page ?? [];
        return { providerRowCount: rows.length, rows };
      },
    };
    return directory;
  }

  /** The former half every run needs: the real directory is never without one. */
  const FORMER = (): MappedFmpCongressMember[] => [
    member(9, { inOffice: false, name: `Former Member${block}` }, "X"),
  ];

  function serviceOf(
    directory: FmpCongressMemberDirectoryPort,
    owner = "integration",
    store: PrismaCongressMemberCatalogStore = new PrismaCongressMemberCatalogStore(
      prisma,
      syncId,
    ),
  ): CanonicalCongressMemberCatalogService {
    return new CanonicalCongressMemberCatalogService(store, directory, {
      owner,
      now: () => clock.now,
    });
  }

  async function completed(
    directory: FmpCongressMemberDirectoryPort,
  ): Promise<CongressMemberCatalogSyncSummary> {
    const result = await serviceOf(directory).sync();
    if (result.outcome !== "COMPLETED") {
      throw new Error(`expected COMPLETED, got ${JSON.stringify(result)}`);
    }
    return result.summary;
  }

  const rowOf = (externalId: string) =>
    prisma.alternativeDataActor.findUnique({ where: { externalId } });

  const ownRows = () =>
    prisma.alternativeDataActor.findMany({
      where: { externalId: { in: everyId } },
      orderBy: { externalId: "asc" },
    });

  // --- disclosures, through the ordinary loader -----------------------------------------------

  class DisclosureProvider implements AlternativeDataProvider {
    senate: MappedFmpCongressTrade[] = [];
    house: MappedFmpCongressTrade[] = [];

    async getInsiderTrades() {
      return { providerRowCount: 0, rows: [] };
    }

    async getCongressTrades(input: {
      chamber: "SENATE" | "HOUSE";
      page: number;
    }) {
      const rows =
        input.page > 0
          ? []
          : input.chamber === "SENATE"
            ? this.senate
            : this.house;
      return { providerRowCount: rows.length, rows };
    }
  }

  function disclosure(
    slot: number,
    overrides: Partial<MappedFmpCongressTrade> = {},
  ): MappedFmpCongressTrade {
    return {
      providerSymbol: symbol,
      chamber: "SENATE",
      actorExternalId: id(slot),
      actorDisplayName: `Disclosure Name${slot} ${block}`,
      actorState: "LA",
      transactionDate: "2026-01-15",
      disclosureDate: "2026-03-03",
      availableFromDate: "2026-03-04",
      kind: "PURCHASE",
      transactionTypeRaw: "Purchase",
      owner: "SELF",
      ownerRaw: "Self",
      assetClass: "STOCK",
      assetTypeRaw: "Stock",
      amountRangeRaw: "$15,001 - $50,000",
      amountLowerBound: 15_001,
      amountUpperBound: 50_000,
      raw: { note: "fixture" },
      ...overrides,
    };
  }

  /** Ingests disclosures for this suite's security exactly as a page view or a backtest would. */
  async function ingest(
    rows: readonly MappedFmpCongressTrade[],
    at = new Date("2026-03-20T12:00:00.000Z"),
  ): Promise<CanonicalAlternativeDataService> {
    const provider = new DisclosureProvider();
    provider.senate = rows.filter((row) => row.chamber === "SENATE");
    provider.house = rows.filter((row) => row.chamber === "HOUSE");
    const service = new CanonicalAlternativeDataService(actors, provider, {
      // Always stale, so every call re-reads the scripted pages.
      freshnessMs: 0,
      maxPagesPerIngest: 4,
      now: () => at,
    });
    await service.ensureIngested(security, ["CONGRESS"]);
    return service;
  }

  async function removeFixtures(): Promise<void> {
    await prisma.congressTrade.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.stockDatasetState.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { in: everyId } },
    });
    await prisma.congressMemberCatalogSync.deleteMany({
      where: { id: syncId },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    actors = new PrismaAlternativeDataStore(prisma);
    const row = await prisma.security.create({
      data: {
        providerSymbol: `CMC-${suffix}`,
        symbol,
        name: "Member Catalog Fixture",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    security = {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchangeCode: row.exchangeCode,
      currency: row.currency,
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
    };
  });

  beforeEach(async () => {
    clock.now = new Date("2026-10-11T12:00:00.000Z");
    await removeFixtures();
  });

  afterAll(async () => {
    if (prisma) {
      await removeFixtures();
      await prisma.security.deleteMany({ where: { id: security.id } });
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------------------------

  it("fills the catalog before any disclosure exists, and the picker finds those members", async () => {
    expect(await ownRows()).toHaveLength(0);

    const summary = await completed(
      directoryOf(
        [
          [
            member(1, { name: `Alder Quillfeather${block}` }),
            member(2, {
              name: `Bryn Stonecroft${block}`,
              chamber: "SENATE",
              positionRaw: "Senator",
              state: "NV",
            }),
          ],
        ],
        [FORMER()],
      ),
    );

    expect(summary).toMatchObject({
      providerRequests: 4,
      received: 3,
      inOffice: 2,
      former: 1,
      created: 3,
      updated: 0,
      declined: 0,
    });
    const rows = await ownRows();
    expect(
      rows.map((row) => [
        row.externalId,
        row.displayName,
        row.chamber,
        row.state,
        row.district,
      ]),
    ).toEqual([
      [id(9, "X"), `Former Member${block}`, "HOUSE", "CA", null],
      [id(1), `Alder Quillfeather${block}`, "HOUSE", "CA", null],
      [id(2), `Bryn Stonecroft${block}`, "SENATE", "NV", null],
    ]);
    // Identities only: not one disclosure, and no coverage statement, came with them.
    expect(
      await prisma.congressTrade.count({
        where: { actorId: { in: rows.map((row) => row.id) } },
      }),
    ).toBe(0);

    // Searchable by name with no disclosure loaded for anybody, in office or not.
    const found = await actors.searchActors({
      term: `Quillfeather${block}`,
      limit: 10,
    });
    expect(found.map((actor) => actor.externalId)).toEqual([id(1)]);
    const formerFound = await actors.searchActors({
      term: `Former Member${block}`,
      limit: 10,
    });
    expect(formerFound.map((actor) => actor.externalId)).toEqual([id(9, "X")]);
    // And resolvable by canonical id, which is what a saved selection holds.
    const [alder] = rows.filter((row) => row.externalId === id(1));
    expect(await actors.findActorsByIds([alder!.id])).toEqual([
      {
        id: alder!.id,
        externalId: id(1),
        displayName: `Alder Quillfeather${block}`,
        chamber: "HOUSE",
        state: "CA",
      },
    ]);
  });

  it("writes nothing on a second run: no duplicate, no new id, not even a touched row", async () => {
    const pages = () =>
      directoryOf([[member(1), member(2), member(3)]], [FORMER()]);
    await completed(pages());
    const first = await ownRows();

    clock.now = new Date("2026-10-18T12:00:00.000Z");
    const summary = await completed(pages());

    expect(summary).toMatchObject({
      received: 4,
      created: 0,
      updated: 0,
      relabelled: 0,
      unchanged: 4,
    });
    const second = await ownRows();
    expect(second).toHaveLength(4);
    // Byte for byte, `updatedAt` included: an unchanged member is not written at all.
    expect(second).toEqual(first);
    expect(new Set(second.map((row) => row.externalId)).size).toBe(4);
  });

  it("keeps the canonical id, the label and every disclosure of a member ingestion created", async () => {
    await ingest([
      disclosure(1, { actorDisplayName: `William Cassidy${block}` }),
    ]);
    const before = await rowOf(id(1));
    expect(before).toMatchObject({
      displayName: `William Cassidy${block}`,
      chamber: "SENATE",
      state: "LA",
      profileName: null,
    });
    const tradesBefore = await prisma.congressTrade.findMany({
      where: { securityId: security.id },
    });
    expect(tradesBefore).toHaveLength(1);

    // The directory spells him differently, and files him elsewhere.
    const summary = await completed(
      directoryOf(
        [
          [
            member(1, {
              name: `Bill Cassidy${block}`,
              chamber: "HOUSE",
              positionRaw: "Representative",
              state: "TX",
            }),
            member(2),
          ],
        ],
        [FORMER()],
      ),
    );

    expect(summary).toMatchObject({ created: 2, updated: 1, relabelled: 0 });
    const after = await rowOf(id(1));
    expect(after).toMatchObject({
      id: before!.id,
      externalId: id(1),
      // His disclosures' label, chamber and state: untouched.
      displayName: `William Cassidy${block}`,
      chamber: "SENATE",
      state: "LA",
      firstObservedAt: before!.firstObservedAt,
      // The directory's spelling, kept beside it.
      profileName: `Bill Cassidy${block}`,
    });
    expect(
      await prisma.congressTrade.findMany({
        where: { securityId: security.id },
      }),
    ).toEqual(tradesBefore);
    expect(tradesBefore[0]?.actorId).toBe(before!.id);
  });

  it("keeps a member the directory no longer lists, with the same canonical id", async () => {
    await ingest([disclosure(4)]);
    await completed(directoryOf([[member(1), member(2)]], [FORMER()]));
    const kept = await rowOf(id(2));
    const fromDisclosures = await rowOf(id(4));

    // `2` has left both halves of the directory; `4` was never in either.
    clock.now = new Date("2026-10-18T12:00:00.000Z");
    const summary = await completed(directoryOf([[member(1)]], [FORMER()]));

    expect(summary.created).toBe(0);
    expect(summary.retained).toBeGreaterThanOrEqual(2);
    expect(await rowOf(id(2))).toEqual(kept);
    expect(await rowOf(id(4))).toEqual(fromDisclosures);
    expect(await ownRows()).toHaveLength(4);
  });

  it("leaves every row and the last complete synchronization as they were when a run fails", async () => {
    await completed(directoryOf([[member(1)]], [FORMER()]));
    const store = new PrismaCongressMemberCatalogStore(prisma, syncId);
    const rowsBefore = await ownRows();
    const stateBefore = await store.getCatalogSyncState(clock.now);
    expect(stateBefore).toMatchObject({
      lastCompletedAt: "2026-10-11T12:00:00.000Z",
      lastFailedAt: null,
      consecutiveFailures: 0,
      running: false,
    });

    // The half in office is read whole — with two members the catalog does not hold — and then the
    // former half fails.
    clock.now = new Date("2026-10-12T09:00:00.000Z");
    const directory = directoryOf(
      [[member(1, { name: "A New Spelling" }), member(5), member(6)]],
      [new FmpTransientError(503)],
    );
    const result = await serviceOf(directory).sync();

    expect(result).toMatchObject({
      outcome: "FAILED",
      code: "PROVIDER_UNAVAILABLE",
      providerRequests: 3,
    });
    expect(await ownRows()).toEqual(rowsBefore);
    expect(await rowOf(id(5))).toBeNull();
    expect(await store.getCatalogSyncState(clock.now)).toMatchObject({
      running: false,
      runSequence: 2,
      // Still the last time the directory was whole — not the time of this run.
      lastCompletedAt: "2026-10-11T12:00:00.000Z",
      lastSummary: stateBefore!.lastSummary,
      lastFailedAt: "2026-10-12T09:00:00.000Z",
      consecutiveFailures: 1,
      lastError:
        "PROVIDER_UNAVAILABLE: FmpTransientError (HTTP 503): Stock data provider is temporarily unavailable",
    });

    // The next complete run writes what the failed one could not, and clears the failure.
    clock.now = new Date("2026-10-12T10:00:00.000Z");
    const summary = await completed(
      directoryOf([[member(1), member(5), member(6)]], [FORMER()]),
    );
    expect(summary.created).toBe(2);
    expect(await store.getCatalogSyncState(clock.now)).toMatchObject({
      lastCompletedAt: "2026-10-12T10:00:00.000Z",
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  it("reports nothing synchronized until a run has completed", async () => {
    const store = new PrismaCongressMemberCatalogStore(prisma, syncId);
    // No run has ever started: there is no state at all.
    expect(await store.getCatalogSyncState(clock.now)).toBeNull();

    await serviceOf(directoryOf([new FmpTransientError(503)], [])).sync();

    // A run that failed is not a catalog that is loaded.
    expect(await store.getCatalogSyncState(clock.now)).toMatchObject({
      lastCompletedAt: null,
      lastSummary: null,
      consecutiveFailures: 1,
      running: false,
    });
  });

  it("never runs twice at once: the second run asks the provider nothing", async () => {
    let second: CongressMemberCatalogSyncResult | undefined;
    const secondDirectory = directoryOf([[member(7)]], [FORMER()]);
    const first = directoryOf(
      [[member(1)]],
      [FORMER()],
      async ({ inOffice, page }) => {
        // A second process starts while the first is reading the directory.
        if (inOffice && page === 0) {
          second = await serviceOf(secondDirectory, "second-process").sync();
        }
      },
    );

    const result = await serviceOf(first, "first-process").sync();

    expect(second).toEqual({ outcome: "ALREADY_RUNNING" });
    expect(secondDirectory.requests).toBe(0);
    expect(result.outcome).toBe("COMPLETED");
    expect(await rowOf(id(7))).toBeNull();
    const state = await new PrismaCongressMemberCatalogStore(
      prisma,
      syncId,
    ).getCatalogSyncState(clock.now);
    expect(state).toMatchObject({ runSequence: 1, running: false });
  });

  it("lets a run start once a dead run's lease has expired, and not before", async () => {
    const store = new PrismaCongressMemberCatalogStore(prisma, syncId);
    // A run claimed and its process died: nothing completed it and nothing failed it.
    expect(
      await store.claimCatalogSync({
        owner: "dead-process",
        now: clock.now,
        leaseMs: 10 * 60_000,
      }),
    ).toEqual({ runSequence: 1 });
    expect((await store.getCatalogSyncState(clock.now))?.running).toBe(true);

    clock.now = new Date("2026-10-11T12:09:59.000Z");
    const blocked = directoryOf([[member(1)]], [FORMER()]);
    expect(await serviceOf(blocked).sync()).toEqual({
      outcome: "ALREADY_RUNNING",
    });
    expect(blocked.requests).toBe(0);

    clock.now = new Date("2026-10-11T12:10:01.000Z");
    expect((await store.getCatalogSyncState(clock.now))?.running).toBe(false);
    const result = await serviceOf(
      directoryOf([[member(1)]], [FORMER()]),
    ).sync();
    expect(result).toMatchObject({ outcome: "COMPLETED", runSequence: 2 });
    // The dead process cannot complete or fail the run that replaced it.
    expect(
      await store.failCatalogSync({
        owner: "dead-process",
        now: clock.now,
        error: "late",
      }),
    ).toBe(false);
  });

  it("follows the directory for a member nobody has disclosed for, until a disclosure names them", async () => {
    await completed(
      directoryOf(
        [[member(1, { name: `First Spelling${block}`, state: "CA" })]],
        [FORMER()],
      ),
    );
    const created = await rowOf(id(1));

    // The directory changes its mind about the name, the chamber and the state.
    const summary = await completed(
      directoryOf(
        [
          [
            member(1, {
              name: `Second Spelling${block}`,
              chamber: "SENATE",
              positionRaw: "Senator",
              state: "NV",
            }),
          ],
        ],
        [FORMER()],
      ),
    );
    expect(summary).toMatchObject({ updated: 1, relabelled: 1 });
    expect(await rowOf(id(1))).toMatchObject({
      id: created!.id,
      displayName: `Second Spelling${block}`,
      profileName: `Second Spelling${block}`,
      chamber: "SENATE",
      state: "NV",
    });

    // A disclosure arrives. Ingestion labels the member, exactly as it always has.
    await ingest([
      disclosure(1, {
        chamber: "HOUSE",
        actorDisplayName: `Disclosure Spelling${block}`,
        actorState: "TX",
        actorDistrict: "TX17",
      }),
    ]);
    expect(await rowOf(id(1))).toMatchObject({
      id: created!.id,
      displayName: `Disclosure Spelling${block}`,
      chamber: "HOUSE",
      state: "TX",
      district: "TX17",
    });

    // From here on the directory no longer relabels them; it only keeps its own spelling current.
    const later = await completed(
      directoryOf(
        [
          [
            member(1, {
              name: `Third Spelling${block}`,
              chamber: "SENATE",
              positionRaw: "Senator",
              state: "NV",
            }),
          ],
        ],
        [FORMER()],
      ),
    );
    expect(later).toMatchObject({ updated: 1, relabelled: 0 });
    expect(await rowOf(id(1))).toMatchObject({
      id: created!.id,
      displayName: `Disclosure Spelling${block}`,
      profileName: `Third Spelling${block}`,
      chamber: "HOUSE",
      state: "TX",
      district: "TX17",
    });
  });

  it("lets a disclosure ingested during a run keep the label, even after the run planned to change it", async () => {
    await completed(
      directoryOf(
        [[member(1, { name: `Directory Name${block}` })]],
        [FORMER()],
      ),
    );

    // The run reads the catalog — the member has no disclosure yet, so it plans to relabel them —
    // and a disclosure is ingested before it writes.
    class RacingStore extends PrismaCongressMemberCatalogStore {
      override async readCatalogIdentities() {
        const identities = await super.readCatalogIdentities();
        await ingest([
          disclosure(1, { actorDisplayName: `Disclosure Name${block}` }),
        ]);
        return identities;
      }
    }
    const result = await serviceOf(
      directoryOf(
        [[member(1, { name: `Renamed By Directory${block}`, state: "NV" })]],
        [FORMER()],
      ),
      "racing",
      new RacingStore(prisma, syncId),
    ).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { updated: 1, relabelled: 0 },
    });
    expect(await rowOf(id(1))).toMatchObject({
      displayName: `Disclosure Name${block}`,
      state: "LA",
      profileName: `Renamed By Directory${block}`,
    });
  });

  it("creates nobody a disclosure created first, and keeps the id ingestion gave them", async () => {
    // The mirror race: the catalog is read before the disclosure exists, so the run plans to create
    // the member, and ingestion creates them before it writes.
    class RacingStore extends PrismaCongressMemberCatalogStore {
      override async readCatalogIdentities() {
        const identities = await super.readCatalogIdentities();
        await ingest([disclosure(3)]);
        return identities;
      }
    }
    const result = await serviceOf(
      directoryOf([[member(3), member(2)]], [FORMER()]),
      "racing",
      new RacingStore(prisma, syncId),
    ).sync();

    expect(result).toMatchObject({
      outcome: "COMPLETED",
      summary: { received: 3, created: 2, updated: 0, unchanged: 1 },
    });
    const rows = await prisma.alternativeDataActor.findMany({
      where: { externalId: id(3) },
    });
    expect(rows).toHaveLength(1);
    const [trade] = await prisma.congressTrade.findMany({
      where: { securityId: security.id },
    });
    expect(trade?.actorId).toBe(rows[0]?.id);
  });

  it("finds a member by either of the provider's spellings, and falls back to shared words", async () => {
    await ingest([
      disclosure(1, { actorDisplayName: `William Cassidy${block}` }),
      disclosure(2, { actorDisplayName: `Rafael E Cruz${block}` }),
    ]);
    await completed(
      directoryOf(
        [
          [
            member(1, { name: `Bill Cassidy${block}` }),
            member(2, { name: `Rafael Edward Cruz${block}` }),
          ],
        ],
        [FORMER()],
      ),
    );
    const search = async (term: string): Promise<string[]> =>
      (await actors.searchActors({ term, limit: 10 })).map(
        (actor) => actor.externalId,
      );

    // Either spelling, whole.
    expect(await search(`William Cassidy${block}`)).toEqual([id(1)]);
    expect(await search(`Bill Cassidy${block}`)).toEqual([id(1)]);
    expect(await search(`bill cassidy${block}`)).toEqual([id(1)]);
    // The label is still his disclosures' spelling: an alias finds him, it does not rename him.
    expect(
      (
        await actors.searchActors({ term: `Bill Cassidy${block}`, limit: 10 })
      )[0]?.displayName,
    ).toBe(`William Cassidy${block}`);
    // The directory has no nickname either, so "Ted" is found by the surname, as before.
    expect(await search(`Ted Cruz${block}`)).toEqual([id(2)]);
    // A word only the directory's spelling holds counts for the fallback too.
    expect(await search(`Teddy Edward Cruz${block}`)).toEqual([id(2)]);
    // And the identifier still does.
    expect(await search(id(1))).toEqual([id(1)]);
    // Nobody is invented for a term nothing matches.
    expect(await search(`Nobody Atall${block}`)).toEqual([]);
  });

  it("puts the member who shares the family name ahead of the ones who share only a given name", async () => {
    // What "Ted Cruz" looks like in a whole directory: "ted" is inside one surname and in front of
    // another, both alphabetically ahead of the senator, whose spellings hold neither "Ted".
    await completed(
      directoryOf(
        [
          [
            member(1, { name: `Jon Husted${block}` }),
            member(2, { name: `Ted Aardvark${block}` }),
            member(3, { name: `Rafael Edward Cruz${block}` }),
            member(4, { name: `Monica De La Cruz${block}` }),
          ],
        ],
        [FORMER()],
      ),
    );

    const found = await actors.searchActors({
      term: `Ted Cruz${block}`,
      limit: 10,
    });

    // The two who share the family name, alphabetically; then the two who share only "ted".
    expect(found.map((actor) => actor.displayName)).toEqual([
      `Monica De La Cruz${block}`,
      `Rafael Edward Cruz${block}`,
      `Jon Husted${block}`,
      `Ted Aardvark${block}`,
    ]);
    // A name sharing more of the term still comes before one that shares only its last word.
    const both = await actors.searchActors({
      term: `Jon Ted Husted${block} Nobody`,
      limit: 10,
    });
    expect(both[0]?.displayName).toBe(`Jon Husted${block}`);
  });

  it("changes nothing a metric reads: observations, columns and coverage are identical afterwards", async () => {
    const service = await ingest([
      disclosure(1, {
        transactionDate: "2026-01-15",
        disclosureDate: "2026-03-03",
        availableFromDate: "2026-03-04",
      }),
      disclosure(1, {
        transactionDate: "2026-02-02",
        disclosureDate: "2026-03-05",
        availableFromDate: "2026-03-06",
        kind: "SALE",
        transactionTypeRaw: "Sale",
      }),
      disclosure(2, {
        chamber: "HOUSE",
        actorState: "TX",
        actorDistrict: "TX17",
        disclosureDate: "2026-03-09",
        availableFromDate: "2026-03-10",
      }),
    ]);
    const selected = await rowOf(id(1));
    const dates = [
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-16",
      "2026-03-17",
      "2026-03-18",
      "2026-03-19",
      "2026-03-20",
    ];
    const metricOf = (
      measure: "PURCHASES" | "SALES" | "BUYERS",
      scope: ActorScope,
    ): AlternativeDataMetric => ({
      kind: "CONGRESS_ACTIVITY",
      measure,
      lookback: 5,
      scope,
      chamber: "ANY",
    });
    const read = async (metrics: readonly AlternativeDataMetric[]) => {
      const operands = metrics.map(alternativeDataOperand);
      const facts = await service.loadFacts({
        security,
        operands,
        from: "2026-01-01",
        to: "2026-03-20",
      });
      return metrics.map((metric, index) => {
        const entry = facts.get(operands[index]!) ?? {
          coverage: null,
          observations: [],
        };
        return {
          coverage: entry.coverage,
          observations: entry.observations,
          column: [
            ...buildAlternativeDataColumn({
              dates,
              request: alternativeDataColumnRequest(metric),
              facts: entry,
            }),
          ],
        };
      });
    };
    const metrics = [
      metricOf("PURCHASES", { kind: "ANY" }),
      metricOf("BUYERS", { kind: "ANY" }),
      metricOf("PURCHASES", { kind: "ACTORS", actorIds: [selected!.id] }),
      metricOf("SALES", { kind: "ACTORS", actorIds: [selected!.id] }),
    ];
    const stored = async () => ({
      trades: await prisma.congressTrade.findMany({
        where: { securityId: security.id },
        orderBy: { id: "asc" },
      }),
      coverage: await prisma.stockDatasetState.findMany({
        where: { securityId: security.id },
        orderBy: [{ dataset: "asc" }, { variant: "asc" }],
      }),
    });

    const before = await read(metrics);
    const storedBefore = await stored();
    // Something to hold still: the rule reads real activity, and a real gap in coverage.
    expect(before[2]!.column.some((value) => value > 0)).toBe(true);
    expect(before[2]!.column.some((value) => Number.isNaN(value))).toBe(true);

    // The synchronization: it names the selected member differently and adds two members nobody
    // has disclosed for — one in office, one former.
    const summary = await completed(
      directoryOf(
        [
          [
            member(1, {
              name: `Directory Spelling${block}`,
              chamber: "HOUSE",
              state: "NY",
            }),
            member(5),
          ],
        ],
        [[...FORMER(), member(6, { inOffice: false })]],
      ),
    );
    expect(summary).toMatchObject({ created: 3, updated: 1 });

    expect(await read(metrics)).toEqual(before);
    // Not a disclosure and not a coverage row was written, changed or removed.
    expect(await stored()).toEqual(storedBefore);

    // A member the directory added is an identity with no disclosures. Selecting them beside the
    // member who traded reads exactly as selecting that member alone …
    const added = await rowOf(id(5));
    const formerAdded = await rowOf(id(6));
    const [alone, withAdded, onlyAdded] = await read([
      metricOf("PURCHASES", { kind: "ACTORS", actorIds: [selected!.id] }),
      metricOf("PURCHASES", {
        kind: "ACTORS",
        actorIds: [selected!.id, added!.id, formerAdded!.id].sort(),
      }),
      metricOf("PURCHASES", { kind: "ACTORS", actorIds: [added!.id] }),
    ]);
    expect(withAdded!.column).toEqual(alone!.column);
    expect(withAdded!.observations).toEqual(alone!.observations);
    // … and selecting only them counts nothing where the security's coverage reaches, and is
    // still not evaluable where it does not: being in the catalog vouches for no history.
    expect(onlyAdded!.observations).toEqual([]);
    expect(onlyAdded!.coverage).toEqual(alone!.coverage);
    expect(onlyAdded!.column.map((value) => Number.isNaN(value))).toEqual(
      alone!.column.map((value) => Number.isNaN(value)),
    );
    expect(
      onlyAdded!.column
        .filter((value) => !Number.isNaN(value))
        .every((value) => value === 0),
    ).toBe(true);
  });
});
