import {
  BILLING_CATALOG,
  PAID_PLANS,
  PLAN_ENTITLEMENTS,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { PLAN_LABEL } from "./format";
import {
  NOT_INCLUDED,
  PLAN_CARD_ORDER,
  formatUsd,
  indexUniversePlans,
  monthlyEquivalentMinorUnits,
  planFeatures,
  planPricing,
  plansCaption,
  yearlySavingMinorUnits,
} from "./plan-presentation";

const indexUniverseRow = (plan: (typeof PLAN_CARD_ORDER)[number]) => {
  const row = planFeatures(plan).find((feature) => feature.id === "index-universe");
  if (!row) {
    throw new Error(`No index-universe row on ${plan}`);
  }
  return row;
};

/** The plans whose matrix entry includes the point-in-time universe at all. */
const includingPlans = () =>
  PLAN_CARD_ORDER.filter(
    (plan) => PLAN_ENTITLEMENTS[plan].backtests.maxIndexUniverseConstituents !== 0,
  );

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
        `Backtest periods up to ${entitlements.backtests.maxHistoricalYears} years long`,
      );
      expect(text).toContain(
        `${entitlements.backtests.maxSymbols} stocks per backtest`,
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

  describe("monthly equivalent of a yearly price (PR-3)", () => {
    it("divides the published yearly price by twelve, rounded to the cent", () => {
      for (const plan of PAID_PLANS) {
        const yearly = BILLING_CATALOG[`${plan}_YEARLY`].amountMinorUnits;
        expect(monthlyEquivalentMinorUnits(plan)).toBe(Math.round(yearly / 12));
        expect(planPricing(plan, "YEAR").monthlyEquivalent).toBe(
          `≈ ${formatUsd(Math.round(yearly / 12))} / month`,
        );
      }
    });

    it("leaves the charged amount and its note exactly as they were", () => {
      for (const plan of PAID_PLANS) {
        const pricing = planPricing(plan, "YEAR");
        const entry = BILLING_CATALOG[`${plan}_YEARLY`];
        expect(pricing.amount).toBe(`$${entry.amountMinorUnits / 100}`);
        expect(pricing.period).toBe("/ year");
        expect(pricing.note).toMatch(/^Billed annually/);
        expect(pricing.priceKey).toBe(entry.key);
      }
    });

    it("says nothing for a monthly price or for Free", () => {
      for (const plan of PLAN_CARD_ORDER) {
        expect(planPricing(plan, "MONTH").monthlyEquivalent).toBeNull();
      }
      expect(planPricing("FREE", "YEAR").monthlyEquivalent).toBeNull();
    });

    it("reads the amounts the decision document fixes", () => {
      // $299 / 12 = $24.9166…, which rounds up; $99 / 12 is exactly $8.25.
      expect(planPricing("PRO", "YEAR").monthlyEquivalent).toBe("≈ $24.92 / month");
      expect(planPricing("STARTER", "YEAR").monthlyEquivalent).toBe("≈ $8.25 / month");
    });

    it("formats cents with the page's one money formatter", () => {
      expect(formatUsd(2492)).toBe("$24.92");
      expect(formatUsd(825)).toBe("$8.25");
      expect(formatUsd(2490)).toBe("$24.90");
      expect(formatUsd(1200)).toBe("$12");
      expect(formatUsd(5)).toBe("$0.05");
    });
  });

  describe("S&P 500 Historical PIT universe (PR-1)", () => {
    it("is a row on every card: included with its allowance, or marked not included", () => {
      for (const plan of PLAN_CARD_ORDER) {
        const allowance = PLAN_ENTITLEMENTS[plan].backtests.maxIndexUniverseConstituents;
        const row = indexUniverseRow(plan);

        expect(row.label).toBe("S&P 500 Historical PIT backtests");
        expect(row.included).toBe(allowance !== 0);
        if (allowance === 0) {
          expect(row.detail).toBe(NOT_INCLUDED);
        } else {
          expect(row.detail).toContain(`Up to ${allowance} index members at once`);
        }
      }
    });

    it("keeps the universe's allowance apart from the stocks-per-backtest limit", () => {
      for (const plan of includingPlans()) {
        expect(indexUniverseRow(plan).detail).toContain(
          "measured separately from stocks per backtest",
        );
        // The ordinary limit is still quoted, unchanged, on its own row.
        expect(planFeatures(plan).find((feature) => feature.id === "backtest-symbols")?.label).toBe(
          `Up to ${PLAN_ENTITLEMENTS[plan].backtests.maxSymbols} stocks per backtest`,
        );
      }
    });

    it("names, above the cards, exactly the plans that include it", () => {
      const including = indexUniversePlans();
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

    it("reads the allowance the decision document fixes", () => {
      // Literals on purpose, as for the catalog amounts: Pro 550, Free and Starter none
      // (`docs/decisions/sp500-historical-pit-v1.md` §5).
      expect(indexUniverseRow("PRO").detail).toBe(
        "Up to 550 index members at once, measured separately from stocks per backtest",
      );
      expect(indexUniverseRow("FREE").included).toBe(false);
      expect(indexUniverseRow("STARTER").included).toBe(false);
      expect(plansCaption()).toBe(
        "Every plan includes every indicator, valuation model and strategy feature. " +
          "Plans differ by capacity, and only Pro includes S&P 500 Historical PIT backtests.",
      );
    });
  });
});
