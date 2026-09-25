import { randomUUID } from "node:crypto";
import {
  alternativeDataMetricSignature,
  type AlternativeDataMetric,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import type {
  MappedFmpCongressTrade,
  MappedFmpInsiderTrade,
} from "@intrinsic/fmp";
import {
  alternativeDataColumnRequest,
  alternativeDataOperand,
  buildAlternativeDataColumn,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CanonicalAlternativeDataService,
  type AlternativeDataProvider,
} from "./alternative-data-service.js";
import { PrismaAlternativeDataStore } from "./alternative-data-prisma-store.js";

useTestDatabase();

/**
 * Alternative-data ingestion against real PostgreSQL.
 *
 * The provider is a fake, and deliberately so: what this suite proves is everything *downstream* of the
 * wire — that reingesting an unchanged history writes nothing, that a corrected disclosure lands beside
 * the row it supersedes rather than over it, that one actor identity survives a rename, and that
 * coverage bounds the evaluable range honestly. The provider field names themselves are proven against
 * captured live payloads in `@intrinsic/fmp`.
 */
describe("alternative-data ingestion", () => {
  const suffix = randomUUID();
  /** The catalog row's own provider identifier, which is not what these endpoints echo. */
  const providerSymbol = `ALT-${suffix}`;
  const symbol = `ALT${suffix.slice(0, 6).toUpperCase()}`;
  /**
   * The symbol the disclosure endpoints echo back.
   *
   * They are asked with `Security.symbol`, and they answer with the symbol they were asked for — so
   * that, not the catalog's `providerSymbol` column, is what a mapped row carries and what the
   * ingest's binding check compares against.
   */
  const echoedSymbol = symbol;

  let prisma: PrismaClient;
  let store: PrismaAlternativeDataStore;
  let security: Security;

  /**
   * A scripted provider: each domain answers from a page list this suite sets per test.
   *
   * `providerRowCounts` scripts how many rows the *payload* carried, independently of how many
   * survived normalization. They are normally the same and default to the mapped length; a test that
   * sets them apart is reproducing the real endpoint behaviour where a full page contains rows the
   * mapper drops.
   */
  class FakeProvider implements AlternativeDataProvider {
    insiderPages: MappedFmpInsiderTrade[][] = [];
    congressPages: Record<"SENATE" | "HOUSE", MappedFmpCongressTrade[][]> = {
      SENATE: [],
      HOUSE: [],
    };
    insiderProviderRowCounts: (number | undefined)[] = [];
    congressProviderRowCounts: Record<
      "SENATE" | "HOUSE",
      (number | undefined)[]
    > = { SENATE: [], HOUSE: [] };
    insiderRequests = 0;
    congressRequests = 0;

    async getInsiderTrades(input: { page: number }) {
      this.insiderRequests += 1;
      const rows = this.insiderPages[input.page] ?? [];
      return {
        providerRowCount:
          this.insiderProviderRowCounts[input.page] ?? rows.length,
        rows,
      };
    }

    async getCongressTrades(input: {
      chamber: "SENATE" | "HOUSE";
      page: number;
    }) {
      this.congressRequests += 1;
      const rows = this.congressPages[input.chamber][input.page] ?? [];
      return {
        providerRowCount:
          this.congressProviderRowCounts[input.chamber][input.page] ??
          rows.length,
        rows,
      };
    }
  }

  let provider: FakeProvider;
  let service: CanonicalAlternativeDataService;
  const now = new Date("2026-03-20T12:00:00.000Z");

  function insider(
    overrides: Partial<MappedFmpInsiderTrade> = {},
  ): MappedFmpInsiderTrade {
    return {
      providerSymbol: echoedSymbol,
      transactionDate: "2026-03-02",
      filingDate: "2026-03-03",
      availableFromDate: "2026-03-04",
      reportingCik: "0000000001",
      reportingName: "Buyer One",
      roles: ["OFFICER"],
      transactionCode: "P",
      transactionTypeRaw: "P-Purchase",
      category: "OPEN_MARKET_PURCHASE",
      securitiesTransacted: 100,
      price: 10,
      transactionValue: 1_000,
      raw: { note: "fixture" },
      ...overrides,
    };
  }

  function congress(
    overrides: Partial<MappedFmpCongressTrade> = {},
  ): MappedFmpCongressTrade {
    return {
      providerSymbol: echoedSymbol,
      chamber: "SENATE",
      actorExternalId: `S-${suffix}`,
      actorDisplayName: "Senator Fixture",
      actorState: "AL",
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

  beforeAll(async () => {
    prisma = new PrismaClient();
    store = new PrismaAlternativeDataStore(prisma);
    const row = await prisma.security.create({
      data: {
        providerSymbol,
        symbol,
        name: "Alternative Data Fixture",
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
    provider = new FakeProvider();
    service = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 60_000,
      maxPagesPerIngest: 4,
      now: () => now,
    });
    await prisma.insiderTransaction.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.congressTrade.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.stockDatasetState.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.actorGroupMember.deleteMany({
      where: { actor: { externalId: { contains: suffix } } },
    });
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { contains: suffix } },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.insiderTransaction.deleteMany({
        where: { securityId: security.id },
      });
      await prisma.congressTrade.deleteMany({
        where: { securityId: security.id },
      });
      await prisma.stockDatasetState.deleteMany({
        where: { securityId: security.id },
      });
      await prisma.alternativeDataActor.deleteMany({
        where: { externalId: { contains: suffix } },
      });
      await prisma.security.deleteMany({ where: { providerSymbol } });
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // Insider ingestion
  // -------------------------------------------------------------------------

  it("persists insider disclosures with both dates and the derived availability", async () => {
    provider.insiderPages = [[insider()]];
    await service.ensureIngested(security, ["INSIDER"]);

    const rows = await prisma.insiderTransaction.findMany({
      where: { securityId: security.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transactionDate.toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(rows[0]?.filingDate.toISOString().slice(0, 10)).toBe("2026-03-03");
    expect(rows[0]?.availableFromDate.toISOString().slice(0, 10)).toBe("2026-03-04");
    expect(rows[0]?.category).toBe("OPEN_MARKET_PURCHASE");
    // The provider's own row is kept, which is what makes a historical signal auditable.
    expect(rows[0]?.raw).toEqual({ note: "fixture" });
  });

  it("is idempotent: reingesting an unchanged history writes nothing", async () => {
    provider.insiderPages = [[insider(), insider({ reportingCik: "0000000002" })]];
    await service.ensureIngested(security, ["INSIDER"]);
    const first = await prisma.insiderTransaction.count({
      where: { securityId: security.id },
    });

    // A second service with the same store and a clock past the freshness window: it re-reads and must
    // change nothing.
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    await refresher.ensureIngested(security, ["INSIDER"]);
    await refresher.ensureIngested(security, ["INSIDER"]);

    expect(
      await prisma.insiderTransaction.count({ where: { securityId: security.id } }),
    ).toBe(first);
    expect(first).toBe(2);
  });

  it("treats a corrected disclosure as a new row rather than an overwrite", async () => {
    provider.insiderPages = [[insider()]];
    await service.ensureIngested(security, ["INSIDER"]);

    // The provider restates the size. History must not be destructively overwritten.
    provider.insiderPages = [
      [insider({ securitiesTransacted: 150, transactionValue: 1_500 })],
    ];
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    await refresher.ensureIngested(security, ["INSIDER"]);

    const rows = await prisma.insiderTransaction.findMany({
      where: { securityId: security.id },
      orderBy: { observedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.securitiesTransacted?.toNumber())).toEqual([
      100, 150,
    ]);
  });

  it("skips a domain that is still fresh", async () => {
    provider.insiderPages = [[insider()]];
    await service.ensureIngested(security, ["INSIDER"]);
    const requests = provider.insiderRequests;
    await service.ensureIngested(security, ["INSIDER"]);
    expect(provider.insiderRequests).toBe(requests);
  });

  it("pages a cold ingest to exhaustion and stops a refresh at the first known page", async () => {
    // Full pages are treated as possibly truncated, so the walk continues; a short page ends it.
    const full = Array.from({ length: 1000 }, (_, index) =>
      insider({
        reportingCik: `CIK-${index}`,
        transactionDate: "2026-02-02",
        filingDate: "2026-02-03",
        availableFromDate: "2026-02-04",
      }),
    );
    provider.insiderPages = [full, [insider({ reportingCik: "TAIL" })]];
    await service.ensureIngested(security, ["INSIDER"]);
    expect(provider.insiderRequests).toBe(2);
    expect(
      await prisma.insiderTransaction.count({ where: { securityId: security.id } }),
    ).toBe(1001);

    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    provider.insiderRequests = 0;
    await refresher.ensureIngested(security, ["INSIDER"]);
    // The first page inserted nothing new, so the walk stops there instead of re-reading history.
    expect(provider.insiderRequests).toBe(1);
  });

  it("keeps paging when a full provider page contains rows the mapper drops", async () => {
    // The real defect this pins, observed live on AAPL: `insider-trading/search` returned a full
    // 1,000-row page of which sixteen were Form 3 initial-holdings statements with an empty
    // `transactionType`. The mapper drops those — correctly, they are not transactions — so the page
    // arrived as 984 mapped rows, the walk read that as "shorter than the cap, therefore the last
    // page", and stopped. Eight years of filings the provider holds were never ingested, and the
    // coverage floor was set to the oldest row of page 0, which makes every earlier session
    // NOT_EVALUABLE for a reason that has nothing to do with the data.
    const page = (marker: string, size: number): MappedFmpInsiderTrade[] =>
      Array.from({ length: size }, (_, index) =>
        insider({
          reportingCik: `${marker}-${index}`,
          transactionDate: "2026-02-02",
          filingDate: "2026-02-03",
          availableFromDate: "2026-02-04",
        }),
      );
    provider.insiderPages = [page("A", 984), page("B", 1000), page("C", 5)];
    // Page 0 and page 1 were both full payloads; page 0 simply had sixteen unmappable rows.
    provider.insiderProviderRowCounts = [1000, 1000, 5];

    await service.ensureIngested(security, ["INSIDER"]);

    expect(provider.insiderRequests).toBe(3);
    expect(
      await prisma.insiderTransaction.count({
        where: { securityId: security.id },
      }),
    ).toBe(984 + 1000 + 5);
  });

  it("stops on a genuinely short provider page", async () => {
    // The counterpart: a payload the provider itself cut short still ends the walk on the first page,
    // so the fix above did not turn every ingest into `maxPagesPerIngest` requests.
    provider.insiderPages = [[insider({ reportingCik: "ONLY" })]];
    provider.insiderProviderRowCounts = [1];
    await service.ensureIngested(security, ["INSIDER"]);
    expect(provider.insiderRequests).toBe(1);
  });

  it("keeps paging congressional disclosures when a full page has unmappable rows", async () => {
    const page = (marker: string, size: number): MappedFmpCongressTrade[] =>
      Array.from({ length: size }, (_, index) =>
        congress({ actorExternalId: `${marker}-${index}-${suffix}` }),
      );
    provider.congressPages.SENATE = [page("S0", 248), page("S1", 3)];
    provider.congressProviderRowCounts.SENATE = [250, 3];
    await service.ensureIngested(security, ["CONGRESS"]);
    // Two SENATE pages plus the single HOUSE page the fake answers empty.
    expect(provider.congressRequests).toBe(3);
    expect(
      await prisma.congressTrade.count({ where: { securityId: security.id } }),
    ).toBe(251);
  });

  it("never binds a row the provider returned for another symbol to this security", async () => {
    // Every persisted row takes `securityId` from the security that was *asked* for. If a page ever
    // carried a foreign symbol — a provider-side filter change, a paging bug — those rows would
    // become this security's insider history and its metrics would count them. They are dropped,
    // reported, and excluded from the coverage window, which is what keeps the coverage floor a
    // statement about this security.
    const foreign: string[] = [];
    const guarded = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 60_000,
      maxPagesPerIngest: 4,
      now: () => now,
      onForeignRows: (event) => foreign.push(`${event.domain}:${event.rows}`),
    });
    provider.insiderPages = [
      [
        insider({ reportingCik: "MINE" }),
        insider({
          reportingCik: "THEIRS",
          providerSymbol: "SOMEONE-ELSE",
          filingDate: "2020-01-02",
          availableFromDate: "2020-01-03",
        }),
      ],
    ];
    await guarded.ensureIngested(security, ["INSIDER"]);

    const rows = await prisma.insiderTransaction.findMany({
      where: { securityId: security.id },
      select: { reportingCik: true },
    });
    expect(rows.map((row) => row.reportingCik)).toEqual(["MINE"]);
    expect(foreign).toEqual(["INSIDER:1"]);

    // And the foreign row's much earlier availability date did not drag the coverage floor down.
    const state = await prisma.stockDatasetState.findFirst({
      where: { securityId: security.id, dataset: "INSIDER_TRADE" },
      select: { earliestDate: true },
    });
    expect(state?.earliestDate?.toISOString().slice(0, 10)).toBe("2026-03-04");
  });

  // -------------------------------------------------------------------------
  // Congressional ingestion
  // -------------------------------------------------------------------------

  it("creates the member on first sight and keeps one identity across renames", async () => {
    provider.congressPages.SENATE = [[congress()]];
    await service.ensureIngested(security, ["CONGRESS"]);
    const actor = await prisma.alternativeDataActor.findFirstOrThrow({
      where: { externalId: `S-${suffix}` },
    });
    expect(actor.chamber).toBe("SENATE");
    expect(actor.state).toBe("AL");

    // The provider changes the display name. The identity — and therefore every group holding it —
    // must not move.
    provider.congressPages.SENATE = [
      [congress({ actorDisplayName: "Senator Renamed" })],
    ];
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    await refresher.ensureIngested(security, ["CONGRESS"]);
    const renamed = await prisma.alternativeDataActor.findFirstOrThrow({
      where: { externalId: `S-${suffix}` },
    });
    expect(renamed.id).toBe(actor.id);
    expect(renamed.displayName).toBe("Senator Renamed");
  });

  it("ingests both chambers into one domain and keeps the amount band unchanged", async () => {
    provider.congressPages.SENATE = [[congress()]];
    provider.congressPages.HOUSE = [
      [
        congress({
          chamber: "HOUSE",
          actorExternalId: `H-${suffix}`,
          actorDisplayName: "Representative Fixture",
          amountRangeRaw: "Over $50,000,000",
          amountLowerBound: 50_000_000,
          amountUpperBound: undefined,
        }),
      ],
    ];
    await service.ensureIngested(security, ["CONGRESS"]);

    const rows = await prisma.congressTrade.findMany({
      where: { securityId: security.id },
      orderBy: { chamber: "asc" },
    });
    expect(rows.map((row) => row.chamber)).toEqual(["HOUSE", "SENATE"]);
    const house = rows[0];
    expect(house?.amountRangeRaw).toBe("Over $50,000,000");
    expect(house?.amountLowerBound?.toNumber()).toBe(50_000_000);
    // No upper bound is invented for an open-ended band, and no midpoint exists anywhere.
    expect(house?.amountUpperBound).toBeNull();
  });

  it("keeps a non-stock disclosure but never counts it in a metric", async () => {
    provider.congressPages.SENATE = [
      [
        congress(),
        congress({
          assetClass: "BOND",
          assetTypeRaw: "Corporate Bond",
          amountRangeRaw: "$500,001 - $1,000,000",
          amountLowerBound: 500_001,
          amountUpperBound: 1_000_000,
          transactionDate: "2026-01-16",
        }),
      ],
    ];
    await service.ensureIngested(security, ["CONGRESS"]);
    expect(
      await prisma.congressTrade.count({ where: { securityId: security.id } }),
    ).toBe(2);

    const observations = await store.getCongressObservations({
      securityId: security.id,
      from: "2026-01-01",
      to: "2026-12-31",
      kind: "PURCHASE",
    });
    // Only the common-stock row.
    expect(observations).toHaveLength(1);
    expect(observations[0]?.amountLowerBound).toBe(15_001);
  });

  // -------------------------------------------------------------------------
  // Coverage and the projected column
  // -------------------------------------------------------------------------

  it("bounds the evaluable range by what was actually ingested", async () => {
    provider.insiderPages = [
      [
        insider({
          transactionDate: "2026-02-02",
          filingDate: "2026-02-03",
          availableFromDate: "2026-02-04",
        }),
        insider({
          reportingCik: "0000000002",
          transactionDate: "2026-03-02",
          filingDate: "2026-03-03",
          availableFromDate: "2026-03-04",
        }),
      ],
    ];
    await service.ensureIngested(security, ["INSIDER"]);
    const state = await store.getAlternativeDatasetState(security.id, "INSIDER");
    expect(state?.earliestAvailableDate).toBe("2026-02-04");
    expect(state?.latestAvailableDate).toBe("2026-03-04");
    // The upper bound is the sync date: past it the product knows nothing.
    expect(state?.syncedThroughDate).toBe("2026-03-20");
  });

  it("never narrows the coverage floor on a shallower refresh", async () => {
    provider.insiderPages = [
      [
        insider({
          transactionDate: "2020-01-02",
          filingDate: "2020-01-03",
          availableFromDate: "2020-01-04",
        }),
      ],
    ];
    await service.ensureIngested(security, ["INSIDER"]);

    // A refresh that only sees the newest page has not un-learned the 2020 row it already persisted.
    provider.insiderPages = [[insider()]];
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    await refresher.ensureIngested(security, ["INSIDER"]);

    const state = await store.getAlternativeDatasetState(security.id, "INSIDER");
    expect(state?.earliestAvailableDate).toBe("2020-01-04");
  });

  it("projects a column that counts a disclosure only from the session after it was filed", async () => {
    // Traded 2 March, filed 3 March. A session on the 3rd must not see it; the 4th must.
    provider.insiderPages = [[insider()]];
    await service.ensureIngested(security, ["INSIDER"]);

    const metric: AlternativeDataMetric = {
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 5,
    };
    const key = alternativeDataOperand(metric);
    const facts = await service.loadFacts({
      security,
      operands: [key],
      from: "2026-02-20",
      to: "2026-03-20",
    });
    const dates = [
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-09",
      "2026-03-10",
    ];
    const column = [
      ...buildAlternativeDataColumn({
        dates,
        request: alternativeDataColumnRequest(metric),
        facts: facts.get(key) ?? { coverage: null, observations: [] },
      }),
    ];
    // The coverage floor is 4 March — the day after the filing — so no five-session window ending
    // before 8 March lies wholly inside it. The first session with a complete, fully covered window is
    // 10 March, whose window opens on the 4th.
    expect(column.slice(0, 6).every((value) => Number.isNaN(value))).toBe(true);
    expect(column[6]).toBe(1);

    // And with a one-session window the boundary reads directly: nothing on the filing date, one on
    // the session after it.
    const narrow = [
      ...buildAlternativeDataColumn({
        dates,
        request: { lookbackSessions: 1, aggregation: "DISTINCT_ACTORS" },
        facts: facts.get(key) ?? { coverage: null, observations: [] },
      }),
    ];
    expect(narrow[0]).toBeNaN();
    expect(narrow[1]).toBeNaN();
    expect(narrow[2]).toBe(1);
    expect(narrow[3]).toBe(0);
  });

  it("scopes a congressional metric to a group's membership", async () => {
    provider.congressPages.SENATE = [[congress()]];
    provider.congressPages.HOUSE = [
      [
        congress({
          chamber: "HOUSE",
          actorExternalId: `H-${suffix}`,
          actorDisplayName: "Representative Fixture",
          transactionDate: "2026-01-16",
        }),
      ],
    ];
    await service.ensureIngested(security, ["CONGRESS"]);
    const senator = await prisma.alternativeDataActor.findFirstOrThrow({
      where: { externalId: `S-${suffix}` },
    });

    const metric: AlternativeDataMetric = {
      kind: "CONGRESS_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
      scope: { kind: "GROUP", groupId: "frozen-group" },
      chamber: "ANY",
    };
    const key = alternativeDataOperand(metric);
    // A resolver standing in for a run's frozen snapshot membership: only the senator is in scope.
    const facts = await service.loadFacts({
      security,
      operands: [key],
      from: "2026-01-01",
      to: "2026-12-31",
      resolveGroupMembers: async () => [senator.id],
    });
    expect(facts.get(key)?.observations.map((entry) => entry.actorKey)).toEqual([
      senator.id,
    ]);

    // The same metric with no scope sees both chambers.
    const unscoped: AlternativeDataMetric = { ...metric, scope: { kind: "ANY" } };
    const unscopedKey = alternativeDataOperand(unscoped);
    const all = await service.loadFacts({
      security,
      operands: [unscopedKey],
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(all.get(unscopedKey)?.observations).toHaveLength(2);

    // And an empty frozen group counts nobody rather than everybody.
    const empty = await service.loadFacts({
      security,
      operands: [key],
      from: "2026-01-01",
      to: "2026-12-31",
      resolveGroupMembers: async () => [],
    });
    expect(empty.get(key)?.observations).toEqual([]);
  });

  it("filters insider observations by role", async () => {
    provider.insiderPages = [
      [
        insider({ reportingCik: "OFFICER-1", roles: ["OFFICER"] }),
        insider({
          reportingCik: "DIRECTOR-1",
          roles: ["DIRECTOR"],
          transactionDate: "2026-03-01",
        }),
      ],
    ];
    await service.ensureIngested(security, ["INSIDER"]);

    const directorsOnly = await store.getInsiderObservations({
      securityId: security.id,
      from: "2026-01-01",
      to: "2026-12-31",
      category: "OPEN_MARKET_PURCHASE",
      roles: ["DIRECTOR"],
    });
    expect(directorsOnly.map((row) => row.actorKey)).toEqual(["DIRECTOR-1"]);

    const everyone = await store.getInsiderObservations({
      securityId: security.id,
      from: "2026-01-01",
      to: "2026-12-31",
      category: "OPEN_MARKET_PURCHASE",
    });
    expect(everyone).toHaveLength(2);
  });

  it("keys one frame column per configured metric", async () => {
    provider.insiderPages = [[insider()]];
    await service.ensureIngested(security, ["INSIDER"]);
    const buyers20: AlternativeDataMetric = {
      kind: "INSIDER_ACTIVITY",
      measure: "BUYERS",
      lookback: 20,
    };
    const buyers60: AlternativeDataMetric = { ...buyers20, lookback: 60 };
    const facts = await service.loadFacts({
      security,
      operands: [
        alternativeDataOperand(buyers20),
        alternativeDataOperand(buyers60),
      ],
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect([...facts.keys()].sort()).toEqual(
      [
        `alt:${alternativeDataMetricSignature(buyers20)}`,
        `alt:${alternativeDataMetricSignature(buyers60)}`,
      ].sort(),
    );
  });
});
