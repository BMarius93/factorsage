import type { StockListSummaryResponse } from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The compact management collection (`ai/architecture/ui-system.md`, "A compact collection"). On
 * Lists, with a collection large enough to page: the count in the heading, search and sort over the whole collection, header
 * sorting that is the Sort control's own order, page sizes, the two sections paged independently,
 * no footer while every row fits on the smallest page, the section kept as one surface on a phone,
 * and no sideways scroll at any width. On Strategies and Monitors, with the persona's own records:
 * the same surfaces at every width.
 *
 * The collection's size is injected over the hermetic API's real answer — the real rows are the
 * templates — so the cases stay deterministic; everything else is the real page.
 */

const LISTS = new RegExp(
  `^${apiBaseUrl().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/lists(\\?.*)?$`,
);

const WIDTHS = [390, 880, 1280, 1440, 1920] as const;

/** `count` copies of a template, named and sized so every order differs from the others. */
function copies(
  template: StockListSummaryResponse,
  prefix: string,
  count: number,
): StockListSummaryResponse[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, "0");
    return {
      ...template,
      id: `${prefix}-${String(index).padStart(3, "0")}`,
      // Names run against the API's order, so Name A–Z is a real re-sort of the whole collection.
      name: `${prefix} ${String(count - index).padStart(3, "0")}`,
      itemCount: ((index * 37) % 97) + 1,
      // Newest first, as the API returns them.
      createdAt: new Date(
        Date.UTC(2026, 8, 30, 0, 0, 0) - index * 3_600_000,
      ).toISOString(),
      updatedAt: `2026-0${1 + (index % 9)}-${day}T12:00:00.000Z`,
      compliance: { ...template.compliance, compliant: true },
    };
  });
}

async function injectLists(page: Page, own: number, builtIn: number) {
  await page.route(LISTS, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const real = (await response.json()) as StockListSummaryResponse[];
    const ownTemplate = real.find((list) => list.ownership !== "SYSTEM");
    const builtInTemplate = real.find((list) => list.ownership === "SYSTEM");
    if (!ownTemplate || !builtInTemplate) {
      throw new Error(
        "The hermetic catalog needs one own and one built-in list.",
      );
    }
    // A point-in-time universe line would only add height; these copies are ordinary lists.
    const plain = (
      list: StockListSummaryResponse,
    ): StockListSummaryResponse => {
      const copy = { ...list };
      delete copy.universe;
      return copy;
    };
    await route.fulfill({
      json: [
        ...copies(plain(ownTemplate), "Mine", own),
        ...copies(plain(builtInTemplate), "Platform", builtIn),
      ],
    });
  });
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
  }
}

function names(page: Page, section: string) {
  return page
    .getByTestId(section)
    .getByTestId("list-row")
    .locator('[data-column="name"] a > span:first-child');
}

test.describe("compact Lists collection", () => {
  test("searches, sorts and pages the whole collection, each section on its own", async ({
    page,
  }) => {
    await injectLists(page, 60, 30);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/lists");
    await dismissConsent(page);

    const own = page.getByTestId("your-lists");
    const builtIns = page.getByTestId("built-in-lists");
    await expect(own).toHaveAttribute("data-density", "compact");
    await expect(page.getByTestId("your-lists-count")).toHaveText("60 lists");
    await expect(page.getByTestId("built-in-lists-count")).toHaveText(
      "30 lists",
    );

    // 25 rows a page by default; the footer offers 10, 25, 50 and 100.
    await expect(names(page, "your-lists")).toHaveCount(25);
    const ownFooter = page.getByTestId("lists-footer");
    await expect(ownFooter).toContainText("Showing 1–25 of 60 lists");
    const rows = ownFooter.getByLabel("Rows");
    await expect(rows.locator("option")).toHaveText(["10", "25", "50", "100"]);

    // A header sorts the whole collection, not the page on screen, and the Sort control follows.
    const nameHeader = own.getByRole("columnheader", { name: /Name/ });
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(own.getByLabel("Sort")).toHaveValue("name");
    await expect(names(page, "your-lists").first()).toHaveText("Mine 001");
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    await expect(names(page, "your-lists").first()).toHaveText("Mine 060");

    // The sections page independently.
    await ownFooter.getByRole("button", { name: "Next" }).click();
    await expect(ownFooter).toContainText("Showing 26–50 of 60 lists");
    const builtInFooter = page.getByTestId("built-in-lists-footer");
    await expect(builtInFooter).toContainText("Showing 1–25 of 30 lists");

    // A search reaches every page and returns to the first; the count says how many match.
    await own.getByRole("searchbox", { name: "Search lists" }).fill("Mine 00");
    await expect(page.getByTestId("your-lists-count")).toHaveText(
      "9 of 60 lists",
    );
    await expect(names(page, "your-lists")).toHaveCount(9);
    // Nine rows fit on the smallest page: no footer.
    await expect(ownFooter).toHaveCount(0);
    await own.getByRole("searchbox", { name: "Search lists" }).fill("");

    // A smaller page, and the built-ins are still where they were.
    await page
      .getByTestId("lists-footer")
      .getByLabel("Rows")
      .selectOption("10");
    await expect(names(page, "your-lists")).toHaveCount(10);
    await expect(page.getByTestId("lists-footer")).toContainText("Page 1 of 6");
    await expect(builtInFooter).toContainText("Showing 1–25 of 30 lists");
    await expect(builtIns.getByLabel("Sort")).toHaveCount(0);
  });

  test("shows no footer while a section fits on the smallest page", async ({
    page,
  }) => {
    await injectLists(page, 10, 2);
    await page.goto("/lists");
    await dismissConsent(page);

    await expect(page.getByTestId("your-lists-count")).toHaveText("10 lists");
    await expect(names(page, "your-lists")).toHaveCount(10);
    await expect(page.getByTestId("lists-footer")).toHaveCount(0);
    await expect(page.getByTestId("built-in-lists-footer")).toHaveCount(0);
  });

  test("keeps one section surface with its rows stacked inside it, at every width", async ({
    page,
  }) => {
    await injectLists(page, 30, 3);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/lists");
      await dismissConsent(page);
      await expect(names(page, "your-lists")).toHaveCount(25);

      const layout = await page.evaluate(() => {
        const section = document.querySelector<HTMLElement>(
          '[data-testid="your-lists"]',
        )!;
        const row = section.querySelector<HTMLElement>(
          '[data-testid="list-row"]',
        )!;
        const sectionStyle = getComputedStyle(section);
        const rowStyle = getComputedStyle(row);
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          sectionBorder: sectionStyle.borderTopWidth,
          rowRadius: rowStyle.borderTopLeftRadius,
          rowLeftBorder: rowStyle.borderLeftWidth,
          rowRight: row.getBoundingClientRect().right,
          sectionRight: section.getBoundingClientRect().right,
        };
      });
      expect(
        layout.overflow,
        `${width}px: no sideways scroll`,
      ).toBeLessThanOrEqual(0);
      // The section is a surface at every width, a phone included…
      expect(layout.sectionBorder, `${width}px: section border`).toBe("1px");
      // …and a row is never a card of its own inside it.
      expect(layout.rowRadius, `${width}px: row radius`).toBe("0px");
      expect(layout.rowLeftBorder, `${width}px: row border`).toBe("0px");
      expect(layout.rowRight).toBeLessThanOrEqual(layout.sectionRight + 0.5);

      // The row's menu is reachable without scrolling sideways.
      const trigger = page
        .getByTestId("your-lists")
        .getByRole("button", { name: /^More actions for / })
        .first();
      const box = await trigger.boundingBox();
      expect(box, `${width}px: menu rendered`).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  });
});

test.describe("compact Strategies and Monitors collections", () => {
  for (const collection of [
    {
      path: "/strategies",
      page: "strategies-page",
      section: "your-strategies",
      row: "strategy-row",
    },
    {
      path: "/monitors",
      page: "monitors-page",
      section: "your-monitors",
      row: "monitor-card",
    },
  ] as const) {
    test(`${collection.path} keeps one section surface with its rows stacked inside it, at every width`, async ({
      page,
    }) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(collection.path);
        await dismissConsent(page);
        const section = page.getByTestId(collection.section);
        await expect(section).toHaveAttribute("data-density", "compact");
        await expect(section.getByTestId(collection.row).first()).toBeVisible();
        // The page opens with its title on the canvas, not in a card of its own.
        await expect(
          page.getByTestId(collection.page).locator('[data-variant="plain"]'),
        ).toHaveCount(1);

        const layout = await section.evaluate((element, row) => {
          const first = element.querySelector<HTMLElement>(
            `[data-testid="${row}"]`,
          )!;
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            sectionBorder: getComputedStyle(element).borderTopWidth,
            rowRadius: getComputedStyle(first).borderTopLeftRadius,
          };
        }, collection.row);
        expect(
          layout.overflow,
          `${width}px: no sideways scroll`,
        ).toBeLessThanOrEqual(0);
        expect(layout.sectionBorder, `${width}px: section border`).toBe("1px");
        expect(layout.rowRadius, `${width}px: row radius`).toBe("0px");
        // No second way to open a row: its name is the link.
        await expect(section.getByRole("link", { name: /^Open / })).toHaveCount(
          0,
        );
      }
    });
  }
});
