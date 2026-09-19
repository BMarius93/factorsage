import { expect, test } from "../fixtures";

/**
 * Anonymous browser behaviour. No persona credentials are involved, so this project needs no
 * storage state and never signs in.
 */
test.describe("guest authentication @smoke", () => {
  test("answers an empty sign-in beside the fields without asking the API (UI-041)", async ({
    page,
  }) => {
    let loginRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/auth/login")) {
        loginRequests += 1;
      }
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeFocused();
    expect(loginRequests).toBe(0);
  });

  test("returns from the topbar sign-in to the page it was used on (UI-042)", async ({
    page,
  }) => {
    await page.goto("/lists");
    await expect(page.getByTestId("sign-in-link")).toHaveAttribute(
      "href",
      "/login?next=%2Flists",
    );
  });

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
    // Email-first registration (AUTH-003): the address is the whole form.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("is sent to sign-in when opening a product route", async ({ page }) => {
    // The Dashboard and the built-in collections are public; a route that is only ever about the
    // caller's own work is not.
    await page.goto("/backtests");

    // The attempted page rides along, so signing in returns to it (UX-003).
    await expect(page).toHaveURL("/login?next=%2Fbacktests");
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
