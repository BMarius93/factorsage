import { expect, test, type Page } from "../fixtures";

/**
 * The Dashboard as a first-time visitor meets it.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`: the QA built-ins put one security
 * active under two built-in monitors and one setup waiting for its trigger, so the rows asserted
 * here are exact.
 *
 * The page is only the signals table. Which monitors feed it is configured on the Monitors page,
 * and the Guest's side of that is covered in `e2e/builtins/collections.guest.spec.ts`.
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
    await page.goto("/");
    await expect(page).toHaveURL("/");
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
    await expect(page.getByTestId("dashboard-freshness")).toContainText(
      "Updated",
    );
  });

  test("reports one signal per row with the agreed columns and no repeated call to action", async ({
    page,
  }) => {
    await page.goto("/");
    const table = page.getByTestId("dashboard-signals");
    await expect(table).toBeVisible();

    await expect(table.getByRole("columnheader")).toHaveText([
      "Stock",
      "Action",
      "Since",
      "Why",
      "Price",
      "Strategy",
      "List",
      "Monitor",
    ]);
    // "Since" says when each signal's state began (UI-025). Still removed deliberately: a Backtest
    // button on every single row.
    await expect(table.getByRole("link", { name: "Backtest" })).toHaveCount(0);
    // And no monitor configuration: that lives on the Monitors page now.
    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("filters by state and by action, and composes the two", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(qaRows(page)).toHaveCount(3);

    const states = page.getByTestId("dashboard-state-filter");
    await states.getByRole("button", { name: /^Waiting/ }).click();
    await expect(qaRows(page)).toHaveCount(1);
    await expect(qaRows(page)).toContainText("QATEST2");

    await states.getByRole("button", { name: /^All/ }).click();
    await expect(qaRows(page)).toHaveCount(3);

    // The action filter is a dropdown, not a second pill group.
    const actions = page.getByTestId("dashboard-level-filter");
    await actions.selectOption("BUY");
    await expect(qaRows(page)).toHaveCount(3);
    await actions.selectOption("SELL");
    await expect(qaRows(page)).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-signals-filtered-empty"),
    ).toBeVisible();

    // State AND action.
    await actions.selectOption("BUY");
    await states.getByRole("button", { name: /^Active/ }).click();
    await expect(qaRows(page)).toHaveCount(2);
  });

  test("opens Stock Details from a row", async ({ page }) => {
    await page.goto("/");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    // A click anywhere that is not itself a control opens the stock.
    await row.getByText("Buy 100%").click();
    await expect(page).toHaveURL(/\/stocks\/QATEST1$/);
  });

  test("links the strategy, the list and the monitor behind a row independently", async ({
    page,
  }) => {
    await page.goto("/");
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

    await page.goBack();
    await qaRows(page)
      .filter({ hasText: MONITOR_B })
      .first()
      .getByRole("link", { name: MONITOR_B })
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
  });

  test("renders phone record cards without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(qaRows(page)).toHaveCount(3);
    // Record cards: every row fits the phone's width, and the page never scrolls sideways.
    const card = qaRows(page).first();
    const box = await card.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
    // The three relationships stay legible inside the card rather than being cut off.
    await expect(card).toContainText("Strategy");
    await expect(card).toContainText("List");
    await expect(card).toContainText("Monitor");
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("opens on the matches, with the freshness beside them and no introduction", async ({
    page,
  }) => {
    await page.goto("/");

    // No hero: the market strip is the first thing under the topbar, and the sentence that
    // explained what a dashboard is has gone with it.
    await expect(page.getByTestId("dashboard-overview")).toBeVisible();
    await expect(
      page.getByText("Current matches and setups from your monitors"),
    ).toHaveCount(0);
    const strip = await page.getByTestId("dashboard-overview").boundingBox();
    const topbar = await page.locator("header").first().boundingBox();
    // Within one page gutter of the chrome, rather than a card-height below it.
    expect(
      (strip?.y ?? 0) - ((topbar?.y ?? 0) + (topbar?.height ?? 0)),
    ).toBeLessThan(64);

    // The freshness survived the hero, inside the section it describes.
    const freshness = page.getByTestId("dashboard-freshness");
    await expect(freshness).toContainText("Updated");
    await expect(
      page.getByRole("heading", { level: 2, name: "Current matches" }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("dashboard-signals")
        .locator("xpath=ancestor::section[1]"),
    ).toContainText("Updated");
  });

  test("says matches, and never how a row's state was reconstructed", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();

    const dashboard = page.getByTestId("dashboard-page");
    await expect(dashboard).not.toContainText("Current signals");
    // Provenance is engine detail; the Dashboard shows the age and stops there.
    await expect(dashboard).not.toContainText("from history");
    await expect(page.getByTestId("dashboard-since").first()).toContainText(
      /ago|just now/,
    );
  });

  test("keeps a long Strategy, List and Monitor name readable on two lines", async ({
    page,
  }) => {
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(qaRows(page)).toHaveCount(3);

      const chips = await qaRows(page)
        .first()
        .locator('td[data-card="links"] [data-lines="2"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const label = node.firstElementChild as HTMLElement;
            const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
            return {
              name: node.textContent ?? "",
              title: node.getAttribute("title") ?? "",
              lines: Math.round(
                label.getBoundingClientRect().height / lineHeight,
              ),
              clipped: label.scrollHeight > label.clientHeight + 1,
            };
          }),
        );

      expect(chips, `${width}px`).toHaveLength(3);
      for (const chip of chips) {
        // Two lines at most, and the whole name is always reachable.
        expect(chip.lines, `${width}px ${chip.name}`).toBeLessThanOrEqual(2);
        expect(chip.title).toBe(chip.name);
      }
      // Wrapping must not push the table sideways at any of these widths.
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

    // Every fact the row carries is still on the card …
    await expect(card.getByTestId("dashboard-stock")).toBeVisible();
    await expect(card.getByTestId("dashboard-since")).toBeVisible();
    await expect(card).toContainText("$");
    await expect(card.locator('[data-card="status"]')).toBeVisible();

    // … but the labelled rows that cost the most height are gone: the age and the price share
    // one unlabelled summary line, and the reason is prose rather than a labelled block.
    const summary = card.locator('td[data-card="summary"]');
    await expect(summary).toHaveCount(2);
    await expect(summary.first()).not.toContainText(/SINCE/i);
    await expect(summary.last()).not.toContainText(/PRICE/i);
    const summaryTops = await summary.evaluateAll((cells) =>
      cells.map((cell) => Math.round(cell.getBoundingClientRect().top)),
    );
    expect(summaryTops[0]).toBe(summaryTops[1]);

    // A card with a trigger and three relationships stays well inside a phone screen.
    const box = await card.boundingBox();
    expect(box?.height ?? Infinity).toBeLessThan(300);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
