import { expect, test } from "../fixtures";
import { qaPersona } from "../utils/env";
import { openAccountMenu } from "../utils/sign-in";

test.describe("PRO_USER session @smoke", () => {
  test("is sent on from the sign-in and register pages instead of seeing a form (UI-040)", async ({
    page,
  }) => {
    await page.goto("/login?next=%2Flists");
    await expect(page).toHaveURL(/\/lists$/);

    await page.goto("/register");
    await expect(page).toHaveURL(/\/dashboard$/);

    // An external destination is never followed, even for a signed-in visitor.
    await page.goto("/login?next=https%3A%2F%2Fevil.example");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

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
