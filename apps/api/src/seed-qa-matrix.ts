import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { isLocalDate } from "@intrinsic/contracts";
import {
  currentAsOfDate,
  qaMatrixFixtures,
  resolveTestPersona,
} from "@intrinsic/testing";
import {
  assertQaMatrixSeedingAllowed,
  describeQaMatrixSeed,
  loadQaMatrixExecutionCalendar,
  qaMatrixSeedDatabaseUrl,
  resolveQaMatrixOwner,
  seedQaMatrixFixtures,
} from "./qa-matrix/seed-qa-matrix";

/**
 * The matrix clock, from `QA_MATRIX_AS_OF_DATE` or today.
 *
 * The product horizon is relative to a clock, so the fixtures are too. Leaving it unset seeds the
 * matrix that is valid *now*, which is what a developer wants; pinning it is how a sweep keeps one
 * reproducible matrix across seeding, execution and reporting.
 */
function resolveAsOfDate(): string {
  const pinned = process.env.QA_MATRIX_AS_OF_DATE?.trim();
  if (!pinned) {
    return currentAsOfDate();
  }
  if (!isLocalDate(pinned)) {
    throw new Error(
      `QA_MATRIX_AS_OF_DATE must be a valid YYYY-MM-DD date; received \`${pinned}\``,
    );
  }
  return pinned;
}

/**
 * Seeds the persistent QA-MATRIX Strategy and Stock List fixtures the Backtest V1 validation
 * matrix runs against.
 *
 * Targets **TEST_DATABASE_URL**, explicitly and only, and refuses outright when NODE_ENV is
 * production — the same rule `pnpm test:securities:seed` follows, for the same reason: these are
 * deterministic QA fixtures and they must never appear in a real user's account.
 *
 * The fixtures are owned by the existing `QA_USER` persona, which must already exist
 * (`pnpm test:users:seed`). Rerunning **with the same clock** is safe and writes nothing when the
 * database already matches the definitions. It creates no backtest runs.
 *
 * See `docs/development/qa-matrix-fixtures.md`.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  // Refuse before reading a persona address or opening any connection.
  assertQaMatrixSeedingAllowed();
  // The QA_ADMIN persona owns the matrix fixtures. The matrix submits through the product's real
  // entitlement-enforced path, and a thousand-case sweep runs at a concurrency no commercial plan
  // sells — `ADMIN_ENTITLEMENTS` is the decision document's own mechanism for that, and it keeps
  // the runner on the real path instead of behind a bypass. See `docs/decisions/entitlements-v1.md`.
  const email = resolveTestPersona("ADMIN_USER").email;
  const prisma = new PrismaClient({
    datasources: { db: { url: qaMatrixSeedDatabaseUrl() } },
  });

  try {
    await prisma.$connect();
    const ownerUserId = await resolveQaMatrixOwner(prisma, email);
    // The boundary fixtures are cut against the calendar the runs themselves execute on, read from
    // this database rather than from the capture the offline suites use.
    const executionCalendar = await loadQaMatrixExecutionCalendar(prisma);
    const fixtures = qaMatrixFixtures(resolveAsOfDate(), executionCalendar);
    const result = await seedQaMatrixFixtures(prisma, ownerUserId, fixtures);
    console.log(
      `QA matrix fixtures ready: ${describeQaMatrixSeed(result, fixtures)}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA matrix fixture seed failed: ${message}`);
  process.exitCode = 1;
});
