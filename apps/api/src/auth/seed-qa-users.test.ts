import type { PrismaClient } from "@intrinsic/database";
import { UserRole } from "@intrinsic/database";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordService } from "./password.service";
import {
  PRODUCTION_QA_SEED_MESSAGE,
  assertQaSeedingAllowed,
  seedQaUsers,
  type QaPersonaInput,
} from "./seed-qa-users";

const PERSONAS: QaPersonaInput[] = [
  {
    name: "QA_ADMIN",
    email: "qa-admin@example.test",
    password: "qa-admin-password-value",
    role: UserRole.ADMIN,
  },
];

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

describe("QA persona seeding safety", () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("refuses to run when NODE_ENV is production", () => {
    expect(() => assertQaSeedingAllowed({ NODE_ENV: "production" })).toThrow(
      PRODUCTION_QA_SEED_MESSAGE,
    );
    expect(() => assertQaSeedingAllowed({ NODE_ENV: "  production  " })).toThrow(
      PRODUCTION_QA_SEED_MESSAGE,
    );
  });

  it("allows development, test, and an unset environment", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => assertQaSeedingAllowed({ NODE_ENV })).not.toThrow();
    }
  });

  it("refuses before writing anything when seeding in production", async () => {
    process.env.NODE_ENV = "production";

    await expect(
      seedQaUsers(forbiddenPrisma, new PasswordService(), PERSONAS),
    ).rejects.toThrow(PRODUCTION_QA_SEED_MESSAGE);
  });

  it("still rejects an invalid persona email outside production", async () => {
    process.env.NODE_ENV = "test";

    await expect(
      seedQaUsers(forbiddenPrisma, new PasswordService(), [
        { ...PERSONAS[0], email: "not-an-email" } as QaPersonaInput,
      ]),
    ).rejects.toThrow("QA_ADMIN_EMAIL must be a valid email address");
  });
});
