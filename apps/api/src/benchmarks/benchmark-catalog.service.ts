import type { PrismaClient } from "@intrinsic/database";
import { BENCHMARK_CATALOG } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { PrismaBenchmarkDataStore } from "@intrinsic/stock-data";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { BENCHMARKS_LOGGER } from "./benchmarks.tokens";

/**
 * Writes `BENCHMARK_CATALOG` into PostgreSQL, keyed by `code`.
 *
 * `@intrinsic/domain` owns benchmark metadata; this is the only place it becomes rows. Running it
 * on every boot is what makes "no manual SQL after a migration" true for local, CI and production
 * databases alike, and it is idempotent so a restart converges rather than duplicating.
 *
 * The product row's words are authoritative and are corrected on every boot. Its *definition* is
 * not editable: a changed source, provider symbol, currency or methodology appends a new immutable
 * series, so bars already fetched under the previous one keep their meaning and a run pinned to it
 * keeps executing exactly what it snapshotted.
 *
 * Exported as a plain function beside the Nest service so a seed script or a test reconciles
 * through exactly the same path instead of hand-writing an equivalent upsert.
 */
export async function reconcileBenchmarkCatalog(
  prisma: PrismaClient,
): Promise<void> {
  // Delegated rather than reimplemented: appending a new `BenchmarkSeries` when a definition
  // changes — instead of editing the row every historical bar hangs off — is the invariant that
  // keeps a submitted run reproducible, and it must not exist in two places that can drift.
  await new PrismaBenchmarkDataStore(prisma).reconcileBenchmarkCatalog(
    BENCHMARK_CATALOG,
  );
}

@Injectable()
export class BenchmarkCatalogService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BENCHMARKS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();
    await reconcileBenchmarkCatalog(this.prisma);
    this.logger.info({
      event: "benchmark.catalog.reconciled",
      benchmarkCount: BENCHMARK_CATALOG.length,
      durationMs: Date.now() - startedAt,
    });
  }
}
