import { getApiConfig } from "@intrinsic/config";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { BacktestsController } from "./backtests.controller";
import { BacktestsService } from "./backtests.service";
import {
  BACKTESTS_LOGGER,
  EXECUTION_CALENDAR_REFERENCE,
} from "./backtests.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule, EntitlementsModule],
  controllers: [BacktestsController],
  providers: [
    {
      provide: BACKTESTS_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "backtests" },
        });
      },
    },
    {
      // The engine's designated reference, from the one place that decides it.
      provide: EXECUTION_CALENDAR_REFERENCE,
      useValue: EXECUTION_CALENDAR_REFERENCE_CODE,
    },
    BacktestsService,
  ],
})
export class BacktestsModule {}
