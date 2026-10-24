import {
  BILLING_CATALOG_ENTRIES,
  OFFERED_BILLING_INTERVALS,
  PLAN_ENTITLEMENTS,
  findBillingPriceKey,
  isPaidPlan,
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
 *   feature rows quote. `docs/decisions/entitlements-v2.md` is the product decision behind those
 *   numbers, and it is the only place they may change.
 * - `BILLING_CATALOG_ENTRIES` (`packages/contracts/src/billing.ts`) supplies every amount and the
 *   logical price key each button sends. `docs/decisions/stripe-billing-v1.md` (as amended by
 *   entitlements-v2) fixes those.
 *
 * **No limit and no amount is re-stated here.** A pricing page that hard-codes "50 stocks" is a
 * second source of truth that silently diverges the first time the matrix moves, and a user who
 * bought what the card promised would then be refused by a guard quoting a different number. The
 * cost of deriving is a few formatting branches; the cost of copying is a support ticket nobody
 * can reproduce.
 *
 * The arithmetic in the file is deliberately narrow and reads **published list prices** from the
 * catalog and nothing else: the annual saving compares the two prices of one plan (as a percentage,
 * rounded **down** so it is never overstated), and the effective monthly cost divides a yearly price
 * by twelve so it can be read beside a monthly one. Neither is a proration estimate, an invoice
 * preview or a credit calculation — those remain Stripe's, on Stripe's own hosted pages, exactly as
 * `docs/decisions/stripe-billing-v1.md` section 19 requires — and neither is ever what a button
 * sends. Both apply only while the catalog sells a yearly price ({@link OFFERED_BILLING_INTERVALS}).
 *
 * **A yearly card never reads as a monthly charge.** Its large figure is the effective monthly cost
 * (the owner's decision, `docs/decisions/entitlements-v2.md` §2), and the line directly under it
 * states the exact annual amount and that it is billed upfront — the amount Stripe charges, which
 * `docs/legal/implementation-spec.md` §6 requires to be stated, not only a monthly equivalent.
 *
 * **What a card never claims.** Plans differ by capacity and by premium content, never by speed:
 * every run shares one deployment-wide execution capacity in one fair queue
 * (`ai/architecture/backtest-execution.md`, "Global admission"). No row may promise priority
 * execution, faster compute or a guaranteed completion time.
 */

/** Cheapest first. The order the cards render in, and the only place it is decided. */
export const PLAN_CARD_ORDER: readonly UserPlan[] = ["FREE", "STARTER", "PRO", "PRO_PLUS"];

/**
 * The plan the card layout emphasizes, with the "Best Value" badge and the page's one solid button.
 *
 * A presentation choice, not an entitlement one: it changes a badge and nothing a guard reads.
 */
export const RECOMMENDED_PLAN: UserPlan = "PRO";
export const RECOMMENDED_BADGE = "Best Value";

/**
 * One line under each plan's name saying who it is for. Pro+ is positioned as the advanced tier —
 * named, but never emphasized over the recommended plan.
 */
export const PLAN_TAGLINE: Readonly<Record<UserPlan, string>> = {
  FREE: "Explore the full research workflow",
  STARTER: "For focused watchlists",
  PRO: "For serious research",
  PRO_PLUS: "Advanced Research",
};

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
  /**
   * The large figure: `$19`, `$0`, or for a yearly price its effective monthly cost (`$14.08`).
   * Always read with {@link PlanPricing.period}, which is `/ month` on every card.
   */
  readonly amount: string;
  /** `/ month` on every card, whichever cadence is selected: the figures compare like for like. */
  readonly period: string;
  /**
   * The line under the price saying what is charged and when: `Billed monthly`, or for a yearly
   * price `Billed annually: $169 upfront` — the exact annual amount. `null` when there is nothing
   * honest to say.
   */
  readonly note: string | null;
  /**
   * The exact amount one yearly payment charges, `$169`. `null` for a monthly price and for Free.
   */
  readonly annualAmount: string | null;
  /**
   * `Save 25%` against twelve monthly payments of the same plan, rounded down. `null` for a
   * monthly price, for Free, and for a yearly price with no saving.
   */
  readonly saving: string | null;
  /** What the card's button would buy. `null` for Free, which has no Stripe price by design. */
  readonly priceKey: BillingPriceKey | null;
};

/** The point-in-time universe the premium row names (`sp500-historical-pit-v1.md`). */
const INDEX_UNIVERSE_NAME = "S&P 500 Historical PIT";

export const NOT_INCLUDED = "Not included";

/**
 * The footnote an "Unlimited" monitor allowance carries, word for word on the card and under the
 * comparison: no plan cap is advertised, which is not a promise of unlimited infrastructure.
 */
export const UNLIMITED_MONITORS_FOOTNOTE =
  "Unlimited active monitors means no plan cap on the number you keep active. A fair-use safeguard protects shared infrastructure; it is not a plan limit.";

/**
 * `2492` -> `$24.92`, `16900` -> `$169`, `179000` -> `$1,790`. Whole dollars drop the cents;
 * anything else shows two. Fixed to en-US, like {@link formatCount}, so a test and a browser in
 * another locale agree.
 */
export function formatUsd(minorUnits: number): string {
  const amount = minorUnits / 100;
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** `1000` -> `1,000`. Fixed to en-US so a test and a browser in another locale agree. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** `["Pro"]` -> `Pro`, `["Starter", "Pro"]` -> `Starter and Pro`. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * `50` -> `"Up to 50 stocks"`, unbounded -> `"Unlimited stocks"`.
 *
 * `null` is a real product value in the matrix — every authenticated plan saves an unlimited
 * number of Lists and Strategies — so it gets words rather than a fallback number.
 */
function capacity(limit: EntitlementLimit, noun: string, nounPlural: string): string {
  if (limit === null) {
    return `Unlimited ${nounPlural}`;
  }
  return `Up to ${formatCount(limit)} ${limit === 1 ? noun : nounPlural}`;
}

function count(limit: EntitlementLimit, noun: string, nounPlural: string): string {
  if (limit === null) {
    return `Unlimited ${nounPlural}`;
  }
  return `${formatCount(limit)} ${limit === 1 ? noun : nounPlural}`;
}

/** Whether a plan includes premium built-in content (lists, strategies, point-in-time universes). */
function includesPremium(plan: UserPlan): boolean {
  return PLAN_ENTITLEMENTS[plan].builtInContent.canUsePremium;
}

/** The plans that include premium content, cheapest first, read from the matrix. */
export function premiumPlans(): readonly UserPlan[] {
  return PLAN_CARD_ORDER.filter(includesPremium);
}

/**
 * The premium row: the one difference between plans that is access rather than capacity, so it is
 * said on every card — included, with what it covers, or not included.
 */
function premiumFeature(plan: UserPlan): PlanFeature {
  const label = "Premium lists, strategies and point-in-time universes";
  if (!includesPremium(plan)) {
    return { id: "premium-content", label, included: false, detail: NOT_INCLUDED };
  }
  const allowance = PLAN_ENTITLEMENTS[plan].backtests.maxIndexUniverseConstituents;
  return {
    id: "premium-content",
    label,
    included: true,
    detail:
      allowance === null
        ? `Including ${INDEX_UNIVERSE_NAME} backtests`
        : `Including ${INDEX_UNIVERSE_NAME} backtests, up to ${formatCount(allowance)} index members at once`,
  };
}

/**
 * The concurrency row. A plan that runs more than one backtest at once advertises it as
 * "Parallel Backtests", and says exactly how many — never more, and never faster.
 */
function concurrencyFeature(plan: UserPlan): PlanFeature {
  const limit = PLAN_ENTITLEMENTS[plan].backtests.maxConcurrentRuns;
  if (limit !== null && limit > 1) {
    return {
      id: "backtest-concurrency",
      label: `Parallel Backtests: ${formatCount(limit)} at a time`,
      included: true,
      detail: `Up to ${formatCount(limit)} of your backtests run at the same time. Every run shares the same execution capacity and fair queue as every other plan.`,
    };
  }
  return {
    id: "backtest-concurrency",
    label: `${count(limit, "backtest", "backtests")} at a time`,
    included: true,
    detail: null,
  };
}

function monitorFeature(plan: UserPlan): PlanFeature {
  const limit = PLAN_ENTITLEMENTS[plan].monitors.maxActive;
  if (limit === null) {
    return {
      id: "monitors",
      label: "Unlimited active monitors*",
      included: true,
      detail: "*No plan cap. Fair use applies.",
    };
  }
  return {
    id: "monitors",
    label: count(limit, "active monitor", "active monitors"),
    included: true,
    detail: null,
  };
}

/**
 * The line above the cards: what every plan shares, and how the plans differ.
 *
 * The plans that include premium content are named — read from the matrix, never written down —
 * and the sentence returns to capacity alone if the matrix ever stops dividing them.
 */
export function plansCaption(): string {
  // The history depth is quoted only while every plan shares it; it is the matrix's, not ours.
  const depths = new Set(
    PLAN_CARD_ORDER.map((plan) => PLAN_ENTITLEMENTS[plan].backtests.maxHistoricalYears),
  );
  const [depth] = [...depths];
  const history =
    depths.size === 1 && typeof depth === "number"
      ? ` and backtests up to ${formatCount(depth)} years long`
      : "";
  const shared = `Every plan includes the full Strategy Builder, ETF and sector conditions, unlimited backtests${history}.`;
  const including = premiumPlans();
  if (including.length === 0 || including.length === PLAN_CARD_ORDER.length) {
    return `${shared} Plans differ by capacity.`;
  }
  const names = joinNames(including.map((plan) => PLAN_LABEL[plan]));
  const verb = including.length === 1 ? "includes" : "include";
  return `${shared} Plans differ by capacity, and only ${names} ${verb} premium content.`;
}

/**
 * The capacities that differ between plans, then what every plan shares, then premium content, in
 * one fixed order.
 *
 * Fixed order and fixed length are what make the four cards line up row for row, so a reader
 * compares the same capacity across plans by looking straight across rather than hunting.
 */
export function planFeatures(plan: UserPlan): readonly PlanFeature[] {
  const entitlements = PLAN_ENTITLEMENTS[plan];
  const row = (id: string, label: string, detail: string | null = null): PlanFeature => ({
    id,
    label,
    included: true,
    detail,
  });
  const historyYears = entitlements.backtests.maxHistoricalYears;

  return [
    row("list-symbols", `${capacity(entitlements.lists.maxSymbols, "stock", "stocks")} per list`),
    // Enforced separately from a list's size, so it is stated separately (UI-039).
    row(
      "backtest-symbols",
      `${capacity(entitlements.backtests.maxSymbols, "stock", "stocks")} per backtest`,
    ),
    concurrencyFeature(plan),
    monitorFeature(plan),
    // The matrix carries no quota on how many backtests a plan may run in total.
    row("backtest-count", "Unlimited backtests"),
    // A limit on the length of the simulated period, not on how far back it may start.
    row(
      "backtest-history",
      historyYears === null
        ? "Backtest periods of any length"
        : `Backtests up to ${formatCount(historyYears)} years long`,
      "Subject to data availability",
    ),
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
    {
      id: "strategy-builder",
      label: "Full Strategy Builder",
      included: entitlements.strategies.analyticalPrimitives === "ALL",
      detail: entitlements.strategies.analyticalPrimitives === "ALL" ? null : NOT_INCLUDED,
    },
    {
      id: "etf-conditions",
      label: "ETF and sector conditions",
      included: entitlements.strategies.analyticalPrimitives === "ALL",
      detail: entitlements.strategies.analyticalPrimitives === "ALL" ? null : NOT_INCLUDED,
    },
    premiumFeature(plan),
  ];
}

/** Whether the toggle has anything to choose between: the catalog sells more than one cadence. */
export function offersIntervalChoice(): boolean {
  return OFFERED_BILLING_INTERVALS.length > 1;
}

/**
 * The cadence the cards show: the one asked for when the catalog sells it, otherwise the first one
 * it does sell. A subscriber still billed on a retired cadence sees today's prices, not a gap.
 */
export function displayedInterval(requested: BillingInterval | null | undefined): BillingInterval {
  if (requested && OFFERED_BILLING_INTERVALS.includes(requested)) {
    return requested;
  }
  return OFFERED_BILLING_INTERVALS[0] ?? "MONTH";
}

function catalogEntry(plan: PaidPlan, interval: BillingInterval) {
  const key = findBillingPriceKey(plan, interval);
  const entry = BILLING_CATALOG_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) {
    // Unreachable for an offered interval; the throw makes a future gap a test failure rather
    // than a card rendering `undefined` at somebody.
    throw new Error(`No catalog entry for ${plan}/${interval}`);
  }
  return entry;
}

/**
 * The annual saving of paying yearly, from the two published list prices.
 *
 * `null` when there is nothing to claim — no yearly price, or no discount — so a catalog edit that
 * removed either silently removes the line rather than printing `save $0`.
 */
export function yearlySavingMinorUnits(plan: PaidPlan): number | null {
  if (findBillingPriceKey(plan, "YEAR") === null) {
    return null;
  }
  const monthly = catalogEntry(plan, "MONTH").amountMinorUnits * 12;
  const yearly = catalogEntry(plan, "YEAR").amountMinorUnits;
  const saving = monthly - yearly;
  return saving > 0 ? saving : null;
}

/**
 * The annual saving as a whole percentage of twelve monthly payments, rounded **down** so the page
 * never claims more than the prices give: $169 against 12 × $19 is 25.88%, shown as 25%. `null`
 * when there is no saving to claim.
 */
export function yearlySavingPercent(plan: PaidPlan): number | null {
  const saving = yearlySavingMinorUnits(plan);
  if (saving === null) {
    return null;
  }
  const twelveMonths = catalogEntry(plan, "MONTH").amountMinorUnits * 12;
  const percent = Math.floor((saving * 100) / twelveMonths);
  return percent > 0 ? percent : null;
}

/**
 * The cadence toggle's tag: `Save 25%` when every paid plan saves the same whole percentage, `Save
 * up to N%` when they differ, `null` when none saves anything.
 */
export function yearlySavingTag(): string | null {
  const percents = PLAN_CARD_ORDER.filter(isPaidPlan).map(yearlySavingPercent);
  if (percents.some((percent) => percent === null)) {
    // A plan with no saving would make "Save N%" untrue for it; say nothing rather than qualify.
    return null;
  }
  const values = percents as number[];
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  return lowest === highest ? `Save ${lowest}%` : `Save up to ${highest}%`;
}

/**
 * A plan's published yearly price spread over twelve months, rounded to the cent: the effective
 * monthly cost a yearly card shows ($169 → $14.08, $439 → $36.58, $1,790 → $149.17). `null`
 * while the catalog sells no yearly price. For comparison only — Stripe charges the yearly amount,
 * upfront.
 */
export function monthlyEquivalentMinorUnits(plan: PaidPlan): number | null {
  if (findBillingPriceKey(plan, "YEAR") === null) {
    return null;
  }
  return Math.round(catalogEntry(plan, "YEAR").amountMinorUnits / 12);
}

export function planPricing(plan: UserPlan, interval: BillingInterval): PlanPricing {
  const period = "/ month";

  if (plan === "FREE") {
    // No Stripe price exists for Free, and none should: moving to Free is a cancellation, never a
    // purchase (decision document section 7).
    return {
      amount: "$0",
      period,
      note: "Free forever",
      annualAmount: null,
      saving: null,
      priceKey: null,
    };
  }

  const entry = catalogEntry(plan, interval);
  if (interval === "MONTH") {
    return {
      amount: formatUsd(entry.amountMinorUnits),
      period,
      // Every card carries a note line, which is what keeps the feature rows on one baseline
      // across the cards rather than shifting by a line whenever one plan has something to add.
      note: "Billed monthly",
      annualAmount: null,
      saving: null,
      priceKey: entry.key,
    };
  }

  const percent = yearlySavingPercent(plan);
  const equivalent = monthlyEquivalentMinorUnits(plan) ?? Math.round(entry.amountMinorUnits / 12);
  const annualAmount = formatUsd(entry.amountMinorUnits);
  return {
    amount: formatUsd(equivalent),
    period,
    note: `Billed annually: ${annualAmount} upfront`,
    annualAmount,
    saving: percent === null ? null : `Save ${percent}%`,
    priceKey: entry.key,
  };
}
