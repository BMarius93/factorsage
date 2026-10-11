import { createHash, randomUUID } from "node:crypto";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type ActorCatalogStatusResponse,
  type AlternativeDataActorResponse,
  type CongressMemberCatalogSyncResponse,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { UserRole, type Prisma } from "@intrinsic/database";
import {
  FmpTransientError,
  type FmpCongressMemberDirectoryPort,
  type MappedFmpCongressMember,
} from "@intrinsic/fmp";
import {
  CONGRESS_MEMBER_CATALOG_SYNC_ID,
  InMemoryLoadCoordinator,
  NullStockDataCache,
  PrismaCongressMemberCatalogStore,
} from "@intrinsic/stock-data";
import {
  acceptCurrentTermsByEmail,
  useIsolatedRateLimits,
  useTestDatabase,
} from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../database/prisma.service";
import {
  STOCK_DATA_CACHE,
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
} from "../stocks/stock-data.tokens";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter; see `securities-sync.integration.test.ts`.
useIsolatedRateLimits();

/**
 * End-to-end contract for the member catalog against real PostgreSQL, through the application's
 * own wiring.
 *
 * The provider's directory is faked; the route, its guards, the claim on the real state row, the
 * writes, the picker's search and the strategy write boundary are all real. What it proves is the
 * brief in one sentence: a member of Congress can be found, selected, saved and read back before a
 * single disclosure of theirs — or of anybody's — has been loaded.
 *
 * This suite uses the application's own singleton state row, because that is what the wiring under
 * test claims. It puts the row back exactly as it found it.
 */

/** Bioguide-shaped identifiers no other suite and no earlier run of this one uses. */
const block = String(10_000 + Math.floor(Math.random() * 90_000));
const id = (slot: number): string => `Q${slot}${block}`;
const everyId = Array.from({ length: 10 }, (_, slot) => id(slot));
const tag = randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase();

function member(
  slot: number,
  overrides: Partial<MappedFmpCongressMember> = {},
): MappedFmpCongressMember {
  return {
    externalId: id(slot),
    name: `Given${slot} Family${block}`,
    chamber: "HOUSE",
    positionRaw: "Representative",
    state: "CA",
    inOffice: true,
    ...overrides,
  };
}

type Page = MappedFmpCongressMember[] | Error;

/**
 * Stands in for the one FMP client provider. Only the directory answers; every per-security read
 * throws, so a synchronization that reached for a disclosure would fail loudly.
 */
class FakeDirectoryProvider implements FmpCongressMemberDirectoryPort {
  inOffice: Page[] = [];
  former: Page[] = [];
  requests = 0;

  async getCongressMemberProfiles(input: { inOffice: boolean; page: number }) {
    this.requests += 1;
    const page = (input.inOffice ? this.inOffice : this.former)[input.page];
    if (page instanceof Error) {
      throw page;
    }
    const rows = page ?? [];
    return { providerRowCount: rows.length, rows };
  }

  async getCongressTrades(): Promise<never> {
    throw new Error("A catalog synchronization must not fetch disclosures");
  }

  async getInsiderTrades(): Promise<never> {
    throw new Error("A catalog synchronization must not fetch disclosures");
  }

  async getProfile(): Promise<never> {
    throw new Error("A catalog synchronization must not fetch a security");
  }

  async getDailyPrices(): Promise<never> {
    throw new Error("A catalog synchronization must not fetch prices");
  }
}

describe("member catalog synchronization through the API", () => {
  const password = "Local-test-password-42";
  const adminEmail = `members-admin-${tag}@example.test`;
  const userEmail = `members-user-${tag}@example.test`;
  const provider = new FakeDirectoryProvider();

  let app: INestApplication;
  let prisma: PrismaService;
  let admin: ReturnType<typeof request.agent>;
  let user: ReturnType<typeof request.agent>;
  /** The singleton state row as this suite found it, to put back. */
  let stateBefore: Awaited<
    ReturnType<PrismaService["congressMemberCatalogSync"]["findUnique"]>
  > = null;

  const FORMER = (): MappedFmpCongressMember[] => [
    member(9, { inOffice: false, name: `Former Member${block}` }),
  ];

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/auth/login").send({ email, password }).expect(200);
    return agent;
  }

  async function sync(): Promise<CongressMemberCatalogSyncResponse> {
    const response = await admin
      .post("/admin/congress-members/sync")
      .expect(200);
    return response.body as CongressMemberCatalogSyncResponse;
  }

  async function status(): Promise<ActorCatalogStatusResponse> {
    // Without a session: the picker asks before it knows who is looking.
    const response = await request(app.getHttpServer())
      .get("/alternative-data/actors/catalog")
      .expect(200);
    return response.body as ActorCatalogStatusResponse;
  }

  async function search(term: string): Promise<AlternativeDataActorResponse[]> {
    const response = await request(app.getHttpServer())
      .get("/alternative-data/actors")
      .query({ q: term })
      .expect(200);
    return response.body as AlternativeDataActorResponse[];
  }

  const ownRows = () =>
    prisma.alternativeDataActor.findMany({
      where: { externalId: { in: everyId } },
      orderBy: { externalId: "asc" },
    });

  async function removeFixtures(): Promise<void> {
    await prisma.strategy.deleteMany({
      where: { user: { email: { in: [adminEmail, userEmail] } } },
    });
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { in: everyId } },
    });
    await prisma.congressMemberCatalogSync.deleteMany({
      where: { id: CONGRESS_MEMBER_CATALOG_SYNC_ID },
    });
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STOCK_DATA_PROVIDER)
      .useValue(provider)
      .overrideProvider(STOCK_DATA_CACHE)
      .useValue(new NullStockDataCache())
      .overrideProvider(STOCK_DATA_COORDINATOR)
      .useValue(new InMemoryLoadCoordinator())
      .compile();

    app = moduleRef.createNestApplication();
    app.enableCors({ origin: getApiConfig().corsOrigins, credentials: true });
    // A real listener on loopback rather than supertest's own ephemeral wildcard bind.
    await app.listen(0, "127.0.0.1");

    prisma = moduleRef.get(PrismaService);
    stateBefore = await prisma.congressMemberCatalogSync.findUnique({
      where: { id: CONGRESS_MEMBER_CATALOG_SYNC_ID },
    });

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        {
          email: adminEmail,
          passwordHash,
          emailVerifiedAt,
          role: UserRole.ADMIN,
        },
        {
          email: userEmail,
          passwordHash,
          emailVerifiedAt,
          role: UserRole.USER,
        },
      ],
    });
    await acceptCurrentTermsByEmail(prisma, [adminEmail, userEmail]);
    admin = await login(adminEmail);
    user = await login(userEmail);
  });

  afterAll(async () => {
    if (prisma) {
      await removeFixtures();
      if (stateBefore) {
        await prisma.congressMemberCatalogSync.create({
          data: {
            ...stateBefore,
            lastSummary:
              (stateBefore.lastSummary as Prisma.InputJsonValue | null) ??
              undefined,
          },
        });
      }
      await prisma.user.deleteMany({
        where: { email: { in: [adminEmail, userEmail] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    provider.inOffice = [];
    provider.former = [];
    provider.requests = 0;
    await removeFixtures();
  });

  it("requires an ADMIN session, and asks the provider nothing for anybody else", async () => {
    provider.inOffice = [[member(1)]];
    provider.former = [FORMER()];

    await request(app.getHttpServer())
      .post("/admin/congress-members/sync")
      .expect(401);
    await user.post("/admin/congress-members/sync").expect(403);

    expect(provider.requests).toBe(0);
    expect(await ownRows()).toHaveLength(0);
  });

  it("fills the catalog from the directory, so members are found with no disclosure loaded", async () => {
    provider.inOffice = [
      [
        member(1, { name: `Alder Quillfeather${block}` }),
        member(2, {
          name: `Bryn Stonecroft${block}`,
          chamber: "SENATE",
          positionRaw: "Senator",
          state: "NV",
        }),
      ],
    ];
    provider.former = [FORMER()];
    expect(await search(`Quillfeather${block}`)).toEqual([]);

    const summary = await sync();

    expect(summary).toMatchObject({
      runSequence: 1,
      providerRequests: 4,
      received: 3,
      inOffice: 2,
      former: 1,
      created: 3,
      updated: 0,
      relabelled: 0,
      unchanged: 0,
      declined: 0,
      declinedByReason: {
        MALFORMED_ID: 0,
        CONFLICTING_ROWS: 0,
        UNNAMED: 0,
        NO_CHAMBER: 0,
      },
      repeatedRows: 0,
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const rows = await ownRows();
    expect(rows).toHaveLength(3);
    expect(
      await prisma.congressTrade.count({
        where: { actorId: { in: rows.map((row) => row.id) } },
      }),
    ).toBe(0);

    // Found by the public picker route, in office or former, by name or by bioguide id.
    const alder = rows.find((row) => row.externalId === id(1))!;
    expect(await search(`Quillfeather${block}`)).toEqual([
      {
        id: alder.id,
        externalId: id(1),
        displayName: `Alder Quillfeather${block}`,
        chamber: "HOUSE",
        state: "CA",
      },
    ]);
    expect(
      (await search(`Former Member${block}`)).map((actor) => actor.externalId),
    ).toEqual([id(9)]);
    expect((await search(id(2))).map((actor) => actor.displayName)).toEqual([
      `Bryn Stonecroft${block}`,
    ]);
  });

  it("changes nothing on a second run, and keeps every canonical id", async () => {
    provider.inOffice = [[member(1), member(2)]];
    provider.former = [FORMER()];
    await sync();
    const first = await ownRows();

    const second = await sync();

    expect(second).toMatchObject({
      runSequence: 2,
      received: 3,
      created: 0,
      updated: 0,
      unchanged: 3,
    });
    expect(await ownRows()).toEqual(first);
  });

  it("lets a strategy select a member nobody has disclosed for, and reads it back unchanged", async () => {
    provider.inOffice = [[member(1), member(2), member(3)]];
    provider.former = [FORMER()];
    await sync();
    const rows = await ownRows();
    const [a, b, formerMember] = [id(1), id(2), id(9)].map(
      (externalId) => rows.find((row) => row.externalId === externalId)!.id,
    ) as [string, string, string];

    const definitionOf = (actorIds: readonly string[]) => ({
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "condition-1",
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "PURCHASES",
                  lookback: 30,
                  scope: { kind: "ACTORS", actorIds },
                  chamber: "ANY",
                },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });

    // Unordered and repeated on the way in: stored canonically, in office and former alike.
    const created = (
      await user
        .post("/strategies")
        .send({
          name: `Catalog selection ${tag}`,
          definition: definitionOf([formerMember, b, a, b]),
        })
        .expect(201)
    ).body as StrategyDetailResponse;
    const canonical = [a, b, formerMember].sort();
    const scopeOf = (strategy: StrategyDetailResponse) => {
      const metric =
        strategy.definition.buyLevels[0]?.signal.conditions[0]?.metric;
      return metric?.kind === "CONGRESS_ACTIVITY" ? metric.scope : undefined;
    };
    expect(scopeOf(created)).toEqual({ kind: "ACTORS", actorIds: canonical });

    // Reopened: exactly the selection that was saved.
    const reopened = (await user.get(`/strategies/${created.id}`).expect(200))
      .body as StrategyDetailResponse;
    expect(scopeOf(reopened)).toEqual({ kind: "ACTORS", actorIds: canonical });

    // And the names behind it resolve, which is what the Builder renders the chips from.
    const resolved = (
      await request(app.getHttpServer())
        .get("/alternative-data/actors/resolve")
        .query({ ids: canonical.join(",") })
        .expect(200)
    ).body as AlternativeDataActorResponse[];
    expect(resolved.map((actor) => actor.id).sort()).toEqual(canonical);

    // The stored hash is the contract's own serialization of that selection — the catalog a member
    // came from is no part of a strategy's identity.
    const version = await prisma.strategyVersion.findFirstOrThrow({
      where: { strategyId: created.id },
    });
    expect(version.definitionHash).toBe(
      createHash("sha256")
        .update(
          strategyDefinitionFingerprint(
            normalizeStrategyDefinition(definitionOf(canonical)),
          ),
        )
        .digest("hex"),
    );

    // A later synchronization — a member renamed, another gone from the directory — moves neither
    // the selection nor the hash, and appends no version.
    provider.inOffice = [[member(1, { name: `Renamed Member${block}` })]];
    await sync();
    const after = (await user.get(`/strategies/${created.id}`).expect(200))
      .body as StrategyDetailResponse;
    expect(scopeOf(after)).toEqual({ kind: "ACTORS", actorIds: canonical });
    expect(after.versionNumber).toBe(created.versionNumber);
    expect(
      await prisma.strategyVersion.findMany({
        where: { strategyId: created.id },
        select: { definitionHash: true },
      }),
    ).toEqual([{ definitionHash: version.definitionHash }]);
    // The member the directory dropped is still there to be read.
    expect(await ownRows()).toHaveLength(4);
  });

  it("says whether the catalog was ever filled, and keeps saying so through a later failure", async () => {
    expect(await status()).toEqual({ state: "NOT_SYNCHRONIZED" });

    // A run that fails before any has completed.
    provider.inOffice = [new FmpTransientError(503)];
    await admin.post("/admin/congress-members/sync").expect(503);
    expect(await status()).toEqual({ state: "SYNCHRONIZATION_FAILED" });

    // A complete one.
    provider.inOffice = [[member(1)]];
    provider.former = [FORMER()];
    await sync();
    const synchronized = await status();
    expect(synchronized.state).toBe("SYNCHRONIZED");
    expect(Number.isNaN(Date.parse(synchronized.synchronizedAt ?? ""))).toBe(
      false,
    );

    // And a later failure: the catalog still holds what the complete run wrote, and says when.
    provider.former = [new FmpTransientError(503)];
    await admin.post("/admin/congress-members/sync").expect(503);
    expect(await status()).toEqual(synchronized);
  });

  it("answers 503 and writes nothing when the directory cannot be read whole", async () => {
    provider.inOffice = [[member(1), member(2)]];
    provider.former = [
      new FmpTransientError(503, {
        cause: new Error("apikey=super-secret upstream body"),
      }),
    ];

    const response = await admin
      .post("/admin/congress-members/sync")
      .expect(503);

    expect(response.body.message).toBe(
      "Member catalog synchronization could not complete (PROVIDER_UNAVAILABLE); the catalog is unchanged",
    );
    expect(JSON.stringify(response.body)).not.toContain("super-secret");
    // The half that was read whole was not written either.
    expect(await ownRows()).toHaveLength(0);
    const state = await prisma.congressMemberCatalogSync.findUniqueOrThrow({
      where: { id: CONGRESS_MEMBER_CATALOG_SYNC_ID },
    });
    expect(state).toMatchObject({
      claimedBy: null,
      lastCompletedAt: null,
      consecutiveFailures: 1,
    });
    expect(state.lastError).not.toContain("super-secret");
  });

  it("answers 409 while another run holds the claim, without asking the provider", async () => {
    provider.inOffice = [[member(1)]];
    provider.former = [FORMER()];
    // The operator command, or another API instance, is mid-run.
    const other = new PrismaCongressMemberCatalogStore(prisma);
    await other.claimCatalogSync({
      owner: "another-process",
      now: new Date(),
      leaseMs: 60_000,
    });

    const response = await admin
      .post("/admin/congress-members/sync")
      .expect(409);

    expect(response.body.message).toBe(
      "A member catalog synchronization is already running",
    );
    expect(provider.requests).toBe(0);
    expect(await ownRows()).toHaveLength(0);

    // Once that run finishes, the route runs.
    await other.failCatalogSync({
      owner: "another-process",
      now: new Date(),
      error: "TEST: released",
    });
    expect((await sync()).created).toBe(2);
  });
});
