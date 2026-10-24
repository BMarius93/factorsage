import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  type BillingPriceKey,
} from "@intrinsic/contracts";
import type { BillingCatalog } from "./billing-catalog";
import type { StripeGateway, StripePriceDescriptor } from "./stripe-gateway";

/**
 * Whether the configured Stripe prices are the ones this product sells.
 *
 * The check behind `pnpm billing:verify-catalog`, as a function, so that anything about to create
 * a subscription on those prices — the billing QA persona tooling — can refuse on exactly the
 * findings the operator command would have printed. `verify-stripe-catalog.ts` explains why the
 * check exists: runtime deliberately never reads an amount, so nothing else would notice a
 * `STRIPE_PRICE_PRO_MONTHLY` that points at the $19 Starter price.
 */

export type CatalogFinding = {
  readonly key: BillingPriceKey;
  readonly problem: string;
};

export type CatalogVerification = {
  /** Each configured price as Stripe holds it, or `null` when it could not be read. */
  readonly prices: ReadonlyMap<BillingPriceKey, StripePriceDescriptor | null>;
  /** Empty when every configured price matches the catalog. */
  readonly findings: readonly CatalogFinding[];
};

export function formatCatalogAmount(minorUnits: number | null): string {
  if (minorUnits === null) {
    return "no amount";
  }
  return `$${(minorUnits / 100).toFixed(2)}`;
}

/**
 * Verifies every configured price to be present and **active**, **recurring** at the configured
 * interval with `interval_count = 1`, **USD**, **licensed**, priced at exactly its catalog amount
 * ($19 / $49 / $199 a month, $169 / $439 / $1,790 a year — so a V1 $99 or $299 year left in a
 * yearly variable is a finding), attached to an **active** product shared with the other cadence of
 * the same plan and with no other plan, and distinct from the others.
 */
export async function verifyStripeCatalog(input: {
  readonly stripe: Pick<StripeGateway, "describePrices">;
  readonly catalog: BillingCatalog;
}): Promise<CatalogVerification> {
  const { stripe, catalog } = input;
  const findings: CatalogFinding[] = [];
  const prices = new Map<BillingPriceKey, StripePriceDescriptor | null>();
  const productByPlan = new Map<string, string>();

  for (const key of BILLING_PRICE_KEYS) {
    const expected = BILLING_CATALOG[key];
    const priceId = catalog.resolveKey(key).priceId;

    let price: StripePriceDescriptor | null = null;
    try {
      price = (await stripe.describePrices([priceId]))[0] ?? null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      findings.push({
        key,
        problem: `could not be read from Stripe (${message})`,
      });
      prices.set(key, null);
      continue;
    }

    prices.set(key, price);
    if (!price) {
      findings.push({
        key,
        problem: `${priceId} does not exist in this Stripe environment`,
      });
      continue;
    }

    if (!price.active) {
      findings.push({
        key,
        problem: `${priceId} is archived; an archived price must never be a purchase target`,
      });
    }
    if (!price.productActive) {
      findings.push({
        key,
        problem: `${priceId} belongs to an archived product`,
      });
    }
    if (price.currency !== expected.currency) {
      findings.push({
        key,
        problem: `currency is ${price.currency}, expected ${expected.currency}`,
      });
    }
    if (price.unitAmount !== expected.amountMinorUnits) {
      findings.push({
        key,
        problem: `amount is ${formatCatalogAmount(price.unitAmount)}, expected ${formatCatalogAmount(expected.amountMinorUnits)}`,
      });
    }
    if (price.recurringInterval === null) {
      findings.push({
        key,
        problem: `${priceId} is a one-time price; V1 sells subscriptions only`,
      });
    } else {
      const wanted = expected.interval === "MONTH" ? "month" : "year";
      if (price.recurringInterval !== wanted) {
        findings.push({
          key,
          problem: `interval is ${price.recurringInterval}, expected ${wanted}`,
        });
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
  }

  // One product per plan, and never one product for two plans: an invoice or the Customer Portal
  // names the product, so a Pro+ price created on the Pro product would bill $199 for "Pro".
  const planByProduct = new Map<string, string>();
  for (const [plan, productId] of productByPlan) {
    const other = planByProduct.get(productId);
    if (other) {
      const key = BILLING_PRICE_KEYS.find((candidate) => BILLING_CATALOG[candidate].plan === plan);
      findings.push({
        key: key as BillingPriceKey,
        problem: `belongs to product ${productId}, which is also the ${other} product; each plan needs its own product`,
      });
    } else {
      planByProduct.set(productId, plan);
    }
  }

  // Distinctness is enforced at startup too; repeating it here means the verifier is a complete
  // statement of catalog health rather than one that assumes the app already booted.
  const ids = new Map<string, BillingPriceKey[]>();
  for (const key of BILLING_PRICE_KEYS) {
    const priceId = catalog.resolveKey(key).priceId;
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

  return { prices, findings };
}
