import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  RECENT_SECURITY_LIMIT,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { RecentSearchesModule } from "./recent-searches.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> RecentSecuritiesService -> real PostgreSQL.
 *
 * The rules worth proving are all persistence rules: recency ordering, that a second view of the
 * same stock moves a row rather than adding one, the bound on how many survive, ownership scoping,
 * and that a catalog row disappearing takes its recent views with it.
 */
describe("recent searches", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `recent-owner-${suffix}@example.test`;
  const otherEmail = `recent-other-${suffix}@example.test`;
  const providerSymbols = [1, 2, 3, 4, 5, 6, 7].map((i) => `RCT${i}-${suffix}`);

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let guest: ReturnType<typeof request.agent>;
  /** Catalog ids in `providerSymbols` order, so a test can name "the third security". */
  let securityIds: string[] = [];

  function security(index: number) {
    return {
      providerSymbol: `RCT${index}-${suffix}`,
      symbol: `RCT${index}${suffix.slice(0, 6).toUpperCase()}`,
      name: `Recent Test Security ${index}`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      currency: "USD",
      type: "STOCK" as const,
      isAdr: false,
      isActivelyTrading: true,
    };
  }

  async function view(
    agent: ReturnType<typeof request.agent>,
    securityId: string,
  ) {
    await agent.post("/recent-searches").send({ securityId }).expect(204);
  }

  async function recentSymbols(
    agent: ReturnType<typeof request.agent>,
    query = "",
  ): Promise<string[]> {
    const response = await agent.get(`/recent-searches${query}`).expect(200);
    return (response.body as StockSearchResultResponse[]).map(
      (row) => row.symbol,
    );
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        RecentSearchesModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt },
        { email: otherEmail, passwordHash, emailVerifiedAt },
      ],
    });
    await prisma.security.createMany({
      data: providerSymbols.map((_, index) => security(index + 1)),
    });
    securityIds = (
      await prisma.security.findMany({
        where: { providerSymbol: { in: providerSymbols } },
        orderBy: { providerSymbol: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);

    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    guest = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password })
      .expect(200);
  });

  beforeEach(async () => {
    await prisma.recentSecurityView.deleteMany({
      where: { securityId: { in: securityIds } },
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Recent views cascade from both the users and the securities.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("returns an authenticated user's viewed securities newest first", async () => {
    await view(owner, securityIds[0]!);
    await view(owner, securityIds[1]!);
    await view(owner, securityIds[2]!);

    expect(await recentSymbols(owner)).toEqual([
      security(3).symbol,
      security(2).symbol,
      security(1).symbol,
    ]);
  });

  it("promotes a re-viewed security instead of duplicating it", async () => {
    await view(owner, securityIds[0]!);
    await view(owner, securityIds[1]!);
    await view(owner, securityIds[2]!);
    await view(owner, securityIds[1]!);

    expect(await recentSymbols(owner)).toEqual([
      security(2).symbol,
      security(3).symbol,
      security(1).symbol,
    ]);
    const ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    expect(
      await prisma.recentSecurityView.count({ where: { userId: ownerId } }),
    ).toBe(3);
  });

  it("keeps only the newest RECENT_SECURITY_LIMIT, in the database as well as the response", async () => {
    for (const securityId of securityIds) {
      await view(owner, securityId);
    }

    const symbols = await recentSymbols(owner);
    expect(symbols).toHaveLength(RECENT_SECURITY_LIMIT);
    // The seven securities were viewed in order, so the newest five are 7 down to 3.
    expect(symbols).toEqual([7, 6, 5, 4, 3].map((i) => security(i).symbol));

    const ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    // The trim is a write-path rule, not a read-path `take`: the table stays bounded even though
    // it is written on every Stock Details view.
    expect(
      await prisma.recentSecurityView.count({ where: { userId: ownerId } }),
    ).toBe(RECENT_SECURITY_LIMIT);
  });

  it("answers with an empty set for a user who has viewed nothing", async () => {
    expect(await recentSymbols(other)).toEqual([]);
  });

  it("never shows one user the securities another user viewed", async () => {
    await view(owner, securityIds[0]!);

    expect(await recentSymbols(other)).toEqual([]);
  });

  /**
   * The catalog is the identity authority and `RecentSecurityView` cascades from it, so a security
   * that leaves the catalog cannot leave a broken row behind for the dropdown to render.
   */
  it("silently omits a security that no longer exists in the catalog", async () => {
    await view(owner, securityIds[0]!);
    await view(owner, securityIds[1]!);
    await prisma.security.delete({ where: { id: securityIds[1]! } });

    expect(await recentSymbols(owner)).toEqual([security(1).symbol]);

    // Restored for the suites that follow; ids are regenerated, so re-read them.
    await prisma.security.create({ data: security(2) });
    securityIds = (
      await prisma.security.findMany({
        where: { providerSymbol: { in: providerSymbols } },
        orderBy: { providerSymbol: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);
  });

  it("refuses to record a security that is not in the catalog", async () => {
    await owner
      .post("/recent-searches")
      .send({ securityId: randomUUID() })
      .expect(404);
  });

  it("rejects a record request with no usable securityId", async () => {
    await owner.post("/recent-searches").send({}).expect(400);
    await owner.post("/recent-searches").send({ securityId: " " }).expect(400);
  });

  describe("guests", () => {
    it("resolves the ids the browser stored, in the order it sent them", async () => {
      const ids = [securityIds[2]!, securityIds[0]!, securityIds[1]!];

      expect(await recentSymbols(guest, `?ids=${ids.join(",")}`)).toEqual([
        security(3).symbol,
        security(1).symbol,
        security(2).symbol,
      ]);
    });

    it("drops ids the catalog does not hold rather than failing the request", async () => {
      const ids = [securityIds[0]!, randomUUID(), "not-an-id"];

      expect(await recentSymbols(guest, `?ids=${ids.join(",")}`)).toEqual([
        security(1).symbol,
      ]);
    });

    it("bounds what it will resolve, however many ids arrive", async () => {
      const resolved = await recentSymbols(
        guest,
        `?ids=${securityIds.join(",")}`,
      );

      expect(resolved).toHaveLength(RECENT_SECURITY_LIMIT);
    });

    it("answers with an empty set when the browser sent nothing", async () => {
      expect(await recentSymbols(guest)).toEqual([]);
    });

    it("ignores ids sent by an authenticated caller", async () => {
      await view(owner, securityIds[0]!);

      expect(
        await recentSymbols(owner, `?ids=${securityIds[3]},${securityIds[4]}`),
      ).toEqual([security(1).symbol]);
    });

    /**
     * A guest's recents live in their browser, so there is nothing here for this write to do. A 401
     * is honest about that; the client treats it exactly like any other failure of a call whose
     * success the page never depends on.
     */
    it("cannot record a view", async () => {
      await guest
        .post("/recent-searches")
        .send({ securityId: securityIds[0]! })
        .expect(401);
    });
  });
});
