import { BILLING_PRICE_KEYS } from "@intrinsic/contracts";
import {
  describeStripeMode,
  openBillingCliContext,
} from "./billing/billing-cli-context";
import {
  formatCatalogAmount,
  verifyStripeCatalog,
} from "./billing/catalog-verification";

/**
 * `pnpm billing:verify-catalog` — proves the configured Stripe prices are the ones this product sells.
 *
 * The allowlist maps a logical key to a Price ID and trusts nothing else about it, which is correct
 * for runtime but leaves one gap: nothing stops `STRIPE_PRICE_PRO_MONTHLY` from pointing at the $9
 * Starter price. Runtime would then sell Pro entitlements for nine dollars and never complain,
 * because by design it never reads the amount. `docs/decisions/stripe-billing-v1.md` section 2 asks
 * for exactly this check, loudly, at configuration time rather than at revenue time.
 *
 * Every configured price is verified to be:
 *
 * - present and **active**;
 * - **recurring**, at the configured interval, with `interval_count = 1`;
 * - **USD**;
 * - **licensed**, not metered — V1 has no usage-based billing;
 * - priced at exactly $9 / $99 / $29 / $299;
 * - attached to an **active** product, and to the *same* product as its sibling interval, so the
 *   Starter monthly and yearly prices really are two cadences of one Starter product;
 * - each a distinct price, with no two logical keys sharing one.
 *
 * Run it after configuring a sandbox, before every production deployment, and after any Dashboard
 * price edit. Exits non-zero on any mismatch so it can gate a deployment.
 *
 * ```bash
 * pnpm billing:verify-catalog
 * ```
 */

async function main(): Promise<void> {
  const context = await openBillingCliContext();

  try {
    console.log(`Stripe environment: ${describeStripeMode(context.config)}`);
    console.log("Verifying the four V1 recurring prices.\n");

    // The rules themselves live in `billing/catalog-verification.ts`, shared with the billing QA
    // persona tooling, which refuses to create a subscription on a catalog this would reject.
    const { prices, findings } = await verifyStripeCatalog(context);

    for (const key of BILLING_PRICE_KEYS) {
      const price = prices.get(key);
      if (!price) {
        continue;
      }
      console.log(
        `${key.padEnd(16)} ${price.id}  ${formatCatalogAmount(price.unitAmount)} / ` +
          `${price.recurringInterval ?? "one-time"}  ` +
          `${price.productName ?? "unknown product"}` +
          `${price.lookupKey ? `  lookup=${price.lookupKey}` : ""}` +
          `${price.active ? "" : "  ARCHIVED"}`,
      );
    }

    if (findings.length === 0) {
      console.log("\nAll four prices match the V1 catalog.");
      return;
    }

    console.error(`\n${findings.length} problem(s) found:`);
    for (const finding of findings) {
      console.error(`  ${finding.key}: ${finding.problem}`);
    }
    console.error(
      "\nFix the Stripe Dashboard or the STRIPE_PRICE_* configuration before serving billing. " +
        "A mismatched price sells the wrong plan silently, because runtime deliberately never reads " +
        "an amount. See ai/architecture/billing.md.",
    );
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Stripe catalog verification failed: ${message}`);
  process.exitCode = 1;
});
