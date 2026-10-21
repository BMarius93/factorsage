import { getApiConfig, getMarketDataWorkerConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MonitorsController } from "./monitors.controller";
import { SystemContentModule } from "../builtins/system-content.module";
import { MonitorsService } from "./monitors.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { MONITORS_LOGGER, MONITOR_ETF_STATUS_OPTIONS } from "./monitors.tokens";

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    EntitlementsModule,
    SystemContentModule,
    BenchmarksModule,
  ],
  controllers: [MonitorsController],
  providers: [
    {
      provide: MONITORS_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "monitors" },
        });
      },
    },
    {
      // The finalized-session convention's publication delay, shared with the refresh child and
      // the market overview: a bar counts only once its close plus this delay has passed.
      provide: MONITOR_ETF_STATUS_OPTIONS,
      useFactory: () => ({
        publicationDelayMs: getMarketDataWorkerConfig().publicationDelayMs,
      }),
    },
    MonitorsService,
  ],
})
export class MonitorsModule {}
