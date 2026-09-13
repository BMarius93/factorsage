import { expect, test, type Page } from "@playwright/test";

/**
 * The new-password input, matched exactly.
 *
 * `getByLabel` substring-matches, and the auth card labels its own region with the page heading —
 * "Choose a new password" — which contains "new password". Without `exact` the locator picks up
 * the region as well as the field.
 */
function newPasswordField(page: Page) {
  return page.getByLabel("New password", { exact: true });
}

/**
 * Anonymous password recovery, end to end through the real API.
 *
 * The one thing a browser suite cannot do is read the inbox, so the redeemable half of the flow
 * is covered by `apps/api/src/auth/password-reset.integration.test.ts`, which reads the token out
 * of the captured message. What is proven here is what a person actually sees: the route from
 * sign-in, the neutral response that refuses to confirm whether an address has an account, and
 * the two ways a link can be unusable.
 */
test.describe("guest password recovery @smoke", () => {
  test("reaches the reset request from the sign-in page", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot your password?" }).click();

    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("answers an address with no account exactly as it answers any other", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page
      .getByLabel("Email")
      .fill(`absent-${Date.now()}@example.test`);
    await page.getByRole("button", { name: "Send reset link" }).click();

    // Neutral by design: the page must not become the account directory the API refuses to be.
    const confirmation = page.getByTestId("forgot-password-sent");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("If that address has");
    await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  });

  test("asks for a link when the reset page is opened without one", async ({
    page,
  }) => {
    await page.goto("/reset-password");

    await expect(page.getByTestId("reset-password-missing-token")).toBeVisible();
    // Exact, because the card's own heading ("Choose a new password") is an accessible label
    // that a substring match would also hit.
    await expect(newPasswordField(page)).toHaveCount(0);
    await page.getByRole("link", { name: "Request a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test("refuses a reset token that was never issued", async ({ page }) => {
    await page.goto("/reset-password?token=not-a-real-reset-token");

    const password = "Replacement-test-password-42";
    await newPasswordField(page).fill(password);
    await page.getByLabel("Confirm new password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByTestId("reset-password-error")).toBeVisible();
    await expect(page.getByTestId("reset-password-success")).toHaveCount(0);
    // A failed reset is not a sign-in.
    await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  });
});
