import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  canonicalBacktestSnapshotDocument,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type BacktestRunDetailResponse,
  type BacktestRunSnapshot,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AlternativeDataModule } from "../alternative-data/alternative-data.module";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * The one product promise this suite exists for: **editing an actor group never changes a backtest
 * that already exists**.
 *
 * `docs/alternative-data-signals.md` makes that non-negotiable, and it cannot be proven anywhere else:
 * the freeze happens at submission, in PostgreSQL, against a group that is mutable configuration —
 * exactly like a Stock List's membership, which the same snapshot freezes for the same reason.
 *
 * No worker runs here, so every run stays `QUEUED`; the subject is the immutable document submission
 * wrote.
 */
describe("backtest snapshots freeze actor group membership", () => {
  const suffix = randomUUID();
  const shortSuffix = suffix.slice(0, 8).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `altbt-owner-${suffix}@example.test`;
  const providerSymbol = `ABT-${suffix}`;
  const externalIds = [`ABTC-A-${suffix}`, `ABTC-B-${suffix}`, `ABTC-C-${suffix}`];

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let ownerUserId = "";
  let stockListId = "";
  let actorIds: string[] = [];

  function definitionFor(groupId: string): StrategyDefinition {
    return normalizeStrategyDefinition({
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
                  scope: { kind: "GROUP", groupId },
                  chamber: "ANY",
                },
                operator: "IS_AT_LEAST",
                value: { kind: "NUMBER", value: 2 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });
  }

  async function createStrategy(definition: StrategyDefinition): Promise<string> {
    const strategy = await prisma.strategy.create({
      data: {
        userId: ownerUserId,
        name: `Congressional ${randomUUID().slice(0, 8)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as object,
            definitionHash: createHash("sha256")
              .update(strategyDefinitionFingerprint(definition))
              .digest("hex"),
          },
        },
      },
    });
    return strategy.id;
  }

  async function submit(strategyId: string): Promise<BacktestRunDetailResponse> {
    const response = await owner
      .post("/backtests")
      .send({
        strategyId,
        stockListId,
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(202);
    return response.body as BacktestRunDetailResponse;
  }

  async function snapshotOf(runId: string): Promise<BacktestRunSnapshot> {
    const row = await prisma.backtestRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: true, snapshotHash: true },
    });
    return row.snapshot as unknown as BacktestRunSnapshot;
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
        BacktestsModule,
        BenchmarksModule,
        AlternativeDataModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Bound to loopback explicitly (TEST-001): an unlistened Nest app lets supertest bind a wildcard
    // ephemeral port that a foreign local listener may already hold.
    await app.listen(0, "127.0.0.1");

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash,
        emailVerifiedAt: new Date(),
        plan: "PRO",
      },
    });
    ownerUserId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;

    const security = await prisma.security.create({
      data: {
        providerSymbol,
        symbol: `ABT${shortSuffix}`,
        name: "Alternative Backtest Security",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    const list = await prisma.stockList.create({
      data: {
        userId: ownerUserId,
        name: "Alt universe",
        items: { create: [{ securityId: security.id }] },
      },
    });
    stockListId = list.id;

    await prisma.alternativeDataActor.createMany({
      data: externalIds.map((externalId, index) => ({
        externalId,
        displayName: `Member ${index} ${suffix}`,
        chamber: "HOUSE" as const,
      })),
    });
    actorIds = (
      await prisma.alternativeDataActor.findMany({
        where: { externalId: { in: externalIds } },
        orderBy: { externalId: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);

    owner = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.backtestRun.deleteMany({
        where: { user: { email: ownerEmail } },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: ownerEmail } });
      await prisma.alternativeDataActor.deleteMany({
        where: { externalId: { in: externalIds } },
      });
      await prisma.security.deleteMany({ where: { providerSymbol } });
    }
    if (app) {
      await app.close();
    }
  });

  it("freezes the referenced group's membership, identity and labels", async () => {
    const group = (
      await owner
        .post("/actor-groups")
        .send({
          name: "Congress Watchlist",
          actorIds: [actorIds[0], actorIds[1]],
        })
        .expect(201)
    ).body as { id: string };
    const strategyId = await createStrategy(definitionFor(group.id));

    const run = await submit(strategyId);
    const snapshot = await snapshotOf(run.id);

    expect(snapshot.actorGroups).toHaveLength(1);
    const frozen = snapshot.actorGroups?.[0];
    expect(frozen?.groupId).toBe(group.id);
    expect(frozen?.name).toBe("Congress Watchlist");
    expect(frozen?.members.map((member) => member.actorId)).toEqual([
      actorIds[0],
      actorIds[1],
    ]);
    // The label travels with the identity, so a completed run can still name what it counted.
    expect(frozen?.members[0]?.externalId).toBe(externalIds[0]);
    expect(frozen?.members[0]?.displayName).toContain("Member 0");

    await owner.delete(`/actor-groups/${group.id}`).catch(() => undefined);
  });

  it("does not change an existing run when the group is edited afterwards", async () => {
    const group = (
      await owner
        .post("/actor-groups")
        .send({ name: "Before", actorIds: [actorIds[0]] })
        .expect(201)
    ).body as { id: string };
    const strategyId = await createStrategy(definitionFor(group.id));
    const run = await submit(strategyId);
    const before = await snapshotOf(run.id);
    const beforeHash = (
      await prisma.backtestRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { snapshotHash: true },
      })
    ).snapshotHash;

    // Every mutation the product offers: a member added, a member removed, and a rename.
    await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: [actorIds[1], actorIds[2]] })
      .expect(200);
    await owner
      .delete(`/actor-groups/${group.id}/members/${actorIds[0]}`)
      .expect(204);
    await owner
      .patch(`/actor-groups/${group.id}`)
      .send({ name: "After" })
      .expect(200);

    const after = await snapshotOf(run.id);
    expect(after).toEqual(before);
    expect(after.actorGroups?.[0]?.name).toBe("Before");
    expect(after.actorGroups?.[0]?.members.map((m) => m.actorId)).toEqual([
      actorIds[0],
    ]);
    // The reproducibility digest is unchanged too, which is what makes the immutability checkable.
    expect(
      createHash("sha256")
        .update(canonicalBacktestSnapshotDocument(after))
        .digest("hex"),
    ).toBe(beforeHash);
  });

  it("survives the group being deleted entirely", async () => {
    const group = (
      await owner
        .post("/actor-groups")
        .send({ name: "Doomed", actorIds: [actorIds[0], actorIds[2]] })
        .expect(201)
    ).body as { id: string };
    const strategyId = await createStrategy(definitionFor(group.id));
    const run = await submit(strategyId);

    // Deleting is refused while a strategy references it — so the strategy is changed first, exactly
    // as a user would have to. The *run* keeps its frozen copy either way.
    await owner.delete(`/actor-groups/${group.id}`).expect(409);
    await prisma.strategyVersion.updateMany({
      where: { strategyId },
      data: {
        definition: {
          schemaVersion: 2,
          buyLevels: [
            {
              id: "buy-1",
              percentage: 100,
              signal: {
                conditions: [
                  {
                    id: "condition-1",
                    metric: { kind: "PRICE" },
                    operator: "IS_ABOVE",
                    value: { kind: "SERIES", seriesId: "EMA_200D" },
                  },
                ],
              },
            },
          ],
          sellLevels: [],
        },
      },
    });
    await owner.delete(`/actor-groups/${group.id}`).expect(204);

    const snapshot = await snapshotOf(run.id);
    expect(snapshot.actorGroups?.[0]?.members.map((m) => m.actorId)).toEqual([
      actorIds[0],
      actorIds[2],
    ]);
  });

  it("carries no actorGroups field at all when the strategy references none", async () => {
    const strategyId = await createStrategy(
      normalizeStrategyDefinition({
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
                    kind: "INSIDER_ACTIVITY",
                    measure: "BUYERS",
                    lookback: 20,
                  },
                  operator: "IS_AT_LEAST",
                  value: { kind: "NUMBER", value: 2 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      }),
    );
    const run = await submit(strategyId);
    const snapshot = await snapshotOf(run.id);
    // Omitted rather than written empty, so an existing snapshot's shape is unchanged by this feature.
    expect("actorGroups" in snapshot).toBe(false);
  });

  it("refuses a submission whose strategy references a group that has gone", async () => {
    const group = await prisma.actorGroup.create({
      data: { userId: ownerUserId, name: `Vanishing ${suffix}` },
    });
    const strategyId = await createStrategy(definitionFor(group.id));
    // Deleted straight through Prisma, past the route's referencing guard, which is exactly the state
    // a user could reach by deleting a group while another session held a stale strategy.
    await prisma.actorGroup.delete({ where: { id: group.id } });

    const refusal = await owner
      .post("/backtests")
      .send({
        strategyId,
        stockListId,
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(400);
    expect(String(refusal.body.message)).toContain("no longer exists");
    // Refused rather than silently executed with an empty group, which would have counted every
    // member of Congress instead of the curated set.
    expect(
      await prisma.backtestRun.count({ where: { userId: ownerUserId } }),
    ).toBe(0);
  });

  it("freezes an empty group as empty, which counts nothing", async () => {
    const group = (
      await owner
        .post("/actor-groups")
        .send({ name: "Being built" })
        .expect(201)
    ).body as { id: string };
    const strategyId = await createStrategy(definitionFor(group.id));
    const run = await submit(strategyId);
    const snapshot = await snapshotOf(run.id);
    // A legitimate state, and a real reading: no manager is in scope, so the count is zero.
    expect(snapshot.actorGroups?.[0]?.members).toEqual([]);
  });
});
