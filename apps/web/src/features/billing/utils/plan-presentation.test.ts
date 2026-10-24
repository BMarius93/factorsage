import {
  BILLING_CATALOG,
  OFFERED_BILLING_INTERVALS,
  PAID_PLANS,
  PLAN_ENTITLEMENTS,
  USER_PLANS,
  findBillingPriceKey,
  type EntitlementLimit,
  type UserPlan,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { PLAN_LABEL } from "./format";
import {
  NOT_INCLUDED,
  PLAN_CARD_ORDER,
  PLAN_TAGLINE,
  RECOMMENDED_BADGE,
  RECOMMENDED_PLAN,
  UNLIMITED_MONITORS_FOOTNOTE,
  displayedInterval,
  formatUsd,
  monthlyEquivalentMinorUnits,
  offersIntervalChoice,
  planFeatures,
  planPricing,
  plansCaption,
  premiumPlans,
  yearlySavingMinorUnits,
  yearlySavingPercent,
  yearlySavingTag,
} from "./plan-presentation";

/** A matrix number as a card prints it: `1000` -> `1,000`, unbounded -> `Unlimited`. */
const quoted = (limit: EntitlementLimit) =>
  limit === null ? "Unlimited" : limit.toLocaleString("en-US");

const rowOf = (plan: UserPlan, id: string) => {
  const row = planFeatures(plan).find((feature) => feature.id === id);
  if (!row) {
    throw new Error(`No ${id} row on ${plan}`);
  }
  return row;
};

/** The plans whose matrix entry includes premium content at all. */
const includingPlans = () =>
  PLAN_CARD_ORDER.filter((plan) => PLAN_ENTITLEMENTS[plan].builtInContent.canUsePremium);

/** Every string the comparison can show: caption, badge, footnote, taglines and every row. */
const everythingSaid = () => [
  plansCaption(),
  RECOMMENDED_BADGE,
  UNLIMITED_MONITORS_FOOTNOTE,
  ...PLAN_CARD_ORDER.flatMap((plan) => [
    PLAN_TAGLINE[plan],
    ...planFeatures(plan).flatMap((feature) => [feature.label, feature.detail ?? ""]),
  ]),
];

/**
 * The property that matters here is not "the card says 50 stocks" — it is that the card says
 * whatever the entitlement matrix says, so the two cannot drift.
 *
 * Every assertion below therefore reads its expected value out of `PLAN_ENTITLEMENTS` or
 * `BILLING_CATALOG` rather than restating it. A test that hard-coded the numbers would agree with
 * a page that hard-coded the same numbers, and the one bug this file exists to catch — a matrix
 * change that the pricing page did not follow — would pass. The few literal tests are marked as
 * such: they pin the decision itself, so a matrix or catalog edit is noticed by somebody.
 */

describe("plan presentation", () => {
  it("offers exactly the four commercial plans, cheapest first", () => {
    expect(PLAN_CARD_ORDER).toEqual(["FREE", "STARTER", "PRO", "PRO_PLUS"]);
    // No plan a user can be on is left out of the comparison.
    expect([...PLAN_CARD_ORDER].sort()).toEqual([...USER_PLANS].sort());
    expect(PLAN_CARD_ORDER.map((plan) => PLAN_LABEL[plan])).toEqual([
      "Free",
      "Starter",
      "Pro",
      "Pro+",
    ]);
  });

  it("quotes every capacity from the entitlement matrix", () => {
    for (const plan of PLAN_CARD_ORDER) {
      const { lists, backtests, monitors } = PLAN_ENTITLEMENTS[plan];

      expect(rowOf(plan, "list-symbols").label).toContain(
        `${quoted(lists.maxSymbols)} stocks per list`,
      );
      expect(rowOf(plan, "backtest-symbols").label).toContain(
        `${quoted(backtests.maxSymbols)} stocks per backtest`,
      );
      expect(rowOf(plan, "monitors").label).toContain(
        `${quoted(monitors.maxActive)} active monitor`,
      );
      const history = rowOf(plan, "backtest-history");
      expect(history.label).toBe(
        backtests.maxHistoricalYears === null
          ? "Backtest periods of any length"
          : `Backtests up to ${quoted(backtests.maxHistoricalYears)} years long`,
      );
      expect(history.detail).toBe("Subject to data availability");
    }
  });

  it("says unlimited where the matrix says unbounded rather than printing a number", () => {
    for (const plan of PLAN_CARD_ORDER) {
      const entitlements = PLAN_ENTITLEMENTS[plan];
      // Saved Lists and Strategies are `null` for every authenticated plan by explicit decision.
      expect(entitlements.lists.maxSaved).toBeNull();
      expect(rowOf(plan, "saved-content").label).toBe("Unlimited lists and strategies");
      // The matrix carries no quota on how many backtests a plan may run in total.
      expect(rowOf(plan, "backtest-count").label).toBe("Unlimited backtests");

      const monitors = rowOf(plan, "monitors");
      if (entitlements.monitors.maxActive === null) {
        // No plan cap, which is not a promise of unlimited infrastructure: the asterisk points at
        // the fair-use footnote under the comparison.
        expect(monitors.label).toBe("Unlimited active monitors*");
        expect(monitors.detail).toBe("*No plan cap. Fair use applies.");
      } else {
        expect(monitors.label).not.toMatch(/Unlimited|\*/);
        expect(monitors.detail).toBeNull();
      }
    }
    expect(UNLIMITED_MONITORS_FOOTNOTE).toMatch(/^Unlimited active monitors means no plan cap/);
    expect(UNLIMITED_MONITORS_FOOTNOTE).toContain("it is not a plan limit");
  });

  it("gives every card the same rows in the same order, so the cards compare", () => {
    const rows = planFeatures("FREE").map((feature) => feature.id);
    expect(rows).toEqual([
      "list-symbols",
      "backtest-symbols",
      "backtest-concurrency",
      "monitors",
      "backtest-count",
      "backtest-history",
      "saved-content",
      "strategy-builder",
      "etf-conditions",
      "premium-content",
    ]);
    for (const plan of PLAN_CARD_ORDER) {
      expect(planFeatures(plan).map((feature) => feature.id)).toEqual(rows);
    }
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("pluralises a capacity of one", () => {
    // FREE is 1 concurrent run and 1 active monitor in the matrix; both must read as singular.
    expect(PLAN_ENTITLEMENTS.FREE.backtests.maxConcurrentRuns).toBe(1);
    expect(PLAN_ENTITLEMENTS.FREE.monitors.maxActive).toBe(1);
    expect(rowOf("FREE", "backtest-concurrency").label).toBe("1 backtest at a time");
    expect(rowOf("FREE", "monitors").label).toBe("1 active monitor");
    expect(rowOf("STARTER", "monitors").label).toBe(
      `${quoted(PLAN_ENTITLEMENTS.STARTER.monitors.maxActive)} active monitors`,
    );
  });

  it("advertises Parallel Backtests exactly where more than one run may execute at once", () => {
    for (const plan of PLAN_CARD_ORDER) {
      const limit = PLAN_ENTITLEMENTS[plan].backtests.maxConcurrentRuns;
      const row = rowOf(plan, "backtest-concurrency");

      expect(row.included).toBe(true);
      if (limit !== null && limit > 1) {
        expect(row.label).toBe(`Parallel Backtests: ${quoted(limit)} at a time`);
        // How many at once, and never faster: every run shares the one fair queue.
        expect(row.detail).toContain(
          `Up to ${quoted(limit)} of your backtests run at the same time`,
        );
        expect(row.detail).toContain("same execution capacity and fair queue");
      } else {
        expect(row.label).toBe(`${quoted(limit)} backtest${limit === 1 ? "" : "s"} at a time`);
        expect(row.detail).toBeNull();
      }
    }
  });

  it("states the Strategy Builder and ETF conditions on every card, from the matrix", () => {
    for (const plan of PLAN_CARD_ORDER) {
      const all = PLAN_ENTITLEMENTS[plan].strategies.analyticalPrimitives === "ALL";
      for (const id of ["strategy-builder", "etf-conditions"]) {
        expect(rowOf(plan, id).included, `${plan} ${id}`).toBe(all);
        expect(rowOf(plan, id).detail, `${plan} ${id}`).toBe(all ? null : NOT_INCLUDED);
      }
    }
  });

  it("never promises priority, speed or a guaranteed run time", () => {
    // Plans differ by capacity and premium content, never by speed: every run on every plan shares
    // one execution capacity in one fair queue (`ai/architecture/backtest-execution.md`).
    for (const text of everythingSaid()) {
      expect(text).not.toMatch(/\b(priority|faster|guaranteed)\b/i);
    }
  });

  it("reads every row the decision document fixes, card by card", () => {
    // Literals on purpose, like the catalog amounts below: the derivations above prove the cards
    // follow the matrix, and this proves the matrix is still the one that was decided — thousands
    // separators included.
    const labels = (plan: UserPlan) => planFeatures(plan).map((feature) => feature.label);
    const shared = [
      "Unlimited backtests",
      "Backtests up to 30 years long",
      "Unlimited lists and strategies",
      "Full Strategy Builder",
      "ETF and sector conditions",
      "Premium lists, strategies and point-in-time universes",
    ];

    expect(labels("FREE")).toEqual([
      "Up to 10 stocks per list",
      "Up to 10 stocks per backtest",
      "1 backtest at a time",
      "1 active monitor",
      ...shared,
    ]);
    expect(labels("STARTER")).toEqual([
      "Up to 50 stocks per list",
      "Up to 50 stocks per backtest",
      "1 backtest at a time",
      "5 active monitors",
      ...shared,
    ]);
    expect(labels("PRO")).toEqual([
      "Up to 750 stocks per list",
      "Up to 750 stocks per backtest",
      "1 backtest at a time",
      "Unlimited active monitors*",
      ...shared,
    ]);
    expect(labels("PRO_PLUS")).toEqual([
      "Up to 1,000 stocks per list",
      "Up to 1,000 stocks per backtest",
      "Parallel Backtests: 2 at a time",
      "Unlimited active monitors*",
      ...shared,
    ]);
    expect(rowOf("PRO_PLUS", "backtest-concurrency").detail).toBe(
      "Up to 2 of your backtests run at the same time. Every run shares the same execution " +
        "capacity and fair queue as every other plan.",
    );
  });

  describe("emphasis", () => {
    it("recommends Pro, with the Best Value badge", () => {
      expect(RECOMMENDED_PLAN).toBe("PRO");
      expect(RECOMMENDED_BADGE).toBe("Best Value");
      expect(PLAN_CARD_ORDER).toContain(RECOMMENDED_PLAN);
    });

    it("gives every card its own tagline, and names Pro+ the advanced tier", () => {
      for (const plan of PLAN_CARD_ORDER) {
        expect(PLAN_TAGLINE[plan].trim(), plan).not.toBe("");
      }
      expect(new Set(PLAN_CARD_ORDER.map((plan) => PLAN_TAGLINE[plan])).size).toBe(
        PLAN_CARD_ORDER.length,
      );
      expect(PLAN_TAGLINE.PRO_PLUS).toBe("Advanced Research");
    });
  });

  describe("prices", () => {
    it("sells both cadences of every paid plan, so there is a cadence to choose", () => {
      expect(OFFERED_BILLING_INTERVALS).toEqual(["MONTH", "YEAR"]);
      expect(offersIntervalChoice()).toBe(true);
      for (const plan of PAID_PLANS) {
        expect(findBillingPriceKey(plan, "MONTH")).toBe(`${plan}_MONTHLY`);
        expect(findBillingPriceKey(plan, "YEAR")).toBe(`${plan}_YEARLY`);
      }
    });

    it("prices each paid plan from the shared Stripe catalog, per month", () => {
      for (const plan of PAID_PLANS) {
        const pricing = planPricing(plan, "MONTH");
        const entry = BILLING_CATALOG[`${plan}_MONTHLY`];

        expect(pricing.priceKey).toBe(entry.key);
        expect(pricing.amount).toBe(formatUsd(entry.amountMinorUnits));
        expect(pricing.period).toBe("/ month");
        expect(pricing.note).toBe("Billed monthly");
        expect(pricing.annualAmount).toBeNull();
        expect(pricing.saving).toBeNull();
      }
    });

    it("prices each paid plan yearly as its effective monthly cost, billed upfront as the exact annual amount", () => {
      for (const plan of PAID_PLANS) {
        const pricing = planPricing(plan, "YEAR");
        const entry = BILLING_CATALOG[`${plan}_YEARLY`];

        // The button buys the yearly price — the amount on the card is never what is sent.
        expect(pricing.priceKey).toBe(entry.key);
        expect(pricing.amount).toBe(formatUsd(Math.round(entry.amountMinorUnits / 12)));
        expect(pricing.period).toBe("/ month");
        expect(pricing.annualAmount).toBe(formatUsd(entry.amountMinorUnits));
        expect(pricing.note).toBe(`Billed annually: ${formatUsd(entry.amountMinorUnits)} upfront`);
        expect(pricing.saving).toBe(`Save ${yearlySavingPercent(plan)}%`);
      }
    });

    it("never presents a yearly price as a monthly charge", () => {
      // The large figure is per month for comparison; the line under it must say that the whole
      // annual amount is charged, once, upfront (docs/legal/implementation-spec.md §6).
      for (const plan of PAID_PLANS) {
        const { note, annualAmount } = planPricing(plan, "YEAR");
        expect(annualAmount).not.toBeNull();
        expect(note).toContain(annualAmount);
        expect(note).toMatch(/annually/);
        expect(note).toMatch(/upfront/);
        expect(note).not.toMatch(/month/);
      }
    });

    it("prices Free at zero with no Stripe price behind it", () => {
      for (const interval of OFFERED_BILLING_INTERVALS) {
        const pricing = planPricing("FREE", interval);
        expect(pricing.amount).toBe("$0");
        expect(pricing.period).toBe("/ month");
        expect(pricing.note).toBe("Free forever");
        expect(pricing.annualAmount).toBeNull();
        expect(pricing.saving).toBeNull();
        // There is no Stripe Price for Free, and a card that offered one would be selling a
        // cancellation.
        expect(pricing.priceKey).toBeNull();
      }
    });

    it("keeps the catalog amounts the decision document fixes", () => {
      // The one place amounts are written down on purpose: if this and the derivation above ever
      // disagree, the catalog moved and somebody must decide whether that was intended.
      expect(planPricing("STARTER", "MONTH").amount).toBe("$19");
      expect(planPricing("PRO", "MONTH").amount).toBe("$49");
      expect(planPricing("PRO_PLUS", "MONTH").amount).toBe("$199");
      expect(planPricing("STARTER", "YEAR").annualAmount).toBe("$169");
      expect(planPricing("PRO", "YEAR").annualAmount).toBe("$439");
      expect(planPricing("PRO_PLUS", "YEAR").annualAmount).toBe("$1,790");
      // The effective monthly costs the owner published.
      expect(planPricing("STARTER", "YEAR").amount).toBe("$14.08");
      expect(planPricing("PRO", "YEAR").amount).toBe("$36.58");
      expect(planPricing("PRO_PLUS", "YEAR").amount).toBe("$149.17");
    });

    it("claims the annual saving the published prices give, rounded down", () => {
      // Literal: 12 × $19 − $169, 12 × $49 − $439, 12 × $199 − $1,790.
      expect(yearlySavingMinorUnits("STARTER")).toBe(5_900);
      expect(yearlySavingMinorUnits("PRO")).toBe(14_900);
      expect(yearlySavingMinorUnits("PRO_PLUS")).toBe(59_800);
      // 25.88%, 25.34% and 25.04%: every plan saves at least 25%, and none is shown more.
      for (const plan of PAID_PLANS) {
        const twelveMonths = BILLING_CATALOG[`${plan}_MONTHLY`].amountMinorUnits * 12;
        const exact =
          ((twelveMonths - BILLING_CATALOG[`${plan}_YEARLY`].amountMinorUnits) * 100) /
          twelveMonths;
        expect(yearlySavingPercent(plan)).toBe(25);
        expect(yearlySavingPercent(plan)).toBeLessThanOrEqual(exact);
        expect(yearlySavingPercent(plan)).toBeGreaterThan(exact - 1);
      }
      expect(yearlySavingTag()).toBe("Save 25%");
      expect(planPricing("PRO", "YEAR").saving).toBe("Save 25%");
    });

    it("divides each yearly price by twelve, to the cent, for the effective monthly cost", () => {
      expect(monthlyEquivalentMinorUnits("STARTER")).toBe(1_408);
      expect(monthlyEquivalentMinorUnits("PRO")).toBe(3_658);
      expect(monthlyEquivalentMinorUnits("PRO_PLUS")).toBe(14_917);
    });

    it("quotes a price for every plan in every cadence the catalog sells", () => {
      // A card asked for a price fails loudly — into the route's error boundary — rather than
      // rendering `undefined` at somebody; every offered cadence must therefore resolve.
      for (const plan of PLAN_CARD_ORDER) {
        for (const interval of OFFERED_BILLING_INTERVALS) {
          expect(() => planPricing(plan, interval)).not.toThrow();
        }
      }
    });

    it("shows the cadence asked for, and monthly when nothing was", () => {
      expect(displayedInterval("MONTH")).toBe("MONTH");
      expect(displayedInterval("YEAR")).toBe("YEAR");
      expect(displayedInterval(null)).toBe("MONTH");
      expect(displayedInterval(undefined)).toBe("MONTH");
    });

    it("formats cents with the page's one money formatter", () => {
      expect(formatUsd(1900)).toBe("$19");
      expect(formatUsd(19900)).toBe("$199");
      expect(formatUsd(2492)).toBe("$24.92");
      expect(formatUsd(2490)).toBe("$24.90");
      expect(formatUsd(5)).toBe("$0.05");
      expect(formatUsd(1408)).toBe("$14.08");
      expect(formatUsd(179000)).toBe("$1,790");
      expect(formatUsd(14917)).toBe("$149.17");
    });
  });

  describe("premium content", () => {
    it("is a row on every card: included with what it covers, or marked not included", () => {
      for (const plan of PLAN_CARD_ORDER) {
        const { builtInContent, backtests } = PLAN_ENTITLEMENTS[plan];
        const row = rowOf(plan, "premium-content");

        expect(row.label).toBe("Premium lists, strategies and point-in-time universes");
        expect(row.included).toBe(builtInContent.canUsePremium);
        if (!builtInContent.canUsePremium) {
          expect(row.detail).toBe(NOT_INCLUDED);
          continue;
        }
        expect(row.detail).toContain("S&P 500 Historical PIT backtests");
        const allowance = backtests.maxIndexUniverseConstituents;
        if (allowance !== null) {
          expect(row.detail).toContain(`up to ${quoted(allowance)} index members at once`);
        }
        // The ordinary per-backtest limit is still quoted, unchanged, on its own row.
        expect(rowOf(plan, "backtest-symbols").label).toBe(
          `Up to ${quoted(backtests.maxSymbols)} stocks per backtest`,
        );
      }
    });

    it("names, above the cards, exactly the plans that include it", () => {
      const including = premiumPlans();
      expect(including).toEqual(includingPlans());
      const caption = plansCaption();
      expect(caption).not.toMatch(/Plans differ by capacity\.$/);
      for (const plan of PLAN_CARD_ORDER) {
        if (including.includes(plan)) {
          expect(caption).toContain(PLAN_LABEL[plan]);
        } else {
          expect(caption).not.toContain(PLAN_LABEL[plan]);
        }
      }
    });

    it("reads what the decision document fixes", () => {
      // Literals on purpose, as for the catalog amounts: Pro and Pro+ include premium content, each
      // measuring the point-in-time universe against its own symbol limit; Free and Starter do not.
      expect(premiumPlans()).toEqual(["PRO", "PRO_PLUS"]);
      expect(rowOf("PRO", "premium-content").detail).toBe(
        "Including S&P 500 Historical PIT backtests, up to 750 index members at once",
      );
      expect(rowOf("PRO_PLUS", "premium-content").detail).toBe(
        "Including S&P 500 Historical PIT backtests, up to 1,000 index members at once",
      );
      expect(rowOf("FREE", "premium-content").included).toBe(false);
      expect(rowOf("STARTER", "premium-content").included).toBe(false);
      expect(plansCaption()).toBe(
        "Every plan includes the full Strategy Builder, ETF and sector conditions, unlimited " +
          "backtests and backtests up to 30 years long. Plans differ by capacity, and only Pro " +
          "and Pro+ include premium content.",
      );
    });
  });
});
