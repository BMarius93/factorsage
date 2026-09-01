import { expect, test } from "@playwright/test";

/**
 * Anonymous browser behaviour. No persona credentials are involved, so this project needs no
 * storage state and never signs in.
 */
test.describe("guest authentication @smoke", () => {
  test("can reach the sign-in page", async ({ page }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("can reach the registration page from sign-in", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Create an account" }).click();

    await expect(page).toHaveURL(/\/register$/);
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(page.getByLabel("Confirm password")).toBeVisible();
  });

  test("is sent to sign-in when opening a product route", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  });

  test("shows a failure and stays signed out for invalid credentials", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("not-a-real-account@example.test");
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  });
});
