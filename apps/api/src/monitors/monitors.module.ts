import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { MonitorsController } from "./monitors.controller";
import { MonitorsService } from "./monitors.service";
import { MONITORS_LOGGER } from "./monitors.tokens";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
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
    MonitorsService,
  ],
})
export class MonitorsModule {}
