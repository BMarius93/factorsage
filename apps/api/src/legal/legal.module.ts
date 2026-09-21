import { getApiConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { LegalAcceptanceInterceptor } from "./legal-acceptance.interceptor";
import { LegalExceptionFilter } from "./legal-exception.filter";
import { LegalController } from "./legal.controller";
import { LegalService } from "./legal.service";
import { LEGAL_LOGGER } from "./legal.tokens";

/**
 * Legal acceptance and the request channels, as one global module.
 *
 * Importing it installs everything: the interceptor that gates every non-exempt route on Terms
 * acceptance, the filter that maps a refusal to HTTP, and the service that owns the append-only
 * evidence. There is nothing to remember per controller — which is what makes "a direct API call
 * cannot bypass acceptance" true by construction rather than by review.
 *
 * `@Global` so a feature module's own integration suite can compile this module beside it and
 * get exactly the behaviour the running API has, which is how the bypass tests are written.
 *
 * The dependency is strictly one-way: this module imports `AuthModule` for `CookieAuthGuard`,
 * and `AuthModule` needs nothing from here. The email-activation path records its acceptance
 * through the **pure** helpers in `legal-acceptance-records.ts`, not through `LegalService` —
 * injecting the service there would put an edge back the other way, which is a cycle dressed up
 * as a global module and breaks every suite that compiles `AuthModule` on its own.
 */
@Global()
@Module({
  // `AuthModule` for `CookieAuthGuard`; the dependency is one-way. `AuthModule` reaches
  // `LegalService` through this module being `@Global` rather than by importing it, which is what
  // keeps the two out of a `forwardRef` cycle.
  imports: [AuthModule, DatabaseModule],
  controllers: [LegalController],
  providers: [
    {
      provide: LEGAL_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "legal" },
        });
      },
    },
    LegalService,
    { provide: APP_INTERCEPTOR, useClass: LegalAcceptanceInterceptor },
    { provide: APP_FILTER, useClass: LegalExceptionFilter },
  ],
  exports: [LegalService],
})
export class LegalModule {}
