import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { seedQaBuiltIns } from "./builtins/seed-qa-builtins";
import {
  assertQaSecuritySeedingAllowed,
  qaSeedDatabaseUrl,
} from "./stocks/seed-qa-securities";

/**
 * `pnpm test:builtins:seed` — the deterministic built-in Dashboard fixtures, in TEST_DATABASE_URL
 * only. Run after `pnpm test:securities:seed`, whose fictional securities it uses.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  assertQaSecuritySeedingAllowed();
  const prisma = new PrismaClient({
    datasources: { db: { url: qaSeedDatabaseUrl() } },
  });
  try {
    await prisma.$connect();
    await seedQaBuiltIns(prisma);
    console.log("QA built-in content ready.");
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA built-in seed failed: ${message}`);
  process.exitCode = 1;
});
