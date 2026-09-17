import { expect, type Page } from "@playwright/test";
import { apiBaseUrl } from "./entitlements";

/**
 * List fixtures set up through the API rather than the UI.
 *
 * Every call goes through `page.request`, so it carries the same session cookie the browser does —
 * this is the signed-in persona provisioning their own data, never a privileged back door. Using
 * the API for arrangement keeps each spec's *assertions* about the part of the product it is
 * actually testing, and it is the only way to reach a state the V1 editor deliberately cannot
 * create, such as a member with several membership periods.
 */

export type ApiBuyWindow = {
  readonly startDate: string;
  readonly endDate: string | null;
};

export type ApiListItem = {
  readonly id: string;
  readonly security: { readonly id: string; readonly symbol: string };
  readonly buyWindowMode: "FULL" | "CUSTOM";
  readonly buyWindows: ApiBuyWindow[];
};

export type ApiList = {
  readonly id: string;
  readonly name: string;
  readonly items: ApiListItem[];
};

/** The catalog id of a symbol, or `null` when the QA catalog rows have not been seeded. */
export async function findSecurityId(
  page: Page,
  symbol: string,
): Promise<string | null> {
  const response = await page.request.get(
    `${apiBaseUrl()}/stocks/search?q=${encodeURIComponent(symbol)}`,
  );
  if (!response.ok()) {
    return null;
  }
  const results = (await response.json()) as {
    id: string;
    symbol: string;
  }[];
  return results.find((entry) => entry.symbol === symbol)?.id ?? null;
}

export async function createList(
  page: Page,
  name: string,
  securityIds: readonly string[],
): Promise<ApiList> {
  const response = await page.request.post(`${apiBaseUrl()}/lists`, {
    data: { name, securityIds: [...securityIds] },
  });
  expect(
    response.ok(),
    `POST /lists failed with ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as ApiList;
}

export async function readList(page: Page, listId: string): Promise<ApiList> {
  const response = await page.request.get(`${apiBaseUrl()}/lists/${listId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ApiList;
}

/** Replaces one member's complete buy-window configuration and returns the canonical result. */
export async function replaceBuyWindows(
  page: Page,
  listId: string,
  itemId: string,
  configuration: {
    mode: "FULL" | "CUSTOM";
    ranges: readonly ApiBuyWindow[];
  },
): Promise<ApiListItem> {
  const response = await page.request.put(
    `${apiBaseUrl()}/lists/${listId}/items/${itemId}/buy-windows`,
    { data: { mode: configuration.mode, ranges: [...configuration.ranges] } },
  );
  expect(
    response.ok(),
    `PUT buy-windows failed with ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as ApiListItem;
}

/** Best-effort teardown: a failed assertion must not leave the shared persona accumulating lists. */
export async function deleteListIfPresent(
  page: Page,
  listId: string | null,
): Promise<void> {
  if (listId === null) {
    return;
  }
  await page.request.delete(`${apiBaseUrl()}/lists/${listId}`).catch(() => {});
}

export function itemOf(list: ApiList, symbol: string): ApiListItem {
  const item = list.items.find((entry) => entry.security.symbol === symbol);
  if (!item) {
    throw new Error(`${symbol} is not a member of ${list.name}`);
  }
  return item;
}
