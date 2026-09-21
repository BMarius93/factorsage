import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import type {
  StockListDetailResponse,
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
 * `POST /lists/:listId/duplicate`: HTTP -> Nest -> StockListsService -> real PostgreSQL.
 *
 * A copy is a new list the caller owns, holding the source's configuration — members in order,
 * each member's buy windows, the description — under new identities, and nothing that records
 * history. The source may be the caller's own list or a built-in; anybody else's reads as missing.
 * The suite owns its users, catalog rows and built-ins, and removes them afterwards.
 */
describe("duplicating a stock list", () => {
  const suffix = randomUUID();
  const tag = suffix.slice(0, 8).toUpperCase();
  const password = "Local-test-password-42";
  const emails = {
    owner: `dup-list-owner-${suffix}@example.test`,
    other: `dup-list-other-${suffix}@example.test`,
    free: `dup-list-free-${suffix}@example.test`,
    downgraded: `dup-list-downgraded-${suffix}@example.test`,
  };
  const SECURITY_COUNT = 12;
  const providerSymbols = Array.from(
    { length: SECURITY_COUNT },
    (_, index) => `DUP${index + 1}-${suffix}`,
  );
  const builtInKeys = {
    small: `test-dup-small-${suffix}`,
    large: `test-dup-large-${suffix}`,
  };

  let app: INestApplication;
  let prisma: PrismaService;
  let anonymous: ReturnType<typeof request>;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let free: ReturnType<typeof request.agent>;
  let downgraded: ReturnType<typeof request.agent>;
  const userIds = { owner: "", other: "", free: "", downgraded: "" };
  /** Catalog ids, in `providerSymbols` order. */
  let securityIds: string[] = [];
  const builtIns = { small: "", large: "" };

  const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

  async function createList(
    agent: ReturnType<typeof request.agent>,
    name: string,
    members: readonly string[],
    description?: string,
  ): Promise<StockListDetailResponse> {
    const [first, ...rest] = members;
    const response = await agent
      .post("/lists")
      .send({
        name,
        ...(description ? { description } : {}),
        securityIds: first ? [first] : [],
      })
      .expect(201);
    const list = response.body as StockListDetailResponse;
    // One add per member, so each lands at its own instant and the list has a definite order.
    for (const securityId of rest) {
      await agent
        .post(`/lists/${list.id}/items`)
        .send({ securityIds: [securityId] })
        .expect(200);
    }
    return readList(agent, list.id);
  }

  async function readList(
    agent: ReturnType<typeof request.agent> | ReturnType<typeof request>,
    listId: string,
  ): Promise<StockListDetailResponse> {
    const response = await agent.get(`/lists/${listId}`).expect(200);
    return response.body as StockListDetailResponse;
  }

  async function setWindows(
    agent: ReturnType<typeof request.agent>,
    list: StockListDetailResponse,
    securityId: string,
    ranges: { startDate: string; endDate: string | null }[],
  ): Promise<void> {
    const item = list.items.find((entry) => entry.security.id === securityId);
    await agent
      .put(`/lists/${list.id}/items/${item!.id}/buy-windows`)
      .send({ mode: ranges.length === 0 ? "FULL" : "CUSTOM", ranges })
      .expect(200);
  }

  /** What a list *is*, as configuration: member, then eligibility — in list order, ids aside. */
  function configurationOf(list: StockListDetailResponse) {
    return list.items.map((item) => ({
      securityId: item.security.id,
      buyWindowMode: item.buyWindowMode,
      buyWindows: item.buyWindows,
    }));
  }

  async function listNamesOf(userId: string): Promise<string[]> {
    const rows = await prisma.stockList.findMany({
      where: { userId },
      select: { name: true },
    });
    return rows.map((row) => row.name);
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
    // A bound loopback port rather than `init()`: supertest would otherwise pick an ephemeral
    // wildcard port per request, which on macOS can collide with an editor helper's listener.
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: emails.owner, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: emails.other, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: emails.free, passwordHash, emailVerifiedAt, plan: "FREE" },
        // Starts on PRO so it can own a list that later outgrows its plan.
        {
          email: emails.downgraded,
          passwordHash,
          emailVerifiedAt,
          plan: "PRO",
        },
      ],
    });
    for (const user of await prisma.user.findMany({
      where: { email: { in: Object.values(emails) } },
      select: { id: true, email: true },
    })) {
      const role = (Object.keys(emails) as (keyof typeof emails)[]).find(
        (key) => emails[key] === user.email,
      )!;
      userIds[role] = user.id;
    }

    await prisma.security.createMany({
      data: providerSymbols.map((providerSymbol, index) => ({
        providerSymbol,
        symbol: `DUP${index + 1}-${tag}`,
        name: `Duplicate Test Security ${index + 1}`,
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        currency: "USD",
        type: "STOCK" as const,
        isAdr: false,
        isActivelyTrading: true,
      })),
    });
    const bySymbol = new Map(
      (
        await prisma.security.findMany({
          where: { providerSymbol: { in: providerSymbols } },
          select: { id: true, providerSymbol: true },
        })
      ).map((row) => [row.providerSymbol, row.id]),
    );
    securityIds = providerSymbols.map((symbol) => bySymbol.get(symbol)!);

    // Built-ins as the bootstrap writes them: SYSTEM-owned, keyed, ordered, last edited by an
    // administrator. `updatedByUserId` is set so the suite can prove it never reaches a copy.
    const small = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: builtInKeys.small,
        name: `Built-in Leaders ${tag}`,
        description: "A built-in universe.",
        displayOrder: 901,
        updatedByUserId: userIds.other,
        items: {
          create: [
            { securityId: securityIds[0]!, buyWindowMode: "FULL" },
            {
              securityId: securityIds[1]!,
              buyWindowMode: "CUSTOM",
              buyWindows: {
                create: [{ startDate: day("2024-01-02"), endDate: null }],
              },
            },
          ],
        },
      },
    });
    builtIns.small = small.id;
    const large = await prisma.stockList.create({
      data: {
        ownership: "SYSTEM",
        systemKey: builtInKeys.large,
        name: `Built-in Eleven ${tag}`,
        displayOrder: 902,
      },
    });
    builtIns.large = large.id;
    for (const securityId of securityIds.slice(0, 11)) {
      await prisma.stockListItem.create({
        data: { stockListId: large.id, securityId },
      });
    }

    anonymous = request(app.getHttpServer());
    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    free = request.agent(app.getHttpServer());
    downgraded = request.agent(app.getHttpServer());
    for (const [agent, email] of [
      [owner, emails.owner],
      [other, emails.other],
      [free, emails.free],
      [downgraded, emails.downgraded],
    ] as const) {
      await agent.post("/auth/login").send({ email, password }).expect(200);
    }
  });

  afterAll(async () => {
    if (prisma) {
      // Monitors restrict their list's deletion, so they go first; lists, items and windows then
      // cascade from their users and built-ins are removed by key.
      await prisma.monitor.deleteMany({
        where: { userId: { in: Object.values(userIds) } },
      });
      await prisma.strategy.deleteMany({
        where: { userId: { in: Object.values(userIds) } },
      });
      await prisma.stockList.deleteMany({
        where: { systemKey: { in: Object.values(builtInKeys) } },
      });
      await prisma.user.deleteMany({
        where: { email: { in: Object.values(emails) } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("copies the caller's own list into a new one they own: members, order, windows and description", async () => {
    // Added out of symbol order, so the copy has to preserve the list's own order, not re-sort it.
    const [first, second, third] = [
      securityIds[2]!,
      securityIds[0]!,
      securityIds[1]!,
    ];
    let source = await createList(
      owner,
      `Source ${tag}`,
      [first, second, third],
      "The source universe.",
    );
    // A multi-period member whose last period is open-ended, a bounded one, and an unrestricted one.
    await setWindows(owner, source, second, [
      { startDate: "2001-03-10", endDate: "2008-07-15" },
      { startDate: "2012-05-01", endDate: null },
    ]);
    await setWindows(owner, source, third, [
      { startDate: "2020-01-01", endDate: "2020-12-31" },
    ]);
    source = await readList(owner, source.id);

    const response = await owner
      .post(`/lists/${source.id}/duplicate`)
      .send({ name: `  Copy ${tag}  ` })
      .expect(201);
    const copy = response.body as StockListDetailResponse;

    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: `Copy ${tag}`,
      description: "The source universe.",
      ownership: "USER",
      canEdit: true,
      compliance: { symbolCount: 3, symbolLimit: 100, compliant: true },
    });
    expect(copy.systemKey).toBeUndefined();
    expect(copy.items.map((item) => item.security.id)).toEqual([
      first,
      second,
      third,
    ]);
    expect(configurationOf(copy)).toEqual(configurationOf(source));
    expect(copy.items.find((item) => item.security.id === first)).toMatchObject(
      { buyWindowMode: "FULL", buyWindows: [] },
    );
    expect(
      copy.items.find((item) => item.security.id === second)?.buyWindows,
    ).toEqual([
      { startDate: "2001-03-10", endDate: "2008-07-15" },
      { startDate: "2012-05-01", endDate: null },
    ]);

    // Every row is new: the list, each membership and each window.
    const sourceItemIds = source.items.map((item) => item.id);
    expect(copy.items.some((item) => sourceItemIds.includes(item.id))).toBe(
      false,
    );
    const windowRows = async (listId: string) =>
      prisma.stockListBuyWindow.findMany({
        where: { item: { stockListId: listId } },
        select: { id: true, stockListItemId: true },
      });
    const [sourceWindows, copyWindows] = await Promise.all([
      windowRows(source.id),
      windowRows(copy.id),
    ]);
    expect(copyWindows).toHaveLength(3);
    expect(sourceWindows).toHaveLength(3);
    const sourceWindowIds = sourceWindows.map((row) => row.id);
    expect(copyWindows.some((row) => sourceWindowIds.includes(row.id))).toBe(
      false,
    );
    const copyItemIds = copy.items.map((item) => item.id);
    expect(
      copyWindows.every((row) => copyItemIds.includes(row.stockListItemId)),
    ).toBe(true);

    // The order is held by the members' own creation instants, strictly increasing in the source's
    // order — never left to the tie-break on the copy's new, random ids.
    const copyMembers = await prisma.stockListItem.findMany({
      where: { stockListId: copy.id },
      orderBy: { createdAt: "asc" },
      select: { securityId: true, createdAt: true },
    });
    expect(copyMembers.map((member) => member.securityId)).toEqual([
      first,
      second,
      third,
    ]);
    const instants = copyMembers.map((member) => member.createdAt.getTime());
    expect(new Set(instants).size).toBe(instants.length);

    // Owned by the caller, as an ordinary list.
    const row = await prisma.stockList.findUniqueOrThrow({
      where: { id: copy.id },
    });
    expect(row).toMatchObject({
      userId: userIds.owner,
      ownership: "USER",
      systemKey: null,
      displayOrder: null,
      updatedByUserId: null,
    });

    // The source is exactly as it was, and both appear in the caller's collection.
    expect(await readList(owner, source.id)).toEqual(source);
    expect(await readList(owner, copy.id)).toEqual(copy);
    const collection = (await owner.get("/lists").expect(200))
      .body as StockListSummaryResponse[];
    expect(collection.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([source.id, copy.id]),
    );
  });

  it("keeps the copy and its source independent in both directions", async () => {
    const [shared, dropped, added] = [
      securityIds[3]!,
      securityIds[4]!,
      securityIds[5]!,
    ];
    let source = await createList(owner, `Independent ${tag}`, [
      shared,
      dropped,
    ]);
    await setWindows(owner, source, shared, [
      { startDate: "2015-06-01", endDate: null },
    ]);
    source = await readList(owner, source.id);
    const copy = (
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({ name: `Independent copy ${tag}` })
        .expect(201)
    ).body as StockListDetailResponse;

    // Every kind of change to the copy: rename, add, remove, re-window.
    await owner
      .patch(`/lists/${copy.id}`)
      .send({ name: `Renamed copy ${tag}`, description: "Changed." })
      .expect(200);
    await owner
      .post(`/lists/${copy.id}/items`)
      .send({ securityIds: [added] })
      .expect(200);
    const droppedInCopy = copy.items.find(
      (item) => item.security.id === dropped,
    )!;
    await owner
      .delete(`/lists/${copy.id}/items/${droppedInCopy.id}`)
      .expect(204);
    await setWindows(owner, copy, shared, []);
    expect(await readList(owner, source.id)).toEqual(source);

    // And the other way round: the copy keeps what it had when the source moves on.
    const copyBefore = await readList(owner, copy.id);
    await setWindows(owner, source, shared, [
      { startDate: "1999-01-04", endDate: "2003-12-31" },
    ]);
    const droppedInSource = source.items.find(
      (item) => item.security.id === dropped,
    )!;
    await owner
      .delete(`/lists/${source.id}/items/${droppedInSource.id}`)
      .expect(204);
    await owner.delete(`/lists/${source.id}`).expect(204);
    expect(await readList(owner, copy.id)).toEqual(copyBefore);
  });

  it("copies a built-in list into an ordinary list the caller owns, and leaves the built-in alone", async () => {
    const builtInBefore = await readList(owner, builtIns.small);
    const builtInRowBefore = await prisma.stockList.findUniqueOrThrow({
      where: { id: builtIns.small },
    });
    expect(builtInBefore).toMatchObject({
      ownership: "SYSTEM",
      canEdit: false,
    });

    const copy = (
      await owner
        .post(`/lists/${builtIns.small}/duplicate`)
        .send({ name: `Built-in Leaders ${tag} — Copy` })
        .expect(201)
    ).body as StockListDetailResponse;

    expect(copy).toMatchObject({
      name: `Built-in Leaders ${tag} — Copy`,
      description: "A built-in universe.",
      ownership: "USER",
      canEdit: true,
      // A customer's list, so it is measured against the plan like any other.
      compliance: { symbolCount: 2, symbolLimit: 100, compliant: true },
    });
    expect(copy.systemKey).toBeUndefined();
    expect(configurationOf(copy)).toEqual(configurationOf(builtInBefore));
    expect(
      copy.items.find((item) => item.security.id === securityIds[1])
        ?.buyWindows,
    ).toEqual([{ startDate: "2024-01-02", endDate: null }]);

    // No built-in property travels: not the ownership, the key, the order or the audit column.
    expect(
      await prisma.stockList.findUniqueOrThrow({ where: { id: copy.id } }),
    ).toMatchObject({
      userId: userIds.owner,
      ownership: "USER",
      systemKey: null,
      displayOrder: null,
      updatedByUserId: null,
    });

    // The built-in is untouched, down to its audit columns.
    expect(await readList(owner, builtIns.small)).toEqual(builtInBefore);
    expect(
      await prisma.stockList.findUniqueOrThrow({
        where: { id: builtIns.small },
      }),
    ).toEqual(builtInRowBefore);

    // Editable where the built-in is not.
    await owner
      .patch(`/lists/${builtIns.small}`)
      .send({ name: "Mine now" })
      .expect(403);
    await owner
      .post(`/lists/${copy.id}/items`)
      .send({ securityIds: [securityIds[6]] })
      .expect(200);

    // Detached from the built-in: a later administrator edit does not reach the copy.
    const copyBefore = await readList(owner, copy.id);
    await prisma.stockListItem.deleteMany({
      where: { stockListId: builtIns.small, securityId: securityIds[0] },
    });
    expect(await readList(owner, copy.id)).toEqual(copyBefore);
    await prisma.stockListItem.create({
      data: { stockListId: builtIns.small, securityId: securityIds[0]! },
    });

    // And deletable, as the built-in never is.
    await owner.delete(`/lists/${copy.id}`).expect(204);
    await owner.delete(`/lists/${builtIns.small}`).expect(403);
  });

  it("answers another customer's list exactly like one that does not exist, and copies nothing", async () => {
    const hidden = await createList(owner, `Private ${tag}`, [securityIds[7]!]);

    const refused = await other
      .post(`/lists/${hidden.id}/duplicate`)
      .send({ name: "Stolen" })
      .expect(404);
    const missing = await other
      .post(`/lists/${randomUUID()}/duplicate`)
      .send({ name: "Stolen" })
      .expect(404);
    expect(refused.body).toEqual(missing.body);
    expect(JSON.stringify(refused.body)).not.toContain(`Private ${tag}`);
    expect(await listNamesOf(userIds.other)).toEqual([]);
  });

  it("requires a session, and creates nothing without one", async () => {
    await anonymous
      .post(`/lists/${builtIns.small}/duplicate`)
      .send({ name: `Guest copy ${tag}` })
      .expect(401);
    await anonymous
      .post(`/lists/${randomUUID()}/duplicate`)
      .send({ name: `Guest copy ${tag}` })
      .expect(401);
    expect(
      await prisma.stockList.count({ where: { name: `Guest copy ${tag}` } }),
    ).toBe(0);
  });

  it("holds the copy to the caller's plan, a built-in's copy included", async () => {
    // Eleven members on a ten-stock plan: a built-in may hold them, a customer's list may not.
    const refused = await free
      .post(`/lists/${builtIns.large}/duplicate`)
      .send({ name: `Too large ${tag}` })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: "ENTITLEMENT_LIST_SYMBOL_LIMIT",
      limit: 10,
      requested: 11,
    });
    expect(await listNamesOf(userIds.free)).toEqual([]);

    // Within the plan, the same account copies a built-in normally.
    await free
      .post(`/lists/${builtIns.small}/duplicate`)
      .send({ name: `Fits ${tag}` })
      .expect(201);
    expect(await listNamesOf(userIds.free)).toEqual([`Fits ${tag}`]);

    // A list that outgrew its plan after a downgrade stays readable, but copying it would create a
    // new over-limit list, which the plan does not allow.
    const oversized = await createList(
      downgraded,
      `Grandfathered ${tag}`,
      securityIds.slice(0, 11),
    );
    await prisma.user.update({
      where: { id: userIds.downgraded },
      data: { plan: "FREE" },
    });
    const downgradedRefusal = await downgraded
      .post(`/lists/${oversized.id}/duplicate`)
      .send({ name: `Grandfathered copy ${tag}` })
      .expect(403);
    expect(downgradedRefusal.body).toMatchObject({
      code: "ENTITLEMENT_LIST_SYMBOL_LIMIT",
    });
    expect(await listNamesOf(userIds.downgraded)).toEqual([
      `Grandfathered ${tag}`,
    ]);
  });

  it("validates the name exactly as a new list's name, and takes nothing else from the request", async () => {
    const source = await createList(
      owner,
      `Named ${tag}`,
      [securityIds[8]!],
      "Kept.",
    );
    const before = await prisma.stockList.count({
      where: { userId: userIds.owner },
    });

    for (const body of [
      {},
      { name: "" },
      { name: "   " },
      { name: 42 },
      { name: "x".repeat(121) },
    ]) {
      await owner.post(`/lists/${source.id}/duplicate`).send(body).expect(400);
    }
    expect(
      await prisma.stockList.count({ where: { userId: userIds.owner } }),
    ).toBe(before);

    // Membership and description come from the source, whatever the body claims.
    const copy = (
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({
          name: "y".repeat(120),
          description: "Injected.",
          securityIds: [securityIds[9]],
        })
        .expect(201)
    ).body as StockListDetailResponse;
    expect(copy.name).toBe("y".repeat(120));
    expect(copy.description).toBe("Kept.");
    expect(copy.items.map((item) => item.security.id)).toEqual([
      securityIds[8],
    ]);

    // Names are not unique, so duplicating twice under one name is two lists.
    const again = (
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({ name: "y".repeat(120) })
        .expect(201)
    ).body as StockListDetailResponse;
    expect(again.id).not.toBe(copy.id);
  });

  it("copies configuration only: the source's monitors stay with the source", async () => {
    const source = await createList(owner, `Watched ${tag}`, [
      securityIds[10]!,
    ]);
    const strategy = await prisma.strategy.create({
      data: { userId: userIds.owner, name: `Watching strategy ${tag}` },
    });
    // Switched off, so no concurrently running monitor cycle ever picks this fixture up.
    const monitor = await prisma.monitor.create({
      data: {
        userId: userIds.owner,
        name: `Watching ${tag}`,
        strategyId: strategy.id,
        stockListId: source.id,
        enabled: false,
      },
    });

    const copy = (
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({ name: `Unwatched ${tag}` })
        .expect(201)
    ).body as StockListDetailResponse;

    expect(
      await prisma.monitor.count({ where: { stockListId: copy.id } }),
    ).toBe(0);
    expect(
      await prisma.backtestRun.count({ where: { stockListId: copy.id } }),
    ).toBe(0);
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitor.id } }))
        .stockListId,
    ).toBe(source.id);
    // Nothing references the copy, so it deletes even while its source cannot.
    await owner.delete(`/lists/${source.id}`).expect(409);
    await owner.delete(`/lists/${copy.id}`).expect(204);
  });

  it("leaves nothing behind when writing the copy fails part-way", async () => {
    const sentinel = "1901-01-01";
    const source = await createList(owner, `Fragile ${tag}`, [
      securityIds[0]!,
      securityIds[11]!,
    ]);
    await setWindows(owner, source, securityIds[11]!, [
      { startDate: sentinel, endDate: null },
    ]);
    const itemsBefore = await prisma.stockListItem.count({
      where: { stockList: { userId: userIds.owner } },
    });

    // The list row and the first member are written before the second member's window, which this
    // trigger refuses — so the only way to end with no copy is for the whole write to roll back.
    const name = `dup_fail_${suffix.replace(/-/g, "_")}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."startDate" = DATE '${sentinel}' THEN
          RAISE EXCEPTION 'simulated failure while copying buy windows';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${name}" BEFORE INSERT ON "StockListBuyWindow" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
    );
    try {
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({ name: `Half a copy ${tag}` })
        .expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${name}" ON "StockListBuyWindow"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
    }

    expect(
      await prisma.stockList.count({ where: { name: `Half a copy ${tag}` } }),
    ).toBe(0);
    expect(
      await prisma.stockListItem.count({
        where: { stockList: { userId: userIds.owner } },
      }),
    ).toBe(itemsBefore);

    // With the fault gone the same request succeeds, windows and all.
    const copy = (
      await owner
        .post(`/lists/${source.id}/duplicate`)
        .send({ name: `Half a copy ${tag}` })
        .expect(201)
    ).body as StockListDetailResponse;
    expect(configurationOf(copy)).toEqual(
      configurationOf(await readList(owner, source.id)),
    );
  });
});
