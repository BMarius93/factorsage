import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import {
  STRATEGY_SCHEMA_VERSION,
  backtestRunLabel,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type BacktestRunDetailResponse,
  type BacktestRunPageResponse,
  type BacktestRunSummaryResponse,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { allocateBacktestRunNumber } from "@intrinsic/database";
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
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Per-user Run IDs (`Run #0001`): allocation, concurrency, stability and the migration backfill.
 *
 * The submitting users are administrators so that no plan's concurrent-run cap stands between the
 * suite and genuinely parallel submissions — the property under test is the numbering, and the
 * concurrency limit is proven in `entitlements.integration.test.ts`. No worker runs here, so every
 * run stays queued; nothing reads market data.
 */
describe("backtest run numbers", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `run-number-owner-${suffix}@example.test`;
  const otherEmail = `run-number-other-${suffix}@example.test`;
  const allocatorEmail = `run-number-allocator-${suffix}@example.test`;
  const providerSymbol = `RN-${suffix}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let ownerUserId = "";
  let otherUserId = "";
  let allocatorUserId = "";
  const strategyIds = new Map<string, string>();
  const listIds = new Map<string, string>();

  const definition: StrategyDefinition = normalizeStrategyDefinition({
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
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  } satisfies StrategyDefinition);
  const definitionHash = createHash("sha256")
    .update(strategyDefinitionFingerprint(definition))
    .digest("hex");

  async function createStrategyAndList(
    userId: string,
    securityId: string,
  ): Promise<void> {
    const strategy = await prisma.strategy.create({
      data: {
        userId,
        name: `Run number strategy ${userId.slice(0, 6)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as object,
            definitionHash,
          },
        },
      },
    });
    const list = await prisma.stockList.create({
      data: {
        userId,
        name: `Run number list ${userId.slice(0, 6)}`,
        items: { create: { securityId, buyWindowMode: "FULL" } },
      },
    });
    strategyIds.set(userId, strategy.id);
    listIds.set(userId, list.id);
  }

  async function submitAs(
    agent: ReturnType<typeof request.agent>,
    userId: string,
  ): Promise<BacktestRunDetailResponse> {
    const response = await agent
      .post("/backtests")
      .send({
        strategyId: strategyIds.get(userId),
        stockListId: listIds.get(userId),
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(202);
    return response.body as BacktestRunDetailResponse;
  }

  async function listRuns(
    agent: ReturnType<typeof request.agent>,
  ): Promise<BacktestRunSummaryResponse[]> {
    const response = await agent.get("/backtests").expect(200);
    return response.body as BacktestRunSummaryResponse[];
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
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Loopback, for the reason `backtests.integration.test.ts` records (TEST-001).
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);

    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [ownerEmail, otherEmail, allocatorEmail].map((email) => ({
        email,
        passwordHash,
        emailVerifiedAt,
        plan: "PRO" as const,
        role: "ADMIN" as const,
      })),
    });
    const users = await prisma.user.findMany({
      where: { email: { in: [ownerEmail, otherEmail, allocatorEmail] } },
      select: { id: true, email: true },
    });
    const idOf = (email: string) =>
      users.find((row) => row.email === email)?.id ?? "";
    ownerUserId = idOf(ownerEmail);
    otherUserId = idOf(otherEmail);
    allocatorUserId = idOf(allocatorEmail);

    const security = await prisma.security.create({
      data: {
        providerSymbol,
        symbol: `RN${suffix.slice(0, 8).toUpperCase()}`,
        name: "Run Number Security",
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    await createStrategyAndList(ownerUserId, security.id);
    await createStrategyAndList(otherUserId, security.id);

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
      // Runs, counters, strategies and lists all cascade from the users.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail, allocatorEmail] } },
      });
      await prisma.security.deleteMany({ where: { providerSymbol } });
    }
    if (app) {
      await app.close();
    }
  });

  describe("allocateBacktestRunNumber", () => {
    it("hands out 1, 2, 3 to a user and nothing to anyone else", async () => {
      const first = await prisma.$transaction((tx) =>
        allocateBacktestRunNumber(tx, allocatorUserId),
      );
      const second = await prisma.$transaction((tx) =>
        allocateBacktestRunNumber(tx, allocatorUserId),
      );
      const third = await prisma.$transaction((tx) =>
        allocateBacktestRunNumber(tx, allocatorUserId),
      );
      expect([first, second, third]).toEqual([1, 2, 3]);
      // Another user's counter did not move.
      expect(
        await prisma.backtestRunNumberCounter.findUnique({
          where: { userId: otherUserId },
        }),
      ).toBeNull();
    });

    it("never gives two concurrent transactions the same number", async () => {
      const before =
        (
          await prisma.backtestRunNumberCounter.findUnique({
            where: { userId: allocatorUserId },
          })
        )?.lastRunNumber ?? 0;
      const parallel = 8;
      // Each transaction holds its allocation open briefly, so the others really do arrive while
      // the row is locked rather than one after another.
      const numbers = await Promise.all(
        Array.from({ length: parallel }, () =>
          prisma.$transaction(
            async (tx) => {
              const allocated = await allocateBacktestRunNumber(
                tx,
                allocatorUserId,
              );
              await tx.$executeRaw`SELECT pg_sleep(0.05)`;
              return allocated;
            },
            { maxWait: 20_000, timeout: 20_000 },
          ),
        ),
      );
      expect([...numbers].sort((a, b) => a - b)).toEqual(
        Array.from(
          { length: parallel },
          (_unused, index) => before + index + 1,
        ),
      );
    });

    it("gives the number back when its transaction rolls back", async () => {
      const before =
        (
          await prisma.backtestRunNumberCounter.findUnique({
            where: { userId: allocatorUserId },
          })
        )?.lastRunNumber ?? 0;
      await expect(
        prisma.$transaction(async (tx) => {
          await allocateBacktestRunNumber(tx, allocatorUserId);
          throw new Error("submission refused after allocation");
        }),
      ).rejects.toThrow("submission refused after allocation");
      const next = await prisma.$transaction((tx) =>
        allocateBacktestRunNumber(tx, allocatorUserId),
      );
      expect(next).toBe(before + 1);
    });
  });

  describe("submission", () => {
    it("numbers a user's runs 1, 2, 3 and reports the number on the list and the run", async () => {
      const first = await submitAs(owner, ownerUserId);
      const second = await submitAs(owner, ownerUserId);
      const third = await submitAs(owner, ownerUserId);
      expect([first.runNumber, second.runNumber, third.runNumber]).toEqual([
        1, 2, 3,
      ]);
      expect(backtestRunLabel(first.runNumber)).toBe("Run #0001");

      // The UUID is untouched and stays the technical identity.
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
      const detail = await owner.get(`/backtests/${second.id}`).expect(200);
      expect((detail.body as BacktestRunDetailResponse).runNumber).toBe(2);

      const listed = await listRuns(owner);
      expect(listed.map((run) => [run.id, run.runNumber])).toEqual([
        [third.id, 3],
        [second.id, 2],
        [first.id, 1],
      ]);
    });

    it("finds a run by its Run ID in the collection's search", async () => {
      const search = async (q: string) => {
        const response = await owner
          .get("/backtests")
          .query({ page: 1, q })
          .expect(200);
        return (response.body as BacktestRunPageResponse).runs.map(
          (run) => run.runNumber,
        );
      };
      // However the ID is written, and only for the run it names.
      for (const q of ["Run #0002", "run 2", "#2"]) {
        expect(await search(q), q).toEqual([2]);
      }
      // A bare number is also searched as text (a name may hold it), but always finds its run.
      expect(await search("2")).toContain(2);
      // The label copied from the page finds its run; a number that names no run finds nothing.
      expect(await search(backtestRunLabel(3))).toEqual([3]);
      expect(await search("Run #9999")).toEqual([]);
      // Text still searches names, as before.
      expect((await search("Run number strategy")).length).toBe(3);
    });

    it("numbers each user independently", async () => {
      const othersFirst = await submitAs(other, otherUserId);
      expect(othersFirst.runNumber).toBe(1);
      // The owner's sequence is unaffected by the other user's run.
      expect((await listRuns(owner)).map((run) => run.runNumber)).toEqual([
        3, 2, 1,
      ]);
      // And neither user sees the other's runs or numbers.
      expect((await listRuns(other)).map((run) => run.id)).toEqual([
        othersFirst.id,
      ]);
    });

    it("gives concurrent submissions distinct, consecutive numbers", async () => {
      const before = Math.max(
        ...(await listRuns(owner)).map((run) => run.runNumber),
      );
      const parallel = 6;
      const runs = await Promise.all(
        Array.from({ length: parallel }, () => submitAs(owner, ownerUserId)),
      );
      expect(runs.map((run) => run.runNumber).sort((a, b) => a - b)).toEqual(
        Array.from(
          { length: parallel },
          (_unused, index) => before + index + 1,
        ),
      );
      // The database agrees, and holds no duplicate for this user.
      const stored = await prisma.backtestRun.findMany({
        where: { userId: ownerUserId },
        select: { runNumber: true },
      });
      expect(new Set(stored.map((row) => row.runNumber)).size).toBe(
        stored.length,
      );
    });

    it("keeps every number after a run is deleted, and never reuses the deleted one", async () => {
      const before = await listRuns(owner);
      const numbersById = new Map(before.map((run) => [run.id, run.runNumber]));
      const highest = Math.max(...numbersById.values());
      // The newest and one in the middle: neither number may come back.
      const newest = before[0] as BacktestRunSummaryResponse;
      const middle = before[2] as BacktestRunSummaryResponse;
      await prisma.backtestRun.deleteMany({
        where: { id: { in: [newest.id, middle.id] } },
      });

      const after = await listRuns(owner);
      for (const run of after) {
        expect(run.runNumber).toBe(numbersById.get(run.id));
      }
      const next = await submitAs(owner, ownerUserId);
      expect(next.runNumber).toBe(highest + 1);
      expect(next.runNumber).not.toBe(newest.runNumber);
      expect(next.runNumber).not.toBe(middle.runNumber);
    });

    it("refuses two runs of one user holding the same number", async () => {
      const [first, second] = await prisma.backtestRun.findMany({
        where: { userId: ownerUserId },
        orderBy: { runNumber: "asc" },
        select: { id: true, runNumber: true },
        take: 2,
      });
      expect(first && second).toBeTruthy();
      // The database backstop under the allocator: `@@unique([userId, runNumber])`.
      await expect(
        prisma.backtestRun.update({
          where: { id: second?.id ?? "" },
          data: { runNumber: first?.runNumber ?? 0 },
        }),
      ).rejects.toThrow();
      // A run of another user may of course hold the same number.
      const others = await prisma.backtestRun.findMany({
        where: { userId: otherUserId },
        select: { runNumber: true },
      });
      expect(others.map((row) => row.runNumber)).toContain(first?.runNumber);
    });
  });

  /**
   * The migration's backfill, executed from the committed `migration.sql` itself.
   *
   * It runs in a throwaway PostgreSQL schema holding only the columns the migration reads and
   * writes, so the real tables of the test database are never touched and the statements under
   * test are exactly the ones that ship.
   */
  describe("migration backfill", () => {
    const migrationPath = resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20261022120000_backtest_run_numbers/migration.sql",
    );

    function statementsOf(sql: string): string[] {
      return sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .split(/;\s*(?:\n|$)/)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    }

    it("numbers existing runs per user in creation order, deterministically, and seeds each counter", async () => {
      const schema = `run_number_backfill_${suffix.replace(/-/g, "").slice(0, 12)}`;
      const statements = statementsOf(readFileSync(migrationPath, "utf8"));
      expect(statements.length).toBeGreaterThan(0);

      try {
        const result = await prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
            // The pre-migration shape, reduced to what the migration touches.
            await tx.$executeRawUnsafe(
              `CREATE TABLE "User" ("id" TEXT PRIMARY KEY)`,
            );
            await tx.$executeRawUnsafe(
              `CREATE TABLE "BacktestRun" (
                 "id" TEXT PRIMARY KEY,
                 "userId" TEXT NOT NULL REFERENCES "User"("id"),
                 "queuedAt" TIMESTAMP(3) NOT NULL,
                 "createdAt" TIMESTAMP(3) NOT NULL
               )`,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO "User" ("id") VALUES ('alice'), ('bob'), ('carol')`,
            );
            // Inserted out of order. Alice has two runs queued in the same instant, which only
            // `createdAt` separates, and two identical in both, which only `id` separates.
            await tx.$executeRawUnsafe(
              `INSERT INTO "BacktestRun" ("id", "userId", "queuedAt", "createdAt") VALUES
                 ('a-late',  'alice', '2026-03-01 10:00:00', '2026-03-01 10:00:00'),
                 ('a-tie-b', 'alice', '2026-02-01 09:00:00', '2026-02-01 09:00:00.500'),
                 ('a-first', 'alice', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
                 ('a-tie-a', 'alice', '2026-02-01 09:00:00', '2026-02-01 09:00:00.100'),
                 ('a-same-z','alice', '2026-04-01 00:00:00', '2026-04-01 00:00:00'),
                 ('a-same-y','alice', '2026-04-01 00:00:00', '2026-04-01 00:00:00'),
                 ('b-only',  'bob',   '2025-12-31 23:59:59', '2025-12-31 23:59:59')`,
            );

            for (const statement of statements) {
              await tx.$executeRawUnsafe(statement);
            }

            const runs = await tx.$queryRawUnsafe<
              { id: string; userId: string; runNumber: number }[]
            >(
              `SELECT "id", "userId", "runNumber" FROM "BacktestRun" ORDER BY "userId", "runNumber"`,
            );
            const counters = await tx.$queryRawUnsafe<
              { userId: string; lastRunNumber: number }[]
            >(
              `SELECT "userId", "lastRunNumber" FROM "BacktestRunNumberCounter" ORDER BY "userId"`,
            );
            const nullable = await tx.$queryRawUnsafe<
              { is_nullable: string }[]
            >(
              `SELECT "is_nullable" FROM information_schema.columns
                WHERE table_schema = '${schema}' AND table_name = 'BacktestRun'
                  AND column_name = 'runNumber'`,
            );
            // Run before the duplicate check below, which aborts the transaction.
            const allocated = await allocateBacktestRunNumber(tx, "alice");
            const fresh = await allocateBacktestRunNumber(tx, "carol");
            let duplicateRefused = false;
            try {
              await tx.$executeRawUnsafe(`SAVEPOINT duplicate_check`);
              await tx.$executeRawUnsafe(
                `INSERT INTO "BacktestRun" ("id", "userId", "queuedAt", "createdAt", "runNumber")
                   VALUES ('a-dup', 'alice', now(), now(), 1)`,
              );
            } catch {
              duplicateRefused = true;
              await tx.$executeRawUnsafe(
                `ROLLBACK TO SAVEPOINT duplicate_check`,
              );
            }
            return {
              runs,
              counters,
              nullable,
              allocated,
              fresh,
              duplicateRefused,
            };
          },
          { timeout: 30_000 },
        );

        expect(result.runs).toEqual([
          { id: "a-first", userId: "alice", runNumber: 1 },
          { id: "a-tie-a", userId: "alice", runNumber: 2 },
          { id: "a-tie-b", userId: "alice", runNumber: 3 },
          { id: "a-late", userId: "alice", runNumber: 4 },
          { id: "a-same-y", userId: "alice", runNumber: 5 },
          { id: "a-same-z", userId: "alice", runNumber: 6 },
          { id: "b-only", userId: "bob", runNumber: 1 },
        ]);
        expect(result.counters).toEqual([
          { userId: "alice", lastRunNumber: 6 },
          { userId: "bob", lastRunNumber: 1 },
        ]);
        expect(result.nullable).toEqual([{ is_nullable: "NO" }]);
        // The allocator continues each backfilled sequence, and starts a user with no runs at 1.
        expect(result.allocated).toBe(7);
        expect(result.fresh).toBe(1);
        expect(result.duplicateRefused).toBe(true);
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
        );
      }
    });
  });
});
