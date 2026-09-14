import { expect, test } from "@playwright/test";
import { openBillingPage, readBillingStatus } from "../utils/billing";

/**
 * The middle tier on the billing surface.
 *
 * STARTER_USER exists so a limit or a label can be shown to have moved *with* the plan rather than
 * being hard-coded — something a Free/Pro pair can never prove. Here that applies to the plan
 * cards: the capacities on each card come from the entitlement matrix, so the Starter card must
 * quote Starter's numbers to a Starter user and to everyone else alike, while only the *current*
 * marker moves.
 *
 * Like every persona spec, it changes nobody's plan and touches no Stripe object.
 */
test.describe("STARTER billing", () => {
  test("reports the seeded plan", async ({ page }) => {
    const status = await readBillingStatus(page);

    expect(status.plan).toBe("STARTER");
    expect(status.subscription).toBeNull();
    expect(status.canChangePlan).toBe(false);
  });

  test("marks Starter current while still quoting every plan's own capacities", async ({
    page,
  }) => {
    await openBillingPage(page);

    await expect(page.getByTestId("billing-plan")).toHaveText("Starter");
    await expect(page.getByTestId("plan-card-STARTER")).toHaveAttribute(
      "data-current",
      "true",
    );
    await expect(page.getByTestId("plan-action-STARTER")).toBeDisabled();
    await expect(page.getByTestId("plan-current-badge")).toHaveCount(1);

    // The matrix, on the cards: 10 / 50 / 100 stocks and 1 / 3 / 10 active monitors.
    await expect(page.getByTestId("plan-features-FREE")).toContainText(
      "Up to 10 stocks per list",
    );
    await expect(page.getByTestId("plan-features-STARTER")).toContainText(
      "Up to 50 stocks per list",
    );
    await expect(page.getByTestId("plan-features-PRO")).toContainText(
      "Up to 100 stocks per list",
    );
    await expect(page.getByTestId("plan-features-FREE")).toContainText(
      "1 active monitor",
    );
    await expect(page.getByTestId("plan-features-STARTER")).toContainText(
      "3 active monitors",
    );
    await expect(page.getByTestId("plan-features-PRO")).toContainText(
      "10 active monitors",
    );
  });

  test("agrees with the entitlements endpoint about what Starter is", async ({
    page,
  }) => {
    // The boundary, from the browser: the card's numbers and the resolver's numbers are the same
    // structure, so a page that drifted from the matrix would disagree here.
    const response = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001"}/entitlements`,
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      plan: string;
      entitlements: {
        lists: { maxSymbols: number };
        monitors: { maxActive: number };
        backtests: { maxHistoricalYears: number };
      };
    };

    expect(body.plan).toBe("STARTER");

    await openBillingPage(page);
    const card = page.getByTestId("plan-features-STARTER");
    await expect(card).toContainText(
      `Up to ${body.entitlements.lists.maxSymbols} stocks per list`,
    );
    await expect(card).toContainText(
      `${body.entitlements.monitors.maxActive} active monitors`,
    );
    await expect(card).toContainText(
      `Backtests over ${body.entitlements.backtests.maxHistoricalYears} years of history`,
    );
  });
});
