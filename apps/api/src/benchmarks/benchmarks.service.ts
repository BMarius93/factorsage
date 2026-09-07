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
 */
@Injectable()
export class BenchmarksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listBenchmarks(): Promise<BenchmarkResponse[]> {
    const rows = await this.prisma.benchmark.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        currency: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      currency: row.currency,
    }));
  }
}
