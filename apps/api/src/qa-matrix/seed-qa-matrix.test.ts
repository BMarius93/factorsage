import type { PrismaClient } from "@intrinsic/database";
import { currentAsOfDate, qaMatrixFixtures } from "@intrinsic/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_DATABASE_QA_SEED_MESSAGE,
  MISSING_TEST_DATABASE_QA_SEED_MESSAGE,
  PRODUCTION_QA_SECURITIES_MESSAGE,
} from "../stocks/seed-qa-securities";
import {
  MISSING_QA_MATRIX_OWNER_MESSAGE,
  assertQaMatrixSeedingAllowed,
  qaMatrixSeedDatabaseUrl,
  resolveQaMatrixOwner,
  seedQaMatrixFixtures,
} from "./seed-qa-matrix";

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
