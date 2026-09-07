import type { PrismaClient } from "@intrinsic/database";
import { BENCHMARK_CATALOG } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
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
 * Exported as a plain function beside the Nest service so a seed script or a test reconciles
 * through exactly the same path instead of hand-writing an equivalent upsert.
 */
export async function reconcileBenchmarkCatalog(
  prisma: PrismaClient,
): Promise<void> {
  for (const entry of BENCHMARK_CATALOG) {
    const columns = {
      name: entry.name,
      description: entry.description ?? null,
      sourceKind: entry.sourceKind,
      providerSymbol: entry.providerSymbol,
      currency: entry.currency,
      methodologyVersion: entry.methodologyVersion,
      isActive: entry.isActive,
      displayOrder: entry.displayOrder,
    };
    await prisma.benchmark.upsert({
      where: { code: entry.code },
      create: { code: entry.code, ...columns },
      // The catalog is authoritative: a hand-edited row is corrected, not preserved. Run
      // snapshots are unaffected — they carry their own copy of the identity they executed.
      update: columns,
    });
  }
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
