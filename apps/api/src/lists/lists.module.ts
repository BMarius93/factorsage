import { getApiConfig } from "@intrinsic/config";
import {
  createLogger,
  type StructuredLogger,
} from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { ListsController } from "./lists.controller";
import { LISTS_LOGGER } from "./lists.tokens";
import { StockListsService } from "./stock-lists.service";

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [ListsController],
  providers: [
    {
      provide: LISTS_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "stock-lists" },
        });
      },
    },
    StockListsService,
  ],
})
export class ListsModule {}
