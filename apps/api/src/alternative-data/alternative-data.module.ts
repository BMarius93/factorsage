import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import type { AlternativeDataStore } from "@intrinsic/stock-data";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SystemContentModule } from "../builtins/system-content.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { ALTERNATIVE_DATA_STORE } from "../stocks/stock-data.tokens";
import { StocksModule } from "../stocks/stocks.module";
import {
  ActorGroupsController,
  AlternativeDataController,
} from "./alternative-data.controller";
import { ActorGroupsService } from "./actor-groups.service";
import {
  ALTERNATIVE_DATA_LOGGER,
  ALTERNATIVE_DATA_STORE_TOKEN,
} from "./alternative-data.tokens";

/**
 * The alternative-data feature module: the canonical actor catalog and the actor groups over it.
 *
 * It imports `StocksModule` rather than constructing a store of its own, so the actor reads here and
 * the ingestion writes there go through **one** `PrismaAlternativeDataStore` against one Prisma client
 * — the same reason the benchmark loader is built from the stocks module's provider and coordinator.
 */
@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    SystemContentModule,
    StocksModule,
  ],
  controllers: [AlternativeDataController, ActorGroupsController],
  providers: [
    {
      provide: ALTERNATIVE_DATA_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "alternative-data" },
        });
      },
    },
    {
      provide: ALTERNATIVE_DATA_STORE_TOKEN,
      inject: [ALTERNATIVE_DATA_STORE],
      useFactory: (store: AlternativeDataStore): AlternativeDataStore => store,
    },
    ActorGroupsService,
  ],
  exports: [ActorGroupsService],
})
export class AlternativeDataModule {}
