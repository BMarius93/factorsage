import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { resolveTestPersona } from "@intrinsic/testing";
import { assertQaSeedingAllowed } from "./auth/seed-qa-users";
import {
  entitlementFixturePersonaEmails,
  seedEntitlementFixtures,
} from "./entitlements/seed-entitlement-fixtures";
import { qaSeedDatabaseUrl } from "./stocks/seed-qa-securities";

/**
 * Seeds the deterministic entitlement fixtures the Playwright entitlement suite runs against.
 *
 * Run it after `pnpm test:users:seed`, which creates the personas this reconciles state for.
 * Rerunning is both safe and the reset: every fixture is brought back to its declared shape, so a
 * spec that removed a symbol or toggled a monitor is undone by seeding again.
 *
 * Targets **TEST_DATABASE_URL** explicitly, never whatever `DATABASE_URL` happens to be: several
 * of these fixtures are states the product refuses to create — an eighty-three-symbol list on a
 * FREE account, a run pinned mid-flight — and they have no business in a development database.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before reading credentials or opening a connection.
  assertQaSeedingAllowed();

  const prisma = new PrismaClient({
    datasources: { db: { url: qaSeedDatabaseUrl() } },
  });

  try {
    await prisma.$connect();
    const result = await seedEntitlementFixtures({
      prisma,
      emails: entitlementFixturePersonaEmails(
        (name) => resolveTestPersona(name).email,
      ),
    });
    console.log(`Fixture securities ready: ${result.securities}`);
    for (const persona of result.personas) {
      console.log(
        `${persona.persona}: ${persona.lists} lists, ${persona.monitors} monitors, ` +
          `${persona.inFlightRuns} in-flight runs, ${persona.completedRuns} completed runs.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Entitlement fixture seed failed: ${message}`);
  process.exitCode = 1;
});
