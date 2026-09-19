import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { createList, findSecurityId } from "../utils/lists";

/**
 * One realistic long name must not break a collection (UI-001, UI-002, UI-006).
 *
 * Names may be 120 characters long. A relationship chip used to truncate its label visually while
 * keeping its full max-content width, so one long list name widened the Monitors table to 2,110px,
 * pushed `Open` and `…` off-screen and broke the monitor's own name mid-word. This arranges exactly
 * that — a monitor, strategy and list each named with 120 characters — and checks the collection at
 * every width the cleanup plan names: no document overflow, and the row's actions reachable without
 * scrolling anything sideways.
 *
 * The monitor is created disabled, so it never takes the persona's active-monitor capacity, and
 * everything is deleted afterwards. Needs `pnpm test:securities:seed`.
 */

const LONG =
  "Global dividend aristocrats with twenty-five consecutive years of increases — core income sleeve, rebalanced every quarter".slice(
    0,
    120,
  );
const MONITOR_NAME = `E2E long ${LONG}`.slice(0, 120);

const WIDTHS = [390, 879, 880, 1024, 1280, 1440] as const;

type Created = { monitorId: string; strategyId: string; listId: string };

async function arrange(page: Page): Promise<Created> {
  const securityId = await findSecurityId(page, "QATEST1");
  expect(securityId, "QATEST1 is seeded by pnpm test:securities:seed").not.toBeNull();
  const list = await createList(page, `List ${LONG}`.slice(0, 120), [securityId!]);
  const strategy = await page.request.post(`${apiBaseUrl()}/strategies`, {
    data: {
      name: `Strategy ${LONG}`.slice(0, 120),
      definition: {
        schemaVersion: 2,
        buyLevels: [
          {
            id: "b1",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "b1c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      },
    },
  });
  expect(strategy.ok(), await strategy.text()).toBe(true);
  const strategyId = ((await strategy.json()) as { id: string }).id;
  const monitor = await page.request.post(`${apiBaseUrl()}/monitors`, {
    data: {
      name: MONITOR_NAME,
      strategyId,
      stockListId: list.id,
      enabled: false,
    },
  });
  expect(monitor.ok(), await monitor.text()).toBe(true);
  return {
    monitorId: ((await monitor.json()) as { id: string }).id,
    strategyId,
    listId: list.id,
  };
}

test.describe("long entity names", () => {
  let created: Created | undefined;

  test.afterEach(async ({ page }) => {
    if (!created) {
      return;
    }
    // Monitor first: a strategy or list a monitor references cannot be deleted.
    await page.request.delete(`${apiBaseUrl()}/monitors/${created.monitorId}`);
    await page.request.delete(`${apiBaseUrl()}/strategies/${created.strategyId}`);
    await page.request.delete(`${apiBaseUrl()}/lists/${created.listId}`);
    created = undefined;
  });

  test("keep the monitors collection inside the viewport with its actions reachable", async ({
    page,
  }) => {
    created = await arrange(page);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/monitors");
      const row = page
        .getByTestId("monitor-card")
        .filter({ hasText: MONITOR_NAME.slice(0, 30) });
      await expect(row).toHaveCount(1);

      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      expect(layout.overflow, `document overflow at ${width}px`).toBeLessThanOrEqual(0);

      const open = row.getByRole("link", { name: `Open ${MONITOR_NAME}` });
      const trigger = row.getByRole("button", {
        name: `More actions for ${MONITOR_NAME}`,
      });
      for (const control of [open, trigger]) {
        const box = await control.boundingBox();
        expect(box, `${width}px: action rendered`).not.toBeNull();
        // Inside the viewport, and inside the table's own surface — no sideways scroll needed.
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        const surfaceRight = await control.evaluate(
          (element) =>
            element.closest("table")!.parentElement!.getBoundingClientRect().right,
        );
        expect(box!.x + box!.width).toBeLessThanOrEqual(surfaceRight + 1);
      }

      // The maintenance menu opens fully on screen at every width, including the phone card
      // where it used to open past the left edge (UI-006).
      await trigger.click();
      const menuId = await trigger.getAttribute("aria-controls");
      const menu = page.locator(`[id="${menuId}"]`);
      const menuBox = await menu.boundingBox();
      expect(menuBox!.x, `${width}px: menu left edge`).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
  });
});
