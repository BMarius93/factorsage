import {
  getApiConfig,
  getStripeBillingConfig,
  type StripeBillingConfig,
} from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { BillingCatalog } from "./billing-catalog";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingReconciliationService } from "./billing-reconciliation.service";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import {
  BILLING_CATALOG_TOKEN,
  BILLING_LOGGER,
  STRIPE_BILLING_CONFIG,
  STRIPE_GATEWAY,
} from "./billing.tokens";
import { StripeApiGateway } from "./stripe.gateway";
import type { StripeGateway } from "./stripe-gateway";
import { StripeWebhookController } from "./stripe-webhook.controller";

/**
 * Stripe Billing V1, as one module.
 *
 * **Billing is optional, and that is structural rather than conditional.** With no `STRIPE_*`
 * configuration the three providers below resolve to `null`, the module still compiles, the routes
 * still answer and `GET /billing/status` reports `billingEnabled: false`. Nothing else in the
 * workspace gains a dependency on a Stripe secret, which is what keeps the existing test suites and
 * the Playwright persona matrix working without one — the decision document (section 29) requires QA
 * personas to keep working without real Stripe purchases.
 *
 * `BillingExceptionFilter` is registered globally here for the same reason `EntitlementsModule`
 * registers its own: a `BillingError` thrown anywhere maps to HTTP once, and an integration suite
 * that compiles only this module gets the same mapping the running API has.
 *
 * `EntitlementsModule` is deliberately **not** imported. Billing writes `User.plan` through
 * `changeUserPlan` and never consults an entitlement, so the dependency would be backwards — and its
 * absence is what proves the direction of the boundary at the module graph level.
 */
@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [
    {
      provide: BILLING_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "billing" },
        });
      },
    },
    {
      provide: STRIPE_BILLING_CONFIG,
      // Throws on a *malformed* or half-complete configuration, which fails startup — the right
      // moment to discover it. Returns null only when billing is genuinely absent.
      useFactory: (): StripeBillingConfig | null => getStripeBillingConfig(),
    },
    {
      provide: BILLING_CATALOG_TOKEN,
      inject: [STRIPE_BILLING_CONFIG],
      useFactory: (config: StripeBillingConfig | null): BillingCatalog | null =>
        config ? new BillingCatalog(config) : null,
    },
    {
      provide: STRIPE_GATEWAY,
      inject: [STRIPE_BILLING_CONFIG, BILLING_LOGGER],
      useFactory: (
        config: StripeBillingConfig | null,
        logger: StructuredLogger,
      ): StripeGateway | null =>
        config
          ? new StripeApiGateway(config, logger.child({ component: "stripe" }))
          : null,
    },
    BillingReconciliationService,
    BillingService,
    { provide: APP_FILTER, useClass: BillingExceptionFilter },
  ],
  exports: [BillingService, BillingReconciliationService],
})
export class BillingModule {}
