import { expect, test } from "../fixtures";
import {
  attemptCheckout,
  openBillingPage,
  readBillingStatus,
} from "../utils/billing";

/**
 * What a FREE user sees and can do on the billing surface.
 *
 * FREE_USER is the persona with nothing bought, so it is the one that proves the purchase path
 * exists, that the four catalog options are offered, and — the part worth a browser test — that a
 * crafted request cannot buy something the catalog does not sell.
 *
 * No Stripe-hosted page is opened. The checkout button's job here is to reach the API and come back
 * with a Stripe URL; whether Stripe renders it is Stripe's problem and the sandbox smoke suite's.
 */
test.describe("FREE billing", () => {
  test("reports FREE with no subscription and a purchase path", async ({
    page,
  }) => {
    const status = await readBillingStatus(page);

    expect(status.plan).toBe("FREE");
    // No subscription and nothing to change are the persona invariants. `canOpenPortal` is
    // deliberately not asserted: it tracks whether a Stripe Customer exists, which is a billing
    // footprint a manual sandbox session could legitimately have left on this shared account.
    expect(status.subscription).toBeNull();
    expect(status.canChangePlan).toBe(false);
    expect(status.catalog.map((entry) => entry.key)).toEqual([
      "STARTER_MONTHLY",
      "STARTER_YEARLY",
      "PRO_MONTHLY",
      "PRO_YEARLY",
    ]);
  });

  test("compares three plans, marks Free as current, and offers no billing management", async ({
    page,
  }) => {
    await openBillingPage(page);

    await expect(page.getByTestId("billing-plan")).toHaveText("Free");
    for (const plan of ["FREE", "STARTER", "PRO"]) {
      await expect(page.getByTestId(`plan-card-${plan}`)).toBeVisible();
    }
    // Three plans, three cards. Monthly and yearly are a property of a plan, not two products.
    await expect(page.getByTestId("billing-catalog")).toBeVisible();
    await expect(page.locator('[data-testid^="plan-card-"]')).toHaveCount(3);

    await expect(page.getByTestId("plan-card-FREE")).toHaveAttribute(
      "data-current",
      "true",
    );
    await expect(page.getByTestId("plan-action-FREE")).toBeDisabled();
    await expect(page.getByTestId("plan-action-STARTER")).toHaveText(
      "Upgrade to Starter",
    );
    await expect(page.getByTestId("plan-action-PRO")).toHaveText("Upgrade to Pro");
    await expect(page.getByTestId("manage-billing")).toHaveCount(0);
  });

  test("re-prices the same three cards when the cadence changes", async ({ page }) => {
    await openBillingPage(page);

    await expect(page.getByTestId("plan-price-STARTER")).toContainText("$9");
    await expect(page.getByTestId("plan-price-PRO")).toContainText("$29");
    await expect(page.getByTestId("plan-action-STARTER")).toHaveAttribute(
      "data-price-key",
      "STARTER_MONTHLY",
    );

    await page.getByRole("radio", { name: "Yearly" }).check();

    await expect(page.getByTestId("plan-price-STARTER")).toContainText("$99");
    await expect(page.getByTestId("plan-price-PRO")).toContainText("$299");
    await expect(page.locator('[data-testid^="plan-card-"]')).toHaveCount(3);
    // The displayed cadence and the price the button will send must always agree.
    await expect(page.getByTestId("plan-action-STARTER")).toHaveAttribute(
      "data-price-key",
      "STARTER_YEARLY",
    );
    await expect(page.getByTestId("plan-action-PRO")).toHaveAttribute(
      "data-price-key",
      "PRO_YEARLY",
    );
  });

  test("keeps the cadence control keyboard-operable and semantically selected", async ({
    page,
  }) => {
    await openBillingPage(page);

    const monthly = page.getByRole("radio", { name: "Monthly" });
    const yearly = page.getByRole("radio", { name: "Yearly" });
    await expect(monthly).toBeChecked();

    await monthly.focus();
    await page.keyboard.press("ArrowRight");

    await expect(yearly).toBeChecked();
    await expect(monthly).not.toBeChecked();
    await expect(page.getByTestId("plan-price-PRO")).toContainText("$299");
  });

  test("stacks the plans on a phone without overflowing sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBillingPage(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // One column: every card starts at the same x, so they stack rather than squeezing side by side.
    const lefts = await page
      .locator('[data-testid^="plan-card-"]')
      .evaluateAll((cards) =>
        cards.map((card) => Math.round(card.getBoundingClientRect().x)),
      );
    expect(lefts).toHaveLength(3);
    expect(new Set(lefts).size).toBe(1);
    await expect(page.getByRole("radio", { name: "Yearly" })).toBeVisible();
  });

  test("reaches billing from the account menu", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("account-menu-trigger").click();
    await page.getByTestId("account-billing-link").click();
    await expect(page.getByTestId("billing-plan")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("refuses a crafted price, plan or role in a checkout request", async ({
    page,
  }) => {
    // Runs with or without Stripe configured: the envelope is rejected in the controller before any
    // billing service or Stripe call is reached, which is the point — a crafted field never gets far
    // enough to matter.
    for (const body of [
      { priceId: "price_live_pro_299" },
      { stripePriceId: "price_live_pro_299" },
      { priceKey: "PRO_MONTHLY", priceId: "price_live_pro_299" },
      { priceKey: "PRO_MONTHLY", plan: "PRO" },
      { priceKey: "PRO_MONTHLY", role: "ADMIN" },
      { priceKey: "PRO_MONTHLY", customerId: "cus_someone_else" },
      { priceKey: "PRO_MONTHLY", successUrl: "https://evil.test/granted" },
      { priceKey: "PRO_PLUS_MONTHLY" },
      { priceKey: "price_1234" },
      {},
    ]) {
      const result = await attemptCheckout(page, body);
      expect(
        result.status,
        `checkout accepted ${JSON.stringify(body)}`,
      ).toBe(400);
    }

    // And none of it moved the plan.
    expect((await readBillingStatus(page)).plan).toBe("FREE");
  });

  test("does not grant a plan by returning from checkout", async ({ page }) => {
    // The whole point of the redirect not being authoritative: a user who abandoned Checkout — or
    // who simply typed this URL — is still FREE, and the page says so.
    await page.goto("/billing?checkout=success");
    await expect(page.getByTestId("checkout-success-notice")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("billing-plan")).toHaveText("Free", {
      timeout: 20_000,
    });
    expect((await readBillingStatus(page)).plan).toBe("FREE");
  });

  test("reports a cancelled checkout as having changed nothing", async ({
    page,
  }) => {
    await page.goto("/billing?checkout=cancelled");
    await expect(page.getByTestId("checkout-cancelled-notice")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("billing-plan")).toHaveText("Free");
  });

  test("sends only a catalog key to checkout and navigates to the URL it gets back", async ({
    page,
  }) => {
    // **The checkout call itself is stubbed, deliberately.** Letting it reach the API would create a
    // real Stripe Customer for this persona, which would both give the shared FREE_USER account a
    // billing footprint the next run inherits and make the normal suite depend on Stripe — the two
    // things `docs/decisions/stripe-billing-v1.md` section 27 rules out. What this proves is the half
    // that belongs to the browser: the page sends nothing but a logical price key, and it navigates
    // to whatever URL the server hands back rather than deciding anything itself. Real hosted
    // Checkout is exercised by the sandbox runbook in `ai/architecture/billing.md`.
    const stubUrl = "https://checkout.stripe.com/c/pay/cs_test_stub";
    let sentBody: unknown = null;

    await page.route("**/billing/checkout", async (route) => {
      sentBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ checkoutUrl: stubUrl }),
      });
    });
    await page.route("https://checkout.stripe.com/**", (route) =>
      route.fulfill({ status: 200, body: "stripe checkout stub" }),
    );

    await openBillingPage(page);
    await page.getByTestId("plan-action-STARTER").click();

    await expect
      .poll(() => sentBody, { timeout: 20_000 })
      .toEqual({ priceKey: "STARTER_MONTHLY" });
    await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(stubUrl);

    // And nothing about arriving at Checkout granted anything.
    await page.unroute("**/billing/checkout");
    expect((await readBillingStatus(page)).plan).toBe("FREE");
  });
});
