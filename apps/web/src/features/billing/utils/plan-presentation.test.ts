import {
  BILLING_CATALOG,
  PAID_PLANS,
  PLAN_ENTITLEMENTS,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  PLAN_CARD_ORDER,
  planFeatures,
  planPricing,
  yearlySavingMinorUnits,
} from "./plan-presentation";

/**
 * The property that matters here is not "the card says 50 stocks" — it is that the card says
 * whatever the entitlement matrix says, so the two cannot drift.
 *
 * Every assertion below therefore reads its expected value out of `PLAN_ENTITLEMENTS` or
 * `BILLING_CATALOG` rather than restating it. A test that hard-coded the numbers would agree with
 * a page that hard-coded the same numbers, and the one bug this file exists to catch — a matrix
 * change that the pricing page did not follow — would pass.
 */

describe("plan presentation", () => {
  it("offers exactly the three commercial plans, cheapest first", () => {
    expect(PLAN_CARD_ORDER).toEqual(["FREE", "STARTER", "PRO"]);
  });

  it("quotes every capacity from the entitlement matrix", () => {
    for (const plan of PLAN_CARD_ORDER) {
      const entitlements = PLAN_ENTITLEMENTS[plan];
      const text = planFeatures(plan)
        .map((feature) => feature.label)
        .join(" | ");

      expect(text).toContain(`${entitlements.lists.maxSymbols} stocks per list`);
      expect(text).toContain(
        `${entitlements.backtests.maxHistoricalYears} years of history`,
      );
      expect(text).toContain(
        `${entitlements.backtests.maxConcurrentRuns} backtest`,
      );
      expect(text).toContain(`${entitlements.monitors.maxActive} active monitor`);
    }
  });

  it("says unlimited where the matrix says unbounded rather than printing a number", () => {
    // Saved Lists and Strategies are `null` for every authenticated plan by explicit decision.
    for (const plan of PLAN_CARD_ORDER) {
      expect(PLAN_ENTITLEMENTS[plan].lists.maxSaved).toBeNull();
      expect(
        planFeatures(plan).some(
          (feature) => feature.label === "Unlimited lists and strategies",
        ),
      ).toBe(true);
    }
  });

  it("gives every card the same rows in the same order, so the cards compare", () => {
    const rows = planFeatures("FREE").map((feature) => feature.id);
    for (const plan of PLAN_CARD_ORDER) {
      expect(planFeatures(plan).map((feature) => feature.id)).toEqual(rows);
    }
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("pluralises a capacity of one", () => {
    // FREE is 1 concurrent run and 1 active monitor in the matrix; both must read as singular.
    expect(PLAN_ENTITLEMENTS.FREE.backtests.maxConcurrentRuns).toBe(1);
    const labels = planFeatures("FREE").map((feature) => feature.label);
    expect(labels).toContain("1 backtest at a time");
    expect(labels).toContain("1 active monitor");
    expect(planFeatures("PRO").map((feature) => feature.label)).toContain(
      "2 backtests at a time",
    );
  });

  it("prices each plan from the shared Stripe catalog, per cadence", () => {
    for (const plan of PAID_PLANS) {
      for (const interval of ["MONTH", "YEAR"] as const) {
        const pricing = planPricing(plan, interval);
        const key = `${plan}_${interval === "MONTH" ? "MONTHLY" : "YEARLY"}` as const;
        const entry = BILLING_CATALOG[key];

        expect(pricing.priceKey).toBe(entry.key);
        expect(pricing.amount).toBe(`$${entry.amountMinorUnits / 100}`);
        expect(pricing.period).toBe(interval === "MONTH" ? "/ month" : "/ year");
      }
    }
  });

  it("prices Free at zero with no Stripe price behind it", () => {
    for (const interval of ["MONTH", "YEAR"] as const) {
      const pricing = planPricing("FREE", interval);
      expect(pricing.amount).toBe("$0");
      // There is no Stripe Price for Free, and a card that offered one would be selling a
      // cancellation.
      expect(pricing.priceKey).toBeNull();
    }
  });

  it("derives the annual saving from the two published prices", () => {
    for (const plan of PAID_PLANS) {
      const monthly = BILLING_CATALOG[`${plan}_MONTHLY`].amountMinorUnits;
      const yearly = BILLING_CATALOG[`${plan}_YEARLY`].amountMinorUnits;
      const saving = yearlySavingMinorUnits(plan);

      expect(saving).toBe(monthly * 12 - yearly);
      expect(planPricing(plan, "YEAR").note).toBe(
        `Billed annually · save $${(saving ?? 0) / 100}`,
      );
    }
  });

  it("keeps the catalog amounts the decision document fixes", () => {
    // The one place literals are written down on purpose: if this and the derivation above ever
    // disagree, the catalog moved and somebody must decide whether that was intended.
    expect(planPricing("STARTER", "MONTH").amount).toBe("$9");
    expect(planPricing("STARTER", "YEAR").amount).toBe("$99");
    expect(planPricing("PRO", "MONTH").amount).toBe("$29");
    expect(planPricing("PRO", "YEAR").amount).toBe("$299");
  });
});
