import type { PrismaClient } from "@intrinsic/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_QA_SECURITIES_MESSAGE,
  QA_SECURITIES,
  assertQaSecuritySeedingAllowed,
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

  it("allows development, test, and an unset environment", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => assertQaSecuritySeedingAllowed({ NODE_ENV })).not.toThrow();
    }
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
