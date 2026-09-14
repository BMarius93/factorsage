import {
  BILLING_CATALOG_ENTRIES,
  PLAN_ENTITLEMENTS,
  billingPriceKeyFor,
  type BillingInterval,
  type BillingPriceKey,
  type EntitlementLimit,
  type PaidPlan,
  type UserPlan,
} from "@intrinsic/contracts";

/**
 * What one plan card says, derived rather than written down.
 *
 * Two canonical structures feed this file and nothing else does:
 *
 * - `PLAN_ENTITLEMENTS` (`packages/contracts/src/entitlements.ts`) supplies every capacity the
 *   feature rows quote. `docs/decisions/entitlements-v1.md` is the product decision behind those
 *   numbers, and it is the only place they may change.
 * - `BILLING_CATALOG_ENTRIES` (`packages/contracts/src/billing.ts`) supplies every amount and the
 *   logical price key each button sends. `docs/decisions/stripe-billing-v1.md` fixes those.
 *
 * **No limit and no amount is re-stated here.** A pricing page that hard-codes "50 stocks" is a
 * second source of truth that silently diverges the first time the matrix moves, and a user who
 * bought what the card promised would then be refused by a guard quoting a different number. The
 * cost of deriving is a few formatting branches; the cost of copying is a support ticket nobody
 * can reproduce.
 *
 * The one piece of arithmetic in the file is the annual saving, and it is deliberately narrow: it
 * compares two **published list prices** from the catalog. It is not a proration estimate, an
 * invoice preview or a credit calculation — those remain Stripe's, on Stripe's own hosted pages,
 * exactly as `docs/decisions/stripe-billing-v1.md` section 19 requires.
 */

/** Cheapest first. The order the cards render in, and the only place it is decided. */
export const PLAN_CARD_ORDER: readonly UserPlan[] = ["FREE", "STARTER", "PRO"];

/**
 * The plan the card layout highlights.
 *
 * A presentation choice, not an entitlement one: it changes a badge and nothing a guard reads.
 */
export const RECOMMENDED_PLAN: UserPlan = "PRO";

export type PlanFeature = {
  /** Stable identity for the row, so the same capacity occupies the same line on every card. */
  readonly id: string;
  readonly label: string;
};

export type PlanPricing = {
  /** `$9`, `$299`, `$0`. */
  readonly amount: string;
  /** `/ month` or `/ year`, matching the selected interval on every card including Free. */
  readonly period: string;
  /** A quiet second line under the price. `null` when there is nothing honest to say. */
  readonly note: string | null;
  /** What the card's button would buy. `null` for Free, which has no Stripe price by design. */
  readonly priceKey: BillingPriceKey | null;
};

function formatUsd(minorUnits: number): string {
  const amount = minorUnits / 100;
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * `50` -> `"Up to 50"`, unbounded -> `"Unlimited"`.
 *
 * `null` is a real product value in the matrix — every authenticated plan saves an unlimited
 * number of Lists and Strategies — so it gets words rather than a fallback number.
 */
function capacity(limit: EntitlementLimit, noun: string, nounPlural: string): string {
  if (limit === null) {
    return `Unlimited ${nounPlural}`;
  }
  return `Up to ${limit} ${limit === 1 ? noun : nounPlural}`;
}

function count(limit: EntitlementLimit, noun: string, nounPlural: string): string {
  if (limit === null) {
    return `Unlimited ${nounPlural}`;
  }
  return `${limit} ${limit === 1 ? noun : nounPlural}`;
}

/**
 * The five capacities that differ between plans, in one fixed order.
 *
 * Fixed order and fixed length are what make the three cards line up row for row, so a reader
 * compares the same capacity across plans by looking straight across rather than hunting.
 */
export function planFeatures(plan: UserPlan): readonly PlanFeature[] {
  const entitlements = PLAN_ENTITLEMENTS[plan];

  return [
    {
      id: "list-symbols",
      label: `${capacity(entitlements.lists.maxSymbols, "stock", "stocks")} per list`,
    },
    {
      id: "saved-content",
      label:
        entitlements.lists.maxSaved === null &&
        entitlements.strategies.maxSaved === null
          ? "Unlimited lists and strategies"
          : `${capacity(entitlements.lists.maxSaved, "list", "lists")} and ${count(
              entitlements.strategies.maxSaved,
              "strategy",
              "strategies",
            ).toLowerCase()}`,
    },
    {
      id: "backtest-history",
      label:
        entitlements.backtests.maxHistoricalYears === null
          ? "Backtests over the full history"
          : `Backtests over ${entitlements.backtests.maxHistoricalYears} years of history`,
    },
    {
      id: "backtest-concurrency",
      label: `${count(entitlements.backtests.maxConcurrentRuns, "backtest", "backtests")} at a time`,
    },
    {
      id: "monitors",
      label: `${count(entitlements.monitors.maxActive, "active monitor", "active monitors")}`,
    },
  ];
}

function catalogEntry(plan: PaidPlan, interval: BillingInterval) {
  const key = billingPriceKeyFor(plan, interval);
  const entry = BILLING_CATALOG_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) {
    // Unreachable while the catalog covers both plans in both cadences; the throw makes a future
    // gap a test failure rather than a card rendering `undefined` at somebody.
    throw new Error(`No catalog entry for ${plan}/${interval}`);
  }
  return entry;
}

/**
 * The annual saving of paying yearly, from the two published list prices.
 *
 * `null` when there is nothing to claim, so a catalog edit that removed the discount silently
 * removes the line rather than printing `save $0`.
 */
export function yearlySavingMinorUnits(plan: PaidPlan): number | null {
  const monthly = catalogEntry(plan, "MONTH").amountMinorUnits * 12;
  const yearly = catalogEntry(plan, "YEAR").amountMinorUnits;
  const saving = monthly - yearly;
  return saving > 0 ? saving : null;
}

export function planPricing(
  plan: UserPlan,
  interval: BillingInterval,
): PlanPricing {
  const period = interval === "MONTH" ? "/ month" : "/ year";

  if (plan === "FREE") {
    // No Stripe price exists for Free, and none should: moving to Free is a cancellation, never a
    // purchase (decision document section 7).
    return { amount: "$0", period, note: "Free forever", priceKey: null };
  }

  const entry = catalogEntry(plan, interval);
  if (interval === "MONTH") {
    return {
      amount: formatUsd(entry.amountMinorUnits),
      period,
      // Every card carries a note line, which is what keeps the feature rows on one baseline
      // across the three cards rather than shifting by a line whenever one plan has something to
      // add and another does not.
      note: "Billed monthly",
      priceKey: entry.key,
    };
  }

  const saving = yearlySavingMinorUnits(plan);
  return {
    amount: formatUsd(entry.amountMinorUnits),
    period,
    note:
      saving === null
        ? "Billed annually"
        : `Billed annually · save ${formatUsd(saving)}`,
    priceKey: entry.key,
  };
}
