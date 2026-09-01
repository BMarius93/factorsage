import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  assertQaSecuritySeedingAllowed,
  seedQaSecurities,
} from "./stocks/seed-qa-securities";

/**
 * Seeds the deterministic fictional QA catalog rows the lists E2E suite searches for.
 *
 * Targets DATABASE_URL — the database the running stack Playwright drives uses — and refuses to
 * run when NODE_ENV is production.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before opening a connection to whatever DATABASE_URL points at.
  assertQaSecuritySeedingAllowed();
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    const seeded = await seedQaSecurities(prisma);
    for (const security of seeded) {
      console.log(`${security.symbol} ready.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA security seed failed: ${message}`);
  process.exitCode = 1;
});
