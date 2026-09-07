import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { BacktestsController } from "./backtests.controller";
import { BacktestsService } from "./backtests.service";
import { BACKTESTS_LOGGER } from "./backtests.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
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
    BacktestsService,
  ],
})
export class BacktestsModule {}
