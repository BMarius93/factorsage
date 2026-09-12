import {
  getApiConfig,
  getStripeBillingConfig,
  loadRootEnv,
  type StripeBillingConfig,
} from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { PrismaService } from "../database/prisma.service";
import { BillingCatalog } from "./billing-catalog";
import { StripeApiGateway } from "./stripe.gateway";
import type { StripeGateway } from "./stripe-gateway";

/**
 * Shared bootstrap for the billing operator commands.
 *
 * The commands are `tsx` scripts, matching every other operational entry point in this app
 * (`seed-qa-users.ts`, `reset-benchmark-data.ts`, the QA matrix runner), so they run against a
 * developer's stack or a deployed environment without booting an HTTP server.
 *
 * They build the *same* gateway, catalog and logger the running API builds, and the repair command
 * calls the *same* reconciliation service. A second implementation of billing rules for tooling is
 * precisely what `docs/decisions/stripe-billing-v1.md` section 16 forbids: a repair that used its own
 * logic would put users into states no webhook could ever produce.
 */
export type BillingCliContext = {
  /**
   * `PrismaService` rather than a bare `PrismaClient`: it is what `BillingReconciliationService`
   * takes, so the command can construct the real service and reuse the real rules.
   */
  readonly prisma: PrismaService;
  readonly logger: StructuredLogger;
  readonly stripe: StripeGateway;
  readonly catalog: BillingCatalog;
  readonly config: StripeBillingConfig;
  readonly close: () => Promise<void>;
};

export async function openBillingCliContext(): Promise<BillingCliContext> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const config = getStripeBillingConfig();

  if (!config) {
    throw new Error(
      "Stripe billing is not configured in this environment. Set STRIPE_SECRET_KEY, " +
        "STRIPE_WEBHOOK_SECRET and the four STRIPE_PRICE_* variables. See ai/architecture/billing.md.",
    );
  }

  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "billing-cli" },
  });

  const prisma = new PrismaService();
  await prisma.$connect();

  return {
    prisma,
    logger,
    stripe: new StripeApiGateway(config, logger.child({ component: "stripe" })),
    catalog: new BillingCatalog(config),
    config,
    close: async () => {
      await prisma.$disconnect();
    },
  };
}

/**
 * Which Stripe environment these credentials point at, for the banner every command prints.
 *
 * Printed unconditionally and prominently: the one operational mistake with lasting consequences is
 * running a repair against live billing while believing it is the sandbox.
 */
export function describeStripeMode(config: StripeBillingConfig): string {
  return config.testMode ? "SANDBOX / TEST MODE" : "*** LIVE MODE ***";
}
