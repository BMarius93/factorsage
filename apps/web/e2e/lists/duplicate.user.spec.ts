import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import {
  createList,
  deleteListIfPresent,
  findSecurityId,
  itemOf,
  readList,
  replaceBuyWindows,
  type ApiList,
} from "../utils/lists";
import {
  chooseFromOverflowMenu,
  overflowMenuActions,
} from "../utils/overflow-menu";

/**
 * Duplicating a list from the Lists collection, for PRO_USER.
 *
 * A copy is a list of the customer's own holding the source's members and membership periods, and
 * the browser lands on its page ready to edit. The source — the customer's own list or a built-in —
 * is left exactly as it was.
 *
 * Needs the QA catalog rows and the QA built-ins: `pnpm test:securities:seed` and
 * `pnpm test:builtins:seed`, both part of `pnpm test:personas:seed`.
 */

const QA_SYMBOL_ONE = "QATEST1";
const QA_SYMBOL_TWO = "QATEST2";
const QA_BUILT_IN_LIST = "QA Built-in Newcomers";

type OwnedList = ApiList & {
  readonly ownership: "USER" | "SYSTEM";
  readonly canEdit: boolean;
  readonly systemKey?: string;
};

function collectionRow(page: Page, section: string, name: string): Locator {
  return page
    .getByTestId(section)
    .locator("tbody tr")
    .filter({ hasText: name });
}

function memberRow(page: Page, symbol: string): Locator {
  return page
    .getByTestId("list-items")
    .locator("tbody tr")
    .filter({ hasText: symbol });
}

/** What a list holds as configuration, in list order, with every identity left out. */
function configurationOf(list: ApiList) {
  return list.items.map((item) => ({
    symbol: item.security.symbol,
    buyWindowMode: item.buyWindowMode,
    buyWindows: item.buyWindows,
  }));
}

function listIdOf(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("PRO_USER duplicates lists", () => {
  test("copies a list with its members and membership periods, then opens the copy to edit", async ({
    page,
  }) => {
    const sourceName = `QA Duplicate Source ${Date.now()}`;
    const copyName = `${sourceName} (mine)`;
    let sourceId: string | null = null;
    let copyId: string | null = null;

    try {
      await page.goto("/lists");
      const [one, two] = await Promise.all([
        findSecurityId(page, QA_SYMBOL_ONE),
        findSecurityId(page, QA_SYMBOL_TWO),
      ]);
      test.skip(
        one === null || two === null,
        "The QA catalog rows are missing. Run `pnpm test:securities:seed`.",
      );
      // Arranged through the API: QATEST1 was a member twice, the second time still open-ended;
      // QATEST2 is always eligible.
      const created = await createList(page, sourceName, [
        one as string,
        two as string,
      ]);
      sourceId = created.id;
      await replaceBuyWindows(
        page,
        created.id,
        itemOf(created, QA_SYMBOL_ONE).id,
        {
          mode: "CUSTOM",
          ranges: [
            { startDate: "2001-03-10", endDate: "2008-07-15" },
            { startDate: "2012-05-01", endDate: null },
          ],
        },
      );
      const source = await readList(page, created.id);

      await page.goto("/lists");
      const row = collectionRow(page, "your-lists", sourceName);
      expect(await overflowMenuActions(page, sourceName, row)).toEqual([
        "Rename",
        "Duplicate",
        "Delete",
      ]);
      await page.keyboard.press("Escape");
      await chooseFromOverflowMenu(page, sourceName, "Duplicate", row);

      const dialog = page.getByTestId("duplicate-dialog");
      await expect(
        dialog.getByRole("heading", { name: "Duplicate list" }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Create an independent copy that you can edit."),
      ).toBeVisible();
      const name = dialog.getByLabel("Name");
      await expect(name).toHaveValue(`${sourceName} — Copy`);
      await expect(name).toBeFocused();
      await name.fill(copyName);
      await dialog
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();

      // Straight onto the copy's own page, which the customer can edit.
      await expect(page.getByTestId("list-detail")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
      copyId = listIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expect(page.getByRole("heading", { name: copyName })).toBeVisible();
      await expect(page.getByTestId("add-stocks-button")).toBeVisible();
      await expect(page.getByTestId("built-in-badge")).toHaveCount(0);
      const first = memberRow(page, QA_SYMBOL_ONE).getByTestId("membership");
      await expect(first).toContainText("Member now · since May 1, 2012");
      await expect(first.getByTestId("membership-periods-toggle")).toHaveText(
        "2 periods",
      );
      await expect(memberRow(page, QA_SYMBOL_TWO)).toContainText(
        "Always eligible",
      );
      // A list's own page offers no Duplicate: copying starts from the collection.
      await expect(
        page.getByRole("button", { name: "Duplicate", exact: true }),
      ).toHaveCount(0);

      // The same configuration under new identities, and a source exactly as it was.
      const copy = (await readList(page, copyId)) as OwnedList;
      expect(copy).toMatchObject({ ownership: "USER", canEdit: true });
      expect(configurationOf(copy)).toEqual(configurationOf(source));
      const sourceItemIds = source.items.map((item) => item.id);
      expect(
        copy.items.filter((item) => sourceItemIds.includes(item.id)),
      ).toEqual([]);
      expect(await readList(page, sourceId)).toEqual(source);
    } finally {
      await deleteListIfPresent(page, copyId);
      await deleteListIfPresent(page, sourceId);
    }
  });

  test("copies a built-in list into an editable list of the customer's own, on a phone too", async ({
    page,
  }) => {
    let copyId: string | null = null;
    await page.setViewportSize({ width: 390, height: 844 });

    try {
      const collection = (await (
        await page.request.get(`${apiBaseUrl()}/lists`)
      ).json()) as OwnedList[];
      const builtIn = collection.find(
        (list) => list.name === QA_BUILT_IN_LIST && list.ownership === "SYSTEM",
      );
      test.skip(
        builtIn === undefined,
        "The QA built-ins are missing. Run `pnpm test:builtins:seed`.",
      );
      const before = (await readList(
        page,
        (builtIn as OwnedList).id,
      )) as OwnedList;

      await page.goto("/lists");
      const row = collectionRow(page, "built-in-lists", QA_BUILT_IN_LIST);
      // Copying is the one thing a customer can do to a built-in from its card.
      expect(await overflowMenuActions(page, QA_BUILT_IN_LIST, row)).toEqual([
        "Duplicate",
      ]);
      await page.keyboard.press("Escape");
      await chooseFromOverflowMenu(page, QA_BUILT_IN_LIST, "Duplicate", row);

      const dialog = page.getByTestId("duplicate-dialog");
      await expect(dialog.getByLabel("Name")).toHaveValue(
        `${QA_BUILT_IN_LIST} — Copy`,
      );
      // The dialog fits the phone: nothing scrolls sideways and both actions are on screen.
      await expectNoHorizontalScroll(page);
      for (const action of ["Cancel", "Duplicate"]) {
        const box = await dialog
          .getByRole("button", { name: action, exact: true })
          .boundingBox();
        expect(box, `${action} has no box`).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
      }
      await dialog
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();

      await expect(page.getByTestId("list-detail")).toBeVisible({
        timeout: 20_000,
      });
      copyId = listIdOf(page);
      await expect(
        page.getByRole("heading", { name: `${QA_BUILT_IN_LIST} — Copy` }),
      ).toBeVisible();
      // An ordinary list of the customer's own: no built-in badge, and it can be changed.
      await expect(page.getByTestId("built-in-badge")).toHaveCount(0);
      await expect(page.getByTestId("add-stocks-button")).toBeVisible();
      await expect(memberRow(page, QA_SYMBOL_ONE)).toContainText(
        "Always eligible",
      );
      await expect(
        memberRow(page, QA_SYMBOL_TWO).getByTestId("membership"),
      ).toContainText("Member now · since Jan 2, 2024");
      await expectNoHorizontalScroll(page);

      const copy = (await readList(page, copyId)) as OwnedList;
      expect(copy).toMatchObject({ ownership: "USER", canEdit: true });
      expect(copy.systemKey).toBeUndefined();
      expect(configurationOf(copy)).toEqual(configurationOf(before));

      // The built-in is unchanged, and still read-only for this customer.
      const after = (await readList(page, before.id)) as OwnedList;
      expect(after).toEqual(before);
      expect(after).toMatchObject({ ownership: "SYSTEM", canEdit: false });
    } finally {
      await deleteListIfPresent(page, copyId);
    }
  });
});
