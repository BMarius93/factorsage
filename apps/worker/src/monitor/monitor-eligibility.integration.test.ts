import { randomUUID } from "node:crypto";
import { STRATEGY_SCHEMA_VERSION } from "@intrinsic/contracts";
import {
  PrismaClient,
  SecurityType,
  type UserPlan,
} from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * What a Monitor cycle is actually allowed to evaluate, against real PostgreSQL.
 *
 * `listActiveMonitors` is the single gate between a stored Monitor and a scan, so this is the one
 * place execution eligibility can be proven. `docs/decisions/entitlements-v1.md` separates two
 * things that look alike:
 *
 * - `enabled` is the user's persisted intent, and a plan change must never rewrite it;
 * - execution eligibility is derived, every cycle, from current entitlements and current resource
 *   state.
 *
 * Every case below therefore asserts *both*: what the cycle loads, and that the `enabled` column
 * underneath is untouched.
 */
describe("monitor execution eligibility", () => {
  const prisma = new PrismaClient();
  const repository = new PrismaMonitorRepository(prisma);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  const userIds = new Map<string, string>();
  const securityIds: string[] = [];
  const createdMonitorIds: string[] = [];

  const DEFINITION = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "condition-1",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  };

  function userIdOf(name: string): string {
    const found = userIds.get(name);
    if (!found) {
      throw new Error(`Unknown fixture user ${name}`);
    }
    return found;
  }

  async function setPlan(name: string, plan: UserPlan): Promise<void> {
    await prisma.user.update({ where: { id: userIdOf(name) }, data: { plan } });
  }

  /**
   * One Monitor with its own Strategy and List.
   *
   * `createdAt` is written explicitly because the active-capacity rule orders by it: rows created
   * in the same millisecond would otherwise be separated only by their random ids, and the test
   * could not say which one *should* hold the slot.
   */
  async function createMonitor(input: {
    owner: string;
    createdAt: Date;
    symbolCount?: number;
    enabled?: boolean;
  }): Promise<string> {
    const userId = userIdOf(input.owner);
    const strategy = await prisma.strategy.create({
      data: {
        userId,
        name: `Strategy ${randomUUID().slice(0, 8)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: DEFINITION as never,
            definitionHash: randomUUID(),
          },
        },
      },
      select: { id: true },
    });
    const stockList = await prisma.stockList.create({
      data: {
        userId,
        name: `List ${randomUUID().slice(0, 8)}`,
        items: {
          create: securityIds
            .slice(0, input.symbolCount ?? 1)
            .map((securityId) => ({ securityId })),
        },
      },
      select: { id: true },
    });
    const monitor = await prisma.monitor.create({
      data: {
        userId,
        name: `Monitor ${randomUUID().slice(0, 8)}`,
        strategyId: strategy.id,
        stockListId: stockList.id,
        enabled: input.enabled ?? true,
        createdAt: input.createdAt,
      },
      select: { id: true },
    });
    createdMonitorIds.push(monitor.id);
    return monitor.id;
  }

  /** The ids this suite created that a cycle would currently evaluate. */
  async function evaluatedIds(): Promise<string[]> {
    const active = await repository.listActiveMonitors();
    return active
      .map((monitor) => monitor.monitorId)
      .filter((id) => createdMonitorIds.includes(id))
      .sort();
  }

  async function enabledFlags(): Promise<Record<string, boolean>> {
    const rows = await prisma.monitor.findMany({
      where: { id: { in: createdMonitorIds } },
      select: { id: true, enabled: true },
    });
    return Object.fromEntries(rows.map((row) => [row.id, row.enabled]));
  }

  beforeAll(async () => {
    for (const name of ["owner", "other"]) {
      const user = await prisma.user.create({
        data: {
          email: `eligibility-${name}-${suffix}@example.test`,
          plan: "PRO",
        },
        select: { id: true },
      });
      userIds.set(name, user.id);
    }

    for (let index = 0; index < 12; index += 1) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `ELG${index}.${suffix}`,
          symbol: `ELG${index}${suffix.slice(0, 4).toUpperCase()}`,
          name: `Eligibility Security ${index}`,
          exchangeCode: "NASDAQ",
          currency: "USD",
          type: SecurityType.STOCK,
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true },
      });
      securityIds.push(security.id);
    }
  });

  afterEach(async () => {
    await prisma.monitor.deleteMany({ where: { id: { in: createdMonitorIds } } });
    createdMonitorIds.length = 0;
    await prisma.stockList.deleteMany({
      where: { userId: { in: [...userIds.values()] } },
    });
    await prisma.strategy.deleteMany({
      where: { userId: { in: [...userIds.values()] } },
    });
    for (const name of userIds.keys()) {
      await setPlan(name, "PRO");
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [...userIds.values()] } } });
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    await prisma.$disconnect();
  });

  it("evaluates only the plan's worth of enabled monitors, oldest first", async () => {
    const first = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const second = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const third = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    await setPlan("owner", "FREE");
    expect(await evaluatedIds()).toEqual([first]);

    await setPlan("owner", "STARTER");
    expect(await evaluatedIds()).toEqual([first, second, third].sort());
  });

  it("leaves every `enabled` value untouched while doing it", async () => {
    await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const before = await enabledFlags();

    await setPlan("owner", "FREE");
    await repository.listActiveMonitors();

    // The cycle is a read. A blocked Monitor is not "turned off" — nothing was written at all.
    expect(await enabledFlags()).toEqual(before);
    expect(Object.values(before).every(Boolean)).toBe(true);
  });

  it("hands the slot to the next monitor when the holder is disabled, and takes it back on upgrade", async () => {
    const first = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const second = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    await setPlan("owner", "FREE");
    expect(await evaluatedIds()).toEqual([first]);

    await prisma.monitor.update({
      where: { id: first },
      data: { enabled: false },
    });
    expect(await evaluatedIds()).toEqual([second]);

    await setPlan("owner", "PRO");
    // The disabled one stays disabled: capacity returning does not override intent.
    expect(await evaluatedIds()).toEqual([second]);
  });

  it("refuses to scan a monitor whose list exceeds the plan's symbol limit", async () => {
    const compliant = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      symbolCount: 2,
    });
    const oversized = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      symbolCount: 12,
    });

    await setPlan("owner", "PRO");
    expect(await evaluatedIds()).toEqual([compliant, oversized].sort());

    // FREE allows ten symbols per list, so the twelve-symbol Monitor stops being eligible — while
    // both the Monitor and its oversized List remain exactly as they were.
    await setPlan("owner", "FREE");
    expect(await evaluatedIds()).toEqual([compliant]);
    expect(
      await prisma.stockListItem.count({
        where: { stockList: { monitors: { some: { id: oversized } } } },
      }),
    ).toBe(12);
    expect((await enabledFlags())[oversized]).toBe(true);
  });

  it("resumes scanning as soon as the list is brought back into compliance", async () => {
    const monitor = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      symbolCount: 12,
    });
    await setPlan("owner", "FREE");
    expect(await evaluatedIds()).toEqual([]);

    // The corrective removal a downgraded user is always allowed to make.
    const list = await prisma.monitor.findUniqueOrThrow({
      where: { id: monitor },
      select: { stockListId: true },
    });
    const removable = await prisma.stockListItem.findMany({
      where: { stockListId: list.stockListId },
      take: 2,
      select: { id: true },
    });
    await prisma.stockListItem.deleteMany({
      where: { id: { in: removable.map((row) => row.id) } },
    });

    expect(await evaluatedIds()).toEqual([monitor]);
  });

  it("keeps an over-capacity monitor's slot rather than passing it to the next one", async () => {
    // The slot is the commercial capacity the user has. An over-limit List is a separate,
    // correctable problem, and letting the next Monitor take the slot instead would silently
    // reorder which Monitors are active every time a List is edited.
    await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      symbolCount: 12,
    });
    const younger = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      symbolCount: 1,
    });

    await setPlan("owner", "FREE");
    expect(await evaluatedIds()).toEqual([]);
    expect((await enabledFlags())[younger]).toBe(true);
  });

  it("counts capacity per owner, so one user's overage never blocks another", async () => {
    await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const theirs = await createMonitor({
      owner: "other",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    await setPlan("owner", "FREE");
    await setPlan("other", "FREE");

    const evaluated = await evaluatedIds();
    expect(evaluated).toHaveLength(2);
    expect(evaluated).toContain(theirs);
  });

  it("never evaluates a disabled monitor, whatever the plan allows", async () => {
    const disabled = await createMonitor({
      owner: "owner",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      enabled: false,
    });
    await setPlan("owner", "PRO");
    expect(await evaluatedIds()).not.toContain(disabled);
  });
});
