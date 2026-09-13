import { expect, type Page } from "@playwright/test";
import { apiBaseUrl } from "./entitlements";

/**
 * Shared moves for the billing specs.
 *
 * These drive the running stack through the browser like a user. Nothing here talks to Stripe: the
 * suite proves FactorSage's own half of billing — what a plan sees, what the API refuses, and that
 * returning from a hosted page grants nothing — and `docs/decisions/stripe-billing-v1.md` section 27
 * is explicit that the normal Playwright run must not depend on Stripe-hosted pages. Real hosted
 * flows are exercised by the opt-in Stripe sandbox smoke suite instead
 * (`pnpm test:billing:sandbox`).
 *
 * Nothing here changes a persona's plan, so the specs stay order-independent like every other
 * persona suite.
 */

export type BillingStatusPayload = {
  readonly plan: "FREE" | "STARTER" | "PRO";
  readonly billingEnabled: boolean;
  readonly subscription: {
    readonly plan: string | null;
    readonly interval: string | null;
    readonly status: string;
    readonly currentPeriodEnd: string | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly cancelAt: string | null;
    readonly pendingChange: unknown | null;
  } | null;
  readonly canStartCheckout: boolean;
  readonly canOpenPortal: boolean;
  readonly canChangePlan: boolean;
  readonly catalog: readonly { readonly key: string }[];
};

/** What the API reports for whoever this browser context is, via the page's own session. */
export async function readBillingStatus(
  page: Page,
): Promise<BillingStatusPayload> {
  const response = await page.request.get(`${apiBaseUrl()}/billing/status`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as BillingStatusPayload;
}

/**
 * Attempts a checkout with a raw body, reporting the status and reason code.
 *
 * Used to prove the server-side allowlist from the *client's* side: a crafted request carrying a
 * Stripe price id, a plan or a role is what an attacker would actually send, and the only honest
 * test of the refusal is to send it.
 */
export async function attemptCheckout(
  page: Page,
  body: Record<string, unknown>,
): Promise<{ status: number; code: string | null }> {
  const response = await page.request.post(`${apiBaseUrl()}/billing/checkout`, {
    data: body,
    failOnStatusCode: false,
  });
  let code: string | null = null;
  try {
    const parsed = (await response.json()) as { code?: unknown };
    code = typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    // A body-less response is still a meaningful status.
  }
  return { status: response.status(), code };
}

export async function openBillingPage(page: Page): Promise<void> {
  await page.goto("/billing");
  await expect(page.getByTestId("billing-plan")).toBeVisible({ timeout: 20_000 });
}
