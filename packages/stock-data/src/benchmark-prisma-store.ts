import type {
  Benchmark,
  BenchmarkDailyPrice,
  BenchmarkDataset,
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

type BenchmarkRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  sourceKind: Benchmark["sourceKind"];
  providerSymbol: string;
  currency: string;
  methodologyVersion: number;
  isActive: boolean;
  displayOrder: number;
};

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

  async listActiveBenchmarks(): Promise<Benchmark[]> {
    const rows = await this.prisma.benchmark.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
    });
    return rows.map(toBenchmark);
  }

  async findBenchmarkByCode(code: string): Promise<Benchmark | null> {
    const row = await this.prisma.benchmark.findUnique({ where: { code } });
    return row ? toBenchmark(row) : null;
  }

  async reconcileBenchmarkCatalog(
    entries: readonly Omit<Benchmark, "id">[],
  ): Promise<Benchmark[]> {
    const persisted: Benchmark[] = [];
    for (const entry of entries) {
      const fields = {
        name: entry.name,
        description: entry.description ?? null,
        sourceKind: entry.sourceKind,
        providerSymbol: entry.providerSymbol,
        currency: entry.currency,
        methodologyVersion: entry.methodologyVersion,
        isActive: entry.isActive,
        displayOrder: entry.displayOrder,
      };
      const row = await this.prisma.benchmark.upsert({
        where: { code: entry.code },
        create: { code: entry.code, ...fields },
        update: fields,
      });
      persisted.push(toBenchmark(row));
    }
    return persisted;
  }

  async getDatasetState(
    benchmarkId: string,
    dataset: BenchmarkDataset,
    variant: string,
  ): Promise<BenchmarkDatasetStateRecord | null> {
    const row = await this.prisma.benchmarkDatasetState.findUnique({
      where: {
        benchmarkId_dataset_variant: { benchmarkId, dataset, variant },
      },
    });
    if (!row) {
      return null;
    }
    return {
      benchmarkId: row.benchmarkId,
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
    benchmarkId: string,
    dataset: BenchmarkDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]> {
    const rows = await this.prisma.benchmarkDatasetCoverage.findMany({
      where: {
        benchmarkId,
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
    benchmarkId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    const rows = await this.prisma.benchmarkDailyPrice.findMany({
      where: {
        benchmarkId,
        date: {
          gte: toDatabaseDate(range.from),
          lte: toDatabaseDate(range.to),
        },
      },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => ({
      benchmarkId: row.benchmarkId,
      date: fromDatabaseDate(row.date),
      open: (row.open as DecimalLike).toNumber(),
      high: (row.high as DecimalLike).toNumber(),
      low: (row.low as DecimalLike).toNumber(),
      close: (row.close as DecimalLike).toNumber(),
      volume: Number(row.volume),
    }));
  }

  async saveDailyPriceSync(input: {
    benchmarkId: string;
    prices: readonly BenchmarkDailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
    tailDate: string;
    freshThrough?: string;
    assertOwned?: () => void;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockBenchmarkWrite(transaction, input.benchmarkId);

      const affectedDates = [
        ...new Set(input.prices.map((price) => price.date)),
      ].map(toDatabaseDate);
      if (affectedDates.length > 0) {
        await transaction.benchmarkDailyPrice.deleteMany({
          where: {
            benchmarkId: input.benchmarkId,
            date: { in: affectedDates },
          },
        });
        await transaction.benchmarkDailyPrice.createMany({
          data: input.prices.map((price) => ({
            benchmarkId: input.benchmarkId,
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
          benchmarkId: input.benchmarkId,
          dataset: "DAILY_PRICE",
          variant: BENCHMARK_DAILY_PRICE_VARIANT,
          from: interval.from,
          to: interval.to,
          syncedAt: input.syncedAt,
        });
      }

      if (input.freshThrough) {
        await this.advanceState(transaction, {
          benchmarkId: input.benchmarkId,
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
      benchmarkId: string;
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
          benchmarkId: input.benchmarkId,
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
        benchmarkId: input.benchmarkId,
        dataset: input.dataset,
        variant: input.variant,
      },
    });
    await transaction.benchmarkDatasetCoverage.createMany({
      data: compacted.map((coverage) => ({
        benchmarkId: input.benchmarkId,
        dataset: input.dataset,
        variant: input.variant,
        ...coverage,
      })),
    });

    const existing = await transaction.benchmarkDatasetState.findUnique({
      where: {
        benchmarkId_dataset_variant: {
          benchmarkId: input.benchmarkId,
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
        benchmarkId_dataset_variant: {
          benchmarkId: input.benchmarkId,
          dataset: input.dataset,
          variant: input.variant,
        },
      },
      create: {
        benchmarkId: input.benchmarkId,
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
    benchmarkId: string,
  ): Promise<void> {
    // Scoped to this transaction and taken once at the outer boundary, exactly as the stock writer
    // does: two processes hydrating the same benchmark serialize instead of interleaving deletes.
    const lockKey = `benchmark-data-write:${benchmarkId}`;
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }
}

function toBenchmark(row: BenchmarkRow): Benchmark {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    sourceKind: row.sourceKind,
    providerSymbol: row.providerSymbol,
    currency: row.currency,
    methodologyVersion: row.methodologyVersion,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
  };
}

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
