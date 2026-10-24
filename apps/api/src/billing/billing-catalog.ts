import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_CATALOG,
  BILLING_PRICE_KEYS,
  BillingError,
  findBillingPriceKey,
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
 * path available: a price id that is not one of the configured values resolves to `null`, and
 * every caller treats `null` as fail-closed.
 *
 * Environment separation falls out of the same structure. The ids come from configuration, so
 * a sandbox deployment physically cannot resolve a live price and a live deployment cannot resolve
 * a sandbox one — an event carrying the other environment's price yields `null` and is surfaced,
 * never mapped.
 */
export type ResolvedPrice = {
  /**
   * The logical price. For a **legacy** price (below) it is today's catalog price of the same plan
   * and cadence — the one a transition is classified from — never the price the subscription is
   * billed on.
   */
  readonly key: BillingPriceKey;
  /** The Stripe price the subscription is actually billed on. */
  readonly priceId: string;
  readonly plan: PaidPlan;
  /** The cadence actually billed. */
  readonly interval: BillingInterval;
  /**
   * True for a retired price listed in `STRIPE_LEGACY_PRICES`: existing subscribers billed on it keep
   * its plan (grandfathered), but it is never sold and never a change target — `resolveKey` cannot
   * reach it, because no logical key names it.
   */
  readonly legacy: boolean;
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
        legacy: false,
      };
      byKey.set(key, resolved);
      byPriceId.set(priceId, resolved);
    }

    // Retired prices resolve only by id. A transition from one is classified exactly as from today's
    // price of the same plan **and cadence**: up a tier is an immediate upgrade, down a tier a
    // period-end downgrade, monthly → yearly immediate, yearly → monthly at the end of the paid year,
    // and "the same plan and cadence at today's price" is no change at all — the subscriber stays on
    // the retired price, grandfathered, until they choose a different plan or cadence.
    const legacyPrices = config.legacyPrices ?? [];
    for (const legacy of legacyPrices) {
      const key = findBillingPriceKey(legacy.plan, legacy.interval);
      if (!key) {
        throw new BillingError("Billing catalog is misconfigured", {
          code: "BILLING_CATALOG_MISCONFIGURED",
        });
      }
      byPriceId.set(legacy.priceId, {
        key,
        priceId: legacy.priceId,
        plan: legacy.plan,
        interval: legacy.interval,
        legacy: true,
      });
    }

    // `getStripeBillingConfig` already refuses duplicate ids at startup. Asserting it again here is
    // cheap and keeps the invariant local to the structure that depends on it: a collision would
    // silently make one logical price unreachable and the other ambiguous.
    if (byPriceId.size !== BILLING_PRICE_KEYS.length + legacyPrices.length) {
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
