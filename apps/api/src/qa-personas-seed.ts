import { loadRootEnv } from "@intrinsic/config";
import { assertQaSeedingAllowed } from "./auth/seed-qa-users";
import {
  announceTarget,
  manualQaPersonas,
  qaPersonaEnvironment,
  qaPersonaPrismaClient,
  seedManualQaPersonas,
} from "./qa/qa-persona-cli";

/**
 * `pnpm qa:seed` — the manual release-testing personas, in the development database.
 *
 * One account per commercial plan plus the administrator, each on a deterministic tier and each
 * **empty of product content**: no list, strategy, monitor, backtest or signal is created here, on
 * purpose. The point of the personas is to exercise the real creation flows by hand, and anything
 * this command pre-created would be a flow that never got tested.
 *
 * The personas, their plans and their roles come from the registry in `@intrinsic/testing`; the
 * credentials come from the environment; the writing is done by the same `seedQaUsers` the
 * Playwright seeder uses. This file contributes only the target database and the guard around it.
 *
 * Idempotent: rerunning re-asserts each password hash, plan and role, and is therefore also how a
 * persona whose plan drifted is put back. It creates and deletes nothing else.
 */
async function main(): Promise<void> {
  loadRootEnv();
  // Refuse before reading a credential or opening a connection.
  assertQaSeedingAllowed();
  const environment = qaPersonaEnvironment();
  const personas = manualQaPersonas();

  announceTarget("Seeding QA personas into", environment);
  const prisma = qaPersonaPrismaClient(environment);
  try {
    await prisma.$connect();
    await seedManualQaPersonas(prisma, personas);
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    "QA personas ready. No lists, strategies, monitors or backtests were created — " +
      "build those by hand.",
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA persona seed failed: ${message}`);
  process.exitCode = 1;
});
