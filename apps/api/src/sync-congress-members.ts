import { randomUUID } from "node:crypto";
import {
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  CanonicalCongressMemberCatalogService,
  createStockDataRedisClient,
  PrismaCongressMemberCatalogStore,
  RedisFmpRequestGate,
  type CongressMemberCatalogSyncResult,
  type CongressMemberCatalogSyncState,
} from "@intrinsic/stock-data";
import { LoggedCongressMemberCatalogService } from "./stocks/logged-congress-member-catalog.service";

/**
 * Synchronizes the member catalog — who a Congressional rule may select — with the provider's
 * member directory (`docs/development/congress-member-catalog.md`).
 *
 * The operator's counterpart of `POST /admin/congress-members/sync`, and the same run: the same
 * service, the same shared `RedisFmpRequestGate`, the same claim on the same state row, so the
 * command and the route can never run beside each other. It adds members and records the
 * directory's spelling of their names. It never removes one and it loads no disclosure.
 *
 * Usage:
 *
 * ```bash
 * pnpm data:congress-members:sync                          # synchronize now
 * pnpm data:congress-members:sync --if-older-than-days 7   # nothing asked while the catalog is fresh
 * pnpm data:congress-members:sync --status                 # what is stored; the provider is not asked
 * pnpm data:congress-members:sync --json                   # the same report as one JSON document
 * ```
 *
 * It exits non-zero when a run failed, so a deploy step or a scheduler sees the failure; a catalog
 * that was already fresh, or a run that found another one in progress, is not a failure.
 */

export type SyncMembersArguments = {
  readonly statusOnly: boolean;
  readonly json: boolean;
  /** Skip the run when the directory was synchronized completely within this many days. */
  readonly ifOlderThanDays?: number;
};

export function parseSyncMembersArguments(
  argv: readonly string[],
): SyncMembersArguments {
  let statusOnly = false;
  let json = false;
  let ifOlderThanDays: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--status":
        statusOnly = true;
        break;
      case "--json":
        json = true;
        break;
      case "--if-older-than-days": {
        const value = argv[index + 1];
        const days = value === undefined ? Number.NaN : Number(value);
        if (!Number.isFinite(days) || days <= 0) {
          throw new Error(
            "--if-older-than-days needs a positive number of days, e.g. --if-older-than-days 7",
          );
        }
        ifOlderThanDays = days;
        index += 1;
        break;
      }
      default:
        // A misspelt flag must not silently become an unconditional run.
        throw new Error(`Unknown argument ${String(flag)}`);
    }
  }
  if (statusOnly && ifOlderThanDays !== undefined) {
    throw new Error(
      "--if-older-than-days only means something for a run; --status asks the provider nothing",
    );
  }
  return {
    statusOnly,
    json,
    ...(ifOlderThanDays === undefined ? {} : { ifOlderThanDays }),
  };
}

/** The database's name, and nothing else, out of a connection string. */
export function databaseNameOf(databaseUrl: string): string {
  return databaseUrl.split("?")[0]!.split("/").pop() ?? "";
}

/**
 * Refuses to synchronize a database that must never hold a provider payload.
 *
 * The same rule `assertIngestTargetAllowed` applies, for the same reason: the matrix database is a
 * copy that makes no provider request, and the test database holds fictional members a real
 * directory would be written beside. Reading the stored state of either is harmless and allowed.
 */
export function assertSyncTargetAllowed(databaseUrl: string): void {
  const name = databaseNameOf(databaseUrl);
  if (/matrix|test/i.test(name)) {
    throw new Error(
      `Refusing to synchronize \`${name}\`. This asks a provider for the real member directory; the ` +
        "matrix and test databases are copies and fixtures, and a provider payload in either of " +
        "them is a defect. Synchronize the development database and provision the matrix from it.",
    );
  }
}

const day = (value: string | null): string => value ?? "never";

export function describeState(
  state: CongressMemberCatalogSyncState | null,
  members: number,
): string[] {
  const lines = [`Members in the catalog:        ${members}`];
  if (!state) {
    lines.push(
      "Synchronized with the directory: never. The catalog holds only members a loaded disclosure named.",
    );
    return lines;
  }
  lines.push(
    `Synchronized with the directory: ${day(state.lastCompletedAt)}`,
    `Runs started:                  ${state.runSequence}`,
    `Running now:                   ${state.running ? "yes" : "no"}`,
  );
  if (state.lastSummary) {
    const summary = state.lastSummary;
    lines.push(
      `Last complete run:             ${summary.received} in the directory ` +
        `(${summary.inOffice} in office, ${summary.former} former), ` +
        `${summary.created} added, ${summary.updated} updated, ${summary.declined} declined, ` +
        `${summary.retained} kept that the directory did not list`,
    );
  }
  if (state.lastFailedAt) {
    lines.push(
      `Last failed run:               ${state.lastFailedAt}` +
        (state.consecutiveFailures > 0
          ? ` (${state.consecutiveFailures} in a row)`
          : " (a later run completed)"),
    );
  }
  if (state.lastError) {
    lines.push(`Why:                           ${state.lastError}`);
  }
  return lines;
}

export function describeResult(
  result: CongressMemberCatalogSyncResult,
): string[] {
  switch (result.outcome) {
    case "UP_TO_DATE":
      return [
        `Nothing to do: the directory was synchronized at ${result.lastCompletedAt}. The provider was not asked.`,
      ];
    case "ALREADY_RUNNING":
      return [
        "Another synchronization is running. The provider was not asked; nothing was changed.",
      ];
    case "FAILED":
      return [
        `FAILED (${result.code}) after ${result.providerRequests} provider request(s).`,
        result.message,
        "The catalog is exactly as it was. Run the command again; a run is safe to repeat.",
      ];
    case "COMPLETED": {
      const summary = result.summary;
      const lines = [
        `Synchronized (run ${result.runSequence}), ${summary.providerRequests} provider request(s).`,
        `In the directory:      ${summary.received} (${summary.inOffice} in office, ${summary.former} former)`,
        `Added to the catalog:  ${summary.created}`,
        `Updated:               ${summary.updated} (${summary.relabelled} relabelled)`,
        `Unchanged:             ${summary.unchanged}`,
        `Declined:              ${summary.declined}`,
        `Kept, not in the directory: ${summary.retained}`,
      ];
      for (const [reason, count] of Object.entries(summary.declinedByReason)) {
        if (count > 0) {
          lines.push(`    ${reason}: ${count}`);
        }
      }
      for (const declined of result.declined) {
        lines.push(
          `    declined ${declined.externalId}: ${declined.reason}` +
            (declined.position ? ` (${declined.position})` : ""),
        );
      }
      if (summary.repeatedRows > 0) {
        lines.push(
          `Rows the directory repeated identically: ${summary.repeatedRows}`,
        );
      }
      return lines;
    }
  }
}

/**
 * A result as a report prints it: without the original error.
 *
 * The error belongs in the log, where its stack is useful. A report is counts, codes and dates, and
 * an error object could carry anything.
 */
export function reportable(
  result: CongressMemberCatalogSyncResult,
): CongressMemberCatalogSyncResult {
  if (result.outcome !== "FAILED") {
    return result;
  }
  return {
    outcome: result.outcome,
    runSequence: result.runSequence,
    code: result.code,
    message: result.message,
    providerRequests: result.providerRequests,
  };
}

async function run(): Promise<void> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const args = parseSyncMembersArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!args.statusOnly) {
    assertSyncTargetAllowed(databaseUrl);
  }

  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "congress-member-catalog" },
  });
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  const traffic = getFmpTrafficConfig();
  const service = new LoggedCongressMemberCatalogService(
    new CanonicalCongressMemberCatalogService(
      new PrismaCongressMemberCatalogStore(prisma),
      new FmpClient(() => getFmpConfig(), fetch, {
        gate: new RedisFmpRequestGate(redis, {
          maxConcurrentRequests: traffic.maxConcurrentRequests,
          rateLimitPerWindow: traffic.rateLimitPerWindow,
          rateWindowMs: traffic.rateWindowMs,
          maxQueueDepth: traffic.maxQueueDepth,
          maxQueueWaitMs: traffic.maxQueueWaitMs,
          requestLeaseMs: traffic.timeoutMs * 2,
        }),
      }),
      { owner: `cli-${process.pid}-${randomUUID()}` },
    ),
    logger,
  );

  let failed = false;
  try {
    await prisma.$connect();
    const result = args.statusOnly
      ? undefined
      : await service.sync(
          args.ifOlderThanDays === undefined
            ? {}
            : {
                unlessCompletedWithinMs:
                  args.ifOlderThanDays * 24 * 60 * 60_000,
              },
        );
    failed = result?.outcome === "FAILED";
    const state = await service.state();
    const members = await prisma.alternativeDataActor.count({});

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            database: databaseNameOf(databaseUrl),
            ...(result ? { result: reportable(result) } : {}),
            state,
            members,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Database: ${databaseNameOf(databaseUrl)}`);
      if (result) {
        console.log("");
        for (const line of describeResult(result)) {
          console.log(line);
        }
      }
      console.log("");
      for (const line of describeState(state, members)) {
        console.log(line);
      }
    }
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }

  if (failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].includes("sync-congress-members")) {
  void run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
