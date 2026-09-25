import { randomUUID } from "node:crypto";
import {
  alternativeDataMetricSignature,
  type AlternativeDataMetric,
} from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import {
  FmpEntitlementError,
  type MappedFmpCongressTrade,
  type MappedFmpInsiderTrade,
  type MappedFmpInstitutionalHolding,
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
  recentReportQuarters,
  type AlternativeDataProvider,
  type AlternativeDataUnavailableEvent,
} from "./alternative-data-service.js";
import { PrismaAlternativeDataStore } from "./alternative-data-prisma-store.js";

useTestDatabase();

/**
 * Alternative-data ingestion against real PostgreSQL.
 *
 * The provider is a fake, and deliberately so: what this suite proves is everything *downstream* of the
 * wire — that reingesting an unchanged history writes nothing, that an amendment lands beside the row it
 * supersedes rather than over it, that 13F position changes are re-derived rather than accumulated, that
 * coverage bounds the evaluable range honestly, and that a restricted dataset leaves coverage absent
 * instead of reporting zeros. The provider field names themselves are proven against captured live
 * payloads in `@intrinsic/fmp`.
 */
describe("alternative-data ingestion", () => {
  const suffix = randomUUID();
  const providerSymbol = `ALT-${suffix}`;
  const symbol = `ALT${suffix.slice(0, 6).toUpperCase()}`;

  let prisma: PrismaClient;
  let store: PrismaAlternativeDataStore;
  let security: Security;

  /** A scripted provider: each domain answers from a page list this suite sets per test. */
  class FakeProvider implements AlternativeDataProvider {
    insiderPages: MappedFmpInsiderTrade[][] = [];
    congressPages: Record<"SENATE" | "HOUSE", MappedFmpCongressTrade[][]> = {
      SENATE: [],
      HOUSE: [],
    };
    institutionalByQuarter = new Map<string, MappedFmpInstitutionalHolding[]>();
    institutionalError: Error | null = null;
    insiderRequests = 0;
    congressRequests = 0;

    async getInsiderTrades(input: { page: number }) {
      this.insiderRequests += 1;
      return this.insiderPages[input.page] ?? [];
    }

    async getCongressTrades(input: {
      chamber: "SENATE" | "HOUSE";
      page: number;
    }) {
      this.congressRequests += 1;
      return this.congressPages[input.chamber][input.page] ?? [];
    }

    async getInstitutionalHoldings(input: {
      year: number;
      quarter: number;
      page: number;
    }) {
      if (this.institutionalError) {
        throw this.institutionalError;
      }
      if (input.page > 0) {
        return [];
      }
      return this.institutionalByQuarter.get(`${input.year}Q${input.quarter}`) ?? [];
    }
  }

  let provider: FakeProvider;
  let service: CanonicalAlternativeDataService;
  const now = new Date("2026-03-20T12:00:00.000Z");

  function insider(
    overrides: Partial<MappedFmpInsiderTrade> = {},
  ): MappedFmpInsiderTrade {
    return {
      providerSymbol,
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
      providerSymbol,
      chamber: "SENATE",
      actorExternalId: `S-${suffix}`,
      actorDisplayName: "Senator Fixture",
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

  function holding(
    overrides: Partial<MappedFmpInstitutionalHolding> = {},
  ): MappedFmpInstitutionalHolding {
    return {
      providerSymbol,
      actorExternalId: `I-${suffix}`,
      actorDisplayName: "Manager Fixture",
      reportPeriod: "2025-09-30",
      filingDate: "2025-11-14",
      availableFromDate: "2025-11-15",
      shares: 1_000,
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
      institutionalQuarters: 4,
      now: () => now,
    });
    await prisma.institutionalPositionEvent.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.institutionalHolding.deleteMany({
      where: { securityId: security.id },
    });
    await prisma.institutionalFiling.deleteMany({
      where: { actor: { externalId: { startsWith: "I-" } } },
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
      await prisma.institutionalPositionEvent.deleteMany({
        where: { securityId: security.id },
      });
      await prisma.institutionalHolding.deleteMany({
        where: { securityId: security.id },
      });
      await prisma.institutionalFiling.deleteMany({
        where: { actor: { externalId: { contains: suffix } } },
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
      institutionalQuarters: 4,
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
      institutionalQuarters: 4,
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
      institutionalQuarters: 4,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    provider.insiderRequests = 0;
    await refresher.ensureIngested(security, ["INSIDER"]);
    // The first page inserted nothing new, so the walk stops there instead of re-reading history.
    expect(provider.insiderRequests).toBe(1);
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
    expect(actor.type).toBe("CONGRESS_PERSON");
    expect(actor.chamber).toBe("SENATE");

    // The provider changes the display name. The identity — and therefore every group holding it —
    // must not move.
    provider.congressPages.SENATE = [
      [congress({ actorDisplayName: "Senator Renamed" })],
    ];
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      institutionalQuarters: 4,
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
  // 13F ingestion and derivation
  // -------------------------------------------------------------------------

  it("derives position changes from consecutive available filings", async () => {
    const quarters = recentReportQuarters(now, 4);
    // Four quarters, newest first from the fake clock: 2026Q1 back to 2025Q2.
    const periods = [...quarters].reverse();
    const filedFor = (index: number) => {
      const period = periods[index] as { year: number; quarter: number };
      const month = period.quarter * 3;
      const end = new Date(Date.UTC(period.year, month, 0));
      const filing = new Date(end.getTime() + 45 * 86_400_000);
      return {
        reportPeriod: end.toISOString().slice(0, 10),
        filingDate: filing.toISOString().slice(0, 10),
        availableFromDate: new Date(filing.getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10),
      };
    };
    const shares = [1_000, 1_500, 900, 0];
    periods.forEach((period, index) => {
      const dates = filedFor(index);
      provider.institutionalByQuarter.set(
        `${period.year}Q${period.quarter}`,
        shares[index] === 0
          ? []
          : [holding({ ...dates, shares: shares[index] as number })],
      );
    });

    await service.ensureIngested(security, ["INSTITUTIONAL"]);

    const events = await prisma.institutionalPositionEvent.findMany({
      where: { securityId: security.id },
      orderBy: { reportPeriod: "asc" },
    });
    expect(events.map((event) => event.change)).toEqual([
      "NEW",
      "INCREASED",
      "REDUCED",
    ]);
    // A quarter the provider returned nothing for is not an exit: the manager simply has no filing
    // there, and inventing one would fabricate a transaction.
    expect(events[1]?.changePercent?.toNumber()).toBeCloseTo(50, 4);
    expect(events[2]?.changePercent?.toNumber()).toBeCloseTo(-40, 4);
    expect(events[0]?.changePercent).toBeNull();
  });

  it("re-derives rather than accumulates, so an amendment replaces a comparison", async () => {
    const period = recentReportQuarters(now, 1)[0] as {
      year: number;
      quarter: number;
    };
    const key = `${period.year}Q${period.quarter}`;
    provider.institutionalByQuarter.set(key, [
      holding({ reportPeriod: "2025-12-31", filingDate: "2026-02-14", availableFromDate: "2026-02-15", shares: 1_000 }),
    ]);
    await service.ensureIngested(security, ["INSTITUTIONAL"]);
    expect(
      await prisma.institutionalPositionEvent.count({
        where: { securityId: security.id },
      }),
    ).toBe(1);

    // An amendment restating the same period. It lands as a new filing row and becomes that period's
    // current statement; the derived events are replaced, not appended to.
    provider.institutionalByQuarter.set(key, [
      holding({
        reportPeriod: "2025-12-31",
        filingDate: "2026-03-10",
        availableFromDate: "2026-03-11",
        shares: 400,
        amendmentType: "13F-HR/A",
      }),
    ]);
    const refresher = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 1,
      maxPagesPerIngest: 4,
      institutionalQuarters: 1,
      now: () => new Date(now.getTime() + 10 * 60_000),
    });
    await refresher.ensureIngested(security, ["INSTITUTIONAL"]);

    // Both filings are on record — nothing is destructively overwritten.
    expect(
      await prisma.institutionalFiling.count({
        where: { actor: { externalId: `I-${suffix}` } },
      }),
    ).toBe(2);
    const events = await prisma.institutionalPositionEvent.findMany({
      where: { securityId: security.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.shares.toNumber()).toBe(400);
    // Only knowable once the amendment was public.
    expect(events[0]?.availableFromDate.toISOString().slice(0, 10)).toBe(
      "2026-03-11",
    );
  });

  it("reports a restricted dataset instead of recording an empty one", async () => {
    const unavailable: AlternativeDataUnavailableEvent[] = [];
    const restricted = new CanonicalAlternativeDataService(store, provider, {
      freshnessMs: 60_000,
      maxPagesPerIngest: 4,
      institutionalQuarters: 4,
      now: () => now,
      onDatasetUnavailable: (event) => unavailable.push(event),
    });
    provider.institutionalError = new FmpEntitlementError(402);

    // It must not throw: a strategy whose other conditions are evaluable still has a backtest to run.
    await restricted.ensureIngested(security, ["INSTITUTIONAL"]);

    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.domain).toBe("INSTITUTIONAL");
    expect(unavailable[0]?.statusCode).toBe(402);
    // No coverage was recorded, so every institutional metric reads NOT_EVALUABLE rather than zero.
    expect(
      await store.getAlternativeDatasetState(security.id, "INSTITUTIONAL"),
    ).toBeNull();
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
      institutionalQuarters: 4,
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
