import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  bootstrapBuiltIns,
  type BuiltInBootstrapMode,
} from "./builtins/builtin-bootstrap";

/**
 * `pnpm builtins:bootstrap` — create any missing built-in List, Strategy and Monitor.
 * `pnpm builtins:reset`     — restore every built-in to the canonical catalog (development only).
 *
 * Both target `DATABASE_URL`. The bootstrap is the deploy step and never overwrites an
 * administrator's edits; the reset is an explicit restore and refuses to run in production unless
 * `--allow-production` is given. Afterwards, `pnpm monitors:scan-once` reconstructs the built-in
 * Monitors' state immediately instead of on the next scheduled cycle.
 */
async function main(): Promise<void> {
  loadRootEnv();
  const args = process.argv.slice(2);
  const mode: BuiltInBootstrapMode = args.includes("--reset")
    ? "reset"
    : "create-missing";
  if (
    mode === "reset" &&
    process.env.NODE_ENV === "production" &&
    !args.includes("--allow-production")
  ) {
    throw new Error(
      "Refusing to reset built-in content in production; pass --allow-production to restore the canonical catalog deliberately",
    );
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const report = await bootstrapBuiltIns(prisma, mode);
    console.log(
      `Built-in content ${mode === "reset" ? "reset" : "bootstrap"} complete.`,
    );
    for (const [kind, entries] of Object.entries(report)) {
      for (const [key, action] of Object.entries(entries)) {
        console.log(`  ${kind.padEnd(10)} ${key.padEnd(34)} ${action}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Built-in bootstrap failed: ${message}`);
  process.exitCode = 1;
});
