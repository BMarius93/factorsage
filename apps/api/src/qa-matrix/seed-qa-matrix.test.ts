import type { PrismaClient } from "@intrinsic/database";
import { currentAsOfDate, qaMatrixFixtures } from "@intrinsic/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_DATABASE_QA_SEED_MESSAGE,
  MISSING_TEST_DATABASE_QA_SEED_MESSAGE,
  PRODUCTION_QA_SECURITIES_MESSAGE,
} from "../stocks/seed-qa-securities";
import {
  MISSING_EXECUTION_CALENDAR_MESSAGE,
  MISSING_QA_MATRIX_OWNER_MESSAGE,
  assertQaMatrixSeedingAllowed,
  loadQaMatrixExecutionCalendar,
  qaMatrixSeedDatabaseUrl,
  resolveQaMatrixOwner,
  seedQaMatrixFixtures,
} from "./seed-qa-matrix";
import { ensureQaMatrixExecutionCalendar } from "./qa-matrix.test-helper";

/** Fails the test if the seeder reaches the database at all. */
const forbiddenPrisma = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `Seeding must not touch the database; it read prisma.${String(property)}`,
      );
    },
  },
) as PrismaClient;

/**
 * Where the matrix fixtures may be written, and where they may not.
 *
 * These fixtures create user-owned strategies and lists, and real-identity catalog rows, under a
 * persona whose password lives in a developer environment file. Landing them in production — or in
 * the development database, beside a developer's own strategies and lists — is what these guards
 * exist to make impossible, and they refuse before any connection is opened.
 */
describe("QA matrix seeding safety", () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  const TEST_DB = "postgresql://u:p@localhost:5432/intrinsic_value_test";
  const DEV_DB = "postgresql://u:p@localhost:5432/intrinsic_value";

  it("refuses to run when NODE_ENV is production", () => {
    expect(() =>
      assertQaMatrixSeedingAllowed({ NODE_ENV: "production" }),
    ).toThrow(PRODUCTION_QA_SECURITIES_MESSAGE);
  });

  it("refuses when there is no dedicated test database to seed into", () => {
    expect(() =>
      assertQaMatrixSeedingAllowed({ DATABASE_URL: DEV_DB }),
    ).toThrow(MISSING_TEST_DATABASE_QA_SEED_MESSAGE);
  });

  it("refuses when the test database is the development database", () => {
    expect(() =>
      assertQaMatrixSeedingAllowed({
        DATABASE_URL: DEV_DB,
        TEST_DATABASE_URL: DEV_DB,
      }),
    ).toThrow(DEV_DATABASE_QA_SEED_MESSAGE);
  });

  it("allows development, test and an unset environment with a dedicated test database", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() =>
        assertQaMatrixSeedingAllowed({
          NODE_ENV,
          DATABASE_URL: DEV_DB,
          TEST_DATABASE_URL: TEST_DB,
        }),
      ).not.toThrow();
    }
  });

  it("allows one database in CI, where there is no second one to protect", () => {
    expect(() =>
      assertQaMatrixSeedingAllowed({
        CI: "true",
        DATABASE_URL: DEV_DB,
        TEST_DATABASE_URL: DEV_DB,
      }),
    ).not.toThrow();
  });

  it("connects to the test database and never to whatever DATABASE_URL points at", () => {
    expect(
      qaMatrixSeedDatabaseUrl({
        DATABASE_URL: DEV_DB,
        TEST_DATABASE_URL: TEST_DB,
      }),
    ).toBe(TEST_DB);
    expect(() => qaMatrixSeedDatabaseUrl({ DATABASE_URL: DEV_DB })).toThrow(
      MISSING_TEST_DATABASE_QA_SEED_MESSAGE,
    );
  });

  it("refuses before writing anything when seeding in production", async () => {
    process.env.NODE_ENV = "production";

    await expect(
      seedQaMatrixFixtures(
        forbiddenPrisma,
        "any-user-id",
        qaMatrixFixtures(currentAsOfDate()),
      ),
    ).rejects.toThrow(PRODUCTION_QA_SECURITIES_MESSAGE);
  });

  describe("the authoritative execution calendar", () => {
    /** A Prisma double exposing only what the calendar loader reads. */
    function prismaWith(options: {
      series?: { id: string } | null;
      bars: { date: Date }[];
    }): PrismaClient {
      return {
        benchmark: {
          findFirst: async () =>
            options.series === null
              ? null
              : { series: [options.series ?? { id: "series-1" }] },
        },
        benchmarkDailyPrice: {
          findMany: async () => options.bars,
          findFirst: async () => options.bars[0] ?? null,
        },
      } as unknown as PrismaClient;
    }

    it("refuses when the pinned series does not exist", async () => {
      await expect(
        loadQaMatrixExecutionCalendar(prismaWith({ series: null, bars: [] })),
      ).rejects.toThrow(MISSING_EXECUTION_CALENDAR_MESSAGE);
    });

    it("refuses when the pinned series exists but has no bars", async () => {
      // The rule the CI failure was the system correctly enforcing, and it stays enforced: the
      // matrix's buy-window boundaries name real execution dates, so a calendar with nothing in it
      // would produce fixtures cut against nothing at all. There is deliberately no fallback to the
      // captured offline calendar here — that capture is for suites, never for a real seed.
      await expect(
        loadQaMatrixExecutionCalendar(prismaWith({ bars: [] })),
      ).rejects.toThrow(MISSING_EXECUTION_CALENDAR_MESSAGE);
    });

    it("returns the series' own dates, ascending, when it has bars", async () => {
      const dates = await loadQaMatrixExecutionCalendar(
        prismaWith({
          bars: [
            { date: new Date("2024-01-02T00:00:00.000Z") },
            { date: new Date("2024-01-03T00:00:00.000Z") },
          ],
        }),
      );
      expect(dates).toEqual(["2024-01-02", "2024-01-03"]);
    });

    it("lets a suite start from a database with zero benchmark bars", async () => {
      // What CI actually has: migrations and nothing else. The setup helper must create the
      // precondition itself rather than assume a developer seeded it weeks ago — the invisible
      // leftover state that made this suite pass locally and fail on a fresh database.
      let bars: { date: Date }[] = [];
      const prisma = {
        benchmark: {
          findFirst: async () => ({ series: [{ id: "series-1" }] }),
        },
        benchmarkDailyPrice: {
          findMany: async () => bars,
          findFirst: async () => bars[0] ?? null,
        },
      } as unknown as PrismaClient;

      // Before setup there is nothing to read, exactly as on a fresh database.
      await expect(loadQaMatrixExecutionCalendar(prisma)).rejects.toThrow(
        MISSING_EXECUTION_CALENDAR_MESSAGE,
      );

      let seedCalls = 0;
      const result = await ensureQaMatrixExecutionCalendar(prisma, async () => {
        seedCalls += 1;
        bars = [
          { date: new Date("2024-01-02T00:00:00.000Z") },
          { date: new Date("2024-01-03T00:00:00.000Z") },
        ];
      });

      expect(seedCalls).toBe(1);
      expect(result.seeded).toBe(true);
      expect(result.dates).toEqual(["2024-01-02", "2024-01-03"]);

      // And on the next run, with bars present, it reads instead of seeding again.
      const second = await ensureQaMatrixExecutionCalendar(prisma, async () => {
        seedCalls += 1;
      });
      expect(seedCalls).toBe(1);
      expect(second.seeded).toBe(false);
      expect(second.dates).toEqual(result.dates);
    });
  });

  it("resolves the QA owner and never creates one", async () => {
    // The persona's credentials, role and verified state belong to `pnpm test:users:seed`. A
    // matrix seed that created the account itself would make that seeder's guarantees untrue.
    const prisma = {
      user: {
        findUnique: async () => null,
        create: () => {
          throw new Error("the matrix seed must never create a user");
        },
      },
    } as unknown as PrismaClient;

    await expect(
      resolveQaMatrixOwner(prisma, "qa@example.test"),
    ).rejects.toThrow(MISSING_QA_MATRIX_OWNER_MESSAGE);
  });

  it("looks the owner up by its normalized address", async () => {
    let seen: unknown;
    const prisma = {
      user: {
        findUnique: async (args: { where: { email: string } }) => {
          seen = args.where.email;
          return { id: "owner-id" };
        },
      },
    } as unknown as PrismaClient;

    await expect(
      resolveQaMatrixOwner(prisma, "  QA.User@Example.Test "),
    ).resolves.toBe("owner-id");
    expect(seen).toBe("qa.user@example.test");
  });
});
