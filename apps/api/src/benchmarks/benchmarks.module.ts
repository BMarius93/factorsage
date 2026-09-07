import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { BenchmarkCatalogService } from "./benchmark-catalog.service";
import { BenchmarksController } from "./benchmarks.controller";
import { BenchmarksService } from "./benchmarks.service";
import { BENCHMARKS_LOGGER } from "./benchmarks.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
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
    BenchmarkCatalogService,
    BenchmarksService,
  ],
})
export class BenchmarksModule {}
