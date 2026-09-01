import { expect, type Page } from "@playwright/test";
import type { QaPersonaCredentials } from "./env";

/**
 * Signs in through the product's own email/password UI.
 *
 * Authentication is never faked or injected: the suite exercises the same form, the same API
 * call, and the same HttpOnly cookie a real user gets.
 */
export async function signInThroughUi(
  page: Page,
  persona: QaPersonaCredentials,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(persona.email);
  await page.getByLabel("Password").fill(persona.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The account control only renders once the API has confirmed the session.
  await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
}

export async function openAccountMenu(page: Page): Promise<void> {
  await page.getByTestId("account-menu-trigger").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
}
