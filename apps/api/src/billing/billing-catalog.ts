import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  BillingError,
  type BillingInterval,
  type BillingPriceKey,
  type PaidPlan,
} from "@intrinsic/contracts";

/**
 * The price allowlist: configured Stripe Price IDs in both directions, and nothing else.
 *
 * This is the whole of what makes a Stripe price mean a FactorSage plan. `docs/decisions/
 * stripe-billing-v1.md` section 1 forbids inferring a plan from the amount, the product name, the
 * currency, the Dashboard ordering or arbitrary metadata, and this class is what leaves no other
 * path available: a price id that is not one of the four configured values resolves to `null`, and
 * every caller treats `null` as fail-closed.
 *
 * Environment separation falls out of the same structure. The four ids come from configuration, so
 * a sandbox deployment physically cannot resolve a live price and a live deployment cannot resolve
 * a sandbox one — an event carrying the other environment's price yields `null` and is surfaced,
 * never mapped.
 */
export type ResolvedPrice = {
  readonly key: BillingPriceKey;
  readonly priceId: string;
  readonly plan: PaidPlan;
  readonly interval: BillingInterval;
};

export class BillingCatalog {
  private readonly byKey: ReadonlyMap<BillingPriceKey, ResolvedPrice>;
  private readonly byPriceId: ReadonlyMap<string, ResolvedPrice>;

  constructor(config: StripeBillingConfig) {
    const byKey = new Map<BillingPriceKey, ResolvedPrice>();
    const byPriceId = new Map<string, ResolvedPrice>();

    for (const key of BILLING_PRICE_KEYS) {
      const entry = BILLING_CATALOG[key];
      const priceId = config.priceIds[key];
      const resolved: ResolvedPrice = {
        key,
        priceId,
        plan: entry.plan,
        interval: entry.interval,
      };
      byKey.set(key, resolved);
      byPriceId.set(priceId, resolved);
    }

    // `getStripeBillingConfig` already refuses duplicate ids at startup. Asserting it again here is
    // cheap and keeps the invariant local to the structure that depends on it: a collision would
    // silently make one logical price unreachable and the other ambiguous.
    if (byPriceId.size !== BILLING_PRICE_KEYS.length) {
      throw new BillingError("Billing catalog is misconfigured", {
        code: "BILLING_CATALOG_MISCONFIGURED",
      });
    }

    this.byKey = byKey;
    this.byPriceId = byPriceId;
  }

  /** The configured Stripe price for a logical catalog key. */
  resolveKey(key: BillingPriceKey): ResolvedPrice {
    const resolved = this.byKey.get(key);
    if (!resolved) {
      throw new BillingError("That plan is not available", {
        code: "BILLING_INVALID_PRICE_KEY",
        priceKey: key,
      });
    }
    return resolved;
  }

  /**
   * What a Stripe price id means, or `null` when it is not one of ours.
   *
   * `null` is a normal, expected answer — an archived legacy price, a Credit Top-Up, a Dashboard
   * experiment, another environment's price — and it always fails closed rather than throwing,
   * because reconciliation must still record what it found and leave the user FREE.
   */
  resolvePriceId(priceId: string | null | undefined): ResolvedPrice | null {
    if (!priceId) {
      return null;
    }
    return this.byPriceId.get(priceId) ?? null;
  }

  /** Every configured price id. Used by the catalog verifier. */
  priceIds(): readonly string[] {
    return BILLING_PRICE_KEYS.map((key) => this.resolveKey(key).priceId);
  }
}
