import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { ListsModule } from "./lists.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> StockListsService -> real PostgreSQL, exercising ownership scoping, membership
 * idempotency, buy-window normalization persistence, and FK cascades. The Redis/FMP-backed stocks
 * module is deliberately not compiled: lists depend only on the local catalog rows this suite
 * seeds and removes itself.
 */
describe("stock lists", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `list-owner-${suffix}@example.test`;
  const otherEmail = `list-other-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let securityIds: string[] = [];

  function security(index: number) {
    return {
      providerSymbol: `LST${index}-${suffix}`,
      symbol: `LST${index}-${suffix.slice(0, 8).toUpperCase()}`,
      name: `List Test Security ${index}`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      currency: "USD",
      type: "STOCK" as const,
      isAdr: false,
      isActivelyTrading: true,
    };
  }

  async function createListViaApi(
    agent: ReturnType<typeof request.agent>,
    body: object,
  ): Promise<StockListDetailResponse> {
    const response = await agent.post("/lists").send(body).expect(201);
    return response.body as StockListDetailResponse;
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigurationModule, DatabaseModule, AuthModule, ListsModule],
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
      data: [security(1), security(2), security(3)],
    });
    securityIds = (
      await prisma.security.findMany({
        where: { providerSymbol: { in: [1, 2, 3].map((i) => `LST${i}-${suffix}`) } },
        orderBy: { providerSymbol: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);

    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password })
      .expect(200);
  });

  afterAll(async () => {
    if (prisma) {
      // Lists, items, and windows cascade from the users.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: [1, 2, 3].map((i) => `LST${i}-${suffix}`) } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("requires authentication on every route", async () => {
    const anonymous = request(app.getHttpServer());
    await anonymous.get("/lists").expect(401);
    await anonymous.post("/lists").send({ name: "x" }).expect(401);
    await anonymous.get(`/lists/${randomUUID()}`).expect(401);
    await anonymous.patch(`/lists/${randomUUID()}`).send({ name: "x" }).expect(401);
    await anonymous.delete(`/lists/${randomUUID()}`).expect(401);
    await anonymous
      .post(`/lists/${randomUUID()}/items`)
      .send({ securityIds: [randomUUID()] })
      .expect(401);
    await anonymous
      .delete(`/lists/${randomUUID()}/items/${randomUUID()}`)
      .expect(401);
    await anonymous
      .put(`/lists/${randomUUID()}/items/${randomUUID()}/buy-windows`)
      .send({ mode: "FULL", ranges: [] })
      .expect(401);
  });

  it("creates an empty list and lists it with a zero item count", async () => {
    const created = await createListViaApi(owner, {
      name: `  Empty ${suffix}  `,
      description: "   ",
    });
    expect(created.name).toBe(`Empty ${suffix}`);
    expect(created.description).toBeUndefined();
    expect(created.items).toEqual([]);

    const listed = await owner.get("/lists").expect(200);
    const summaries = listed.body as StockListSummaryResponse[];
    const summary = summaries.find((entry) => entry.id === created.id);
    expect(summary).toMatchObject({ name: `Empty ${suffix}`, itemCount: 0 });
    expect(summary?.description).toBeUndefined();

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("creates a list with initial securities in one atomic request", async () => {
    const created = await createListViaApi(owner, {
      name: "Seeded",
      description: "Initial members",
      securityIds: [securityIds[0], securityIds[1]],
    });

    expect(created.description).toBe("Initial members");
    expect(created.items).toHaveLength(2);
    for (const item of created.items) {
      expect(item.buyWindowMode).toBe("FULL");
      expect(item.buyWindows).toEqual([]);
      expect(item.security.name).toContain("List Test Security");
      expect(item.security.exchangeCode).toBe("NASDAQ");
    }
    expect(new Set(created.items.map((item) => item.security.id))).toEqual(
      new Set([securityIds[0], securityIds[1]]),
    );

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("rejects creating a list that references a security outside the catalog", async () => {
    const response = await owner
      .post("/lists")
      .send({ name: "Bad", securityIds: [securityIds[0], randomUUID()] })
      .expect(400);
    expect(response.body.message).toContain("not in the supported catalog");

    // The rejection is atomic: no partial list was created.
    const listed = await owner.get("/lists").expect(200);
    expect(
      (listed.body as StockListSummaryResponse[]).some(
        (entry) => entry.name === "Bad",
      ),
    ).toBe(false);
  });

  it("validates the list name", async () => {
    await owner.post("/lists").send({ name: "   " }).expect(400);
    await owner.post("/lists").send({}).expect(400);
    await owner.post("/lists").send({ name: "x".repeat(121) }).expect(400);
  });

  it("renames a list and clears its description", async () => {
    const created = await createListViaApi(owner, {
      name: "Before",
      description: "Old words",
    });

    const renamed = await owner
      .patch(`/lists/${created.id}`)
      .send({ name: "After", description: null })
      .expect(200);
    expect(renamed.body).toMatchObject({ id: created.id, name: "After" });
    expect(renamed.body.description).toBeUndefined();

    const reread = await owner.get(`/lists/${created.id}`).expect(200);
    expect(reread.body.name).toBe("After");

    await owner.patch(`/lists/${created.id}`).send({}).expect(400);
    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("adds securities idempotently and removes them", async () => {
    const created = await createListViaApi(owner, { name: "Members" });

    const added = await owner
      .post(`/lists/${created.id}/items`)
      .send({ securityIds: [securityIds[0], securityIds[1]] })
      .expect(200);
    const afterAdd = added.body as StockListDetailResponse;
    expect(afterAdd.items).toHaveLength(2);

    // Re-adding an existing member plus one new member converges instead of duplicating.
    const readded = await owner
      .post(`/lists/${created.id}/items`)
      .send({ securityIds: [securityIds[0], securityIds[2]] })
      .expect(200);
    const afterReadd = readded.body as StockListDetailResponse;
    expect(afterReadd.items).toHaveLength(3);
    expect(
      new Set(afterReadd.items.map((item) => item.security.id)),
    ).toEqual(new Set(securityIds));

    // Unknown securities are rejected without touching membership.
    await owner
      .post(`/lists/${created.id}/items`)
      .send({ securityIds: [randomUUID()] })
      .expect(400);
    await owner
      .post(`/lists/${created.id}/items`)
      .send({ securityIds: [] })
      .expect(400);

    const removedItem = afterReadd.items[0];
    await owner
      .delete(`/lists/${created.id}/items/${removedItem?.id}`)
      .expect(204);
    const reread = await owner.get(`/lists/${created.id}`).expect(200);
    expect((reread.body as StockListDetailResponse).items).toHaveLength(2);

    // Removing it again reports not-found rather than pretending to delete.
    await owner
      .delete(`/lists/${created.id}/items/${removedItem?.id}`)
      .expect(404);

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("persists CUSTOM buy windows in canonical normalized form and replaces them atomically", async () => {
    const created = await createListViaApi(owner, {
      name: "Windows",
      securityIds: [securityIds[0]],
    });
    const item = created.items[0] as StockListItemResponse;
    const windowsUrl = `/lists/${created.id}/items/${item.id}/buy-windows`;

    // Unordered, overlapping, adjacent, and duplicated input collapses to the canonical set.
    const custom = await owner
      .put(windowsUrl)
      .send({
        mode: "CUSTOM",
        ranges: [
          { startDate: "2023-01-01", endDate: null },
          { startDate: "2020-07-01", endDate: "2020-12-31" },
          { startDate: "2020-01-01", endDate: "2020-08-31" },
          { startDate: "2021-01-01", endDate: "2021-03-31" },
          { startDate: "2020-01-01", endDate: "2020-08-31" },
        ],
      })
      .expect(200);
    const canonical = custom.body as StockListItemResponse;
    expect(canonical.buyWindowMode).toBe("CUSTOM");
    expect(canonical.buyWindows).toEqual([
      { startDate: "2020-01-01", endDate: "2021-03-31" },
      { startDate: "2023-01-01", endDate: null },
    ]);

    // The persisted rows are exactly the canonical set.
    const storedCustom = await prisma.stockListBuyWindow.findMany({
      where: { stockListItemId: item.id },
      orderBy: { startDate: "asc" },
    });
    expect(
      storedCustom.map((row) => ({
        start: row.startDate.toISOString().slice(0, 10),
        end: row.endDate?.toISOString().slice(0, 10) ?? null,
      })),
    ).toEqual([
      { start: "2020-01-01", end: "2021-03-31" },
      { start: "2023-01-01", end: null },
    ]);

    // A second submission REPLACES the configuration rather than accumulating.
    const replaced = await owner
      .put(windowsUrl)
      .send({
        mode: "CUSTOM",
        ranges: [{ startDate: "2019-06-01", endDate: "2019-12-31" }],
      })
      .expect(200);
    expect((replaced.body as StockListItemResponse).buyWindows).toEqual([
      { startDate: "2019-06-01", endDate: "2019-12-31" },
    ]);
    expect(
      await prisma.stockListBuyWindow.count({
        where: { stockListItemId: item.id },
      }),
    ).toBe(1);

    // Switching back to FULL removes every persisted row.
    const full = await owner
      .put(windowsUrl)
      .send({ mode: "FULL", ranges: [] })
      .expect(200);
    expect(full.body).toMatchObject({ buyWindowMode: "FULL", buyWindows: [] });
    expect(
      await prisma.stockListBuyWindow.count({
        where: { stockListItemId: item.id },
      }),
    ).toBe(0);

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("rejects invalid buy-window submissions", async () => {
    const created = await createListViaApi(owner, {
      name: "Window validation",
      securityIds: [securityIds[0]],
    });
    const item = created.items[0] as StockListItemResponse;
    const windowsUrl = `/lists/${created.id}/items/${item.id}/buy-windows`;

    // CUSTOM needs at least one range.
    await owner.put(windowsUrl).send({ mode: "CUSTOM", ranges: [] }).expect(400);
    // FULL must not carry ranges.
    await owner
      .put(windowsUrl)
      .send({
        mode: "FULL",
        ranges: [{ startDate: "2020-01-01", endDate: null }],
      })
      .expect(400);
    // Inverted and malformed dates.
    await owner
      .put(windowsUrl)
      .send({
        mode: "CUSTOM",
        ranges: [{ startDate: "2021-01-01", endDate: "2020-01-01" }],
      })
      .expect(400);
    await owner
      .put(windowsUrl)
      .send({
        mode: "CUSTOM",
        ranges: [{ startDate: "2020-13-01", endDate: null }],
      })
      .expect(400);
    await owner.put(windowsUrl).send({ mode: "SOMETIMES", ranges: [] }).expect(400);

    // Nothing was persisted by any rejected submission.
    const reread = await owner.get(`/lists/${created.id}`).expect(200);
    expect((reread.body as StockListDetailResponse).items[0]).toMatchObject({
      buyWindowMode: "FULL",
      buyWindows: [],
    });

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("denies every cross-user access without revealing that the list exists", async () => {
    const created = await createListViaApi(owner, {
      name: "Private",
      securityIds: [securityIds[0]],
    });
    const item = created.items[0] as StockListItemResponse;

    const read = await other.get(`/lists/${created.id}`).expect(404);
    const missing = await other.get(`/lists/${randomUUID()}`).expect(404);
    // A foreign list answers exactly like a nonexistent one.
    expect(read.body.message).toBe(missing.body.message);

    await other
      .patch(`/lists/${created.id}`)
      .send({ name: "Taken over" })
      .expect(404);
    await other.delete(`/lists/${created.id}`).expect(404);
    await other
      .post(`/lists/${created.id}/items`)
      .send({ securityIds: [securityIds[1]] })
      .expect(404);
    await other
      .delete(`/lists/${created.id}/items/${item.id}`)
      .expect(404);
    await other
      .put(`/lists/${created.id}/items/${item.id}/buy-windows`)
      .send({
        mode: "CUSTOM",
        ranges: [{ startDate: "2020-01-01", endDate: null }],
      })
      .expect(404);

    // The other user's own collection never shows the foreign list.
    const listed = await other.get("/lists").expect(200);
    expect(
      (listed.body as StockListSummaryResponse[]).some(
        (entry) => entry.id === created.id,
      ),
    ).toBe(false);

    // And nothing about the list changed.
    const reread = await owner.get(`/lists/${created.id}`).expect(200);
    const unchanged = reread.body as StockListDetailResponse;
    expect(unchanged.name).toBe("Private");
    expect(unchanged.items).toHaveLength(1);
    expect(unchanged.items[0]).toMatchObject({
      buyWindowMode: "FULL",
      buyWindows: [],
    });

    await owner.delete(`/lists/${created.id}`).expect(204);
  });

  it("cascades deletes: removing an item drops its windows, removing a list drops everything", async () => {
    const created = await createListViaApi(owner, {
      name: "Cascade",
      securityIds: [securityIds[0], securityIds[1]],
    });
    const [first, second] = created.items as StockListItemResponse[];
    for (const item of [first, second]) {
      await owner
        .put(`/lists/${created.id}/items/${item?.id}/buy-windows`)
        .send({
          mode: "CUSTOM",
          ranges: [{ startDate: "2020-01-01", endDate: "2020-12-31" }],
        })
        .expect(200);
    }

    await owner.delete(`/lists/${created.id}/items/${first?.id}`).expect(204);
    expect(
      await prisma.stockListBuyWindow.count({
        where: { stockListItemId: first?.id ?? "" },
      }),
    ).toBe(0);

    await owner.delete(`/lists/${created.id}`).expect(204);
    expect(
      await prisma.stockListItem.count({
        where: { stockListId: created.id },
      }),
    ).toBe(0);
    expect(
      await prisma.stockListBuyWindow.count({
        where: { stockListItemId: second?.id ?? "" },
      }),
    ).toBe(0);
    await owner.get(`/lists/${created.id}`).expect(404);
  });
});
