import { expect, test } from "../fixtures";
import { fixtureName } from "../utils/entitlements";
import {
  createList,
  deleteListIfPresent,
  readList,
  readOwnLists,
  replaceBuyWindows,
} from "../utils/lists";

/**
 * A list's members, a page at a time: 25 by default, a Current / Former / All filter where
 * membership is dated, and a stock just added brought onto the page that holds it and tinted —
 * even when the filter in force would have hidden it.
 *
 * The members are borrowed from the persona's seeded `Pro Wide` fixture (`pnpm test:personas:seed`),
 * so the spec never depends on the provider; its own list is created and deleted here.
 */

const WIDTHS = [390, 880, 1280, 1440, 1920] as const;

test.describe("List members, paged and filtered", () => {
  let listId: string | null = null;

  test.afterEach(async ({ page }) => {
    await deleteListIfPresent(page, listId);
    listId = null;
  });

  test("pages the members, filters them by membership, and takes the reader to a stock just added", async ({
    page,
  }) => {
    const source = (await readOwnLists(page)).find(
      (list) => list.name === fixtureName("Pro Wide"),
    );
    expect(
      source,
      "The Pro Wide fixture is missing. Seed it with: pnpm test:personas:seed",
    ).toBeTruthy();
    const pool = (await readList(page, source!.id)).items.map(
      (item) => item.security,
    );
    expect(pool.length).toBeGreaterThan(41);

    const created = await createList(
      page,
      `E2E paged members ${Date.now()}`,
      pool.slice(0, 40).map((security) => security.id),
    );
    listId = created.id;
    // One member left the list's universe at the end of 2020: the one former member.
    const former = created.items[3]!;
    await replaceBuyWindows(page, created.id, former.id, {
      mode: "CUSTOM",
      ranges: [{ startDate: "2018-01-02", endDate: "2020-12-31" }],
    });

    await page.goto(`/lists/${created.id}`);
    const members = page.getByTestId("list-item");
    await expect(members).toHaveCount(25);
    await expect(page.getByTestId("list-items-count")).toHaveText("40 stocks");
    const footer = page.getByTestId("list-items-footer");
    await expect(footer).toContainText("Showing 1–25 of 40 stocks");

    // Membership is dated here, so the filter is offered.
    const filter = page.getByTestId("list-membership-filter");
    await filter.selectOption("former");
    await expect(members).toHaveCount(1);
    await expect(members.first()).toContainText(former.security.symbol);
    await expect(page.getByTestId("list-items-count")).toHaveText(
      "1 of 40 stocks",
    );
    // One row fits the smallest page: no footer.
    await expect(footer).toHaveCount(0);

    // Adding a stock while the filter would hide it: the filter gives way, the page that holds the
    // new stock opens, and its row is tinted and on screen.
    const extra = pool[40]!;
    const search = page.getByRole("combobox", {
      name: "Search stocks to add to this list",
    });
    await search.fill(extra.symbol);
    await page
      .getByRole("option")
      .filter({ hasText: extra.symbol })
      .first()
      .click();
    await page.getByTestId("add-stocks-button").click();

    await expect(filter).toHaveValue("all");
    const added = members.filter({ hasText: extra.symbol });
    await expect(added).toHaveAttribute("data-highlight", "true");
    await expect(added).toBeInViewport();
    await expect(page.getByTestId("list-items-footer")).toContainText(
      "Showing 26–41 of 41 stocks",
    );
    await expect(added).not.toHaveAttribute("data-highlight", "true", {
      timeout: 5_000,
    });

    // Current members: every stock but the one that left.
    await filter.selectOption("current");
    await expect(page.getByTestId("list-items-count")).toHaveText(
      "40 of 41 stocks",
    );
  });

  test("keeps the members one section surface, rows stacked inside it, at every width", async ({
    page,
  }) => {
    const source = (await readOwnLists(page)).find(
      (list) => list.name === fixtureName("Pro Wide"),
    );
    expect(source).toBeTruthy();
    const pool = (await readList(page, source!.id)).items.map(
      (item) => item.security,
    );
    const created = await createList(
      page,
      `E2E paged members layout ${Date.now()}`,
      pool.slice(0, 30).map((security) => security.id),
    );
    listId = created.id;

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/lists/${created.id}`);
      await expect(page.getByTestId("list-item")).toHaveCount(25);
      const layout = await page
        .locator('section[aria-labelledby="list-members-title"]')
        .evaluate((section) => {
          const row = section.querySelector<HTMLElement>(
            '[data-testid="list-item"]',
          )!;
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            sectionBorder: getComputedStyle(section).borderTopWidth,
            rowRadius: getComputedStyle(row).borderTopLeftRadius,
          };
        });
      expect(
        layout.overflow,
        `${width}px: no sideways scroll`,
      ).toBeLessThanOrEqual(0);
      expect(layout.sectionBorder, `${width}px: section border`).toBe("1px");
      expect(layout.rowRadius, `${width}px: row radius`).toBe("0px");
    }
  });
});
