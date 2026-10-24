import { loadRootEnv } from "@intrinsic/config";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { BacktestSharingService } from "./backtests/backtest-sharing.service";
import { BacktestsModule } from "./backtests/backtests.module";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { PrismaService } from "./database/prisma.service";

/**
 * Curates the public demonstration shelf (`docs/decisions/entitlements-v2.md` §4).
 *
 * ```bash
 * pnpm --filter @intrinsic/api demo-backtests -- list
 * pnpm --filter @intrinsic/api demo-backtests -- feature --run <runId> --title "Quality pullbacks, 30 years" \
 *   [--description "…"] [--position 0]
 * pnpm --filter @intrinsic/api demo-backtests -- unfeature --run <runId>
 * ```
 *
 * `feature` shares the run through its owner's own idempotent share path if it is not shared yet,
 * then lists it. A demonstration publishes exactly what its share link publishes — the headline
 * figures and the general parameters, never the strategy, the list or the trades — so choose runs
 * whose owner agreed to that (an operator's own runs are the expected source). `unfeature` takes a
 * run off the shelf and leaves its link alone; revoking the link takes it off as well.
 */

@Module({ imports: [ConfigurationModule, DatabaseModule, AuthModule, BacktestsModule] })
class DemoBacktestsCliModule {}

function option(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

async function main(): Promise<void> {
  loadRootEnv();
  const [command, ...rest] = process.argv.slice(2).filter((value) => value !== "--");
  if (command !== "list" && command !== "feature" && command !== "unfeature") {
    throw new Error("Usage: demo-backtests <list|feature|unfeature> [--run id] [--title t] [--description d] [--position n]");
  }
  const context = await NestFactory.createApplicationContext(DemoBacktestsCliModule, {
    logger: false,
  });
  try {
    const sharing = context.get(BacktestSharingService, { strict: false });
    const prisma = context.get(PrismaService, { strict: false });
    if (command === "list") {
      process.stdout.write(`${JSON.stringify(await sharing.listDemos(), null, 2)}\n`);
      return;
    }
    const runId = option(rest, "--run");
    if (!runId) {
      throw new Error("--run is required");
    }
    if (command === "unfeature") {
      const removed = await sharing.unfeatureDemo(runId);
      process.stdout.write(`${JSON.stringify({ runId, removed })}\n`);
      return;
    }
    const title = option(rest, "--title")?.trim();
    if (!title || title.length > 120) {
      throw new Error("--title is required, at most 120 characters");
    }
    const description = option(rest, "--description")?.trim() || null;
    if (description && description.length > 500) {
      throw new Error("--description is at most 500 characters");
    }
    const positionRaw = option(rest, "--position") ?? "0";
    const position = Number(positionRaw);
    if (!Number.isInteger(position) || position < 0) {
      throw new Error("--position must be a non-negative integer");
    }
    const run = await prisma.backtestRun.findUnique({
      where: { id: runId },
      select: { userId: true },
    });
    if (!run) {
      throw new Error(`No backtest run ${runId}`);
    }
    const demo = await sharing.featureDemo({
      userId: run.userId,
      runId,
      title,
      description,
      position,
    });
    process.stdout.write(`${JSON.stringify({ runId, featured: demo !== null, demo }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
