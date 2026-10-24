import {
  IndexIngestionStatus,
  MarketIndexKey as MarketIndexKeyEnum,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import {
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import type { LocalDate, MarketIndexKey } from "@intrinsic/domain";
import type { StructuredLogger as Logger } from "@intrinsic/observability";
import {
  ALTERNATIVE_DATA_DOMAINS,
  type CanonicalAlternativeDataService,
  type CanonicalStockDataService,
} from "@intrinsic/stock-data";

/**
 * The bulk history ingestion of an index universe (`docs/decisions/sp500-historical-pit-v1.md` §6).
 *
 * Every resolved security's full supported history is loaded through the canonical loaders — the
 * exact reads a product surface would make — so prices, statements, the derived state, the split
 * list and the alternative-data disclosures land exactly where and how they always do. What this
 * adds is durability around a run of a thousand securities:
 *
 * - **Checkpointed.** Each security's outcome is written to `IndexUniverseIngestion` as soon as it
 *   is known, so a run that stops — a crash, a closed session, an exhausted budget — resumes from the
 *   first security not yet done instead of from the start.
 * - **Idempotent.** The loaders ask the provider only for what PostgreSQL does not already cover, so
 *   repeating a security that already succeeded costs a handful of freshness checks and nothing
 *   else, and the same row is never stored twice.
 * - **Incremental.** `--refresh` repeats every security, which reads only each one's stale tail:
 *   the safe way to bring the universe up to date after the initial load.
 * - **Shardable.** `--shard i/n` takes every n-th security, so several processes share the CPU of the
 *   derived-state rebuilds while the one provider gate keeps their combined traffic inside the plan.
 * - **Shared across indexes.** A security's history is one dataset whichever index names it
 *   (`docs/decisions/historical-universes-v1.md` §7): a security another index's run already loaded
 *   is checkpointed here as reused, at no provider cost, instead of being loaded again. `--refresh`
 *   and `--symbols` still repeat it.
 */

export const INGESTION_STEPS = [
  "CORE_HISTORY",
  "VALUATION_INPUTS",
  "ALTERNATIVE_DATA",
] as const;

export type IngestionStep = (typeof INGESTION_STEPS)[number];

export type IngestionStepOutcome = {
  readonly step: IngestionStep;
  readonly status: "COMPLETED" | "FAILED" | "NOT_RUN";
  readonly durationMs: number;
  readonly detail?: string;
};

export type IndexUniverseIngestionSummary = {
  /** Securities another index's run already loaded, checkpointed here without a provider request. */
  readonly reused: number;
  readonly selected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stoppedEarly: boolean;
  readonly durationMs: number;
  readonly providerRequests: number;
};

export type IngestionSelection = {
  /** Repeat securities that already succeeded (an incremental refresh). */
  readonly refresh: boolean;
  /** Repeat securities whose last attempt failed. */
  readonly retryFailed: boolean;
  readonly maxAttempts: number;
  readonly symbols: readonly string[] | null;
  readonly shard: { index: number; count: number } | null;
  readonly limit: number | null;
};

type UniverseSecurity = { securityId: string; providerSymbol: string };

/** The resolved securities of a universe, ordered by provider symbol. */
export async function universeSecurities(
  prisma: PrismaClient,
  indexKey: MarketIndexKey,
): Promise<UniverseSecurity[]> {
  const rows = await prisma.indexConstituent.findMany({
    where: {
      indexKey: MarketIndexKeyEnum[indexKey],
      resolution: { in: ["RESOLVED", "RESOLVED_PARTIAL"] },
      securityId: { not: null },
    },
    select: { security: { select: { id: true, providerSymbol: true } } },
  });
  const unique = new Map<string, UniverseSecurity>();
  for (const row of rows) {
    if (row.security) {
      unique.set(row.security.id, {
        securityId: row.security.id,
        providerSymbol: row.security.providerSymbol,
      });
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.providerSymbol < right.providerSymbol ? -1 : 1,
  );
}

/** Stable shard of a security: a hash of its id, so shards never depend on list order. */
function shardOf(securityId: string, count: number): number {
  let hash = 0;
  for (let index = 0; index < securityId.length; index += 1) {
    hash = (hash * 31 + securityId.charCodeAt(index)) >>> 0;
  }
  return hash % count;
}

export async function runIndexUniverseIngestion(input: {
  readonly prisma: PrismaClient;
  readonly indexKey: MarketIndexKey;
  readonly stockData: CanonicalStockDataService;
  readonly alternativeData: CanonicalAlternativeDataService;
  readonly range: { from: LocalDate; to: LocalDate };
  readonly selection: IngestionSelection;
  readonly concurrency: number;
  readonly logger: Logger;
  /** Requests the loaders have announced per symbol, cumulative for the process. */
  readonly providerRequests: ReadonlyMap<string, number>;
  /** True once the run must stop: a closed guard or a signal. */
  readonly shouldStop: () => boolean;
}): Promise<IndexUniverseIngestionSummary> {
  const { prisma, logger } = input;
  const startedAt = Date.now();
  const indexKey = MarketIndexKeyEnum[input.indexKey];
  const universe = await universeSecurities(prisma, input.indexKey);

  // Every universe security has a progress row; a new one starts PENDING.
  const known = new Set(
    (
      await prisma.indexUniverseIngestion.findMany({
        where: { indexKey },
        select: { securityId: true },
      })
    ).map((row) => row.securityId),
  );
  const missing = universe.filter((entry) => !known.has(entry.securityId));
  for (let offset = 0; offset < missing.length; offset += 500) {
    await prisma.indexUniverseIngestion.createMany({
      data: missing.slice(offset, offset + 500).map((entry) => ({
        indexKey,
        securityId: entry.securityId,
      })),
      skipDuplicates: true,
    });
  }

  const wantedSymbols = input.selection.symbols
    ? new Set(input.selection.symbols.map((symbol) => symbol.toUpperCase()))
    : null;
  const reused = input.selection.refresh
    ? 0
    : await reuseOtherIndexIngestions(
        prisma,
        indexKey,
        universe,
        wantedSymbols,
      );

  const progress = new Map(
    (await prisma.indexUniverseIngestion.findMany({ where: { indexKey } })).map(
      (row) => [row.securityId, row],
    ),
  );
  let work = universe.filter((entry) => {
    if (wantedSymbols && !wantedSymbols.has(entry.providerSymbol)) {
      return false;
    }
    if (
      input.selection.shard &&
      shardOf(entry.securityId, input.selection.shard.count) !==
        input.selection.shard.index
    ) {
      return false;
    }
    const row = progress.get(entry.securityId);
    if (!row || row.status === IndexIngestionStatus.PENDING) {
      return true;
    }
    if (row.status === IndexIngestionStatus.FAILED) {
      return (
        input.selection.retryFailed &&
        row.attempts < input.selection.maxAttempts
      );
    }
    return input.selection.refresh || wantedSymbols !== null;
  });
  if (input.selection.limit !== null) {
    work = work.slice(0, input.selection.limit);
  }
  logger.info({
    event: "index.ingest.started",
    indexKey: input.indexKey,
    universe: universe.length,
    reused,
    selected: work.length,
    concurrency: input.concurrency,
    shard: input.selection.shard,
  });

  let succeeded = 0;
  let failed = 0;
  let done = 0;
  let stoppedEarly = false;
  const requestsBefore = sumRequests(input.providerRequests);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (input.shouldStop()) {
        stoppedEarly = true;
        return;
      }
      const index = next;
      next += 1;
      const entry = work[index];
      if (!entry) {
        return;
      }
      const outcome = await ingestSecurity(input, entry);
      done += 1;
      if (outcome === "SUCCEEDED") {
        succeeded += 1;
      } else {
        failed += 1;
      }
      if (done % 10 === 0 || done === work.length) {
        logger.info({
          event: "index.ingest.progress",
          done,
          selected: work.length,
          succeeded,
          failed,
          elapsedMs: Date.now() - startedAt,
          providerRequests:
            sumRequests(input.providerRequests) - requestsBefore,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, input.concurrency) }, () => worker()),
  );
  const summary = {
    reused,
    selected: work.length,
    succeeded,
    failed,
    skipped: work.length - done,
    stoppedEarly,
    durationMs: Date.now() - startedAt,
    providerRequests: sumRequests(input.providerRequests) - requestsBefore,
  };
  logger.info({ event: "index.ingest.completed", ...summary });
  return summary;
}

/**
 * Checkpoints as succeeded, without a provider request, every pending security of this universe
 * whose full history another index's run already loaded. Returns how many.
 */
async function reuseOtherIndexIngestions(
  prisma: PrismaClient,
  indexKey: MarketIndexKeyEnum,
  universe: readonly UniverseSecurity[],
  wantedSymbols: ReadonlySet<string> | null,
): Promise<number> {
  const candidates = universe.filter(
    (entry) =>
      wantedSymbols === null || !wantedSymbols.has(entry.providerSymbol),
  );
  if (candidates.length === 0) {
    return 0;
  }
  const pending = new Set(
    (
      await prisma.indexUniverseIngestion.findMany({
        where: {
          indexKey,
          status: IndexIngestionStatus.PENDING,
          securityId: { in: candidates.map((entry) => entry.securityId) },
        },
        select: { securityId: true },
      })
    ).map((row) => row.securityId),
  );
  if (pending.size === 0) {
    return 0;
  }
  const elsewhere = await prisma.indexUniverseIngestion.findMany({
    where: {
      indexKey: { not: indexKey },
      status: IndexIngestionStatus.SUCCEEDED,
      securityId: { in: [...pending] },
    },
    select: { securityId: true, indexKey: true, lastCompletedAt: true },
    orderBy: [{ securityId: "asc" }, { indexKey: "asc" }],
  });
  const source = new Map<string, (typeof elsewhere)[number]>();
  for (const row of elsewhere) {
    if (!source.has(row.securityId)) {
      source.set(row.securityId, row);
    }
  }
  for (const [securityId, row] of source) {
    const detail = `reused: loaded by the ${row.indexKey} ingestion${row.lastCompletedAt ? ` at ${row.lastCompletedAt.toISOString()}` : ""}`;
    await prisma.indexUniverseIngestion.update({
      where: { indexKey_securityId: { indexKey, securityId } },
      data: {
        status: IndexIngestionStatus.SUCCEEDED,
        lastCompletedAt: new Date(),
        lastError: null,
        providerRequests: 0,
        durationMs: 0,
        stepOutcomes: INGESTION_STEPS.map((step) => ({
          step,
          status: "COMPLETED",
          durationMs: 0,
          detail,
        })) as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return source.size;
}

async function ingestSecurity(
  input: Parameters<typeof runIndexUniverseIngestion>[0],
  entry: UniverseSecurity,
): Promise<"SUCCEEDED" | "FAILED"> {
  const { prisma, logger } = input;
  const indexKey = MarketIndexKeyEnum[input.indexKey];
  const key = {
    indexKey_securityId: { indexKey, securityId: entry.securityId },
  };
  const startedAt = Date.now();
  const requestsBefore = input.providerRequests.get(entry.providerSymbol) ?? 0;
  await prisma.indexUniverseIngestion.update({
    where: key,
    data: { attempts: { increment: 1 }, lastStartedAt: new Date() },
  });
  const steps: IngestionStepOutcome[] = [];
  const run = async (
    step: IngestionStep,
    blockedBy: string | null,
    work: () => Promise<void>,
  ): Promise<boolean> => {
    if (blockedBy !== null) {
      steps.push({ step, status: "NOT_RUN", durationMs: 0, detail: blockedBy });
      return false;
    }
    const stepStartedAt = Date.now();
    try {
      await work();
      steps.push({
        step,
        status: "COMPLETED",
        durationMs: Date.now() - stepStartedAt,
      });
      return true;
    } catch (error) {
      steps.push({
        step,
        status: "FAILED",
        durationMs: Date.now() - stepStartedAt,
        detail: describeError(error),
      });
      logger.warn({
        event: "index.ingest.step.failed",
        symbol: entry.providerSymbol,
        step,
        err: error,
      });
      return false;
    }
  };

  const core = await run("CORE_HISTORY", null, async () => {
    await input.stockData.getDailyDerivedState(
      entry.providerSymbol,
      input.range,
    );
  });
  const valuation = await run(
    "VALUATION_INPUTS",
    core ? null : "core history did not complete",
    async () => {
      // One ratio read refreshes the split list, which is the only valuation input stored; the
      // ratios themselves are computed when read and never persisted.
      await input.stockData.getDailyValuationRatio(
        entry.providerSymbol,
        VALUATION_RATIO_IDS[0] as ValuationRatioId,
        {
          from: input.range.to,
          to: input.range.to,
        },
      );
    },
  );
  const alternative = await run("ALTERNATIVE_DATA", null, async () => {
    const security = await input.stockData.getSecurity(entry.providerSymbol);
    await input.alternativeData.ensureIngested(
      security,
      ALTERNATIVE_DATA_DOMAINS,
    );
  });
  const ok = core && valuation && alternative;
  const failure = steps.find((step) => step.status === "FAILED");
  await prisma.indexUniverseIngestion.update({
    where: key,
    data: {
      status: ok ? IndexIngestionStatus.SUCCEEDED : IndexIngestionStatus.FAILED,
      lastCompletedAt: ok ? new Date() : undefined,
      lastError: ok
        ? null
        : (failure?.detail ?? "a step did not run").slice(0, 1_000),
      providerRequests:
        (input.providerRequests.get(entry.providerSymbol) ?? 0) -
        requestsBefore,
      durationMs: Date.now() - startedAt,
      stepOutcomes: steps as unknown as Prisma.InputJsonValue,
    },
  });
  return ok ? "SUCCEEDED" : "FAILED";
}

function sumRequests(requests: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of requests.values()) {
    total += value;
  }
  return total;
}

/** An error as a report may describe it: class, message, HTTP status and the first code in its causes. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }
  const details: string[] = [];
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") {
    details.push(`HTTP ${status}`);
  }
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,59}$/.test(code)) {
      details.push(code);
      break;
    }
    current = current.cause;
  }
  return `${error.name}: ${error.message}${details.length > 0 ? ` [${details.join(", ")}]` : ""}`;
}
