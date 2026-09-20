import {
  expect,
  expectNoProviderRequests,
  installBrowserStubs,
  test,
  type Page,
} from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * A signed-in customer meeting the same built-in content: their own first, the platform's under it.
 *
 * The built-in sections must not disappear once someone signs in — that was the whole point of
 * making them public — and the one piece of per-viewer state a built-in has, whether its signals
 * reach this account's Dashboard, is edited here and persists for this account alone.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */

const QA_LIST = "QA Built-in Leaders";
const QA_STRATEGY = "QA Built-in Trend";
const QA_MONITOR = "QA Built-in Monitor A";

const COLLECTIONS = [
  { path: "/lists", own: "your-lists", builtIn: "built-in-lists", name: QA_LIST },
  {
    path: "/strategies",
    own: "your-strategies",
    builtIn: "built-in-strategies",
    name: QA_STRATEGY,
  },
  {
    path: "/monitors",
    own: "your-monitors",
    builtIn: "built-in-monitors",
    name: QA_MONITOR,
  },
] as const;

function builtInRow(page: Page, name: string) {
  return page
    .getByTestId("built-in-monitors")
    .locator("tbody tr")
    .filter({ hasText: name });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("PRO_USER built-in collections", () => {
  test("puts the customer's own content above the built-in content on every collection", async ({
    page,
  }) => {
    for (const collection of COLLECTIONS) {
      await page.goto(collection.path);
      const own = page.getByTestId(collection.own);
      const builtIn = page.getByTestId(collection.builtIn);
      await expect(own).toBeVisible();
      await expect(builtIn).toBeVisible();
      await expect(builtIn).toContainText(collection.name);
      // Your content first, and a built-in is never inside it.
      await expect(own).not.toContainText(collection.name);
      const order = await own.evaluate(
        (node, other) =>
          node.compareDocumentPosition(other as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        await builtIn.elementHandle(),
      );
      expect(order, `${collection.path}: built-ins must come after your own`).toBeGreaterThan(0);
      await expectNoHorizontalScroll(page);
    }
  });

  test("keeps built-ins read-only for a customer", async ({ page }) => {
    await page.goto("/lists");
    await expect(
      page
        .getByTestId("built-in-lists")
        .locator("tbody tr")
        .filter({ hasText: QA_LIST })
        .getByTestId("list-actions"),
    ).toHaveCount(0);

    await page.goto("/monitors");
    await expect(builtInRow(page, QA_MONITOR).getByTestId("monitor-actions")).toHaveCount(0);

    await page.goto("/strategies");
    await page
      .getByTestId("built-in-strategies")
      .getByRole("link", { name: QA_STRATEGY })
      .first()
      .click();
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    await expect(page.getByTestId("save-strategy")).toHaveCount(0);
  });

  test("saves a built-in monitor's dashboard visibility for this account only", async ({
    page,
    browser,
  }) => {
    await page.goto("/monitors");
    const toggle = builtInRow(page, QA_MONITOR).getByTestId(
      "built-in-monitor-toggle",
    );
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    try {
      await toggle.click();
      await expect(
        builtInRow(page, QA_MONITOR).getByTestId("built-in-monitor-toggle"),
      ).toHaveAttribute("aria-checked", "false");

      // Durable, not local state.
      await page.reload();
      await expect(
        builtInRow(page, QA_MONITOR).getByTestId("built-in-monitor-toggle"),
      ).toHaveAttribute("aria-checked", "false");

      // And it is a Dashboard preference: that monitor's rows are gone from this account's
      // Dashboard, while the shared monitor keeps producing them for everybody else.
      await page.goto("/");
      await expect(
        page
          .getByTestId("dashboard-signal-row")
          .filter({ hasText: QA_MONITOR }),
      ).toHaveCount(0);

      const guest = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      // A context opened by hand gets the same hermetic browser as the fixture's own.
      const guestStubs = await installBrowserStubs(guest);
      const guestPage = await guest.newPage();
      await guestPage.goto("/");
      await expect(
        guestPage
          .getByTestId("dashboard-signal-row")
          .filter({ hasText: QA_MONITOR }),
      ).not.toHaveCount(0);
      expectNoProviderRequests(guestStubs);
      await guest.close();
    } finally {
      await page.goto("/monitors");
      const current = builtInRow(page, QA_MONITOR).getByTestId(
        "built-in-monitor-toggle",
      );
      if ((await current.getAttribute("aria-checked")) === "false") {
        await current.click();
        await expect(current).toHaveAttribute("aria-checked", "true");
      }
    }

    await page.goto("/");
    await expect(
      page.getByTestId("dashboard-signal-row").filter({ hasText: QA_MONITOR }),
    ).not.toHaveCount(0);
  });

  test("refuses a customer's attempt to change built-in content at the API", async ({
    page,
  }) => {
    const monitors = (await (
      await page.request.get(`${apiBaseUrl()}/monitors`)
    ).json()) as { id: string; name: string; ownership: string }[];
    const builtIn = monitors.find((monitor) => monitor.name === QA_MONITOR);
    expect(builtIn?.ownership).toBe("SYSTEM");

    // The browser hides the controls; the API is what actually refuses.
    const refused = await page.request.patch(
      `${apiBaseUrl()}/monitors/${builtIn!.id}`,
      { data: { name: "Mine now" } },
    );
    expect(refused.status()).toBe(403);
  });
});
