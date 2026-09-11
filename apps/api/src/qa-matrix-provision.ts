import { getQaPersonaConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient, UserRole } from "@intrinsic/database";
import { isLocalDate } from "@intrinsic/contracts";
import { currentAsOfDate, qaMatrixFixtures } from "@intrinsic/testing";
import { PasswordService } from "./auth/password.service";
import { seedQaUsers, type QaPersonaInput } from "./auth/seed-qa-users";
import {
  describeQaMatrixSeed,
  loadQaMatrixExecutionCalendar,
  resolveQaMatrixOwner,
  seedQaMatrixFixtures,
} from "./qa-matrix/seed-qa-matrix";
import { useMatrixDatabase } from "./qa-matrix/matrix-environment";
import { provisionMatrixDatabase } from "./qa-matrix/provision-matrix-database";

/**
 * Provisions the dedicated matrix environment: `pnpm qa:matrix:provision`.
 *
 * Creates the matrix database if it does not exist, brings it to the repository's migration head,
 * copies the canonical market data the matrix reads out of the development database, and seeds the
 * QA persona and the QA-MATRIX Strategy and List fixtures into it.
 *
 * Idempotent. Re-running tops up whatever is missing and rewrites nothing that is already correct.
 * The source database is only ever read.
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

async function provision(): Promise<void> {
  loadRootEnv();
  const environment = useMatrixDatabase();
  const log = (message: string): void => {
    console.log(`  ${message}`);
  };

  console.log(`QA matrix environment: ${environment.databaseName}`);
  console.log(
    `  source          ${environment.sourceDatabaseUrl.replace(/\/\/[^@]*@/, "//")}`,
  );
  console.log(`  redis database  ${environment.redisDb}`);
  console.log("");

  const result = await provisionMatrixDatabase(environment, log);

  const prisma = new PrismaClient({
    datasources: { db: { url: environment.databaseUrl } },
  });
  try {
    await prisma.$connect();

    const personas = getQaPersonaConfig();
    const seededUsers = await seedQaUsers(
      prisma,
      new PasswordService(),
      [
        { name: "QA_USER", ...personas.user, role: UserRole.USER },
        { name: "QA_ADMIN", ...personas.admin, role: UserRole.ADMIN },
      ] satisfies QaPersonaInput[],
    );
    log(`QA personas ready: ${seededUsers.map((p) => p.name).join(", ")}`);

    const ownerUserId = await resolveQaMatrixOwner(prisma, personas.user.email);
    const executionCalendar = await loadQaMatrixExecutionCalendar(prisma);
    const fixtures = qaMatrixFixtures(resolveAsOfDate(), executionCalendar);
    const seed = await seedQaMatrixFixtures(prisma, ownerUserId, fixtures);
    log(`fixtures: ${describeQaMatrixSeed(seed, fixtures)}`);
  } finally {
    await prisma.$disconnect();
  }

  console.log("");
  console.log(
    `Matrix environment provisioned in ${Math.round(result.durationMs / 1000)}s. ` +
      "Next: `pnpm qa:matrix:preflight`.",
  );
}

void provision().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`\nQA matrix provisioning failed: ${message}`);
  process.exitCode = 1;
});
