import type { BenchmarkResponse } from "@intrinsic/contracts";
import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { BenchmarksService } from "./benchmarks.service";

/**
 * The selectable benchmark catalog. System-owned and read-only over HTTP: rows come from
 * `BENCHMARK_CATALOG` in `@intrinsic/domain`, never from a request.
 *
 * It sits at `/benchmarks` rather than under `/backtests` so a benchmark code can never be
 * confused with a run id by the router, and so the Backtest submission form can load the catalog
 * without touching the runs collection.
 */
@Controller("benchmarks")
@UseGuards(CookieAuthGuard)
export class BenchmarksController {
  constructor(
    @Inject(BenchmarksService) private readonly benchmarks: BenchmarksService,
  ) {}

  @RateLimit("standard-read")
  @Get()
  async listAll(): Promise<BenchmarkResponse[]> {
    return this.benchmarks.listBenchmarks();
  }
}
