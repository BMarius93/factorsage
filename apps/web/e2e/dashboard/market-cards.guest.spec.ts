import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Dashboard's five-card overview strip, as a first-time visitor meets it.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`. The market values below are the
 * deterministic QA market-reference fixtures — `^GSPC`, `^DJI` and `^VIX` seeded into the real
 * benchmark series with complete coverage and a current tail watermark — so this suite never
 * reaches FMP and its numbers do not change because the real market did.
 */

const SP500 = 7637.05;
const DJIA = 51778.04;
const VIX = 15.43;

/** `Run Backtest · S&P 500 · DJIA · VIX · Real-time Matches`, and nothing else. */
const CARD_TEST_IDS = [
  "dashboard-run-backtest",
  "dashboard-market-card-SP500_INDEX",
  "dashboard-market-card-DJIA_INDEX",
  "dashboard-market-card-VIX_INDEX",
  "dashboard-matches-card",
] as const;

function qaRows(page: Page) {
  return page.getByTestId("dashboard-signal-row");
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("guest dashboard overview cards", () => {
  test("shows exactly the five agreed cards, in order", async ({ page }) => {
    await page.goto("/dashboard");
    const strip = page.getByTestId("dashboard-overview");
    await expect(strip).toBeVisible();

    for (const testId of CARD_TEST_IDS) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    const order = await strip.evaluate((element) =>
      [...(element.firstElementChild?.children ?? [])].map((card) =>
        card.getAttribute("data-testid"),
      ),
    );
    expect(order).toEqual([...CARD_TEST_IDS]);

    // Explicitly out of scope, and the strip is where they would creep in.
    await expect(strip).not.toContainText(/nasdaq/i);
    await expect(strip).not.toContainText(/fear/i);
    await expect(strip).not.toContainText(/greed/i);
    await expect(strip).not.toContainText(/bitcoin/i);
  });

  test("reports the seeded index values, changes and trends without an account", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    // Index levels, not the SPY share price the backtest benchmark is sourced from.
    await expect(
      page.getByTestId("dashboard-market-value-SP500_INDEX"),
    ).toHaveText("7,637");
    await expect(
      page.getByTestId("dashboard-market-value-DJIA_INDEX"),
    ).toHaveText("51,778");
    await expect(
      page.getByTestId("dashboard-market-value-VIX_INDEX"),
    ).toHaveText("15.43");

    // Session-over-session, with the direction shown as well as stated.
    await expect(
      page.getByTestId("dashboard-market-change-SP500_INDEX"),
    ).toHaveText("+1.13%");
    await expect(
      page.getByTestId("dashboard-market-change-SP500_INDEX"),
    ).toHaveAttribute("data-tone", "positive");
    await expect(
      page.getByTestId("dashboard-market-change-VIX_INDEX"),
    ).toHaveText("−12.87%");
    await expect(
      page.getByTestId("dashboard-market-change-VIX_INDEX"),
    ).toHaveAttribute("data-tone", "negative");

    // Seven observed sessions each for the two price indices, drawn without axes or labels.
    for (const code of ["SP500_INDEX", "DJIA_INDEX"]) {
      const spark = page.getByTestId(`${code}-sparkline`);
      await expect(spark).toHaveAttribute("data-points", "7");
      await expect(spark).toHaveAttribute("aria-hidden", "true");
    }
  });

  test("reads VIX as a gauge: the real close, its zone, and the session change", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const vix = page.getByTestId("dashboard-market-card-VIX_INDEX");

    await expect(vix).toHaveAttribute("data-variant", "gauge");
    await expect(
      page.getByTestId("dashboard-market-value-VIX_INDEX"),
    ).toHaveText("15.43");
    await expect(page.getByTestId("dashboard-vix-status")).toHaveText("Normal");
    await expect(page.getByTestId("dashboard-vix-status")).toHaveAttribute(
      "data-zone",
      "NORMAL",
    );
    // Secondary, and still session over session: the seeded fixture's fall.
    await expect(
      page.getByTestId("dashboard-market-change-VIX_INDEX"),
    ).toHaveText("−12.87%");
    const gauge = page.getByTestId("dashboard-vix-gauge");
    await expect(gauge).toBeVisible();
    await expect(gauge).toHaveAttribute("aria-hidden", "true");
    await expect(gauge).toHaveAttribute(
      "data-fraction",
      (15.43 / 80).toFixed(4),
    );
    // A gauge, not a trend line, and never sentiment language.
    await expect(page.getByTestId("VIX_INDEX-sparkline")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-page")).not.toContainText(
      /fear|greed/i,
    );
    await expect(vix).not.toContainText(/24h/i);
  });

  test("serves the API the same numbers the cards render, and calls them closes", async ({
    page,
  }) => {
    // No session on this request at all: the endpoint is readable by anyone.
    const response = await page.request.get(`${apiBaseUrl()}/market-overview`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      basis: string;
      items: { code: string; value?: number; sparkline: unknown[] }[];
    };

    // Guest-readable, and honest about being end-of-day rather than live.
    expect(body.basis).toBe("END_OF_DAY");
    const byCode = new Map(body.items.map((item) => [item.code, item]));
    expect(byCode.get("SP500_INDEX")?.value).toBe(SP500);
    expect(byCode.get("DJIA_INDEX")?.value).toBe(DJIA);
    expect(byCode.get("VIX_INDEX")?.value).toBe(VIX);
    // No provider symbol crosses the contract.
    const serialized = JSON.stringify(body);
    for (const symbol of ["^GSPC", "^DJI", "^VIX", "SPY"]) {
      expect(serialized).not.toContain(symbol);
    }

    await page.goto("/dashboard");
    await expect(
      page.getByTestId("dashboard-market-value-SP500_INDEX"),
    ).toHaveText("7,637");
  });

  test("asks a Guest for an account in place, without leaving the Dashboard", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByTestId("dashboard-run-backtest").click();

    const prompt = page.getByTestId("sign-in-prompt");
    await expect(prompt).toBeVisible();
    // Signing in goes straight to New Backtest, which is what the Guest asked for (UI-042).
    await expect(prompt.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Fbacktests%2Fnew",
    );
    await expect(
      prompt.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/register?next=%2Fbacktests%2Fnew");

    // Still here: no redirect to /login merely for clicking, and the page underneath is intact.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
  });

  test("agrees with the built-in rows the Dashboard is showing", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    await expect(page.getByTestId("dashboard-matches-total")).toBeVisible();

    const rows = await qaRows(page).count();
    await expect(page.getByTestId("dashboard-matches-total")).toHaveText(
      String(rows),
    );

    const active = await qaRows(page)
      .filter({ has: page.locator('[data-state="ACTIVE"]') })
      .count();
    const waiting = await qaRows(page)
      .filter({ has: page.locator('[data-state="PENDING_TRIGGER"]') })
      .count();
    await expect(page.getByTestId("dashboard-matches-breakdown")).toHaveText(
      `${active} active · ${waiting} waiting`,
    );
  });

  test("does not move when the signal table below is filtered", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const total = await page
      .getByTestId("dashboard-matches-total")
      .textContent();
    const breakdown = await page
      .getByTestId("dashboard-matches-breakdown")
      .textContent();

    await page
      .getByTestId("dashboard-state-filter")
      .getByRole("button", { name: /^Active/ })
      .click();
    await expect(
      qaRows(page).filter({
        has: page.locator('[data-state="PENDING_TRIGGER"]'),
      }),
    ).toHaveCount(0);

    // The market did not change because the reader narrowed a table.
    await expect(page.getByTestId("dashboard-matches-total")).toHaveText(
      total ?? "",
    );
    await expect(page.getByTestId("dashboard-matches-breakdown")).toHaveText(
      breakdown ?? "",
    );
  });

  test("fits a 390px phone with no horizontal page overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-overview")).toBeVisible();

    // All five still present, still one row, still readable.
    for (const testId of CARD_TEST_IDS) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    await expect(
      page.getByTestId("dashboard-market-value-DJIA_INDEX"),
    ).toHaveText("51,778");

    // VIX becomes its compact phone form: label, level, zone — all legible, none clipped.
    const vix = page.getByTestId("dashboard-market-card-VIX_INDEX");
    await expect(vix).toContainText("VIX");
    await expect(
      page.getByTestId("dashboard-market-value-VIX_INDEX"),
    ).toBeVisible();
    await expect(
      page.getByTestId("dashboard-market-value-VIX_INDEX"),
    ).toHaveText("15.43");
    await expect(page.getByTestId("dashboard-vix-status")).toBeVisible();
    await expect(page.getByTestId("dashboard-vix-status")).toHaveText("Normal");
    const fontSizes = await vix.evaluate((card) =>
      [
        card.querySelector('[data-testid="dashboard-market-value-VIX_INDEX"]'),
        card.querySelector('[data-testid="dashboard-vix-status"]'),
      ].map((element) =>
        element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0,
      ),
    );
    for (const size of fontSizes) {
      expect(size).toBeGreaterThanOrEqual(9);
    }

    await expectNoHorizontalScroll(page);

    // And nothing inside the strip is clipped mid-word.
    const clipped = await page.evaluate(() => {
      const clippedElements: string[] = [];
      for (const element of document.querySelectorAll(
        '[data-testid="dashboard-overview"] *',
      )) {
        if (
          element.children.length === 0 &&
          element.scrollWidth > element.clientWidth + 1
        ) {
          clippedElements.push(element.textContent ?? "");
        }
      }
      return clippedElements;
    });
    expect(clipped).toEqual([]);
  });

  test("puts the cards above the current signals", async ({ page }) => {
    await page.goto("/dashboard");
    const stripBottom = await page
      .getByTestId("dashboard-overview")
      .evaluate((element) => element.getBoundingClientRect().bottom);
    const signalsTop = await page
      .getByTestId("dashboard-signals")
      .evaluate((element) => element.getBoundingClientRect().top);

    expect(stripBottom).toBeLessThan(signalsTop);
  });
});
