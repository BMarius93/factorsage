import { spawnSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import { DEFAULT_BENCHMARK_CODE } from "@intrinsic/contracts";
import { QA_MATRIX_SECURITIES } from "@intrinsic/testing";
import type { MatrixEnvironment } from "./matrix-environment";

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
 * It is idempotent. Rows are inserted with `skipDuplicates`, so re-provisioning tops up whatever is
 * missing — a source that has since hydrated another year, a table that failed halfway — without
 * duplicating anything or dropping what is there.
 */

/** Rows per read page and per insert batch. Sized for wide `DailyDerivedState` rows. */
const PAGE = 2_000;

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
  copy(source: PrismaClient, target: PrismaClient): Promise<number>;
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

/**
 * The canonical market data the matrix depends on, and nothing else.
 *
 * The catalog is copied whole because `Security` is the identity authority and a partial catalog
 * would make the matrix database one in which the product's own search and navigation behave
 * differently. Everything keyed by a security is restricted to the thirty-three the fixtures name:
 * copying prices for nine thousand securities the matrix never reads would take an hour to move
 * data no run opens.
 */
function copiers(securityIds: readonly string[]): readonly Copier[] {
  const where = { securityId: { in: [...securityIds] } };
  return [
    {
      table: "Security",
      async copy(source, target) {
        const rows = await source.security.findMany();
        return insertBatches(rows, (batch) =>
          target.security.createMany({ data: batch, skipDuplicates: true }),
        );
      },
    },
    {
      table: "SecurityProfile",
      async copy(source, target) {
        const rows = await source.securityProfile.findMany({ where });
        return insertBatches(rows, (batch) =>
          target.securityProfile.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
    {
      table: "StockDatasetState",
      async copy(source, target) {
        const rows = await source.stockDatasetState.findMany({ where });
        return insertBatches(rows, (batch) =>
          target.stockDatasetState.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
    {
      table: "StockDatasetCoverage",
      async copy(source, target) {
        const rows = await source.stockDatasetCoverage.findMany({ where });
        return insertBatches(rows, (batch) =>
          target.stockDatasetCoverage.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
    {
      table: "FinancialStatement",
      async copy(source, target) {
        const rows = await source.financialStatement.findMany({ where });
        // `values` is `JSONB` and Prisma's read type admits `null`, which its create type does not.
        // A statement row never actually carries JSON null, so the document is passed through as
        // the input type rather than being reshaped.
        return insertBatches(
          rows.map((row) => ({
            ...row,
            values: row.values as Prisma.InputJsonValue,
          })),
          (batch) =>
            target.financialStatement.createMany({
              data: batch,
              skipDuplicates: true,
            }),
        );
      },
    },
    {
      table: "DailyPrice",
      async copy(source, target) {
        let written = 0;
        for (const securityId of securityIds) {
          written += await copyPaged(
            (skip) =>
              source.dailyPrice.findMany({
                where: { securityId },
                orderBy: { date: "asc" },
                skip,
                take: PAGE,
              }),
            (batch) =>
              target.dailyPrice.createMany({
                data: batch,
                skipDuplicates: true,
              }),
          );
        }
        return written;
      },
    },
    {
      table: "WeeklyPrice",
      async copy(source, target) {
        let written = 0;
        for (const securityId of securityIds) {
          written += await copyPaged(
            (skip) =>
              source.weeklyPrice.findMany({
                where: { securityId },
                orderBy: { weekStartDate: "asc" },
                skip,
                take: PAGE,
              }),
            (batch) =>
              target.weeklyPrice.createMany({
                data: batch,
                skipDuplicates: true,
              }),
          );
        }
        return written;
      },
    },
    {
      table: "DailyDerivedState",
      async copy(source, target) {
        let written = 0;
        for (const securityId of securityIds) {
          written += await copyPaged(
            (skip) =>
              source.dailyDerivedState.findMany({
                where: { securityId },
                orderBy: { date: "asc" },
                skip,
                take: PAGE,
              }),
            (batch) =>
              target.dailyDerivedState.createMany({
                data: batch,
                skipDuplicates: true,
              }),
          );
        }
        return written;
      },
    },
    {
      table: "Benchmark",
      async copy(source, target) {
        const rows = await source.benchmark.findMany();
        return insertBatches(rows, (batch) =>
          target.benchmark.createMany({ data: batch, skipDuplicates: true }),
        );
      },
    },
    {
      table: "BenchmarkSeries",
      async copy(source, target) {
        const rows = await source.benchmarkSeries.findMany();
        return insertBatches(rows, (batch) =>
          target.benchmarkSeries.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
    {
      table: "BenchmarkDailyPrice",
      async copy(source, target) {
        const series = await source.benchmarkSeries.findMany({
          select: { id: true },
        });
        let written = 0;
        for (const { id } of series) {
          written += await copyPaged(
            (skip) =>
              source.benchmarkDailyPrice.findMany({
                where: { seriesId: id },
                orderBy: { date: "asc" },
                skip,
                take: PAGE,
              }),
            (batch) =>
              target.benchmarkDailyPrice.createMany({
                data: batch,
                skipDuplicates: true,
              }),
          );
        }
        return written;
      },
    },
    {
      table: "BenchmarkDatasetState",
      async copy(source, target) {
        const rows = await source.benchmarkDatasetState.findMany();
        return insertBatches(rows, (batch) =>
          target.benchmarkDatasetState.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
    {
      table: "BenchmarkDatasetCoverage",
      async copy(source, target) {
        const rows = await source.benchmarkDatasetCoverage.findMany();
        return insertBatches(rows, (batch) =>
          target.benchmarkDatasetCoverage.createMany({
            data: batch,
            skipDuplicates: true,
          }),
        );
      },
    },
  ];
}

async function copyPaged<T>(
  read: (skip: number) => Promise<T[]>,
  insert: (batch: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let skip = 0;
  let written = 0;
  for (;;) {
    const page = await read(skip);
    if (page.length === 0) {
      return written;
    }
    const result = await insert(page);
    written += result.count;
    skip += page.length;
    if (page.length < PAGE) {
      return written;
    }
  }
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
      const count = await copier.copy(source, target);
      copied[copier.table] = count;
      progress(
        `copied ${copier.table}: ${count} row(s) in ${Date.now() - startedAt}ms`,
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
  return {
    databaseCreated,
    migrationsApplied,
    copied,
    securities,
    durationMs: Date.now() - startedAt,
  };
}
