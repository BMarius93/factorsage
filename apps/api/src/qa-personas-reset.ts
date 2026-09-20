import { createInterface } from "node:readline/promises";
import { loadRootEnv } from "@intrinsic/config";
import { assertQaSeedingAllowed } from "./auth/seed-qa-users";
import {
  announceTarget,
  manualQaPersonas,
  qaPersonaEnvironment,
  qaPersonaPrismaClient,
  seedManualQaPersonas,
} from "./qa/qa-persona-cli";
import {
  countQaPersonaContent,
  describeDeletedCounts,
  findQaPersonaUsers,
  resetQaPersonaContent,
  totalDeleted,
} from "./qa/qa-personas";

/**
 * `pnpm qa:reset` — put the manual QA personas back to a brand-new account's state.
 *
 * Preview, confirm, delete, seed:
 *
 * 1. count what each persona owns and print it;
 * 2. wait for a `y` — or `--yes`, which is also what a non-interactive shell must pass, because
 *    an unattended run of a deletion tool should be deliberate rather than merely possible;
 * 3. delete every Monitor, Backtest run, Strategy and Stock List **owned by those accounts**, plus
 *    their per-user built-in Dashboard preferences and recently-viewed securities;
 * 4. re-assert the personas' plans and roles, creating any that were missing.
 *
 * The confirmation is not ceremony. `PRO_USER` is the default local development account
 * (`ai/workflows/auth-testing.md`), so in a development database the content being deleted is
 * usually a developer's own manual work rather than leftovers from a previous QA pass.
 *
 * The accounts themselves survive — their ids do, which is what lets the persistent browser
 * profiles stay signed in — and nothing outside those ids is read or written. `SYSTEM`-owned
 * built-in content has a null `userId`, so it is matched by no statement here and remains exactly
 * as a real customer sees it. `./qa/qa-personas.ts` explains why that scoping is structural rather
 * than careful.
 */

function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((argument) => names.includes(argument));
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  assertQaSeedingAllowed();
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "--dry-run");
  const assumeYes = hasFlag(argv, "--yes", "-y");

  const environment = qaPersonaEnvironment();
  const personas = manualQaPersonas();

  announceTarget(
    dryRun ? "Would reset QA personas in" : "Resetting QA personas in",
    environment,
  );
  const prisma = qaPersonaPrismaClient(environment);
  try {
    await prisma.$connect();

    const existing = await findQaPersonaUsers(prisma, personas);
    let pending = 0;
    for (const persona of existing) {
      const counts = await countQaPersonaContent(prisma, persona.userId);
      pending += totalDeleted(counts);
      console.log(`  ${persona.name}: ${describeDeletedCounts(counts)}`);
    }
    const missing = personas.length - existing.length;
    if (missing > 0) {
      console.log(
        `  ${missing} persona(s) do not exist yet and will be created.`,
      );
    }

    if (dryRun) {
      console.log("Dry run: nothing was deleted.");
      return;
    }

    if (pending > 0 && !assumeYes) {
      if (!process.stdin.isTTY) {
        console.error(
          "Refusing to delete without confirmation. Rerun with --yes to reset non-interactively.",
        );
        process.exitCode = 1;
        return;
      }
      const proceed = await confirm(
        `Delete all of the above from ${environment.databaseName}? [y/N] `,
      );
      if (!proceed) {
        console.log("Cancelled. Nothing was deleted.");
        return;
      }
    }

    const results = await resetQaPersonaContent(prisma, existing);
    for (const result of results) {
      console.log(
        `  ${result.name}: deleted ${describeDeletedCounts(result.deleted)}`,
      );
      if (result.hasBillingSubscription) {
        console.warn(
          `  ${result.name}: has a Stripe billing mirror. Its plan was re-asserted here, but ` +
            "the next billing reconciliation is authoritative and may move it again.",
        );
      }
    }

    await seedManualQaPersonas(prisma, personas);
    console.log("QA personas are empty and on their declared plans.");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA persona reset failed: ${message}`);
  process.exitCode = 1;
});
