import { expect, test, type Locator, type Page } from "../fixtures";

/**
 * The Dashboard as a first-time visitor meets it: the market overview, then the Monitor Activity
 * feed (`docs/decisions/monitor-eod-v2.md` §6).
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`: the QA built-ins record four observed
 * changes — QATEST1 activated under Monitor A on Sep 1, ended on Sep 8 and activated again on Sep 10,
 * and activated under Monitor B on Sep 11 — plus a setup waiting for its trigger, which is not
 * activity. Each is written with the version and evidence that decided it, and checkpointed, so a
 * running worker leaves them exactly as declared.
 */

const MONITOR_A = "QA Built-in Monitor A";
const MONITOR_B = "QA Built-in Monitor B";

function qaRows(page: Page) {
  return page
    .getByTestId("dashboard-activity-row")
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
  test("shows the built-in monitors' observed activity without an account", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard-guest-notice")).toBeVisible();
    await expect(page.getByTestId("sign-in-link")).toBeVisible();

    const rows = qaRows(page);
    await expect(rows).toHaveCount(4);
    // Newest session first; the same security under two monitors is two events.
    await expect(rows.first()).toContainText(MONITOR_B);
    await expect(rows.first().getByTestId("dashboard-session")).toHaveText(
      "Sep 11, 2026",
    );
    await expect(rows.first()).toContainText("Activated");
    await expect(
      rows.filter({ hasText: "Ended · conditions no longer hold" }),
    ).toHaveCount(1);
    // A setup waiting for its trigger is not activity.
    await expect(rows.filter({ hasText: "QATEST2" })).toHaveCount(0);
    await expect(page.getByTestId("dashboard-freshness")).toContainText(
      "Updated",
    );
  });

  test("reports one event per row with the agreed columns and no repeated call to action", async ({
    page,
  }) => {
    await page.goto("/");
    const table = page.getByTestId("dashboard-activity");
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText([
      "Stock",
      "Signal",
      "Session",
      "Why",
      "Price",
      "Monitor",
    ]);
    await expect(table.getByRole("link", { name: "Backtest" })).toHaveCount(0);
    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("explains each event with the values that decided it", async ({
    page,
  }) => {
    await page.goto("/");
    const ended = qaRows(page).filter({
      hasText: "Ended · conditions no longer hold",
    });
    const why = ended.getByTestId("dashboard-why");
    await expect(why).toHaveAttribute("data-basis", "EVIDENCE");
    await expect(why).toContainText("Price is above SMA 200D (90.25 vs 92.10)");
    await expect(why).toContainText("did not hold");
  });

  test("narrows the feed to one monitor", async ({ page }) => {
    await page.goto("/");
    await expect(qaRows(page)).toHaveCount(4);
    await page.getByTestId("dashboard-monitor-filter").selectOption({
      label: MONITOR_A,
    });
    await expect(qaRows(page)).toHaveCount(3);
    await expect(qaRows(page).filter({ hasText: MONITOR_B })).toHaveCount(0);
  });

  test("opens Stock Details from a row", async ({ page }) => {
    await page.goto("/");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    // A click anywhere that is not itself a control opens the stock.
    await row.getByText("Buy 1", { exact: true }).click();
    await expect(page).toHaveURL(/\/stocks\/QATEST1$/);
  });

  test("links the monitor that observed an event", async ({ page }) => {
    await page.goto("/");
    await qaRows(page)
      .filter({ hasText: MONITOR_B })
      .first()
      .getByRole("link", { name: MONITOR_B })
      .first()
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
  });

  test("renders phone record cards without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(qaRows(page)).toHaveCount(4);
    const card = qaRows(page).first();
    const box = await card.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
    await expect(card.getByTestId("dashboard-card-monitor")).toContainText(
      "Monitor",
    );
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("opens on the activity, with the freshness beside it and no introduction", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("market-overview")).toBeVisible();
    const market = await page.getByTestId("market-overview").boundingBox();
    const topbar = await page.locator("header").first().boundingBox();
    expect(
      (market?.y ?? 0) - ((topbar?.y ?? 0) + (topbar?.height ?? 0)),
    ).toBeLessThan(64);

    await expect(
      page.getByRole("heading", { level: 2, name: "Monitor activity" }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("dashboard-activity")
        .locator("xpath=ancestor::section[1]"),
    ).toContainText("Updated");
    const dashboard = page.getByTestId("dashboard-page");
    await expect(dashboard).not.toContainText("Current matches");
    await expect(dashboard).not.toContainText(/\blive\b|real-time/i);
  });

  test("wraps a long Monitor name onto at most two centred lines, whole on hover", async ({
    page,
  }) => {
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(qaRows(page)).toHaveCount(4);
      const chips = await qaRows(page)
        .first()
        .locator('td[data-card="hidden"] [data-kind]')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const label = node.firstElementChild as HTMLElement;
            const style = getComputedStyle(label);
            const lineHeight = parseFloat(style.lineHeight);
            const text = label.getBoundingClientRect();
            return {
              name: node.textContent ?? "",
              title: node.getAttribute("title") ?? "",
              lines: Math.round(text.height / lineHeight),
              align: style.textAlign,
            };
          }),
        );
      expect(chips, `${width}px`).toHaveLength(1);
      for (const chip of chips) {
        expect(chip.lines, `${width}px ${chip.name}`).toBeLessThanOrEqual(2);
        expect(chip.align).toBe("center");
        expect(chip.title).toBe(chip.name);
      }
      await expectNoHorizontalScroll(page);
      const tableOverflow = await page.evaluate(() => {
        const scroll = document.querySelector("table")?.parentElement;
        return scroll ? scroll.scrollWidth - scroll.clientWidth : 0;
      });
      expect(tableOverflow, `${width}px table overflow`).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("packs a phone card into one screen's worth of scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const card = qaRows(page).first();
    await expect(card).toBeVisible();

    await expect(card.getByTestId("dashboard-stock")).toBeVisible();
    await expect(card.getByTestId("dashboard-session")).toBeVisible();
    await expect(card).toContainText("$");
    await expect(card.locator('[data-card="status"]')).toBeVisible();

    // DB-1: the stock shares the card's first line with its price, and the signal shares the next
    // with the session it was decided on — the price and the session unlabelled.
    const summary = card.locator('td[data-card="summary"]');
    await expect(summary).toHaveCount(2);
    const price = card.locator('td[data-column="price"]');
    const session = card.locator('td[data-column="session"]');
    await expect(session).not.toContainText(/SESSION/i);
    await expect(price).not.toContainText(/PRICE/i);
    const top = (cell: Locator) =>
      cell.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top),
      );
    expect(await top(price)).toBe(
      await top(card.locator('td[data-card="identity"]')),
    );
    expect(await top(session)).toBe(
      await top(card.locator('td[data-card="status"]')),
    );
    expect(await top(session)).toBeGreaterThan(await top(price));
    // And the ticker is never what gives way to them.
    const tickerClipped = await card
      .getByTestId("dashboard-stock")
      .evaluate((identity) =>
        [...identity.querySelectorAll<HTMLElement>('[class*="symbol"]')].some(
          (symbol) => symbol.scrollWidth > symbol.clientWidth + 1,
        ),
      );
    expect(tickerClipped).toBe(false);

    await expect(card.locator('td[data-card="links"]')).toHaveCount(0);
    await expect(card.getByTestId("dashboard-card-monitor")).toHaveText(
      /^Monitor.+$/,
    );
    const box = await card.boundingBox();
    expect(box?.height ?? Infinity).toBeLessThan(340);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
