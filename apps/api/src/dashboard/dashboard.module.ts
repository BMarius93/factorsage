import { getApiConfig, getMonitorWorkerConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService, type DashboardOptions } from "./dashboard.service";
import { DASHBOARD_LOGGER, DASHBOARD_OPTIONS } from "./dashboard.tokens";

/**
 * A scan is "current" for three scan intervals. The interval is measured from the end of a cycle,
 * so one late cycle is ordinary; three missed ones are an outage the Dashboard must not hide.
 */
const STALE_AFTER_SCAN_INTERVALS = 3;

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    EntitlementsModule,
  ],
  controllers: [DashboardController],
  providers: [
    {
      provide: DASHBOARD_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "dashboard" },
        });
      },
    },
    {
      provide: DASHBOARD_OPTIONS,
      useFactory: (): DashboardOptions => ({
        staleAfterMs:
          getMonitorWorkerConfig().scanIntervalMs * STALE_AFTER_SCAN_INTERVALS,
      }),
    },
    DashboardService,
  ],
})
export class DashboardModule {}
