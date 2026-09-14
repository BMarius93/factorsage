import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { RecentSearchesController } from "./recent-searches.controller";
import { RECENT_SEARCHES_LOGGER } from "./recent-searches.tokens";
import { RecentSecuritiesService } from "./recent-securities.service";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [RecentSearchesController],
  providers: [
    {
      provide: RECENT_SEARCHES_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "recent-searches" },
        });
      },
    },
    RecentSecuritiesService,
  ],
})
export class RecentSearchesModule {}
