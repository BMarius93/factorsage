import { randomUUID } from "node:crypto";
import { PrismaClient } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findQaPersonaUsers,
  resetQaPersonaContent,
  totalDeleted,
} from "./qa-personas";

useTestDatabase();

/**
 * `pnpm qa:reset` deletes rows, so the property worth a test is not "it empties a persona" but
 * **"it empties nothing else"**.
 *
 * Three owners are built here and the reset is run for exactly one of them: the QA persona, an
 * unrelated customer, and `SYSTEM` (built-in content, `userId = null`, invariant 21). The
 * assertions are about the two that must survive.
 */
describe("QA persona reset", () => {
  const suffix = randomUUID();
  const prisma = new PrismaClient();

  const personaEmail = `qa-reset-persona-${suffix}@example.test`;
  const bystanderEmail = `qa-reset-bystander-${suffix}@example.test`;

  let personaId = "";
  let bystanderId = "";
  let securityId = "";
  let systemListId = "";
  let systemStrategyId = "";
  let systemMonitorId = "";

  /** One owner's full set of product content: a list, a strategy and a monitor joining them. */
  async function createContentFor(
    owner: { userId: string | null; systemKey?: string },
    label: string,
  ): Promise<{ listId: string; strategyId: string; monitorId: string }> {
    const system = owner.userId === null;
    const list = await prisma.stockList.create({
      data: {
        ownership: system ? "SYSTEM" : "USER",
        userId: owner.userId,
        systemKey: system ? `${owner.systemKey}-list` : null,
        name: `${label} list`,
        items: { create: { securityId, buyWindowMode: "FULL" } },
      },
      select: { id: true },
    });
    const strategy = await prisma.strategy.create({
      data: {
        ownership: system ? "SYSTEM" : "USER",
        userId: owner.userId,
        systemKey: system ? `${owner.systemKey}-strategy` : null,
        name: `${label} strategy`,
        versions: {
          create: {
            versionNumber: 1,
            definition: { schemaVersion: 2, buyLevels: [], sellLevels: [] },
            definitionHash: `${label}-${suffix}`,
          },
        },
      },
      select: { id: true },
    });
    const monitor = await prisma.monitor.create({
      data: {
        ownership: system ? "SYSTEM" : "USER",
        userId: owner.userId,
        systemKey: system ? `${owner.systemKey}-monitor` : null,
        name: `${label} monitor`,
        strategyId: strategy.id,
        stockListId: list.id,
      },
      select: { id: true },
    });
    return { listId: list.id, strategyId: strategy.id, monitorId: monitor.id };
  }

  beforeAll(async () => {
    await prisma.$connect();

    const security = await prisma.security.create({
      data: {
        providerSymbol: `QARESET-${suffix}`,
        symbol: `QARESET-${suffix}`.slice(0, 20),
        name: "QA reset fixture",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
      select: { id: true },
    });
    securityId = security.id;

    personaId = (
      await prisma.user.create({
        data: { email: personaEmail, plan: "STARTER" },
        select: { id: true },
      })
    ).id;
    bystanderId = (
      await prisma.user.create({
        data: { email: bystanderEmail, plan: "PRO" },
        select: { id: true },
      })
    ).id;

    await createContentFor({ userId: personaId }, `persona-${suffix}`);
    await createContentFor({ userId: bystanderId }, `bystander-${suffix}`);
    const system = await createContentFor(
      { userId: null, systemKey: `qa-reset-${suffix}` },
      `system-${suffix}`,
    );
    systemListId = system.listId;
    systemStrategyId = system.strategyId;
    systemMonitorId = system.monitorId;

    // Per-user state that a reset is expected to clear: the persona's Dashboard preference for a
    // built-in Monitor, and a recently-viewed security.
    await prisma.userBuiltInMonitorPreference.create({
      data: { userId: personaId, monitorId: systemMonitorId, enabled: false },
    });
    await prisma.userBuiltInMonitorPreference.create({
      data: { userId: bystanderId, monitorId: systemMonitorId, enabled: false },
    });
    await prisma.recentSecurityView.create({
      data: { userId: personaId, securityId, viewedAt: new Date() },
    });
  });

  afterAll(async () => {
    await prisma.monitor.deleteMany({
      where: { id: { in: [systemMonitorId] } },
    });
    await prisma.monitor.deleteMany({ where: { userId: bystanderId } });
    await prisma.strategy.deleteMany({
      where: { id: { in: [systemStrategyId] } },
    });
    await prisma.stockList.deleteMany({
      where: { id: { in: [systemListId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [personaId, bystanderId] } },
    });
    await prisma.security.deleteMany({ where: { id: securityId } });
    await prisma.$disconnect();
  });

  it("empties the named persona and leaves every other owner untouched", async () => {
    const found = await findQaPersonaUsers(prisma, [
      { name: "FIXTURE_PERSONA", email: personaEmail },
      // An unseeded persona simply is not found; it must not widen the deletion.
      { name: "ABSENT_PERSONA", email: `absent-${suffix}@example.test` },
    ]);
    expect(found.map((row) => row.userId)).toEqual([personaId]);

    const [result] = await resetQaPersonaContent(prisma, found);
    expect(result).toBeDefined();
    expect(totalDeleted(result!.deleted)).toBeGreaterThan(0);
    expect(result!.deleted).toMatchObject({
      stockLists: 1,
      strategies: 1,
      monitors: 1,
      builtInMonitorPreferences: 1,
      recentSecurityViews: 1,
    });

    // The persona is empty from the product's point of view…
    await expect(
      prisma.stockList.count({ where: { userId: personaId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.strategy.count({ where: { userId: personaId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.monitor.count({ where: { userId: personaId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.recentSecurityView.count({ where: { userId: personaId } }),
    ).resolves.toBe(0);

    // …and still exists, on the plan it had. Reset never recreates the account, because a new id
    // would invalidate the persistent browser profile's session.
    const persona = await prisma.user.findUnique({
      where: { id: personaId },
      select: { plan: true },
    });
    expect(persona?.plan).toBe("STARTER");

    // The unrelated customer keeps everything, including their own built-in preference.
    await expect(
      prisma.stockList.count({ where: { userId: bystanderId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.strategy.count({ where: { userId: bystanderId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.monitor.count({ where: { userId: bystanderId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.userBuiltInMonitorPreference.count({
        where: { userId: bystanderId },
      }),
    ).resolves.toBe(1);

    // SYSTEM-owned built-in content is never matched by a `userId` filter and survives.
    await expect(
      prisma.stockList.count({ where: { id: systemListId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.strategy.count({ where: { id: systemStrategyId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.monitor.count({ where: { id: systemMonitorId } }),
    ).resolves.toBe(1);
  });

  it("is safe to run again, and does nothing when no persona resolves", async () => {
    const [again] = await resetQaPersonaContent(prisma, [
      { name: "FIXTURE_PERSONA", email: personaEmail, userId: personaId },
    ]);
    expect(totalDeleted(again!.deleted)).toBe(0);

    await expect(resetQaPersonaContent(prisma, [])).resolves.toEqual([]);
    await expect(
      prisma.stockList.count({ where: { userId: bystanderId } }),
    ).resolves.toBe(1);
  });
});
