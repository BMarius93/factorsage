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
      // Real US tickers are at most five characters; the -QA provider suffix is not a provider
      // format, so the catalog synchronization can never claim or reconcile these rows.
      expect(security.symbol.length).toBeGreaterThan(5);
      expect(security.providerSymbol.endsWith("-QA")).toBe(true);
    }
  });
});
