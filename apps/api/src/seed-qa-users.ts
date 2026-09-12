import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { resolveAllTestPersonas } from "@intrinsic/testing";
import { PasswordService } from "./auth/password.service";
import {
  assertQaSeedingAllowed,
  seedQaUsers,
  type QaPersonaInput,
} from "./auth/seed-qa-users";
import { qaSeedDatabaseUrl } from "./stocks/seed-qa-securities";

/**
 * Seeds every persistent test persona used by Playwright, manual development and live API smoke
 * testing.
 *
 * The set of personas, and each one's plan and role, come from the registry in
 * `@intrinsic/testing` — this command adds no policy of its own, so a persona cannot mean one
 * thing here and another in a spec. Credentials come only from the environment, so no password
 * ever appears in source control.
 *
 * **Idempotent.** Each persona is upserted by its normalized email and its password hash, role and
 * plan are re-asserted every run, so rerunning it is also how a persona whose plan was changed by
 * hand is put back. Refuses to run when NODE_ENV is production.
 *
 * Targets **TEST_DATABASE_URL**, the same database the deterministic fixtures and the Playwright
 * stack use, so the personas exist where the suites look for them.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before reading credentials or opening a connection to whatever DATABASE_URL points at.
  assertQaSeedingAllowed();
  const personas: QaPersonaInput[] = resolveAllTestPersonas().map(
    (persona) => ({
      name: persona.name,
      email: persona.email,
      password: persona.password,
      role: persona.role,
      plan: persona.plan,
    }),
  );
  const prisma = new PrismaClient({
    datasources: { db: { url: qaSeedDatabaseUrl() } },
  });

  try {
    await prisma.$connect();
    const seeded = await seedQaUsers(prisma, new PasswordService(), personas);
    for (const persona of seeded) {
      console.log(
        `${persona.name} ready (role ${persona.role}, plan ${persona.plan}).`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Test persona seed failed: ${message}`);
  process.exitCode = 1;
});
