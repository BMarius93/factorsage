import type {
  BenchmarkCatalogEntry,
  BenchmarkDailyPrice,
  BenchmarkDataset,
  BenchmarkSeries,
  BenchmarkSourceKind,
  BenchmarkWithSeries,
  DateRange,
} from "@intrinsic/domain";
import type { PrismaClient } from "@intrinsic/database";
import {
  BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
  BENCHMARK_DAILY_PRICE_VARIANT,
  type BenchmarkDataStore,
  type BenchmarkDatasetStateRecord,
} from "./benchmark-ports.js";

type PrismaTransaction = Parameters<
  Parameters<PrismaClient["$transaction"]>[0]
>[0];

type SeriesRow = {
  id: string;
  benchmarkId: string;
  version: number;
  sourceKind: BenchmarkSourceKind;
  providerSymbol: string;
  currency: string;
  methodologyVersion: number;
};

type BenchmarkRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  displayOrder: number;
  series: SeriesRow[];
};

/**
 * The definition in force: the highest version.
 *
 * Reconciliation only ever appends, so "current" is always the last row rather than a pointer
 * column that could disagree with the rows it points at.
 */
const CURRENT_SERIES = {
  series: { orderBy: { version: "desc" as const }, take: 1 },
} as const;

type DecimalLike = { toNumber(): number };

/**
 * PostgreSQL persistence for benchmarks.
 *
 * It mirrors `PrismaStockDataStore`'s contract deliberately — one advisory-locked transaction per
 * write, delete-then-recreate for the affected dates, coverage intervals compacted with one-day
 * adjacency — because a benchmark's coverage must mean exactly what a security's coverage means.
 * What it does not mirror is the surface: there is no profile, no fundamentals and no derived
 * state to persist for a comparison series.
 */
/**
 * How long the benchmark's bulk write may hold its transaction.
 *
 * The same budget, and the same reason, as `PrismaStockDataStore`: a benchmark's first hydration
 * over a thirty-year backtest period writes roughly 7,500 daily rows in one transaction, which
 * passes Prisma's five-second interactive-transaction default and expires with P2028 after the work
 * is already done. A seeded QA benchmark writes a few hundred rows and never reveals it.
 */
const BULK_WRITE_TRANSACTION_OPTIONS = {
  timeout: 120_000,
  maxWait: 30_000,
} as const;

export class PrismaBenchmarkDataStore implements BenchmarkDataStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listActiveBenchmarks(): Promise<BenchmarkWithSeries[]> {
    const rows = await this.prisma.benchmark.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      include: CURRENT_SERIES,
    });
    return rows.flatMap((row) => {
      const withSeries = toBenchmarkWithSeries(row);
      return withSeries ? [withSeries] : [];
    });
  }

  async findBenchmarkByCode(code: string): Promise<BenchmarkWithSeries | null> {
    const row = await this.prisma.benchmark.findUnique({
      where: { code },
      include: CURRENT_SERIES,
    });
    return row ? toBenchmarkWithSeries(row) : null;
  }

  async findSeriesById(seriesId: string): Promise<BenchmarkSeries | null> {
    const row = await this.prisma.benchmarkSeries.findUnique({
      where: { id: seriesId },
    });
    return row ? toSeries(row) : null;
  }

  /**
   * Registers the catalog, appending a version whenever a definition differs from the one in force.
   *
   * The product row's words may be edited freely — a renamed benchmark is still the same
   * benchmark. Its *definition* may not: a different source, provider symbol, currency or
   * methodology produces different numbers, so it becomes a new series and the previous one keeps
   * every bar already fetched for it. A rerun of an unchanged catalog appends nothing, and the
   * whole thing runs in one transaction so a concurrent reconciliation cannot interleave a
   * half-written version.
   */
  async reconcileBenchmarkCatalog(
    entries: readonly BenchmarkCatalogEntry[],
  ): Promise<BenchmarkWithSeries[]> {
    const persisted: BenchmarkWithSeries[] = [];
    for (const entry of entries) {
      const row = await this.prisma.$transaction(async (transaction) => {
        const benchmark = await transaction.benchmark.upsert({
          where: { code: entry.code },
          create: {
            code: entry.code,
            name: entry.name,
            description: entry.description ?? null,
            isActive: entry.isActive,
            displayOrder: entry.displayOrder,
          },
          update: {
            name: entry.name,
            description: entry.description ?? null,
            isActive: entry.isActive,
            displayOrder: entry.displayOrder,
          },
        });

        const definition = {
          sourceKind: entry.sourceKind,
          providerSymbol: entry.providerSymbol,
          currency: entry.currency,
          methodologyVersion: entry.methodologyVersion,
        };
        // Compared against the version currently in force, not against every version ever written.
        // A rerun of an unchanged catalog appends nothing; returning a benchmark to a source it
        // used before appends a new version rather than being silently rejected, and that version
        // fetches its own data — which is right, because a restated history is not the old one.
        const current = await transaction.benchmarkSeries.findFirst({
          where: { benchmarkId: benchmark.id },
          orderBy: { version: "desc" },
        });
        const unchanged =
          current !== null &&
          current.sourceKind === definition.sourceKind &&
          current.providerSymbol === definition.providerSymbol &&
          current.currency === definition.currency &&
          current.methodologyVersion === definition.methodologyVersion;
        if (!unchanged) {
          await transaction.benchmarkSeries.create({
            data: {
              benchmarkId: benchmark.id,
              version: (current?.version ?? 0) + 1,
              ...definition,
            },
          });
        }

        return transaction.benchmark.findUniqueOrThrow({
          where: { id: benchmark.id },
          include: CURRENT_SERIES,
        });
      });

      const withSeries = toBenchmarkWithSeries(row);
      if (!withSeries) {
        throw new Error(
          `Benchmark ${entry.code} was reconciled without a series definition`,
        );
      }
      persisted.push(withSeries);
    }
    return persisted;
  }

  async getDatasetState(
    seriesId: string,
    dataset: BenchmarkDataset,
    variant: string,
  ): Promise<BenchmarkDatasetStateRecord | null> {
    const row = await this.prisma.benchmarkDatasetState.findUnique({
      where: {
        seriesId_dataset_variant: { seriesId, dataset, variant },
      },
    });
    if (!row) {
      return null;
    }
    return {
      seriesId: row.seriesId,
      dataset: row.dataset,
      variant: row.variant,
      ...(row.earliestDate
        ? { earliestDate: fromDatabaseDate(row.earliestDate) }
        : {}),
      ...(row.latestDate
        ? { latestDate: fromDatabaseDate(row.latestDate) }
        : {}),
      ...(row.lastSuccessfulSyncAt
        ? { lastSuccessfulSyncAt: row.lastSuccessfulSyncAt.toISOString() }
        : {}),
    };
  }

  async getDatasetCoverage(
    seriesId: string,
    dataset: BenchmarkDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]> {
    const rows = await this.prisma.benchmarkDatasetCoverage.findMany({
      where: {
        seriesId,
        dataset,
        variant,
        fromDate: { lte: toDatabaseDate(range.to) },
        toDate: { gte: toDatabaseDate(range.from) },
      },
      orderBy: { fromDate: "asc" },
    });
    return rows.map((row) => ({
      from: fromDatabaseDate(row.fromDate),
      to: fromDatabaseDate(row.toDate),
    }));
  }

  async getDailyPrices(
    seriesId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    const rows = await this.prisma.benchmarkDailyPrice.findMany({
      where: {
        seriesId,
        date: {
          gte: toDatabaseDate(range.from),
          lte: toDatabaseDate(range.to),
        },
      },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => ({
      seriesId: row.seriesId,
      date: fromDatabaseDate(row.date),
      open: (row.open as DecimalLike).toNumber(),
      high: (row.high as DecimalLike).toNumber(),
      low: (row.low as DecimalLike).toNumber(),
      close: (row.close as DecimalLike).toNumber(),
      volume: Number(row.volume),
    }));
  }

  async saveDailyPriceSync(input: {
    seriesId: string;
    prices: readonly BenchmarkDailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
    tailDate: string;
    freshThrough?: string;
    assertOwned?: () => void;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockBenchmarkWrite(transaction, input.seriesId);

      const affectedDates = [
        ...new Set(input.prices.map((price) => price.date)),
      ].map(toDatabaseDate);
      if (affectedDates.length > 0) {
        await transaction.benchmarkDailyPrice.deleteMany({
          where: {
            seriesId: input.seriesId,
            date: { in: affectedDates },
          },
        });
        await transaction.benchmarkDailyPrice.createMany({
          data: input.prices.map((price) => ({
            seriesId: input.seriesId,
            date: toDatabaseDate(price.date),
            open: price.open,
            high: price.high,
            low: price.low,
            close: price.close,
            volume: BigInt(Math.round(price.volume)),
          })),
        });
      }

      for (const interval of input.successfulCoverage) {
        await this.advanceState(transaction, {
          seriesId: input.seriesId,
          dataset: "DAILY_PRICE",
          variant: BENCHMARK_DAILY_PRICE_VARIANT,
          from: interval.from,
          to: interval.to,
          syncedAt: input.syncedAt,
        });
      }

      if (input.freshThrough) {
        await this.advanceState(transaction, {
          seriesId: input.seriesId,
          dataset: "DAILY_PRICE",
          variant: BENCHMARK_DAILY_PRICE_FRESHNESS_VARIANT,
          from: input.freshThrough,
          to: input.freshThrough,
          syncedAt: input.syncedAt,
        });
      }

      // The lease is asserted immediately before the transaction commits: a worker that lost its
      // hydration lock must not land a write recorded as complete coverage.
      input.assertOwned?.();
    }, BULK_WRITE_TRANSACTION_OPTIONS);
  }

  private async advanceState(
    transaction: PrismaTransaction,
    input: {
      seriesId: string;
      dataset: BenchmarkDataset;
      variant: string;
      from: string;
      to: string;
      syncedAt: string;
    },
  ): Promise<void> {
    const existingCoverage =
      await transaction.benchmarkDatasetCoverage.findMany({
        where: {
          seriesId: input.seriesId,
          dataset: input.dataset,
          variant: input.variant,
        },
        orderBy: { fromDate: "asc" },
      });
    const intervals = [
      ...existingCoverage.map((coverage) => ({
        fromDate: coverage.fromDate,
        toDate: coverage.toDate,
        lastSuccessfulSyncAt: coverage.lastSuccessfulSyncAt,
      })),
      {
        fromDate: toDatabaseDate(input.from),
        toDate: toDatabaseDate(input.to),
        lastSuccessfulSyncAt: new Date(input.syncedAt),
      },
    ].sort((left, right) => left.fromDate.valueOf() - right.fromDate.valueOf());

    // Intervals one calendar day apart describe one continuous asked-for period; merging them
    // stops the coverage table growing one row per read.
    const compacted: typeof intervals = [];
    for (const interval of intervals) {
      const previous = compacted.at(-1);
      if (
        previous &&
        interval.fromDate.valueOf() <=
          previous.toDate.valueOf() + 24 * 60 * 60 * 1_000
      ) {
        previous.toDate = new Date(
          Math.max(previous.toDate.valueOf(), interval.toDate.valueOf()),
        );
        previous.lastSuccessfulSyncAt = new Date(
          Math.max(
            previous.lastSuccessfulSyncAt.valueOf(),
            interval.lastSuccessfulSyncAt.valueOf(),
          ),
        );
      } else {
        compacted.push({ ...interval });
      }
    }

    await transaction.benchmarkDatasetCoverage.deleteMany({
      where: {
        seriesId: input.seriesId,
        dataset: input.dataset,
        variant: input.variant,
      },
    });
    await transaction.benchmarkDatasetCoverage.createMany({
      data: compacted.map((coverage) => ({
        seriesId: input.seriesId,
        dataset: input.dataset,
        variant: input.variant,
        ...coverage,
      })),
    });

    const existing = await transaction.benchmarkDatasetState.findUnique({
      where: {
        seriesId_dataset_variant: {
          seriesId: input.seriesId,
          dataset: input.dataset,
          variant: input.variant,
        },
      },
    });
    const earliestDate = existing?.earliestDate
      ? new Date(
          Math.min(
            existing.earliestDate.valueOf(),
            toDatabaseDate(input.from).valueOf(),
          ),
        )
      : toDatabaseDate(input.from);
    const latestDate = existing?.latestDate
      ? new Date(
          Math.max(
            existing.latestDate.valueOf(),
            toDatabaseDate(input.to).valueOf(),
          ),
        )
      : toDatabaseDate(input.to);
    const lastSuccessfulSyncAt = new Date(input.syncedAt);

    await transaction.benchmarkDatasetState.upsert({
      where: {
        seriesId_dataset_variant: {
          seriesId: input.seriesId,
          dataset: input.dataset,
          variant: input.variant,
        },
      },
      create: {
        seriesId: input.seriesId,
        dataset: input.dataset,
        variant: input.variant,
        earliestDate,
        latestDate,
        lastSuccessfulSyncAt,
      },
      update: { earliestDate, latestDate, lastSuccessfulSyncAt },
    });
  }

  private async lockBenchmarkWrite(
    transaction: PrismaTransaction,
    seriesId: string,
  ): Promise<void> {
    // Scoped to this transaction and taken once at the outer boundary, exactly as the stock writer
    // does: two processes hydrating the same benchmark serialize instead of interleaving deletes.
    const lockKey = `benchmark-data-write:${seriesId}`;
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }
}

function toSeries(row: SeriesRow): BenchmarkSeries {
  return {
    id: row.id,
    benchmarkId: row.benchmarkId,
    version: row.version,
    sourceKind: row.sourceKind,
    providerSymbol: row.providerSymbol,
    currency: row.currency,
    methodologyVersion: row.methodologyVersion,
  };
}

/**
 * A benchmark whose definition has not been reconciled yet has no series and is not usable, so it
 * is reported as absent rather than as a benchmark with nothing behind it.
 */
function toBenchmarkWithSeries(row: BenchmarkRow): BenchmarkWithSeries | null {
  const series = row.series[0];
  if (!series) {
    return null;
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    series: toSeries(series),
  };
}

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
