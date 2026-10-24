import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  type BillingPriceKey,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { BillingCatalog } from "./billing-catalog";
import { verifyStripeCatalog } from "./catalog-verification";
import { FakeStripeGateway } from "./stripe-gateway.test-helper";
import type { StripePriceDescriptor } from "./stripe-gateway";

/**
 * The catalog check behind `pnpm billing:verify-catalog`, which the billing QA persona seed also
 * runs before it creates anything: a fixture on a mis-mapped price would be a persona on the wrong
 * plan, and nothing at runtime would notice.
 */

const PRICE_IDS: Record<BillingPriceKey, string> = {
  STARTER_MONTHLY: "price_starter_monthly",
  STARTER_YEARLY: "price_starter_yearly",
  PRO_MONTHLY: "price_pro_monthly",
  PRO_YEARLY: "price_pro_yearly",
  PRO_PLUS_MONTHLY: "price_pro_plus_monthly",
  PRO_PLUS_YEARLY: "price_pro_plus_yearly",
};

const CONFIG: StripeBillingConfig = {
  secretKey: "sk_test_catalog",
  webhookSecret: "whsec_catalog",
  priceIds: PRICE_IDS,
  testMode: true,
  checkoutSuccessUrl: "http://localhost:3000/billing?checkout=success",
  checkoutCancelUrl: "http://localhost:3000/billing?checkout=cancelled",
  portalReturnUrl: "http://localhost:3000/billing",
  timeoutMs: 1_000,
  maxNetworkRetries: 0,
};

function correct(key: BillingPriceKey): StripePriceDescriptor {
  const entry = BILLING_CATALOG[key];
  return {
    id: PRICE_IDS[key],
    active: true,
    currency: "usd",
    unitAmount: entry.amountMinorUnits,
    recurringInterval: entry.interval === "MONTH" ? "month" : "year",
    recurringIntervalCount: 1,
    usageType: "licensed",
    productId: `prod_${entry.plan.toLowerCase()}`,
    productName: entry.plan,
    productActive: true,
    lookupKey: entry.lookupKey,
  };
}

function stripeWith(
  overrides: Partial<
    Record<BillingPriceKey, Partial<StripePriceDescriptor> | null>
  > = {},
): FakeStripeGateway {
  const stripe = new FakeStripeGateway({ webhookSecret: CONFIG.webhookSecret });
  for (const key of BILLING_PRICE_KEYS) {
    const override = overrides[key];
    if (override !== null) {
      stripe.seedPrice({ ...correct(key), ...override });
    }
  }
  return stripe;
}

async function problems(
  overrides: Parameters<typeof stripeWith>[0] = {},
): Promise<string[]> {
  const { findings } = await verifyStripeCatalog({
    stripe: stripeWith(overrides),
    catalog: new BillingCatalog(CONFIG),
  });
  return findings.map((finding) => `${finding.key}: ${finding.problem}`);
}

describe("verifyStripeCatalog", () => {
  it("finds nothing wrong with the six catalog prices", async () => {
    const result = await verifyStripeCatalog({
      stripe: stripeWith(),
      catalog: new BillingCatalog(CONFIG),
    });
    expect(result.findings).toEqual([]);
    expect([...result.prices.keys()]).toEqual([...BILLING_PRICE_KEYS]);
  });

  it("catches a key pointing at a cheaper plan's price", async () => {
    expect(await problems({ PRO_MONTHLY: { unitAmount: 1_900 } })).toEqual([
      "PRO_MONTHLY: amount is $19.00, expected $49.00",
    ]);
    expect(await problems({ PRO_PLUS_MONTHLY: { unitAmount: 4_900 } })).toEqual([
      "PRO_PLUS_MONTHLY: amount is $49.00, expected $199.00",
    ]);
    expect(await problems({ PRO_PLUS_YEARLY: { unitAmount: 43_900 } })).toEqual([
      "PRO_PLUS_YEARLY: amount is $439.00, expected $1790.00",
    ]);
  });

  it("catches a V1 year left in a yearly variable", async () => {
    // STRIPE_PRICE_STARTER_YEARLY and STRIPE_PRICE_PRO_YEARLY once held the $99 and $299 V1 years.
    // A deployment that never repointed them would sell those as today's years.
    expect(await problems({ STARTER_YEARLY: { unitAmount: 9_900 } })).toEqual([
      "STARTER_YEARLY: amount is $99.00, expected $169.00",
    ]);
    expect(await problems({ PRO_YEARLY: { unitAmount: 29_900 } })).toEqual([
      "PRO_YEARLY: amount is $299.00, expected $439.00",
    ]);
  });

  it("catches a year that renews monthly, or a month that renews yearly", async () => {
    expect(await problems({ PRO_YEARLY: { recurringInterval: "month" } })).toEqual([
      "PRO_YEARLY: interval is month, expected year",
    ]);
    expect(await problems({ PRO_PLUS_MONTHLY: { recurringInterval: "year" } })).toEqual([
      "PRO_PLUS_MONTHLY: interval is year, expected month",
    ]);
  });

  it("catches the two cadences of one plan on two products", async () => {
    expect(await problems({ PRO_YEARLY: { productId: "prod_pro_annual" } })).toEqual([
      "PRO_YEARLY: belongs to product prod_pro_annual, but the other PRO price belongs to prod_pro",
    ]);
  });

  it.each<[string, Partial<StripePriceDescriptor>, RegExp]>([
    ["an archived price", { active: false }, /is archived/],
    ["an archived product", { productActive: false }, /archived product/],
    ["another currency", { currency: "eur" }, /currency is eur, expected usd/],
    [
      "the wrong cadence",
      { recurringInterval: "year" },
      /interval is year, expected month/,
    ],
    [
      "a multi-month interval",
      { recurringIntervalCount: 3 },
      /interval_count is 3/,
    ],
    ["a one-time price", { recurringInterval: null }, /one-time price/],
    ["a metered price", { usageType: "metered" }, /usage type is metered/],
  ])("catches %s", async (_label, override, expected) => {
    const found = await problems({ STARTER_MONTHLY: override });
    expect(found.join(" | ")).toMatch(expected);
    expect(found.every((line) => line.startsWith("STARTER_"))).toBe(true);
  });

  it("catches two plans sold under one product", async () => {
    // The Pro+ price created on the Pro product: every invoice and the Customer Portal would
    // name a $199 subscription "Pro".
    expect(
      await problems({
        PRO_PLUS_MONTHLY: { productId: "prod_pro" },
        PRO_PLUS_YEARLY: { productId: "prod_pro" },
      }),
    ).toEqual([
      "PRO_PLUS_MONTHLY: belongs to product prod_pro, which is also the PRO product; each plan needs its own product",
    ]);

    // One product for the whole catalog: every plan after the first is reported.
    const shared = { productId: "prod_factorsage" };
    expect(
      await problems({
        STARTER_MONTHLY: shared,
        STARTER_YEARLY: shared,
        PRO_MONTHLY: shared,
        PRO_YEARLY: shared,
        PRO_PLUS_MONTHLY: shared,
        PRO_PLUS_YEARLY: shared,
      }),
    ).toEqual([
      "PRO_MONTHLY: belongs to product prod_factorsage, which is also the STARTER product; each plan needs its own product",
      "PRO_PLUS_MONTHLY: belongs to product prod_factorsage, which is also the STARTER product; each plan needs its own product",
    ]);
  });

  it("accepts a product of any id, so long as no other plan shares it", async () => {
    expect(
      await problems({
        STARTER_MONTHLY: { productId: "prod_other" },
        STARTER_YEARLY: { productId: "prod_other" },
      }),
    ).toEqual([]);
  });

  it("reports a configured price Stripe does not have", async () => {
    expect(await problems({ PRO_PLUS_MONTHLY: null })).toEqual([
      "PRO_PLUS_MONTHLY: price_pro_plus_monthly does not exist in this Stripe environment",
    ]);
  });
});
