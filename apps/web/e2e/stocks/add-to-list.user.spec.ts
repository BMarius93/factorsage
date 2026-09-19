import { expect, test } from "../fixtures";
import {
  createList,
  deleteListIfPresent,
  findSecurityId,
  readList,
} from "../utils/lists";

/**
 * Research leads somewhere (UI-018): Stock Details adds the stock to one of the caller's lists,
 * says when it is already there, and never offers a built-in list.
 *
 * The spec owns its list and deletes it, so the shared persona's fixtures are untouched.
 */
test.describe("PRO_USER Stock Details add to list", () => {
  test("adds the stock to a chosen list, then reports it as already there", async ({
    page,
  }) => {
    let listId: string | null = null;
    try {
      const other = await findSecurityId(page, "QATEST2");
      expect(other).not.toBeNull();
      const list = await createList(page, `E2E add-to-list ${Date.now()}`, [
        other as string,
      ]);
      listId = list.id;

      await page.goto("/stocks/QATEST1");
      await page.getByTestId("add-to-list-button").click();
      const dialog = page.getByTestId("add-to-list-dialog");
      await expect(dialog).toBeVisible();

      const select = dialog.getByTestId("add-to-list-select");
      // Only the caller's own lists: built-ins are read-only.
      await expect(
        select.locator("option", { hasText: "QA Built-in" }),
      ).toHaveCount(0);
      await select.selectOption(list.id);
      await dialog.getByTestId("add-to-list-submit").click();
      await expect(dialog.getByTestId("add-to-list-added")).toContainText(
        `QATEST1 is now in ${list.name}.`,
      );

      const saved = await readList(page, list.id);
      expect(saved.items.map((item) => item.security.symbol).sort()).toEqual([
        "QATEST1",
        "QATEST2",
      ]);

      // A second visit knows it is already a member and sends nothing.
      await dialog.getByRole("button", { name: "Done" }).click();
      await page.getByTestId("add-to-list-button").click();
      await dialog.getByTestId("add-to-list-select").selectOption(list.id);
      await expect(dialog.getByTestId("add-to-list-already")).toHaveText(
        `QATEST1 is already in ${list.name}.`,
      );
      await expect(dialog.getByTestId("add-to-list-submit")).toBeDisabled();
    } finally {
      await deleteListIfPresent(page, listId);
    }
  });
});
