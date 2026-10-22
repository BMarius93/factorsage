import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { BacktestShareResponse } from "@intrinsic/contracts";
import { e2eFakeFmpControlUrl } from "@intrinsic/testing/e2e-stack";
import { expectNoProviderRequests, installBrowserStubs } from "../fixtures";
import { apiBaseUrl } from "./entitlements";
import { STORAGE_STATE } from "./env";
import type { TestPersonaName } from "@intrinsic/testing/personas";

/**
 * Shared moves for the backtest-sharing specs (`docs/decisions/backtest-sharing-v1.md`).
 *
 * The owner side is driven through the run page like a user would; everything else here only
 * reads — a reader's own browser context, the fixture FMP server's request journal, and the
 * public report as a crawler with no JavaScript receives it.
 */

/** A share URL as the dialog shows it: the web origin, `/share/`, a 43-character token. */
export const SHARE_URL = /^https?:\/\/[^/]+\/share\/[A-Za-z0-9_-]{43}$/;

export function shareTokenOf(url: string): string {
  const token = new URL(url).pathname.split("/").at(-1);
  if (!token) {
    throw new Error(`Not a share URL: ${url}`);
  }
  return token;
}

/** The owner's view of a run's link, from the API, with the page's own session. */
export async function readShare(
  page: Page,
  runId: string,
): Promise<BacktestShareResponse> {
  const response = await page.request.get(
    `${apiBaseUrl()}/backtests/${runId}/share`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as BacktestShareResponse;
}

/** Opens the Share dialog on the owner's run page. */
export async function openShareDialog(page: Page, runId: string) {
  await page.goto(`/backtests/${runId}`);
  await expect(page.getByTestId("backtest-run")).toHaveAttribute(
    "data-status",
    "COMPLETED",
    { timeout: 20_000 },
  );
  const button = page.getByTestId("backtest-share");
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.getByTestId("backtest-share-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Creates the run's link through the dialog and returns the URL it shows. */
export async function enableShareThroughDialog(
  page: Page,
  runId: string,
): Promise<string> {
  const dialog = await openShareDialog(page, runId);
  const enable = dialog.getByTestId("backtest-share-enable");
  if (await enable.isVisible().catch(() => false)) {
    await enable.click();
  }
  const field = dialog.getByTestId("backtest-share-url");
  await expect(field).toHaveValue(SHARE_URL);
  return field.inputValue();
}

/** Stops sharing through the dialog, with its explicit confirmation. */
export async function revokeShareThroughDialog(
  page: Page,
  runId: string,
): Promise<void> {
  const dialog = await openShareDialog(page, runId);
  await dialog.getByTestId("backtest-share-revoke").click();
  await dialog.getByTestId("backtest-share-revoke-confirm-button").click();
  await expect(dialog.getByTestId("backtest-share-enable")).toBeVisible();
  await expect(page.getByTestId("backtest-share")).toHaveAttribute(
    "data-shared",
    "false",
  );
}

/** Best-effort: a run left shared would change what the next spec starts from. */
export async function revokeShareIfPresent(
  request: APIRequestContext,
  runId: string,
): Promise<void> {
  try {
    await request.delete(`${apiBaseUrl()}/backtests/${runId}/share`);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

/** A reader's own browser: a Guest, or a persona signed in on its own plan. */
export async function readerContext(
  browser: Browser,
  persona: TestPersonaName | "GUEST",
): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState:
      persona === "GUEST"
        ? { cookies: [], origins: [] }
        : STORAGE_STATE[persona],
  });
  await installBrowserStubs(context);
  return context;
}

export async function closeReaderContext(context: BrowserContext) {
  expectNoProviderRequests(await installBrowserStubs(context));
  await context.close();
}

type JournalEntry = { readonly endpoint: string; readonly detail: string };

/**
 * The fixture FMP server's request journal: every provider request the stack made, in order.
 * A public read must add nothing to it.
 */
export async function fmpJournal(after = 0): Promise<{
  entries: JournalEntry[];
  last: number;
}> {
  const response = await fetch(
    `${e2eFakeFmpControlUrl()}journal?after=${after}`,
  );
  expect(response.ok, "the fixture FMP journal answers").toBe(true);
  return (await response.json()) as { entries: JournalEntry[]; last: number };
}

/** The eight KPI tiles as the page renders them, keyed by tile. */
export async function metricTexts(page: Page): Promise<Record<string, string>> {
  return page
    .getByTestId("backtest-metrics")
    .locator(":scope > [data-testid^='metric-']")
    .evaluateAll((tiles) =>
      Object.fromEntries(
        tiles.map((tile) => [
          tile.getAttribute("data-testid") ?? "",
          (tile.textContent ?? "").trim(),
        ]),
      ),
    );
}

/** No page may scroll sideways: a shared report must be readable on a phone without panning. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}
