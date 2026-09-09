import type { PrismaClient } from "@intrinsic/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_DATABASE_QA_SEED_MESSAGE,
  MISSING_TEST_DATABASE_QA_SEED_MESSAGE,
  PRODUCTION_QA_SECURITIES_MESSAGE,
  QA_SECURITIES,
  assertQaSecuritySeedingAllowed,
  qaSeedDatabaseUrl,
  seedQaSecurities,
} from "./seed-qa-securities";

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

describe("QA security seeding safety", () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("refuses to run when NODE_ENV is production", () => {
    expect(() =>
      assertQaSecuritySeedingAllowed({ NODE_ENV: "production" }),
    ).toThrow(PRODUCTION_QA_SECURITIES_MESSAGE);
    expect(() =>
      assertQaSecuritySeedingAllowed({ NODE_ENV: "  production  " }),
    ).toThrow(PRODUCTION_QA_SECURITIES_MESSAGE);
  });

  const TEST_DB = "postgresql://u:p@localhost:5432/intrinsic_value_test";
  const DEV_DB = "postgresql://u:p@localhost:5432/intrinsic_value";

  it("allows development, test, and an unset environment", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() =>
        assertQaSecuritySeedingAllowed({
          NODE_ENV,
          DATABASE_URL: DEV_DB,
          TEST_DATABASE_URL: TEST_DB,
        }),
      ).not.toThrow();
    }
  });

  it("refuses when there is no dedicated test database to seed into", () => {
    expect(() =>
      assertQaSecuritySeedingAllowed({ DATABASE_URL: DEV_DB }),
    ).toThrow(MISSING_TEST_DATABASE_QA_SEED_MESSAGE);
  });

  it("refuses when the test database is the development database", () => {
    // The seed writes synthetic S&P 500 bars into the real benchmark series. A `.env` pointing
    // both variables at one database would put them in front of every manual backtest, which is
    // exactly the contamination this guard exists to prevent.
    expect(() =>
      assertQaSecuritySeedingAllowed({
        DATABASE_URL: DEV_DB,
        TEST_DATABASE_URL: DEV_DB,
      }),
    ).toThrow(DEV_DATABASE_QA_SEED_MESSAGE);
  });

  it("allows the equality `useTestDatabase` itself creates in a DB-backed suite", () => {
    // The helper overwrites DATABASE_URL with the test database *after* making this same check
    // against the real one, and records that it did. Without the carve-out no deterministic-fixture
    // seeder could be exercised from an integration suite at all.
    expect(() =>
      assertQaSecuritySeedingAllowed({
        INTRINSIC_TEST_DATABASE_ACTIVE: "true",
        DATABASE_URL: TEST_DB,
        TEST_DATABASE_URL: TEST_DB,
      }),
    ).not.toThrow();
    // It is not a way past the other rules.
    expect(() =>
      assertQaSecuritySeedingAllowed({
        INTRINSIC_TEST_DATABASE_ACTIVE: "true",
        NODE_ENV: "production",
        TEST_DATABASE_URL: TEST_DB,
      }),
    ).toThrow(PRODUCTION_QA_SECURITIES_MESSAGE);
    expect(() =>
      assertQaSecuritySeedingAllowed({
        INTRINSIC_TEST_DATABASE_ACTIVE: "true",
      }),
    ).toThrow(MISSING_TEST_DATABASE_QA_SEED_MESSAGE);
  });

  it("allows one database in CI, where there is no second one to protect", () => {
    expect(() =>
      assertQaSecuritySeedingAllowed({
        CI: "true",
        DATABASE_URL: DEV_DB,
        TEST_DATABASE_URL: DEV_DB,
      }),
    ).not.toThrow();
  });

  it("connects to the test database and never to whatever DATABASE_URL points at", () => {
    // The seed chooses its target explicitly rather than inheriting it, so a shell aimed at the
    // development database cannot redirect the writes.
    expect(
      qaSeedDatabaseUrl({ DATABASE_URL: DEV_DB, TEST_DATABASE_URL: TEST_DB }),
    ).toBe(TEST_DB);
    expect(() => qaSeedDatabaseUrl({ DATABASE_URL: DEV_DB })).toThrow(
      MISSING_TEST_DATABASE_QA_SEED_MESSAGE,
    );
  });

  it("refuses before writing anything when seeding in production", async () => {
    process.env.NODE_ENV = "production";

    await expect(seedQaSecurities(forbiddenPrisma)).rejects.toThrow(
      PRODUCTION_QA_SECURITIES_MESSAGE,
    );
  });

  it("uses symbols no real US listing can collide with", () => {
    for (const security of QA_SECURITIES) {
      // Real US tickers are at most five characters, so a seven-character symbol can never appear
      // in a provider universe and the catalog synchronization can never claim these rows.
      expect(security.symbol.length).toBeGreaterThan(5);
    }
  });

  it("keeps the provider symbol identical to the product symbol, as real rows have it", () => {
    for (const security of QA_SECURITIES) {
      // `/stocks/{symbol}` resolves a security by its provider identity. A decorated provider
      // symbol would make these the only catalog rows the product's own navigation cannot open.
      expect(security.providerSymbol).toBe(security.symbol);
    }
  });
});
