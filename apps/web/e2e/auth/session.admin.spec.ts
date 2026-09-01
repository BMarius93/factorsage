import { expect, test } from "@playwright/test";
import { qaPersona } from "../utils/env";
import { openAccountMenu } from "../utils/sign-in";

test.describe("QA_ADMIN session @smoke", () => {
  test("reaches the ADMIN-only route", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.getByTestId("admin-page")).toBeVisible();
    await expect(page.getByTestId("auth-forbidden")).toHaveCount(0);
  });

  test("shows the ADMIN role in the account menu", async ({ page }) => {
    await page.goto("/dashboard");
    await openAccountMenu(page);

    await expect(page.getByTestId("account-email")).toHaveText(
      qaPersona("QA_ADMIN").email,
    );
    await expect(page.getByTestId("account-role")).toHaveText("ADMIN");
  });

  test("signing out clears the authenticated state", async ({ page }) => {
    await page.goto("/dashboard");
    await openAccountMenu(page);
    await page.getByTestId("sign-out").click();

    await expect(page).toHaveURL(/\/login$/);

    // The cleared cookie must actually end the session, not just change the view.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  });
});
