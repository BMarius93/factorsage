import { expect, test } from "../fixtures";
import { qaPersona } from "../utils/env";
import { submitSignInForm } from "../utils/sign-in";

/**
 * The Dashboard is the product's home page, and `/` is its address.
 *
 * `/dashboard` is where it used to live. It still resolves, as a redirect (`next.config.ts` →
 * `src/lib/route-redirects.ts`), so a bookmark, an old link or a typed address keeps working —
 * but what ends up in the address bar is `/`, never the old route. That asymmetry is the whole
 * point of the change and is what this spec pins: one canonical URL, no second one shadowing it,
 * and no pair of rules that could send a browser round in a circle.
 */
test.describe("canonical Dashboard route", () => {
  test("serves the Dashboard at the root, with no redirect of its own", async ({
    page,
  }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    // Landed directly: no hop through another address on the way in.
    expect(response?.request().redirectedFrom()).toBeNull();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();
    await expect(page.getByTestId("dashboard-overview")).toBeVisible();
  });

  test("redirects the old /dashboard address to it, once", async ({ page }) => {
    const response = await page.goto("/dashboard");

    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();

    // Exactly one hop, from exactly the old address: a second rule anywhere pointing back at
    // `/dashboard` would show up here as a longer chain or as a timeout, not as a passing test.
    const chain: string[] = [];
    for (
      let hop = response?.request().redirectedFrom();
      hop;
      hop = hop.redirectedFrom()
    ) {
      chain.unshift(new URL(hop.url()).pathname);
    }
    expect(chain).toEqual(["/dashboard"]);
  });

  test("keeps the Dashboard readable without an account, at either address", async ({
    page,
  }) => {
    for (const entry of ["/", "/dashboard"]) {
      await page.goto(entry);
      // A Guest is invited in, never bounced to /login (UX-003).
      await expect(page).toHaveURL("/");
      await expect(page.getByTestId("dashboard-guest-notice")).toBeVisible();
      await expect(page.getByTestId("auth-checking")).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/login/);
    }
  });

  test("points the brand mark and the phone's bottom bar at the root", async ({
    page,
  }) => {
    // From a page that is not the Dashboard, because the question is whether the shell's two
    // ways home lead back to it. `/monitors` is guest-readable and renders from one request.
    await page.goto("/monitors");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const brand = page.getByRole("link", { name: "FactorSage home" });
    await expect(brand).toHaveAttribute("href", "/");
    await brand.click();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const bottomNav = page.getByRole("navigation", { name: "Primary mobile" });
    await expect(
      bottomNav.getByRole("link", { name: "Dashboard" }),
    ).toHaveAttribute("href", "/");
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("lands a plain sign-in on the Dashboard, at the canonical address", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitSignInForm(page, qaPersona("PRO_USER"));

    // No `next`, so the fallback decides — and the fallback is `/`, not `/dashboard`.
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
    await expect(page.getByTestId("dashboard-page")).toBeVisible();
  });
});
