import { randomUUID } from "node:crypto";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient, UserRole } from "@intrinsic/database";
import type {
  FmpSecurityCatalogPort,
  MappedFmpSecurityListing,
} from "@intrinsic/fmp";
import {
  InMemoryLoadCoordinator,
  NullStockDataCache,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
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

/**
 * End-to-end contract for the admin catalog synchronization against real PostgreSQL.
 *
 * The provider is faked, but persistence, guards, HTTP shape and the resulting searchability of
 * synchronized securities are real. Fixture symbols share one random tag so this suite can clean
 * up exactly its own rows in a shared test database.
 */

const tag = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
const SYMBOLS = {
  equity: `Z${tag}A`,
  second: `Z${tag}B`,
  etf: `Z${tag}E`,
  foreign: `Z${tag}F`,
};

function listing(
  symbol: string,
  overrides: Partial<MappedFmpSecurityListing["listing"]> = {},
): MappedFmpSecurityListing {
  return {
    providerSymbol: symbol,
    listing: {
      symbol,
      name: `${symbol} Holdings`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      country: "US",
      sector: "Technology",
      industry: "Software",
      isEtf: false,
      isFund: false,
      isActivelyTrading: true,
      ...overrides,
    },
  };
}

/**
 * Also implements the per-stock read port so it can stand in for the single FMP client provider.
 * Every heavy-data method throws: a catalog synchronization that reached one would fail loudly.
 */
class FakeCatalogProvider implements FmpSecurityCatalogPort {
  universe = new Map<string, MappedFmpSecurityListing[]>();
  readonly requestedExchanges: string[] = [];

  async getStockUniverse(exchangeCode: string) {
    this.requestedExchanges.push(exchangeCode);
    return this.universe.get(exchangeCode) ?? [];
  }

  async getProfile() {
    throw new Error(
      "Catalog synchronization must not fetch per-stock profiles",
    );
  }

  async getDailyPrices(): Promise<never> {
    throw new Error("Catalog synchronization must not fetch prices");
  }

  async getFinancialStatements(): Promise<never> {
    throw new Error("Catalog synchronization must not fetch fundamentals");
  }
}

describe("admin security catalog synchronization", () => {
  const password = "Local-test-password-42";
  const adminEmail = `catalog-admin-${tag.toLowerCase()}@example.test`;
  const userEmail = `catalog-user-${tag.toLowerCase()}@example.test`;
  const provider = new FakeCatalogProvider();

  let app: INestApplication;
  let prisma: PrismaService;

  async function adminAgent() {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: adminEmail, password })
      .expect(200);
    return agent;
  }

  async function sync() {
    const agent = await adminAgent();
    const response = await agent.post("/admin/securities/sync").expect(200);
    return response.body;
  }

  async function catalogRows() {
    return prisma.security.findMany({
      where: { providerSymbol: { startsWith: `Z${tag}` } },
      orderBy: { providerSymbol: "asc" },
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
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    // Password login requires a verified address, and this suite is about authorization rather
    // than the verification flow.
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: adminEmail, passwordHash, emailVerifiedAt, role: UserRole.ADMIN },
        { email: userEmail, passwordHash, emailVerifiedAt, role: UserRole.USER },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.security.deleteMany({
        where: { providerSymbol: { startsWith: `Z${tag}` } },
      });
      await prisma.user.deleteMany({
        where: { email: { in: [adminEmail, userEmail] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    provider.universe.clear();
    provider.requestedExchanges.length = 0;
    await prisma.security.deleteMany({
      where: { providerSymbol: { startsWith: `Z${tag}` } },
    });
  });

  it("requires an ADMIN session", async () => {
    await request(app.getHttpServer())
      .post("/admin/securities/sync")
      .expect(401);

    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);
    await agent.post("/admin/securities/sync").expect(403);
  });

  it("obtains the universe in bulk and inserts supported records", async () => {
    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity),
      listing(SYMBOLS.second),
    ]);

    const summary = await sync();

    expect(provider.requestedExchanges).toEqual(["NASDAQ", "NYSE", "AMEX"]);
    expect(summary).toMatchObject({
      received: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      skipped: 0,
      failed: 0,
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const rows = await catalogRows();
    expect(rows.map((row) => row.symbol)).toEqual([
      SYMBOLS.equity,
      SYMBOLS.second,
    ]);
    expect(rows[0]).toMatchObject({
      name: `${SYMBOLS.equity} Holdings`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      currency: "USD",
      country: "US",
      sector: "Technology",
      type: "STOCK",
      isActivelyTrading: true,
    });
  });

  it("is idempotent across repeated synchronizations", async () => {
    provider.universe.set("NASDAQ", [listing(SYMBOLS.equity)]);

    const first = await sync();
    const second = await sync();

    expect(first).toMatchObject({ created: 1, unchanged: 0 });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(await catalogRows()).toHaveLength(1);
  });

  it("updates changed lightweight metadata on an existing row", async () => {
    provider.universe.set("NASDAQ", [listing(SYMBOLS.equity)]);
    await sync();

    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity, {
        name: "Renamed Holdings",
        sector: "Industrials",
      }),
    ]);
    const summary = await sync();

    expect(summary).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect((await catalogRows())[0]).toMatchObject({
      name: "Renamed Holdings",
      sector: "Industrials",
    });
  });

  it("synchronizes an upstream deactivation without deleting the identity", async () => {
    provider.universe.set("NASDAQ", [listing(SYMBOLS.equity)]);
    await sync();
    const createdId = (await catalogRows())[0]?.id;

    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity, { isActivelyTrading: false }),
    ]);
    const summary = await sync();

    expect(summary).toMatchObject({ updated: 1, deactivated: 1 });
    const rows = await catalogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(createdId);
    expect(rows[0]?.isActivelyTrading).toBe(false);
  });

  it("keeps a security that vanished from the upstream response", async () => {
    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity),
      listing(SYMBOLS.second),
    ]);
    await sync();

    provider.universe.set("NASDAQ", [listing(SYMBOLS.equity)]);
    const summary = await sync();

    expect(summary).toMatchObject({ received: 1, unchanged: 1, failed: 0 });
    // Absence from one response never hard-deletes a historical identity.
    expect((await catalogRows()).map((row) => row.symbol)).toEqual([
      SYMBOLS.equity,
      SYMBOLS.second,
    ]);
  });

  it("skips non-equity and unsupported-exchange records", async () => {
    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity),
      listing(SYMBOLS.etf, { isEtf: true }),
      listing(SYMBOLS.foreign, { exchangeCode: "LSE" }),
    ]);

    const summary = await sync();

    expect(summary).toMatchObject({ received: 3, created: 1, skipped: 2 });
    expect((await catalogRows()).map((row) => row.symbol)).toEqual([
      SYMBOLS.equity,
    ]);
  });

  it("loads catalog identity only, never stock history", async () => {
    provider.universe.set("NASDAQ", [listing(SYMBOLS.equity)]);

    // The fake provider throws on every heavy-data method, so a clean 201 already proves no
    // price, fundamental or profile request was made. The persisted side is asserted directly.
    await sync();
    const securityId = (await catalogRows())[0]?.id ?? "";

    expect(await prisma.dailyPrice.count({ where: { securityId } })).toBe(0);
    expect(
      await prisma.financialStatement.count({ where: { securityId } }),
    ).toBe(0);
    expect(
      await prisma.dailyDerivedState.count({ where: { securityId } }),
    ).toBe(0);
    expect(
      await prisma.stockDatasetState.count({ where: { securityId } }),
    ).toBe(0);
    expect(await prisma.securityProfile.count({ where: { securityId } })).toBe(
      0,
    );
  });

  it("makes synchronized securities findable through the stock search", async () => {
    provider.universe.set("NASDAQ", [
      listing(SYMBOLS.equity, { name: `Synchronized ${tag} Robotics` }),
    ]);
    await sync();

    const bySymbol = await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: SYMBOLS.equity.toLowerCase() })
      .expect(200);
    expect(bySymbol.body).toEqual([
      {
        // The catalog row's durable id rides along so features such as stock lists can
        // reference the security without a second lookup.
        id: expect.stringMatching(/[0-9a-f-]{36}/) as unknown,
        symbol: SYMBOLS.equity,
        name: `Synchronized ${tag} Robotics`,
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
      },
    ]);

    const byName = await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: `synchronized ${tag} robotics` })
      .expect(200);
    expect(byName.body).toHaveLength(1);
  });

  it("returns not-found for a symbol the catalog does not list", async () => {
    const response = await request(app.getHttpServer())
      .get(`/stocks/${SYMBOLS.foreign}`)
      .expect(404);

    // No provider discovery happened: the fake throws on getProfile, which would surface as 503.
    expect(response.body.message).toBe("Stock symbol was not found");
  });
});

/** Guards against the suite leaking rows if the app fails to start. */
afterAll(async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.security.deleteMany({
      where: { providerSymbol: { startsWith: `Z${tag}` } },
    });
  } finally {
    await prisma.$disconnect();
  }
});
