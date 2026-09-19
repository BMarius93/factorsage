import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { submitSignInForm } from "../utils/sign-in";
import { qaPersona } from "../utils/env";

/**
 * A visitor browsing FactorSage's built-in content without an account.
 *
 * Built-ins are public product content (`AGENTS.md` invariant 21), so the Lists, Strategies and
 * Monitors collections are readable — a visitor who is bounced to `/login` for navigating cannot
 * discover what the product does. Every protected action keeps them where they are and asks for an
 * account through the shared prompt.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */

const QA_LIST = "QA Built-in Leaders";
const QA_STRATEGY = "QA Built-in Trend";
const QA_MONITOR = "QA Built-in Monitor A";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Opens the page and asserts a Guest was not redirected away from it. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByTestId("sign-in-link")).toBeVisible();
}

/**
 * The prompt is open, and both of its answers carry the page being read as `?next=` so that
 * signing in comes straight back to it (UX-003).
 */
async function expectSignInPrompt(page: Page) {
  const prompt = page.getByTestId("sign-in-prompt");
  await expect(prompt).toBeVisible();
  const here = new URL(page.url());
  const next = encodeURIComponent(`${here.pathname}${here.search}`);
  await expect(prompt.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    `/login?next=${next}`,
  );
  await expect(
    prompt.getByRole("link", { name: "Create an account" }),
  ).toHaveAttribute("href", `/register?next=${next}`);
  return prompt;
}

test.describe("guest built-in collections", () => {
  test("browses built-in lists without an account", async ({ page }) => {
    await open(page, "/lists");

    const builtIns = page.getByTestId("built-in-lists");
    await expect(builtIns).toBeVisible();
    await expect(builtIns).toContainText(QA_LIST);
    // No fake "Your lists" section for someone who cannot own one.
    await expect(page.getByTestId("your-lists")).toHaveCount(0);

    await builtIns.getByRole("link", { name: QA_LIST }).first().click();
    await expect(page.getByTestId("list-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    // Read-only: the definition is fully readable, none of it is editable.
    await expect(page.getByTestId("add-stocks-button")).toHaveCount(0);
    await expect(page.getByTestId("list-items")).toBeVisible();
  });

  test("browses built-in strategies without an account", async ({ page }) => {
    await open(page, "/strategies");

    const builtIns = page.getByTestId("built-in-strategies");
    await expect(builtIns).toContainText(QA_STRATEGY);
    await expect(page.getByTestId("your-strategies")).toHaveCount(0);

    await builtIns.getByRole("link", { name: QA_STRATEGY }).first().click();
    // The complete strategy logic is readable, and read-only.
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    await expect(page.getByText("Price crosses above SMA 20D")).toBeVisible();
    await expect(page.getByTestId("save-strategy")).toHaveCount(0);
  });

  test("browses built-in monitors without an account", async ({ page }) => {
    await open(page, "/monitors");

    const builtIns = page.getByTestId("built-in-monitors");
    await expect(builtIns).toContainText(QA_MONITOR);
    await expect(page.getByTestId("your-monitors")).toHaveCount(0);

    const row = builtIns.locator("tbody tr").filter({ hasText: QA_MONITOR });
    // The monitor names its strategy and its list, and both are reachable from the row.
    await expect(row.getByRole("link", { name: QA_STRATEGY })).toBeVisible();
    await expect(row.getByRole("link", { name: QA_LIST })).toBeVisible();
    // Read-only: no enable/disable, no edit, no delete.
    await expect(row.getByTestId("monitor-actions")).toHaveCount(0);

    await row.getByRole("link", { name: QA_MONITOR }).click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("edit-monitor")).toHaveCount(0);
  });

  test("asks for an account in place, rather than redirecting, for every protected action", async ({
    page,
  }) => {
    for (const [path, action] of [
      ["/lists", "new-list-button"],
      ["/strategies", "new-strategy-button"],
      ["/monitors", "new-monitor-button"],
    ] as const) {
      await open(page, path);
      await page.getByTestId(action).first().click();
      const prompt = await expectSignInPrompt(page);
      // Still on the page they were reading: nothing navigated.
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await prompt.getByRole("button", { name: "Close dialog" }).click();
      await expect(prompt).toHaveCount(0);
    }
  });

  test("asks a Guest to sign in rather than saving a built-in monitor's visibility", async ({
    page,
  }) => {
    await open(page, "/monitors");
    const row = page
      .getByTestId("built-in-monitors")
      .locator("tbody tr")
      .filter({ hasText: QA_MONITOR });

    const toggle = row.getByTestId("built-in-monitor-toggle");
    // The control is visible — that is how the feature is discovered — and defaults to shown.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expectSignInPrompt(page);
    // Nothing anonymous was persisted, and the control did not move.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveURL(/\/monitors$/);

    const monitorId = await builtInMonitorId(page, QA_MONITOR);
    const refused = await page.request.put(
      `${apiBaseUrl()}/dashboard/monitors/${monitorId}/visibility`,
      { data: { visible: false } },
    );
    expect(refused.status()).toBe(401);
  });

  test("asks for an account in place when a Guest backtests a built-in strategy (UX-002)", async ({
    page,
  }) => {
    await open(page, "/strategies");
    await page
      .getByTestId("built-in-strategies")
      .getByRole("link", { name: QA_STRATEGY })
      .first()
      .click();
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    const strategyUrl = page.url();

    const action = page.getByTestId("backtest-this-strategy");
    // A button for a Guest: following a link into /backtests/new would bounce them to /login.
    await expect(action).toHaveJSProperty("tagName", "BUTTON");
    await action.click();

    const prompt = await expectSignInPrompt(page);
    await expect(prompt).toContainText("Sign in to run a backtest");
    await expect(prompt).toContainText("you will come straight back here");
    // Nothing navigated: still on the strategy, which is still rendered underneath.
    expect(page.url()).toBe(strategyUrl);
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
  });

  test("asks for an account in place when a Guest backtests a built-in monitor (UX-002)", async ({
    page,
  }) => {
    await open(page, "/monitors");
    await page
      .getByTestId("built-in-monitors")
      .locator("tbody tr")
      .filter({ hasText: QA_MONITOR })
      .getByRole("link", { name: QA_MONITOR })
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    const monitorUrl = page.url();

    await page.getByTestId("backtest-this-monitor").click();

    await expectSignInPrompt(page);
    expect(page.url()).toBe(monitorUrl);
  });

  test("comes straight back to the built-in strategy after signing in from the prompt (UX-003)", async ({
    page,
  }) => {
    await open(page, "/strategies");
    await page
      .getByTestId("built-in-strategies")
      .getByRole("link", { name: QA_STRATEGY })
      .first()
      .click();
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    const strategyPath = new URL(page.url()).pathname;
    const strategyId = strategyPath.split("/").pop() ?? "";

    await page.getByTestId("backtest-this-strategy").click();
    const prompt = await expectSignInPrompt(page);
    await prompt.getByRole("link", { name: "Sign in" }).click();

    // The sign-in page carries the strategy as its destination.
    await expect(page).toHaveURL(
      `/login?next=${encodeURIComponent(strategyPath)}`,
    );
    // An existing seeded persona; this creates no account and sends no email.
    await submitSignInForm(page, qaPersona("PRO_USER"));

    await expect(page).toHaveURL(strategyPath);
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
    // Signed in, the same action is the prefilled link it always was.
    const action = page.getByTestId("backtest-this-strategy");
    await expect(action).toHaveJSProperty("tagName", "A");
    await expect(action).toHaveAttribute(
      "href",
      `/backtests/new?strategyId=${encodeURIComponent(strategyId)}`,
    );
  });

  test("renders the built-in collections on a phone without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path, section] of [
      ["/lists", "built-in-lists"],
      ["/strategies", "built-in-strategies"],
      ["/monitors", "built-in-monitors"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(section)).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});

async function builtInMonitorId(page: Page, name: string): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl()}/monitors`);
  const body = (await response.json()) as { id: string; name: string }[];
  const monitor = body.find((entry) => entry.name === name);
  if (!monitor) {
    throw new Error(`${name} is not published; run pnpm test:builtins:seed`);
  }
  return monitor.id;
}
