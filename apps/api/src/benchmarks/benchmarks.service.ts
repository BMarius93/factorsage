import type { BenchmarkResponse } from "@intrinsic/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * Benchmarks are system-owned reference data, so there is no ownership scoping and no write path
 * here: the catalog is reconciled from `@intrinsic/domain` at boot.
 *
 * `providerSymbol` is deliberately absent from the projection. Which series backs `SP500` is a
 * server-side sourcing decision that may change without changing what the product means, and the
 * browser selects a code, never a ticker.
 *
 * This is the **backtest** catalog, so it is filtered by `isBacktestSelectable` as well as by
 * `isActive`. The market-reference indices are active benchmarks that the system loads and stores
 * like any other, and they are not something a portfolio can be compared against — nothing buys
 * `^GSPC`, and `^VIX` is a level rather than a price. They are reported by `/market-overview`
 * instead, and a Guest reads that without a session.
 */
@Injectable()
export class BenchmarksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listBenchmarks(): Promise<BenchmarkResponse[]> {
    const rows = await this.prisma.benchmark.findMany({
      where: { isActive: true, isBacktestSelectable: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        // The currency belongs to the series, and the one in force is the highest version.
        series: {
          orderBy: { version: "desc" },
          take: 1,
          select: { currency: true },
        },
      },
    });
    return rows.flatMap((row) => {
      const series = row.series[0];
      // A benchmark whose definition has not been reconciled yet is not selectable.
      return series
        ? [
            {
              id: row.id,
              code: row.code,
              name: row.name,
              ...(row.description === null
                ? {}
                : { description: row.description }),
              currency: series.currency,
            },
          ]
        : [];
    });
  }
}
