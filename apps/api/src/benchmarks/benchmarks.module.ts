import { getApiConfig } from "@intrinsic/config";
import type { FmpClient } from "@intrinsic/fmp";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import {
  IoredisCacheClient,
  type BenchmarkDataService,
  type LoadCoordinator,
} from "@intrinsic/stock-data";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import {
  STOCK_DATA_COORDINATOR,
  STOCK_DATA_PROVIDER,
  STOCK_DATA_REDIS,
} from "../stocks/stock-data.tokens";
import { StocksModule } from "../stocks/stocks.module";
import { BenchmarkCatalogService } from "./benchmark-catalog.service";
import { createBenchmarkDataService } from "./benchmark-data.composition";
import { BenchmarksController } from "./benchmarks.controller";
import { BenchmarksService } from "./benchmarks.service";
import { BENCHMARK_DATA_SERVICE, BENCHMARKS_LOGGER } from "./benchmarks.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule, StocksModule],
  controllers: [BenchmarksController],
  providers: [
    {
      provide: BENCHMARKS_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "benchmarks" },
        });
      },
    },
    {
      provide: BENCHMARK_DATA_SERVICE,
      inject: [
        PrismaService,
        STOCK_DATA_REDIS,
        STOCK_DATA_PROVIDER,
        STOCK_DATA_COORDINATOR,
        BENCHMARKS_LOGGER,
      ],
      // Built from the pieces `StocksModule` already owns, never from new ones: one FMP gate, one
      // Redlock, one Redis connection. `ai/architecture/benchmark-data.md` explains why sharing the
      // loading machinery — and nothing about benchmark *identity* — is the whole design.
      useFactory: (
        prisma: PrismaService,
        redis: ConstructorParameters<typeof IoredisCacheClient>[0],
        provider: FmpClient,
        coordinator: LoadCoordinator,
        logger: StructuredLogger,
      ): BenchmarkDataService =>
        createBenchmarkDataService({
          prisma,
          cache: new IoredisCacheClient(redis),
          provider,
          coordinator,
          onProviderRequest: (request) => {
            logger.debug({ event: "benchmark.provider.request", ...request });
          },
        }),
    },
    BenchmarkCatalogService,
    BenchmarksService,
  ],
  exports: [BENCHMARK_DATA_SERVICE],
})
export class BenchmarksModule {}
