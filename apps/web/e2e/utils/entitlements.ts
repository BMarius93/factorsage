import { expect, type Locator, type Page } from "@playwright/test";
import type { Entitlements } from "@intrinsic/contracts";

/**
 * Shared moves for the entitlement specs.
 *
 * Everything here drives the running stack through the browser the way a user would. Nothing
 * changes a persona's plan and nothing writes to the database directly: the fixtures are seeded
 * before the suite by `pnpm test:personas:seed`, so a spec's only job is to observe what the
 * product does with them. That is what keeps these specs order-independent — no test can leave a
 * persona in a state another test depends on.
 */

/** Everything the fixture seeder owns is named with this prefix. Mirrors the seeder's constant. */
export const ENTITLEMENT_FIXTURE_PREFIX = "ENT-";

export function fixtureName(name: string): string {
  return `${ENTITLEMENT_FIXTURE_PREFIX}${name}`;
}

/**
 * The API origin the browser talks to.
 *
 * The web app and the API are separate origins, and `/entitlements` is the API's. Read from the
 * same variable the browser bundle uses, so a spec cannot assert against a different deployment
 * than the page it just loaded.
 */
export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";
}

export type EntitlementsPayload = {
  readonly principal: "GUEST" | "AUTHENTICATED";
  readonly plan?: string;
  readonly role?: string;
  readonly entitlements: Entitlements;
};

/**
 * What the API reports for whoever this browser context is.
 *
 * Uses the page's own request context, so it carries the same session cookie the UI does — this is
 * the signed-in user's view of their own entitlements, not a privileged back door.
 */
export async function readEntitlements(
  page: Page,
): Promise<EntitlementsPayload> {
  const response = await page.request.get(`${apiBaseUrl()}/entitlements`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as EntitlementsPayload;
}

/** Opens a seeded fixture list by its reserved name. */
export async function openFixtureList(
  page: Page,
  name: string,
): Promise<void> {
  await page.goto("/lists");
  const link = page.getByRole("link", { name: fixtureName(name) }).first();
  await expect(
    link,
    `The fixture list "${fixtureName(name)}" is missing. Seed it once with: pnpm test:personas:seed`,
  ).toBeVisible({ timeout: 20_000 });
  await link.click();
  await expect(page.getByTestId("list-detail")).toBeVisible({
    timeout: 20_000,
  });
}

export function listItems(page: Page): Locator {
  return page.getByTestId("list-items").locator("li");
}

export function listItem(page: Page, symbol: string): Locator {
  return listItems(page).filter({ hasText: symbol });
}

/**
 * Tries to add one stock to the open list and reports what the page answered.
 *
 * Returns rather than asserts, because the same interaction is expected to succeed for one plan
 * and be refused for another — and both outcomes are worth reading in the spec that cares.
 */
export async function addStockToOpenList(
  page: Page,
  symbol: string,
): Promise<{ accepted: boolean; message: string | null }> {
  const search = page.getByRole("combobox", {
    name: "Search stocks to add to this list",
  });
  await search.fill(symbol);
  const option = page.getByRole("option").filter({ hasText: symbol }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.click();
  await page.getByTestId("add-stocks-button").click();

  const error = page.getByTestId("list-add-error");
  // Exactly one of the two outcomes always arrives: the refusal banner, or the new row.
  await expect
    .poll(
      async () =>
        (await error.count()) > 0 || (await listItem(page, symbol).count()) > 0,
      { timeout: 20_000 },
    )
    .toBe(true);

  return (await error.count()) > 0
    ? { accepted: false, message: (await error.innerText()).trim() }
    : { accepted: true, message: null };
}

/** Removes one stock from the open list through the confirmation dialog. */
export async function removeStockFromOpenList(
  page: Page,
  symbol: string,
): Promise<void> {
  await page.getByLabel(`Remove ${symbol} from list`).click();
  await page.getByRole("button", { name: "Remove stock" }).click();
  await expect(listItem(page, symbol)).toHaveCount(0, { timeout: 20_000 });
}

/** One monitor card on `/monitors`, found by its seeded name. */
export function monitorCard(page: Page, name: string): Locator {
  return page
    .getByTestId("monitor-card")
    .filter({ hasText: fixtureName(name) });
}

/** Fills the New Backtest form and submits, reporting what the page answered. */
export async function submitBacktest(
  page: Page,
  input: {
    /** The persona's seeded fixture strategy, without the reserved prefix. */
    readonly strategyName: string;
    readonly listName: string;
    readonly startDate: string;
    readonly endDate: string;
  },
): Promise<{ accepted: boolean; message: string | null }> {
  await page.goto("/backtests/new");
  const listSelect = page.getByTestId("backtest-list");
  await expect(listSelect).toBeEnabled({ timeout: 30_000 });
  // Every field the form validates itself must be filled, or the client refuses before the API is
  // ever asked — and a spec about a plan limit would be asserting on its own omission.
  await page
    .getByTestId("backtest-strategy")
    .selectOption({ label: fixtureName(input.strategyName) });
  await listSelect.selectOption({ label: fixtureName(input.listName) });
  await page.getByTestId("backtest-start").fill(input.startDate);
  await page.getByTestId("backtest-end").fill(input.endDate);
  await page.getByTestId("submit-backtest").click();

  const error = page.getByTestId("backtest-submit-error");
  await expect
    .poll(
      async () =>
        (await error.count()) > 0 || /\/backtests\/[0-9a-f-]{36}$/.test(page.url()),
      { timeout: 30_000 },
    )
    .toBe(true);

  return (await error.count()) > 0
    ? { accepted: false, message: (await error.innerText()).trim() }
    : { accepted: true, message: null };
}

/** `years` before `date`, with the product's own 29-February clamp. */
export function yearsBefore(date: string, years: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  const lastDayOfMonth = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDayOfMonth));
  return shifted.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
