import { expect, test, type Page } from "@playwright/test";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Dashboard as a first-time visitor meets it.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`: the QA built-ins put one security
 * active under two built-in monitors and one setup waiting for its trigger, so the rows asserted
 * here are exact. Nothing is persisted for a Guest, which the last case proves at the API.
 */

const MONITOR_A = "QA Built-in Monitor A";
const MONITOR_B = "QA Built-in Monitor B";

function qaRows(page: Page) {
  return page
    .getByTestId("dashboard-signal-row")
    .filter({ hasText: /QA Built-in Monitor/ });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("guest dashboard", () => {
  test("shows the built-in monitors' current signals without an account", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("dashboard-guest-notice")).toBeVisible();
    await expect(page.getByTestId("sign-in-link")).toBeVisible();

    const rows = qaRows(page);
    await expect(rows).toHaveCount(3);
    // The same security under two monitors is two rows.
    await expect(rows.filter({ hasText: "QATEST1" })).toHaveCount(2);
    const waiting = rows.filter({ hasText: "QATEST2" });
    await expect(waiting).toContainText("Waiting for trigger");
    await expect(waiting).toContainText(
      "Waiting for: Price crosses above SMA 20D",
    );
    await expect(rows.filter({ hasText: MONITOR_A })).toContainText("Active");

    await expect(
      page.getByTestId("dashboard-monitor").filter({ hasText: MONITOR_A }),
    ).toContainText("Updated");
  });

  test("filters to setups waiting for a trigger", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(qaRows(page)).toHaveCount(3);
    await page
      .getByTestId("dashboard-state-filter")
      .getByRole("button", { name: /Waiting for trigger/ })
      .click();
    await expect(qaRows(page)).toHaveCount(1);
    await expect(qaRows(page)).toContainText("QATEST2");
  });

  test("opens Stock Details from a row", async ({ page }) => {
    await page.goto("/dashboard");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    // A click anywhere that is not itself a control opens the stock.
    await row.getByText("Buy 100%").click();
    await expect(page).toHaveURL(/\/stocks\/QATEST1$/);
  });

  test("reads the built-in monitor, strategy and list behind a row", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const row = qaRows(page)
      .filter({ hasText: MONITOR_B })
      .filter({ hasText: "QATEST2" });
    await row.getByRole("link", { name: "QA Built-in Trend" }).click();
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    await expect(page.getByText("Price crosses above SMA 20D")).toBeVisible();

    await page.goBack();
    await qaRows(page)
      .filter({ hasText: MONITOR_B })
      .first()
      .getByRole("link", { name: "QA Built-in Newcomers" })
      .click();
    await expect(page.getByTestId("list-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("add-stocks-button")).toHaveCount(0);
  });

  test("asks a Guest to sign in rather than saving a monitor toggle", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const card = page
      .getByTestId("dashboard-monitor")
      .filter({ hasText: MONITOR_A });
    await card.getByTestId("dashboard-monitor-toggle").click();
    const prompt = page.getByTestId("sign-in-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    await expect(card.getByTestId("dashboard-monitor-toggle")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const refused = await page.request.put(
      `${apiBaseUrl()}/dashboard/monitors/${await monitorId(page, MONITOR_A)}/visibility`,
      { data: { visible: false } },
    );
    expect(refused.status()).toBe(401);
  });

  test("renders phone record cards without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(qaRows(page)).toHaveCount(3);
    // Record cards: every row fits the phone's width, and the page never scrolls sideways.
    const box = await qaRows(page).first().boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});

async function monitorId(page: Page, name: string): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl()}/dashboard`);
  const body = (await response.json()) as {
    monitors: { id: string; name: string }[];
  };
  const monitor = body.monitors.find((entry) => entry.name === name);
  if (!monitor) {
    throw new Error(
      `${name} is not on the dashboard; run pnpm test:builtins:seed`,
    );
  }
  return monitor.id;
}
