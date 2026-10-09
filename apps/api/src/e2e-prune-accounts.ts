import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  pruneE2eDisposableAccounts,
  resolveE2eAccountCleanupTarget,
} from "./e2e-stack/e2e-accounts";

/**
 * Deletes the throwaway accounts E2E specs register (`pnpm test:accounts:prune`).
 *
 * The Playwright global setup runs it before a run, so whatever an interrupted or older run left
 * is gone, and the teardown runs it after, so a run leaves nothing behind. Run it by hand with
 * `--dry-run` to see what it would remove and what it refuses.
 *
 * Targets **TEST_DATABASE_URL** only and refuses everything else before opening a connection; an
 * account it refuses to delete makes it exit non-zero. `apps/api/src/e2e-stack/e2e-accounts.ts`
 * holds the rules.
 */
async function main(): Promise<void> {
  loadRootEnv();
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    // A mistyped `--dry-run` must not become a real delete.
    throw new Error(
      `Unknown argument ${unknown.join(" ")}; the only option is --dry-run.`,
    );
  }
  const dryRun = args.includes("--dry-run");

  // Refuse before a client exists that could act on the wrong database.
  const target = resolveE2eAccountCleanupTarget();
  const prisma = new PrismaClient({
    datasources: { db: { url: target.databaseUrl } },
  });

  try {
    const result = await pruneE2eDisposableAccounts(prisma, target, { dryRun });
    const verb = dryRun ? "would prune" : "pruned";
    const byKind = new Map<string, number>();
    for (const account of result.pruned) {
      byKind.set(account.kind, (byKind.get(account.kind) ?? 0) + 1);
    }
    console.log(
      `[e2e-accounts] ${verb} ${result.pruned.length} disposable E2E account(s) in ` +
        `${result.databaseName}` +
        (byKind.size === 0
          ? ""
          : ` (${[...byKind].map(([kind, count]) => `${kind}: ${count}`).join(", ")})`) +
        `; refused ${result.refused.length}.`,
    );
    for (const account of result.refused) {
      console.error(
        `[e2e-accounts] refused ${account.email}: ${account.reasons.join(", ")}`,
      );
    }
    if (result.refused.length > 0) {
      console.error(
        "[e2e-accounts] A disposable E2E address is in a state registration cannot produce. It " +
          "was left untouched for investigation — if it holds a role or plan, registration " +
          "honoured a forged claim.",
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[e2e-accounts] ${message}`);
  process.exitCode = 1;
});
