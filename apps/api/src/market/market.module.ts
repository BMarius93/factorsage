import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { MarketController } from "./market.controller";
import { MarketService } from "./market.service";
import { MARKET_CLOCK, MARKET_LOGGER } from "./market.tokens";

/**
 * The market-overview surface. It owns no data path of its own: the benchmark loader comes from
 * `BenchmarksModule`, which is where the API composes it once.
 */
@Module({
  imports: [ConfigurationModule, BenchmarksModule],
  controllers: [MarketController],
  providers: [
    {
      provide: MARKET_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "market" },
        });
      },
    },
    {
      provide: MARKET_CLOCK,
      useFactory: (): (() => Date) => () => new Date(),
    },
    MarketService,
  ],
})
export class MarketModule {}
