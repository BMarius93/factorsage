import { getQaPersonaConfig, loadRootEnv } from "@intrinsic/config";
import { isLocalDate } from "@intrinsic/contracts";
import { PrismaClient } from "@intrinsic/database";
import { currentAsOfDate, qaMatrixFixtures } from "@intrinsic/testing";
import { loadQaMatrixExecutionCalendar } from "./qa-matrix/seed-qa-matrix";
import { useMatrixDatabase } from "./qa-matrix/matrix-environment";
import {
  formatPreflightReport,
  runQaMatrixPreflight,
} from "./qa-matrix/matrix-preflight";
import { repositoryRoot } from "./qa-matrix/matrix-paths";

/**
 * `pnpm qa:matrix:preflight` — the gate that must be green before a thousand backtests start.
 *
 * Reports every check and exits non-zero when any of them failed. It writes nothing and is safe to
 * run at any time.
 */
async function preflight(): Promise<void> {
  loadRootEnv();
  const environment = useMatrixDatabase();
  const pinned = process.env.QA_MATRIX_AS_OF_DATE?.trim();
  if (pinned && !isLocalDate(pinned)) {
    throw new Error(
      `QA_MATRIX_AS_OF_DATE must be a valid YYYY-MM-DD date; received \`${pinned}\``,
    );
  }
  const asOfDate = pinned || currentAsOfDate();

  const prisma = new PrismaClient({
    datasources: { db: { url: environment.databaseUrl } },
  });
  try {
    await prisma.$connect();
    // Resolved against this database's own calendar, so the fixtures the preflight validates are
    // the ones the runs would actually execute.
    const calendar = await loadQaMatrixExecutionCalendar(prisma).catch(
      () => [] as string[],
    );
    const fixtures = qaMatrixFixtures(
      asOfDate,
      calendar.length > 0 ? calendar : undefined,
    );
    const report = await runQaMatrixPreflight({
      prisma,
      environment,
      fixtures,
      asOfDate,
      ownerEmail: getQaPersonaConfig().user.email,
      today: currentAsOfDate(),
      repositoryRoot: repositoryRoot(),
    });
    console.log(formatPreflightReport(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void preflight().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA matrix preflight failed: ${message}`);
  process.exitCode = 1;
});
