import { expect, type Page } from "@playwright/test";
import { qaPersona, type QaPersonaCredentials, type TestPersonaName } from "./env";

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

/**
 * Signs in as a named persona, whatever state the page is in.
 *
 * The persona projects in `playwright.config.ts` already start signed in, so most specs never call
 * this. It exists for the two cases a storage state cannot cover: a spec that needs to switch
 * persona mid-test, and the guest project asserting what signing in changes.
 *
 * It never mutates a persona's plan. Personas are fixed points — a spec signs in as the plan it is
 * about — which is what keeps entitlement specs independent of each other and of their order.
 */
export async function loginAs(
  page: Page,
  name: TestPersonaName,
): Promise<void> {
  await signInThroughUi(page, qaPersona(name));
}
