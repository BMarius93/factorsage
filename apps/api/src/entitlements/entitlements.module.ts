import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EntitlementExceptionFilter } from "./entitlement-exception.filter";
import { EntitlementsController } from "./entitlements.controller";
import { EntitlementsService } from "./entitlements.service";
import { ENTITLEMENTS_LOGGER } from "./entitlements.tokens";

/**
 * The entitlement boundary, as one module.
 *
 * Every feature module that can mutate a quota-controlled resource imports this one, which is also
 * what installs the global `EntitlementExceptionFilter`: a refusal thrown anywhere maps to HTTP
 * once, and an integration suite that compiles only its own feature module still gets the same
 * mapping the running API has. Enforcement and its error semantics cannot drift apart.
 */
@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [EntitlementsController],
  providers: [
    {
      provide: ENTITLEMENTS_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "entitlements" },
        });
      },
    },
    EntitlementsService,
    { provide: APP_FILTER, useClass: EntitlementExceptionFilter },
  ],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
