import { expect, test } from "../fixtures";
import { qaPersona } from "../utils/env";
import { openAccountMenu } from "../utils/sign-in";

test.describe("PRO_USER session @smoke", () => {
  test("keeps an authenticated session across navigations", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
  });

  test("shows the signed-in identity and plan, and no internal role", async ({ page }) => {
    await page.goto("/dashboard");
    await openAccountMenu(page);

    await expect(page.getByTestId("account-email")).toHaveText(
      qaPersona("PRO_USER").email,
    );
    await expect(page.getByTestId("account-plan")).toHaveText("Pro");
    await expect(page.getByTestId("account-role")).toHaveCount(0);
  });

  test("cannot reach the ADMIN-only route", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.getByTestId("auth-forbidden")).toBeVisible();
    await expect(page.getByTestId("admin-page")).toHaveCount(0);
  });
});
