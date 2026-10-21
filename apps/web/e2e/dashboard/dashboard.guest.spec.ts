import type { DashboardActivityResponse } from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Dashboard as a first-time visitor meets it: the Monitor Activity feed, grouped by market
 * session, with the Market watch sidebar beside it from 1,280px (`docs/decisions/monitor-eod-v2.md`
 * §7, Dashboard V2). The sidebar itself is `market-watch.guest.spec.ts`.
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

/** The session heading of the group an event sits in. */
function sessionOf(row: ReturnType<typeof qaRows>) {
  return row
    .locator("xpath=ancestor::*[@data-testid='dashboard-session-group'][1]")
    .getByTestId("dashboard-session");
}

async function expectNoHorizontalScroll(page: Page, context = "") {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, context).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible()) {
    await reject.click();
  }
}

test.describe("guest dashboard", () => {
  test("shows the built-in monitors' observed activity without an account, one heading per session", async ({
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
    await expect(sessionOf(rows.first())).toHaveText("September 11, 2026");
    await expect(sessionOf(rows.nth(1))).toHaveText("September 10, 2026");
    await expect(sessionOf(rows.nth(2))).toHaveText("September 8, 2026");
    await expect(sessionOf(rows.nth(3))).toHaveText("September 1, 2026");
    // Every session is written once, however many events it holds.
    const headings = await page
      .getByTestId("dashboard-session")
      .allInnerTexts();
    expect(new Set(headings).size).toBe(headings.length);

    await expect(rows.first().getByTestId("dashboard-event-state")).toHaveText(
      "Activated",
    );
    await expect(
      rows.filter({
        has: page.getByTestId("dashboard-event-state").getByText("Ended"),
      }),
    ).toHaveCount(1);
    // A setup waiting for its trigger is not activity.
    await expect(rows.filter({ hasText: "QATEST2" })).toHaveCount(0);
    await expect(page.getByTestId("dashboard-freshness")).toContainText(
      "Updated",
    );
  });

  test("shows the level without its step, beside its state and its Monitor, with no Price or Monitor column", async ({
    page,
  }) => {
    for (const width of [1920, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const table = page.getByTestId("dashboard-activity");
      await expect(table.getByRole("columnheader")).toHaveText([
        "Stock",
        "Signal",
        "Conditions",
      ]);
      const rows = qaRows(page);
      await expect(rows).toHaveCount(4);
      for (const row of await rows.all()) {
        // `Buy`, never `Buy 1` — and the step is still the event's own.
        await expect(row.getByTestId("dashboard-event-level")).toHaveText(
          "Buy",
        );
        await expect(row).toHaveAttribute("data-level", "BUY");
        await expect(row).toHaveAttribute("data-level-index", "1");
        await expect(row).not.toContainText(/Buy 1/);
        // The Monitor is named on every event, linked to its page.
        await expect(
          row.getByTestId("dashboard-event-monitor").getByRole("link"),
        ).toHaveText(/QA Built-in Monitor [AB]/);
        // No standalone price: the activation price is not on the row.
        await expect(row).not.toContainText("$");
      }
      await expect(table.getByRole("link", { name: "Backtest" })).toHaveCount(
        0,
      );
      await expectNoHorizontalScroll(page, `${width}px`);
    }
    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("shows every condition with the values that decided it, the ending's failure included", async ({
    page,
  }) => {
    await page.goto("/");
    const ended = qaRows(page).filter({
      has: page.getByTestId("dashboard-event-state").getByText("Ended"),
    });
    const conditions = ended.getByTestId("dashboard-conditions");
    await expect(conditions).toHaveAttribute("data-basis", "EVIDENCE");
    const lines = ended.getByTestId("dashboard-condition");
    // One line per predicate, in the Strategy's order: two Conditions and the Trigger, ANDed.
    await expect(lines).toHaveCount(3);
    await expect(
      lines.getByTestId("dashboard-condition-expression"),
    ).toHaveText([
      "SMA 50D is above SMA 200D",
      "Price is above SMA 200D",
      "Price crosses above SMA 20D",
    ]);
    await expect(lines.nth(0)).toHaveAttribute("data-result", "TRUE");
    await expect(lines.nth(1)).toHaveAttribute("data-result", "FALSE");
    await expect(lines.nth(1)).toContainText("and");
    await expect(
      lines.nth(1).getByTestId("dashboard-condition-values"),
    ).toHaveText("90.25 < 92.10");
    await expect(lines.nth(1)).toContainText("did not hold");
    await expect(lines.nth(2)).toHaveAttribute("data-role", "TRIGGER");
    await expect(
      lines.nth(2).getByTestId("dashboard-condition-values"),
    ).toHaveText("87.25 → 90.25 > 88.75");
  });

  test("filters by Monitor, by event, and by both, and offers to clear a filter that matches nothing", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(qaRows(page)).toHaveCount(4);
    const monitorFilter = page.getByTestId("dashboard-monitor-filter");
    const eventFilter = page.getByTestId("dashboard-event-filter");
    await expect(monitorFilter).toHaveValue("ALL");
    await expect(eventFilter).toHaveValue("ALL");

    await monitorFilter.selectOption({ label: MONITOR_A });
    await expect(qaRows(page)).toHaveCount(3);
    await expect(qaRows(page).filter({ hasText: MONITOR_B })).toHaveCount(0);
    // The filter holds the Monitor's id, not its name.
    expect(await monitorFilter.inputValue()).toMatch(/^[0-9a-f-]{36}$/);

    await eventFilter.selectOption({ label: "Activated" });
    await expect(qaRows(page)).toHaveCount(2);
    for (const row of await qaRows(page).all()) {
      await expect(row.getByTestId("dashboard-event-state")).toHaveText(
        "Activated",
      );
    }

    await eventFilter.selectOption({ label: "Ended" });
    await expect(qaRows(page)).toHaveCount(1);
    await expect(sessionOf(qaRows(page).first())).toHaveText(
      "September 8, 2026",
    );

    await monitorFilter.selectOption({ label: MONITOR_B });
    const empty = page.getByTestId("dashboard-activity-empty");
    await expect(empty).toContainText("No matching activity");
    await empty.getByTestId("dashboard-clear-filters").click();
    await expect(qaRows(page)).toHaveCount(4);
    await expect(monitorFilter).toHaveValue("ALL");
    await expect(eventFilter).toHaveValue("ALL");
  });

  test("filters the whole history in the API, page after page", async ({
    page,
  }) => {
    // One event per page, followed to the end: every page is of the filtered kind, and the pages
    // together are exactly the filtered feed — not a filtered first page.
    const collect = async (query: string) => {
      const seen: DashboardActivityResponse["events"] = [];
      let cursor: string | undefined;
      do {
        const response = await page.request.get(
          `${apiBaseUrl()}/dashboard/activity?${query}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(response.status()).toBe(200);
        const body = (await response.json()) as DashboardActivityResponse;
        seen.push(...body.events);
        cursor = body.nextCursor;
      } while (cursor);
      return seen.filter((event) =>
        /^QA Built-in Monitor/.test(event.monitor.name),
      );
    };
    const activated = await collect("kind=ACTIVATED");
    expect(activated.map((event) => [event.sessionDate, event.kind])).toEqual([
      ["2026-09-11", "ACTIVATED"],
      ["2026-09-10", "ACTIVATED"],
      ["2026-09-01", "ACTIVATED"],
    ]);
    const ended = await collect("kind=RESOLVED");
    expect(ended.map((event) => [event.sessionDate, event.kind])).toEqual([
      ["2026-09-08", "RESOLVED"],
    ]);
  });

  test("opens Stock Details from a row", async ({ page }) => {
    await page.goto("/");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    // A click anywhere that is not itself a control opens the stock.
    await row.getByTestId("dashboard-event-level").click();
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

  test("stacks each event on a phone, every condition shown, without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await dismissConsent(page);
    await expect(qaRows(page)).toHaveCount(4);
    const card = qaRows(page).first();
    const box = await card.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
    // The stock and the signal share the first line; the conditions run full width under them.
    const top = (testId: string) =>
      card
        .getByTestId(testId)
        .evaluate((element) => Math.round(element.getBoundingClientRect().top));
    expect(
      Math.abs(
        (await top("dashboard-stock")) - (await top("dashboard-event-level")),
      ),
    ).toBeLessThanOrEqual(4);
    await expect(card.getByTestId("dashboard-condition")).toHaveCount(3);
    for (const line of await card.getByTestId("dashboard-condition").all()) {
      await expect(line).toBeVisible();
    }
    await expect(card.getByTestId("dashboard-event-monitor")).toContainText(
      MONITOR_B,
    );
    // The ticker is never what gives way.
    const tickerClipped = await card
      .getByTestId("dashboard-stock")
      .evaluate((identity) =>
        [...identity.querySelectorAll<HTMLElement>('[class*="symbol"]')].some(
          (symbol) => symbol.scrollWidth > symbol.clientWidth + 1,
        ),
      );
    expect(tickerClipped).toBe(false);
    // The filters stay on a phone, side by side.
    await expect(page.getByTestId("dashboard-monitor-filter")).toBeVisible();
    await expect(page.getByTestId("dashboard-event-filter")).toBeVisible();
    await expectNoHorizontalScroll(page, "390px");
  });

  test("opens on the activity, with the freshness beside its heading and no introduction", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-main")).toBeVisible();
    // The feed's column starts right under the topbar — nothing above it but the Guest's notice.
    const main = await page.getByTestId("dashboard-main").boundingBox();
    const topbar = await page.locator("header").first().boundingBox();
    expect(
      Math.abs((main?.y ?? 0) - ((topbar?.y ?? 0) + (topbar?.height ?? 0))),
    ).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("market-overview")).toHaveCount(0);

    await expect(
      page.getByRole("heading", { level: 2, name: "Monitor activity" }),
    ).toBeVisible();
    await expect(page.getByTestId("dashboard-activity-section")).toContainText(
      "Updated",
    );
    const dashboard = page.getByTestId("dashboard-page");
    await expect(dashboard).not.toContainText("Current matches");
    await expect(dashboard).not.toContainText(/\blive\b|real-time/i);
  });

  test("wraps a long Monitor name onto at most two lines, whole on hover", async ({
    page,
  }) => {
    for (const width of [1920, 1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(qaRows(page)).toHaveCount(4);
      const chips = await qaRows(page)
        .first()
        .getByTestId("dashboard-event-monitor")
        .locator("[data-kind]")
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
            };
          }),
        );
      expect(chips, `${width}px`).toHaveLength(1);
      for (const chip of chips) {
        expect(chip.lines, `${width}px ${chip.name}`).toBeLessThanOrEqual(2);
        expect(chip.title).toBe(chip.name);
      }
      await expectNoHorizontalScroll(page, `${width}px`);
    }
  });

  test("offers no Run Backtest on the Dashboard, and leaves the Backtests area in the navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();

    await expect(page.getByTestId("dashboard-run-backtest")).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-page").getByText(/run backtest/i),
    ).toHaveCount(0);
    // Backtesting is where it always was: one entry in the main navigation.
    await expect(
      page
        .getByRole("navigation", { name: "Primary", exact: true })
        .getByRole("link", { name: "Backtests" }),
    ).toHaveAttribute("href", "/backtests");
  });

  test("has no summary card above the activity, and names the activity once", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();

    await expect(page.getByTestId("dashboard-overview")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-card")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-total")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-page")).not.toContainText(
      "Current matches",
    );
    await expect(
      page.getByRole("heading", { level: 2, name: "Monitor activity" }),
    ).toHaveCount(1);
    expect(
      await page.getByTestId("dashboard-activity-row").count(),
    ).toBeGreaterThan(0);
  });
});
