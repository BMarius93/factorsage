import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  type BillingPriceKey,
} from "@intrinsic/contracts";
import {
  describeStripeMode,
  openBillingCliContext,
} from "./billing/billing-cli-context";
import type { StripePriceDescriptor } from "./billing/stripe-gateway";

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

type Finding = { readonly key: BillingPriceKey; readonly problem: string };

async function main(): Promise<void> {
  const context = await openBillingCliContext();

  try {
    console.log(`Stripe environment: ${describeStripeMode(context.config)}`);
    console.log("Verifying the four V1 recurring prices.\n");

    const findings: Finding[] = [];
    const described = new Map<BillingPriceKey, StripePriceDescriptor | null>();
    const productByPlan = new Map<string, string>();

    for (const key of BILLING_PRICE_KEYS) {
      const expected = BILLING_CATALOG[key];
      const priceId = context.catalog.resolveKey(key).priceId;

      let price: StripePriceDescriptor | null = null;
      try {
        price = (await context.stripe.describePrices([priceId]))[0] ?? null;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        findings.push({ key, problem: `could not be read from Stripe (${message})` });
        described.set(key, null);
        continue;
      }

      described.set(key, price);
      if (!price) {
        findings.push({ key, problem: `${priceId} does not exist in this Stripe environment` });
        continue;
      }

      if (!price.active) {
        findings.push({ key, problem: `${priceId} is archived; an archived price must never be a purchase target` });
      }
      if (!price.productActive) {
        findings.push({ key, problem: `${priceId} belongs to an archived product` });
      }
      if (price.currency !== expected.currency) {
        findings.push({ key, problem: `currency is ${price.currency}, expected ${expected.currency}` });
      }
      if (price.unitAmount !== expected.amountMinorUnits) {
        findings.push({
          key,
          problem: `amount is ${formatAmount(price.unitAmount)}, expected ${formatAmount(expected.amountMinorUnits)}`,
        });
      }
      if (price.recurringInterval === null) {
        findings.push({ key, problem: `${priceId} is a one-time price; V1 sells subscriptions only` });
      } else {
        const wanted = expected.interval === "MONTH" ? "month" : "year";
        if (price.recurringInterval !== wanted) {
          findings.push({ key, problem: `interval is ${price.recurringInterval}, expected ${wanted}` });
        }
        if (price.recurringIntervalCount !== 1) {
          findings.push({
            key,
            problem: `interval_count is ${price.recurringIntervalCount}, expected 1`,
          });
        }
      }
      if (price.usageType !== null && price.usageType !== "licensed") {
        findings.push({
          key,
          problem: `usage type is ${price.usageType}; V1 has no metered or usage-based billing`,
        });
      }

      // Both cadences of one plan must be two prices of one product, or the Customer Portal cannot
      // present them as the same thing and an invoice will name the wrong product.
      if (price.productId) {
        const known = productByPlan.get(expected.plan);
        if (known && known !== price.productId) {
          findings.push({
            key,
            problem: `belongs to product ${price.productId}, but the other ${expected.plan} price belongs to ${known}`,
          });
        } else if (!known) {
          productByPlan.set(expected.plan, price.productId);
        }
      }

      console.log(
        `${key.padEnd(16)} ${priceId}  ${formatAmount(price.unitAmount)} / ` +
          `${price.recurringInterval ?? "one-time"}  ` +
          `${price.productName ?? "unknown product"}` +
          `${price.lookupKey ? `  lookup=${price.lookupKey}` : ""}` +
          `${price.active ? "" : "  ARCHIVED"}`,
      );
    }

    // Distinctness is enforced at startup too; repeating it here means the verifier is a complete
    // statement of catalog health rather than one that assumes the app already booted.
    const ids = new Map<string, BillingPriceKey[]>();
    for (const key of BILLING_PRICE_KEYS) {
      const priceId = context.catalog.resolveKey(key).priceId;
      ids.set(priceId, [...(ids.get(priceId) ?? []), key]);
    }
    for (const [priceId, keys] of ids) {
      if (keys.length > 1) {
        findings.push({
          key: keys[0] as BillingPriceKey,
          problem: `${priceId} is configured for ${keys.join(" and ")}; each logical price needs its own Stripe price`,
        });
      }
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

function formatAmount(minorUnits: number | null): string {
  if (minorUnits === null) {
    return "no amount";
  }
  return `$${(minorUnits / 100).toFixed(2)}`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Stripe catalog verification failed: ${message}`);
  process.exitCode = 1;
});
