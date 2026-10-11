import { getApiConfig, getMarketDataWorkerConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { MarketController } from "./market.controller";
import { MarketService } from "./market.service";
import {
  MARKET_CLOCK,
  MARKET_LOGGER,
  MARKET_OVERVIEW_OPTIONS,
  type MarketOverviewOptions,
} from "./market.tokens";

/**
 * The market-overview surface. It owns no data path of its own: the benchmark reader comes from
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
    {
      provide: MARKET_OVERVIEW_OPTIONS,
      useFactory: (): MarketOverviewOptions => ({
        // The refresh worker's own end-of-day convention, so the overview never calls a bar final
        // that the refresh would still treat as provisional.
        publicationDelayMs: getMarketDataWorkerConfig().publicationDelayMs,
        cacheTtlMs: 60_000,
        maxStaleMs: 15 * 60_000,
      }),
    },
    MarketService,
  ],
})
export class MarketModule {}
