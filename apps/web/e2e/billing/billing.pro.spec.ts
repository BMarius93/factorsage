import { expect, test } from "@playwright/test";
import { openBillingPage, readBillingStatus } from "../utils/billing";

/**
 * What a paying-tier persona sees on the billing surface.
 *
 * PRO_USER is `plan=PRO` because it is seeded that way, **not** because it has a Stripe
 * subscription — `docs/decisions/stripe-billing-v1.md` section 29 requires QA personas to keep
 * working without real purchases, and the persona matrix predates billing. That makes this spec
 * the one that proves a deliberate and easily-broken property: the plan a user is entitled to comes
 * from `User.plan` alone, so the product works for an account with no biller attached at all.
 *
 * A regression here would look like the billing page refusing to render, or claiming PRO_USER is
 * FREE, the moment Stripe became involved.
 */
test.describe("PRO billing", () => {
  test("reports the seeded plan with no Stripe subscription behind it", async ({
    page,
  }) => {
    const status = await readBillingStatus(page);

    expect(status.plan).toBe("PRO");
    // No purchase was ever made, so there is nothing to mirror and nothing to manage.
    expect(status.subscription).toBeNull();
    expect(status.canOpenPortal).toBe(false);
    expect(status.canChangePlan).toBe(false);
  });

  test("shows the current plan and still offers the catalog", async ({
    page,
  }) => {
    await openBillingPage(page);

    await expect(page.getByTestId("billing-plan")).toHaveText("Pro");
    await expect(page.getByTestId("billing-catalog")).toBeVisible();
    // No subscription means no renewal date and no scheduled state to show.
    await expect(page.getByTestId("billing-period-end")).toHaveCount(0);
    await expect(page.getByTestId("billing-cancel-scheduled")).toHaveCount(0);
    await expect(page.getByTestId("billing-pending-change")).toHaveCount(0);
  });

  test("keeps entitlements independent of billing", async ({ page }) => {
    // The boundary, from the browser: entitlements answer PRO from the plan column while billing
    // reports no subscription at all.
    const billing = await readBillingStatus(page);
    const response = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001"}/entitlements`,
    );
    expect(response.ok()).toBe(true);
    const entitlements = (await response.json()) as {
      plan: string;
      entitlements: { tier: string };
    };

    expect(billing.plan).toBe("PRO");
    expect(entitlements.plan).toBe("PRO");
    expect(entitlements.entitlements.tier).toBe("PRO");
    expect(billing.subscription).toBeNull();
  });

  test("refuses a plan change with no subscription to change", async ({
    page,
  }) => {
    const status = await readBillingStatus(page);
    test.skip(!status.billingEnabled, "Stripe billing is not configured here");

    const response = await page.request.post(
      `${process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001"}/billing/change`,
      { data: { priceKey: "STARTER_MONTHLY" }, failOnStatusCode: false },
    );
    expect(response.status()).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "BILLING_NO_SUBSCRIPTION",
    );
    // A refused change never moves the plan.
    expect((await readBillingStatus(page)).plan).toBe("PRO");
  });
});
