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
import { PLAN_LABEL } from "./format";

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
 * The arithmetic in the file is deliberately narrow and reads **published list prices** from the
 * catalog and nothing else: the annual saving compares the two prices of one plan, and the monthly
 * equivalent divides a yearly price by twelve so it can be read beside a monthly one. Neither is a
 * proration estimate, an invoice preview or a credit calculation — those remain Stripe's, on
 * Stripe's own hosted pages, exactly as `docs/decisions/stripe-billing-v1.md` section 19 requires —
 * and neither is ever what a button sends.
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
  /**
   * `false` for a row the plan does not include. It still renders — marked, in words, as not
   * included — because a row that is simply missing reads as an oversight, not as a difference.
   */
  readonly included: boolean;
  /** A quieter second line under the label. `null` when the label says it all. */
  readonly detail: string | null;
};

export type PlanPricing = {
  /** `$9`, `$299`, `$0`. */
  readonly amount: string;
  /** `/ month` or `/ year`, matching the selected interval on every card including Free. */
  readonly period: string;
  /** A quiet second line under the price. `null` when there is nothing honest to say. */
  readonly note: string | null;
  /**
   * A yearly price per month, `≈ $24.92 / month`, read beside the monthly cards (PR-3). Secondary
   * to the amount actually charged, which stays the price line. `null` for a monthly price and
   * for Free, which has nothing to divide.
   */
  readonly monthlyEquivalent: string | null;
  /** What the card's button would buy. `null` for Free, which has no Stripe price by design. */
  readonly priceKey: BillingPriceKey | null;
};

/** The product's name for the one point-in-time index universe (`sp500-historical-pit-v1.md`). */
const INDEX_UNIVERSE_FEATURE = "S&P 500 Historical PIT backtests";

export const NOT_INCLUDED = "Not included";

/** `2492` -> `$24.92`, `29900` -> `$299`. */
export function formatUsd(minorUnits: number): string {
  const amount = minorUnits / 100;
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** `["Pro"]` -> `Pro`, `["Starter", "Pro"]` -> `Starter and Pro`. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
 * Whether a plan's backtests may run over the S&P 500 Historical PIT universe at all.
 *
 * `0` is the matrix's way of saying "not included" (`backtests.maxIndexUniverseConstituents`);
 * `null` is unbounded, which is included.
 */
function includesIndexUniverse(plan: UserPlan): boolean {
  return PLAN_ENTITLEMENTS[plan].backtests.maxIndexUniverseConstituents !== 0;
}

/** The plans that include the point-in-time universe, cheapest first, read from the matrix. */
export function indexUniversePlans(): readonly UserPlan[] {
  return PLAN_CARD_ORDER.filter(includesIndexUniverse);
}

/**
 * The point-in-time universe row (PR-1): the one difference between plans that is access rather
 * than capacity, so it is said on every card — included, with its allowance, or not included.
 *
 * The allowance is **not** "stocks per backtest". `docs/decisions/sp500-historical-pit-v1.md` §5
 * measures this universe by the most members it holds on any one date of the run's period, under
 * its own limit, and the per-backtest stock limit keeps binding every other List. The detail line
 * says both, so the 100 on the row above never reads as excluding a 500-member index.
 */
function indexUniverseFeature(plan: UserPlan): PlanFeature {
  const allowance = PLAN_ENTITLEMENTS[plan].backtests.maxIndexUniverseConstituents;
  if (allowance === 0) {
    return {
      id: "index-universe",
      label: INDEX_UNIVERSE_FEATURE,
      included: false,
      detail: NOT_INCLUDED,
    };
  }
  const members =
    allowance === null ? "Any number of index members" : `Up to ${allowance} index members`;
  return {
    id: "index-universe",
    label: INDEX_UNIVERSE_FEATURE,
    included: true,
    detail: `${members} at once, measured separately from stocks per backtest`,
  };
}

/**
 * The line above the cards: what every plan shares, and how the plans differ.
 *
 * "Plans differ by capacity" stopped being the whole truth when the point-in-time universe became
 * a plan difference (PR-1), so the plans that include it are named — read from the matrix, never
 * written down — and the sentence returns to capacity alone if the matrix ever stops dividing them.
 */
export function plansCaption(): string {
  const shared = "Every plan includes every indicator, valuation model and strategy feature.";
  const including = indexUniversePlans();
  if (including.length === 0 || including.length === PLAN_CARD_ORDER.length) {
    return `${shared} Plans differ by capacity.`;
  }
  const names = joinNames(including.map((plan) => PLAN_LABEL[plan]));
  const verb = including.length === 1 ? "includes" : "include";
  return `${shared} Plans differ by capacity, and only ${names} ${verb} ${INDEX_UNIVERSE_FEATURE}.`;
}

/**
 * The capacities that differ between plans, then the point-in-time universe, in one fixed order.
 *
 * Fixed order and fixed length are what make the three cards line up row for row, so a reader
 * compares the same capacity across plans by looking straight across rather than hunting. The
 * universe row comes last because it is the only one with a second line.
 */
export function planFeatures(plan: UserPlan): readonly PlanFeature[] {
  const entitlements = PLAN_ENTITLEMENTS[plan];
  const row = (id: string, label: string): PlanFeature => ({
    id,
    label,
    included: true,
    detail: null,
  });

  return [
    row("list-symbols", `${capacity(entitlements.lists.maxSymbols, "stock", "stocks")} per list`),
    row(
      "saved-content",
      entitlements.lists.maxSaved === null && entitlements.strategies.maxSaved === null
        ? "Unlimited lists and strategies"
        : `${capacity(entitlements.lists.maxSaved, "list", "lists")} and ${count(
            entitlements.strategies.maxSaved,
            "strategy",
            "strategies",
          ).toLowerCase()}`,
    ),
    // Enforced separately from a list's size, so it is stated separately (UI-039).
    row(
      "backtest-symbols",
      `${capacity(entitlements.backtests.maxSymbols, "stock", "stocks")} per backtest`,
    ),
    // A limit on the length of the simulated period, not on how far back it may start: any
    // plan may begin thirty years ago. "Over N years of history" read as a look-back cap.
    row(
      "backtest-history",
      entitlements.backtests.maxHistoricalYears === null
        ? "Backtest periods of any length"
        : `Backtest periods up to ${entitlements.backtests.maxHistoricalYears} years long`,
    ),
    row(
      "backtest-concurrency",
      `${count(entitlements.backtests.maxConcurrentRuns, "backtest", "backtests")} at a time`,
    ),
    row(
      "monitors",
      `${count(entitlements.monitors.maxActive, "active monitor", "active monitors")}`,
    ),
    indexUniverseFeature(plan),
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

/**
 * A plan's published yearly price spread over twelve months, rounded to the cent (PR-3).
 *
 * Half a cent rounds up, as `Math.round` does for these positive amounts: `$299` is 2491.67 cents a
 * month and reads `$24.92`. For comparison only — Stripe charges the yearly amount, once.
 */
export function monthlyEquivalentMinorUnits(plan: PaidPlan): number {
  return Math.round(catalogEntry(plan, "YEAR").amountMinorUnits / 12);
}

export function planPricing(
  plan: UserPlan,
  interval: BillingInterval,
): PlanPricing {
  const period = interval === "MONTH" ? "/ month" : "/ year";

  if (plan === "FREE") {
    // No Stripe price exists for Free, and none should: moving to Free is a cancellation, never a
    // purchase (decision document section 7).
    return {
      amount: "$0",
      period,
      note: "Free forever",
      monthlyEquivalent: null,
      priceKey: null,
    };
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
      monthlyEquivalent: null,
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
    monthlyEquivalent: `≈ ${formatUsd(monthlyEquivalentMinorUnits(plan))} / month`,
    priceKey: entry.key,
  };
}
