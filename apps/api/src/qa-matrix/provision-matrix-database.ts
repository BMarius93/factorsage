import { spawnSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import { DEFAULT_BENCHMARK_CODE } from "@intrinsic/contracts";
import { createStockDataRedisClient } from "@intrinsic/stock-data";
import { QA_MATRIX_SECURITIES } from "@intrinsic/testing";
import type { MatrixEnvironment } from "./matrix-environment";
import {
  MIRROR_PAGE,
  mirrorTableScope,
  reconcileIdentityRows,
  type MirrorResult,
} from "./mirror-table";

/**
 * Provisions the matrix database from already-durable canonical data.
 *
 * The matrix needs thirty-four years of real prices, derived state and statements for thirty-three
 * securities plus a thirty-year benchmark calendar. All of that already exists — in the development
 * database, hydrated by the prior long-backtest and 34-year retention work — so the matrix
 * **copies** it rather than asking the provider for it again. That is the whole design:
 *
 * - the source is read with `SELECT` and nothing else, so the development database is never
 *   reset, migrated, truncated or written to;
 * - no FMP request is made during provisioning or, if the copy is complete, during execution;
 * - the copy is restricted to canonical market data. No user, no strategy, no list and no previous
 *   backtest run crosses over, so the matrix database contains only the QA account the seeders
 *   create and the market data the runs read.
 *
 * It is idempotent, and it is an **exact** copy: each market-data scope is replaced rather than
 * topped up, so re-provisioning converges on the source whatever the matrix database held before.
 * Inserting with `skipDuplicates` used to leave a row the source had since corrected at its old
 * value (AUD-06). `mirror-table.ts` carries the two copy semantics and explains them.
 */

/** Rows per read page and per insert batch. Sized for wide `DailyDerivedState` rows. */
const PAGE = MIRROR_PAGE;

export type ProvisionProgress = (message: string) => void;

export type ProvisionResult = {
  readonly databaseCreated: boolean;
  readonly migrationsApplied: boolean;
  readonly copied: Readonly<Record<string, number>>;
  readonly securities: number;
  readonly durationMs: number;
};

/**
 * Creates the matrix database if it does not exist.
 *
 * `CREATE DATABASE` cannot run inside a transaction and cannot be parameterized, so the name is
 * validated rather than escaped: `resolveMatrixEnvironment` has already required it to contain
 * `matrix`, and this additionally requires it to be a plain identifier. A name that is not one is a
 * configuration error, not something to quote around.
 */
export async function ensureMatrixDatabaseExists(
  environment: MatrixEnvironment,
  progress: ProvisionProgress,
): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(environment.databaseName)) {
    throw new Error(
      `\`${environment.databaseName}\` is not a plain PostgreSQL identifier; the matrix database ` +
        "name must be one so it can be created without quoting games.",
    );
  }
  const admin = new PrismaClient({
    datasources: { db: { url: environment.adminDatabaseUrl } },
  });
  try {
    const existing = await admin.$queryRawUnsafe<{ datname: string }[]>(
      "select datname from pg_database where datname = $1",
      environment.databaseName,
    );
    if (existing.length > 0) {
      progress(`database \`${environment.databaseName}\` already exists`);
      return false;
    }
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${environment.databaseName}"`,
    );
    progress(`created database \`${environment.databaseName}\``);
    return true;
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Brings the matrix database to the repository's current migration head.
 *
 * Shells out to the same `prisma migrate deploy` every other environment uses rather than applying
 * SQL by hand: one migration history is a database rule, and a second way of applying it would be a
 * second history in all but name.
 */
export function applyMatrixMigrations(
  environment: MatrixEnvironment,
  progress: ProvisionProgress,
): boolean {
  progress("applying migrations (prisma migrate deploy)");
  const result = spawnSync(
    "pnpm",
    ["--filter", "@intrinsic/database", "prisma:migrate:deploy"],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: environment.databaseUrl },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed against the matrix database (exit ${result.status}).`,
    );
  }
  return true;
}

type Copier = {
  readonly table: string;
  copy(source: PrismaClient, target: PrismaClient): Promise<CopyOutcome>;
};

type CopyOutcome = {
  /** Rows the copy wrote into the target — the copied scope's row count afterwards. */
  readonly inserted: number;
  /** Rows the copy removed from the target first, stale or not. */
  readonly deleted?: number;
  /** Identity rows whose content the source had changed. */
  readonly updated?: number;
  /** Identity rows only the target has. They are kept; `mirror-table.ts` explains why. */
  readonly extra?: number;
};

async function insertBatches<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let written = 0;
  for (let index = 0; index < rows.length; index += PAGE) {
    const result = await insert([...rows.slice(index, index + PAGE)]);
    written += result.count;
  }
  return written;
}

/** Binds {@link mirrorTableScope} to a pair of Prisma delegates for one scope. */
function mirrorScope<T>(
  read: (skip: number, take: number) => Promise<T[]>,
  remove: () => Promise<{ count: number }>,
  insert: (rows: readonly T[]) => Promise<{ count: number }>,
): Promise<MirrorResult> {
  return mirrorTableScope(
    {
      readSourcePage: read,
      deleteTargetScope: async () => (await remove()).count,
      insertTarget: async (rows) => (await insert(rows)).count,
    },
    PAGE,
  );
}

function totalMirrored(results: readonly MirrorResult[]): CopyOutcome {
  return {
    inserted: results.reduce((sum, result) => sum + result.inserted, 0),
    deleted: results.reduce((sum, result) => sum + result.deleted, 0),
  };
}

function describeOutcome(outcome: CopyOutcome): string {
  const parts = [`${outcome.inserted} row(s)`];
  if (outcome.deleted) {
    parts.push(`replacing ${outcome.deleted}`);
  }
  if (outcome.updated) {
    parts.push(`${outcome.updated} updated`);
  }
  if (outcome.extra) {
    parts.push(`${outcome.extra} target-only kept`);
  }
  return parts.join(", ");
}

async function perSecurity(
  securityIds: readonly string[],
  mirror: (securityId: string) => Promise<MirrorResult>,
): Promise<MirrorResult[]> {
  const results: MirrorResult[] = [];
  for (const securityId of securityIds) {
    results.push(await mirror(securityId));
  }
  return results;
}

/**
 * The canonical market data the matrix depends on, and nothing else.
 *
 * The catalog is copied whole because `Security` is the identity authority and a partial catalog
 * would make the matrix database one in which the product's own search and navigation behave
 * differently. Everything keyed by a security is restricted to the thirty-three the fixtures name:
 * copying prices for nine thousand securities the matrix never reads would take an hour to move
 * data no run opens.
 *
 * The three identity tables are reconciled; every other table is mirrored scope by scope, one scope
 * per security or per series, so the copy of one security's history never depends on what the
 * matrix database already held for it.
 */
function copiers(securityIds: readonly string[]): readonly Copier[] {
  const where = { securityId: { in: [...securityIds] } };
  return [
    {
      table: "Security",
      copy(source, target) {
        return reconcileIdentityRows({
          readSource: () => source.security.findMany(),
          readTarget: () => target.security.findMany(),
          insertTarget: (rows) =>
            insertBatches(rows, (batch) =>
              target.security.createMany({ data: batch }),
            ),
          updateTarget: async ({ id, updatedAt: _updatedAt, ...data }) => {
            await target.security.update({ where: { id }, data });
          },
        });
      },
    },
    {
      table: "SecurityProfile",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.securityProfile.findMany({
              where,
              orderBy: { securityId: "asc" },
              skip,
              take,
            }),
          () => target.securityProfile.deleteMany({ where }),
          (rows) => target.securityProfile.createMany({ data: [...rows] }),
        );
      },
    },
    {
      table: "StockDatasetState",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.stockDatasetState.findMany({
              where,
              orderBy: [
                { securityId: "asc" },
                { dataset: "asc" },
                { variant: "asc" },
              ],
              skip,
              take,
            }),
          () => target.stockDatasetState.deleteMany({ where }),
          (rows) => target.stockDatasetState.createMany({ data: [...rows] }),
        );
      },
    },
    {
      table: "StockDatasetCoverage",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.stockDatasetCoverage.findMany({
              where,
              orderBy: { id: "asc" },
              skip,
              take,
            }),
          () => target.stockDatasetCoverage.deleteMany({ where }),
          (rows) => target.stockDatasetCoverage.createMany({ data: [...rows] }),
        );
      },
    },
    {
      table: "FinancialStatement",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.financialStatement.findMany({
              where,
              orderBy: { id: "asc" },
              skip,
              take,
            }),
          () => target.financialStatement.deleteMany({ where }),
          (rows) =>
            // `values` is `JSONB` and Prisma's read type admits `null`, which its create type does
            // not. A statement row never actually carries JSON null, so the document is passed
            // through as the input type rather than being reshaped.
            target.financialStatement.createMany({
              data: rows.map((row) => ({
                ...row,
                values: row.values as Prisma.InputJsonValue,
              })),
            }),
        );
      },
    },
    {
      table: "DailyPrice",
      async copy(source, target) {
        return totalMirrored(
          await perSecurity(securityIds, (securityId) =>
            mirrorScope(
              (skip, take) =>
                source.dailyPrice.findMany({
                  where: { securityId },
                  orderBy: { date: "asc" },
                  skip,
                  take,
                }),
              () => target.dailyPrice.deleteMany({ where: { securityId } }),
              (rows) => target.dailyPrice.createMany({ data: [...rows] }),
            ),
          ),
        );
      },
    },
    {
      table: "WeeklyPrice",
      async copy(source, target) {
        return totalMirrored(
          await perSecurity(securityIds, (securityId) =>
            mirrorScope(
              (skip, take) =>
                source.weeklyPrice.findMany({
                  where: { securityId },
                  orderBy: { weekStartDate: "asc" },
                  skip,
                  take,
                }),
              () => target.weeklyPrice.deleteMany({ where: { securityId } }),
              (rows) => target.weeklyPrice.createMany({ data: [...rows] }),
            ),
          ),
        );
      },
    },
    {
      table: "DailyDerivedState",
      async copy(source, target) {
        return totalMirrored(
          await perSecurity(securityIds, (securityId) =>
            mirrorScope(
              (skip, take) =>
                source.dailyDerivedState.findMany({
                  where: { securityId },
                  orderBy: { date: "asc" },
                  skip,
                  take,
                }),
              () =>
                target.dailyDerivedState.deleteMany({ where: { securityId } }),
              (rows) =>
                target.dailyDerivedState.createMany({ data: [...rows] }),
            ),
          ),
        );
      },
    },
    {
      table: "Benchmark",
      copy(source, target) {
        return reconcileIdentityRows({
          readSource: () => source.benchmark.findMany(),
          readTarget: () => target.benchmark.findMany(),
          insertTarget: (rows) =>
            insertBatches(rows, (batch) =>
              target.benchmark.createMany({ data: batch }),
            ),
          updateTarget: async ({ id, updatedAt: _updatedAt, ...data }) => {
            await target.benchmark.update({ where: { id }, data });
          },
        });
      },
    },
    {
      table: "BenchmarkSeries",
      copy(source, target) {
        // `BenchmarkSeries` has no `updatedAt`, so every one of its columns is compared.
        return reconcileIdentityRows(
          {
            readSource: () => source.benchmarkSeries.findMany(),
            readTarget: () => target.benchmarkSeries.findMany(),
            insertTarget: (rows) =>
              insertBatches(rows, (batch) =>
                target.benchmarkSeries.createMany({ data: batch }),
              ),
            updateTarget: async ({ id, ...data }) => {
              await target.benchmarkSeries.update({ where: { id }, data });
            },
          },
          [],
        );
      },
    },
    {
      table: "BenchmarkDailyPrice",
      async copy(source, target) {
        const series = await source.benchmarkSeries.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const results: MirrorResult[] = [];
        for (const { id: seriesId } of series) {
          results.push(
            await mirrorScope(
              (skip, take) =>
                source.benchmarkDailyPrice.findMany({
                  where: { seriesId },
                  orderBy: { date: "asc" },
                  skip,
                  take,
                }),
              () =>
                target.benchmarkDailyPrice.deleteMany({ where: { seriesId } }),
              (rows) =>
                target.benchmarkDailyPrice.createMany({ data: [...rows] }),
            ),
          );
        }
        return totalMirrored(results);
      },
    },
    {
      table: "BenchmarkDatasetState",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.benchmarkDatasetState.findMany({
              orderBy: [
                { seriesId: "asc" },
                { dataset: "asc" },
                { variant: "asc" },
              ],
              skip,
              take,
            }),
          () => target.benchmarkDatasetState.deleteMany({}),
          (rows) =>
            target.benchmarkDatasetState.createMany({ data: [...rows] }),
        );
      },
    },
    {
      // The canonical actor catalog: a global identity table, like `Security`, and copied whole so a
      // congressional disclosure's `actorId` resolves and an actor group can name a real member.
      table: "AlternativeDataActor",
      copy(source, target) {
        // `metadata` is nullable `JSONB`, which Prisma's read type admits as `null` and its write
        // types do not. An absent document is written as an omitted field rather than as a JSON
        // null, which is the same stored value and the same thing a fresh ingest writes; a document
        // that is present crosses unchanged.
        const writable = <T extends { metadata: Prisma.JsonValue }>(
          row: T,
        ): Omit<T, "metadata"> & { metadata?: Prisma.InputJsonValue } => {
          const { metadata, ...rest } = row;
          return metadata === null
            ? rest
            : { ...rest, metadata: metadata as Prisma.InputJsonValue };
        };
        return reconcileIdentityRows({
          readSource: () => source.alternativeDataActor.findMany(),
          readTarget: () => target.alternativeDataActor.findMany(),
          insertTarget: (rows) =>
            insertBatches(rows, (batch) =>
              target.alternativeDataActor.createMany({
                data: batch.map(writable),
              }),
            ),
          updateTarget: async ({ id, updatedAt: _updatedAt, ...data }) => {
            await target.alternativeDataActor.update({
              where: { id },
              data: writable(data),
            });
          },
        });
      },
    },
    {
      // Insider and congressional disclosure history, per security, exactly as the price history is.
      // Without them a matrix strategy naming an alternative-data metric would evaluate against no
      // coverage at all — every session NOT_EVALUABLE — and a sweep would report a thousand green
      // runs that never tested the thing they were built to test. Their `StockDatasetState` and
      // `StockDatasetCoverage` rows come across with every other dataset's above, which is what
      // makes the copied coverage floor the same statement here as in the source.
      table: "InsiderTransaction",
      async copy(source, target) {
        return totalMirrored(
          await perSecurity(securityIds, (securityId) =>
            mirrorScope(
              (skip, take) =>
                source.insiderTransaction.findMany({
                  where: { securityId },
                  orderBy: { id: "asc" },
                  skip,
                  take,
                }),
              () =>
                target.insiderTransaction.deleteMany({ where: { securityId } }),
              (rows) =>
                target.insiderTransaction.createMany({
                  data: rows.map((row) => ({
                    ...row,
                    raw: row.raw as Prisma.InputJsonValue,
                  })),
                }),
            ),
          ),
        );
      },
    },
    {
      table: "CongressTrade",
      async copy(source, target) {
        return totalMirrored(
          await perSecurity(securityIds, (securityId) =>
            mirrorScope(
              (skip, take) =>
                source.congressTrade.findMany({
                  where: { securityId },
                  orderBy: { id: "asc" },
                  skip,
                  take,
                }),
              () => target.congressTrade.deleteMany({ where: { securityId } }),
              (rows) =>
                target.congressTrade.createMany({
                  data: rows.map((row) => ({
                    ...row,
                    raw: row.raw as Prisma.InputJsonValue,
                  })),
                }),
            ),
          ),
        );
      },
    },
    {
      table: "BenchmarkDatasetCoverage",
      copy(source, target) {
        return mirrorScope(
          (skip, take) =>
            source.benchmarkDatasetCoverage.findMany({
              orderBy: { id: "asc" },
              skip,
              take,
            }),
          () => target.benchmarkDatasetCoverage.deleteMany({}),
          (rows) =>
            target.benchmarkDatasetCoverage.createMany({ data: [...rows] }),
        );
      },
    },
  ];
}

/**
 * Copies canonical market data from the source database into the matrix database.
 *
 * The source client is opened read-only in intent — nothing in `copiers` issues a write against it,
 * which is asserted by the fact that every `source` call is a `findMany`. The alternative,
 * `CREATE DATABASE … TEMPLATE`, would be one statement but requires that nothing else is connected
 * to the development database and would carry its users, strategies and runs across with it.
 */
export async function copyCanonicalMarketData(
  environment: MatrixEnvironment,
  progress: ProvisionProgress,
): Promise<{ copied: Record<string, number>; securities: number }> {
  const source = new PrismaClient({
    datasources: { db: { url: environment.sourceDatabaseUrl } },
  });
  const target = new PrismaClient({
    datasources: { db: { url: environment.databaseUrl } },
  });

  try {
    const symbols = QA_MATRIX_SECURITIES.map((entry) => entry.symbol);
    const sourceSecurities = await source.security.findMany({
      where: { symbol: { in: symbols } },
      select: { id: true, symbol: true },
    });
    const found = new Set(sourceSecurities.map((row) => row.symbol));
    const missing = symbols.filter((symbol) => !found.has(symbol));
    if (missing.length > 0) {
      throw new Error(
        `The provisioning source does not carry ${missing.length} matrix securities ` +
          `(${missing.join(", ")}). The matrix reuses already-hydrated canonical data rather than ` +
          "fetching decades of history again, so the source database must already have them. " +
          "Hydrate them there first, or point QA_MATRIX_SOURCE_DATABASE_URL at a database that does.",
      );
    }

    const securityIds = sourceSecurities.map((row) => row.id);
    const copied: Record<string, number> = {};
    for (const copier of copiers(securityIds)) {
      const startedAt = Date.now();
      const outcome = await copier.copy(source, target);
      copied[copier.table] = outcome.inserted;
      progress(
        `copied ${copier.table}: ${describeOutcome(outcome)} in ${
          Date.now() - startedAt
        }ms`,
      );
    }

    await assertCalendarCopied(target);
    return { copied, securities: securityIds.length };
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

/**
 * The one copy whose absence would not surface until a thousand runs had executed against a
 * silently shortened period.
 */
async function assertCalendarCopied(target: PrismaClient): Promise<void> {
  for (const code of new Set([
    EXECUTION_CALENDAR_REFERENCE_CODE,
    DEFAULT_BENCHMARK_CODE,
  ])) {
    const series = (
      await target.benchmark.findFirst({
        where: { code },
        include: { series: { orderBy: { version: "desc" }, take: 1 } },
      })
    )?.series[0];
    const bars = series
      ? await target.benchmarkDailyPrice.count({
          where: { seriesId: series.id },
        })
      : 0;
    if (bars === 0) {
      throw new Error(
        `The matrix database has no bars for the \`${code}\` benchmark after provisioning. ` +
          "A run needs it as its execution calendar and as its comparison, and without it the " +
          "matrix would either refuse every submission or simulate a period nobody asked for.",
      );
    }
  }
}

/** The little of a Redis client this needs, so the flush can be tested without a server. */
export type MatrixProjectionStore = {
  flushdb(): Promise<unknown>;
  disconnect(): void;
};

/**
 * Discards the matrix environment's Redis projections.
 *
 * Redis holds *projections* of the copied data — yearly price chunks, derived-state chunks, the
 * per-security manifest, the benchmark series. They are disposable by design and rebuilt from
 * PostgreSQL, but nothing invalidates them when the copy underneath changes: a manifest whose
 * dataset versions still match is trusted, so a projection built from the previous copy keeps being
 * served. That is the same defect as AUD-06 one layer up, and it showed itself as one: after the
 * matrix data was re-copied with a settled final bar, the runs still priced the benchmark from the
 * cached in-session bar (SPY 2026-09-22 close 773.44 against the stored 773.38) and invariant 17
 * failed on the final date of 494 of them.
 *
 * So provisioning ends by emptying the matrix Redis index. `resolveMatrixEnvironment` has already
 * required that index to be the matrix's own and not the development one; this additionally
 * requires the URL to name exactly the index the environment reports, because `FLUSHDB` is
 * irreversible and a client connected to the wrong index would empty a live cache.
 */
export async function discardMatrixProjections(
  environment: MatrixEnvironment,
  progress: ProvisionProgress,
  connect: (url: string) => MatrixProjectionStore = (url) =>
    createStockDataRedisClient(url),
): Promise<void> {
  const index = Number(new URL(environment.redisUrl).pathname.slice(1));
  if (!Number.isInteger(index) || index !== environment.redisDb) {
    throw new Error(
      `The matrix Redis URL names index \`${new URL(environment.redisUrl).pathname}\` while the ` +
        `environment reports database ${environment.redisDb}. Refusing to flush: the two must ` +
        "agree, or the flush could empty a cache that belongs to something else.",
    );
  }
  const redis = connect(environment.redisUrl);
  try {
    await redis.flushdb();
    progress(
      `discarded the Redis projections in database ${index}; they rebuild from PostgreSQL on first read`,
    );
  } finally {
    redis.disconnect();
  }
}

export async function provisionMatrixDatabase(
  environment: MatrixEnvironment,
  progress: ProvisionProgress,
): Promise<ProvisionResult> {
  const startedAt = Date.now();
  const databaseCreated = await ensureMatrixDatabaseExists(
    environment,
    progress,
  );
  const migrationsApplied = applyMatrixMigrations(environment, progress);
  const { copied, securities } = await copyCanonicalMarketData(
    environment,
    progress,
  );
  // After the copy, not before: a projection rebuilt from the half-copied data would be exactly
  // what this is here to prevent.
  await discardMatrixProjections(environment, progress);
  return {
    databaseCreated,
    migrationsApplied,
    copied,
    securities,
    durationMs: Date.now() - startedAt,
  };
}
