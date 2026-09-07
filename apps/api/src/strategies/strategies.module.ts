import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { StrategiesController } from "./strategies.controller";
import { StrategiesService } from "./strategies.service";
import { STRATEGIES_LOGGER } from "./strategies.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [StrategiesController],
  providers: [
    {
      provide: STRATEGIES_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "strategies" },
        });
      },
    },
    StrategiesService,
  ],
})
export class StrategiesModule {}
