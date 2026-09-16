import { expect, test, type Page } from "@playwright/test";
import { chooseFromOverflowMenu } from "../utils/overflow-menu";
import {
  createList,
  deleteListIfPresent,
  findSecurityId,
  itemOf,
  readList,
  replaceBuyWindows,
} from "../utils/lists";

/**
 * Stock lists and point-in-time membership, for PRO_USER against the deterministic QA catalog.
 *
 * Precondition beyond the usual stack + `pnpm test:users:seed`: the fictional QA securities must
 * exist in the running stack's catalog — seed them once with `pnpm test:securities:seed`. The
 * suite never talks to FMP and never assumes real market symbols exist in the environment.
 *
 * Membership is the product's name for what the API and the domain call a buy window: the period
 * during which a member may be **bought**. It never restricts selling, which the backtest suite
 * (`backtests/membership-pit.user.spec.ts`) proves against the real engine.
 */

const QA_SYMBOL_ONE = "QATEST1";
const QA_SYMBOL_TWO = "QATEST2";

function itemRow(page: Page, symbol: string) {
  return page
    .getByTestId("list-items")
    .locator("tbody tr")
    .filter({ hasText: symbol });
}

/** The membership cell of one row. `fact` is the default card role, so Exchange shares it. */
function membershipCellText(page: Page, symbol: string) {
  return itemRow(page, symbol).getByTestId("membership");
}

async function openMembership(page: Page, symbol: string) {
  await itemRow(page, symbol)
    .getByRole("button", { name: "Membership" })
    .click();
  const editor = page.getByTestId("membership-editor");
  await expect(editor).toBeVisible();
  return editor;
}

/** No page may scroll sideways: a list must be editable on a phone without panning. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function searchAndPick(page: Page, symbol: string) {
  const searchInput = page.getByRole("combobox", {
    name: "Search stocks to add to the new list",
  });
  await searchInput.fill(symbol);
  const option = page.getByRole("option").filter({ hasText: symbol });
  await expect(
    option,
    `The QA catalog rows are missing. Seed them once with: pnpm test:securities:seed`,
  ).toBeVisible();
  await option.click();
  // The pick becomes a chip.
  await expect(page.getByLabel(`Remove ${symbol}`)).toBeVisible();
}

test.describe("PRO_USER stock lists", () => {
  test("creates, edits membership, prunes, and deletes a list", async ({
    page,
  }) => {
    const listName = `QA Lists E2E ${Date.now()}`;
    let listId: string | null = null;

    try {
      // 1. Create a uniquely named list with two catalog securities picked through search.
      await page.goto("/lists");
      await page.getByTestId("new-list-button").first().click();
      await page.getByLabel("Name").fill(listName);
      await searchAndPick(page, QA_SYMBOL_ONE);
      await searchAndPick(page, QA_SYMBOL_TWO);
      await page.getByRole("button", { name: "Create list" }).click();

      // 2. Creation lands on the saved list; both members start unrestricted.
      await expect(page.getByTestId("list-detail")).toBeVisible({
        timeout: 20_000,
      });
      listId = new URL(page.url()).pathname.split("/").pop() ?? null;
      await expect(page.getByRole("heading", { name: listName })).toBeVisible();
      await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText("Full history");
      await expect(itemRow(page, QA_SYMBOL_TWO)).toContainText("Full history");

      // 3. Restrict one stock to a bounded membership period.
      const editor = await openMembership(page, QA_SYMBOL_ONE);
      await editor.getByRole("radio", { name: /Membership period/ }).click();
      await editor.getByLabel("From", { exact: true }).fill("2020-01-01");
      await editor.getByLabel("Present", { exact: true }).uncheck();
      await editor.getByLabel("To", { exact: true }).fill("2020-12-31");
      await editor.getByTestId("save-membership").click();
      await expect(editor).not.toBeVisible();
      await expect(membershipCellText(page, QA_SYMBOL_ONE)).toContainText(
        "Jan 1, 2020",
      );

      // 4. Switch back to full history; the period is gone.
      const reopened = await openMembership(page, QA_SYMBOL_ONE);
      await reopened.getByRole("radio", { name: /Full history/ }).click();
      await reopened.getByTestId("save-membership").click();
      await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText("Full history");

      // 5. Remove the second stock after confirmation.
      await chooseFromOverflowMenu(
        page,
        `${QA_SYMBOL_TWO} in this list`,
        "Remove from list",
      );
      await page.getByRole("button", { name: "Remove stock" }).click();
      await expect(itemRow(page, QA_SYMBOL_TWO)).toHaveCount(0);
      await expect(itemRow(page, QA_SYMBOL_ONE)).toBeVisible();

      // 6. Delete the list; the collection no longer shows it.
      await chooseFromOverflowMenu(page, listName, "Delete list");
      await page.getByRole("button", { name: "Delete list" }).click();
      await expect(page).toHaveURL(/\/lists$/);
      await expect(page.getByText(listName)).toHaveCount(0);
      listId = null;
    } finally {
      await deleteListIfPresent(page, listId);
    }
  });

  test.describe("membership editing", () => {
    let listId: string | null = null;

    test.beforeEach(async ({ page }) => {
      // Arranged through the API so each scenario asserts about membership, not about list
      // creation, which the journey above already covers.
      await page.goto("/lists");
      const securityId = await findSecurityId(page, QA_SYMBOL_ONE);
      test.skip(
        securityId === null,
        `${QA_SYMBOL_ONE} is not in the catalog. Run \`pnpm test:securities:seed\`.`,
      );
      const list = await createList(
        page,
        `QA Membership E2E ${Date.now()}`,
        [securityId as string],
      );
      listId = list.id;
    });

    test.afterEach(async ({ page }) => {
      await deleteListIfPresent(page, listId);
      listId = null;
    });

    // Scenario 1 — an open-ended membership survives a save and a full reload.
    test("saves an open-ended membership and still reads Present after a reload", async ({
      page,
    }) => {
      await page.goto(`/lists/${listId}`);
      const editor = await openMembership(page, QA_SYMBOL_ONE);
      await editor.getByRole("radio", { name: /Membership period/ }).click();
      await editor.getByLabel("From", { exact: true }).fill("1982-11-30");
      // Present is the default for a new period; assert it rather than assume it.
      await expect(editor.getByLabel("Present", { exact: true })).toBeChecked();
      await expect(editor.getByTestId("membership-preview")).toContainText(
        "Nov 30, 1982 → Present",
      );
      await editor.getByTestId("save-membership").click();
      await expect(editor).not.toBeVisible();

      const cell = membershipCellText(page, QA_SYMBOL_ONE);
      await expect(cell).toContainText("Nov 30, 1982");
      await expect(cell).toContainText("Present");

      await page.reload();
      await expect(page.getByTestId("list-detail")).toBeVisible();
      const afterReload = membershipCellText(page, QA_SYMBOL_ONE);
      await expect(afterReload).toContainText("Nov 30, 1982");
      await expect(afterReload).toContainText("Present");

      // Reopening shows the persisted period, not a blank form.
      const reopened = await openMembership(page, QA_SYMBOL_ONE);
      await expect(reopened.getByLabel("From", { exact: true })).toHaveValue("1982-11-30");
      await expect(reopened.getByLabel("Present", { exact: true })).toBeChecked();
      await expect(reopened.getByLabel("To", { exact: true })).toBeDisabled();

      // Open-ended is `null` on the wire, never a fabricated future date.
      const persisted = itemOf(
        await readList(page, listId as string),
        QA_SYMBOL_ONE,
      );
      expect(persisted.buyWindows).toEqual([
        { startDate: "1982-11-30", endDate: null },
      ]);
    });

    // Scenario 2 — a bounded membership survives a save and a full reload.
    test("saves a bounded membership and still shows both dates after a reload", async ({
      page,
    }) => {
      await page.goto(`/lists/${listId}`);
      const editor = await openMembership(page, QA_SYMBOL_ONE);
      await editor.getByRole("radio", { name: /Membership period/ }).click();
      await editor.getByLabel("From", { exact: true }).fill("2001-03-10");
      await editor.getByLabel("Present", { exact: true }).uncheck();
      await editor.getByLabel("To", { exact: true }).fill("2008-07-15");
      await expect(editor.getByTestId("membership-preview")).toContainText(
        "Mar 10, 2001 → Jul 15, 2008",
      );
      await editor.getByTestId("save-membership").click();
      await expect(editor).not.toBeVisible();

      await page.reload();
      await expect(page.getByTestId("list-detail")).toBeVisible();
      const cell = membershipCellText(page, QA_SYMBOL_ONE);
      await expect(cell).toContainText("Mar 10, 2001");
      await expect(cell).toContainText("Jul 15, 2008");
      await expect(cell).not.toContainText("Present");

      const reopened = await openMembership(page, QA_SYMBOL_ONE);
      await expect(reopened.getByLabel("From", { exact: true })).toHaveValue("2001-03-10");
      await expect(reopened.getByLabel("To", { exact: true })).toHaveValue("2008-07-15");
      await expect(reopened.getByLabel("Present", { exact: true })).not.toBeChecked();
    });

    // Scenario 3 — the invalid state is refused locally and never reaches the database.
    test("refuses an end date before the start and persists nothing", async ({
      page,
    }) => {
      await page.goto(`/lists/${listId}`);
      const editor = await openMembership(page, QA_SYMBOL_ONE);
      await editor.getByRole("radio", { name: /Membership period/ }).click();
      await editor.getByLabel("From", { exact: true }).fill("2020-01-01");
      await editor.getByLabel("Present", { exact: true }).uncheck();
      await editor.getByLabel("To", { exact: true }).fill("2019-01-01");
      await editor.getByTestId("save-membership").click();

      const message = editor.getByTestId("membership-validation");
      await expect(message).toHaveText("Membership cannot end before it starts");
      // The message belongs to the field it is about, for assistive technology too.
      await expect(editor.getByLabel("To", { exact: true })).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      // The dialog stays open: an invalid state cannot be dismissed into a save.
      await expect(editor).toBeVisible();

      await editor.getByRole("button", { name: "Cancel" }).click();
      await page.reload();
      await expect(page.getByTestId("list-detail")).toBeVisible();
      await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText("Full history");

      const persisted = itemOf(
        await readList(page, listId as string),
        QA_SYMBOL_ONE,
      );
      expect(persisted.buyWindowMode).toBe("FULL");
      expect(persisted.buyWindows).toEqual([]);
    });

    // The hazard the single-period editor is allowed to exist only because it handles.
    test("never flattens a multi-period member through the single-period editor", async ({
      page,
    }) => {
      const before = itemOf(
        await readList(page, listId as string),
        QA_SYMBOL_ONE,
      );
      const periods = [
        { startDate: "2001-03-10", endDate: "2008-07-15" },
        { startDate: "2012-05-01", endDate: null },
      ];
      await replaceBuyWindows(page, listId as string, before.id, {
        mode: "CUSTOM",
        ranges: periods,
      });

      await page.goto(`/lists/${listId}`);
      // The row says how many periods there are rather than showing only the first.
      const cell = membershipCellText(page, QA_SYMBOL_ONE);
      await expect(cell).toContainText("Mar 10, 2001");
      await expect(cell).toContainText("+1 more");

      const editor = await openMembership(page, QA_SYMBOL_ONE);
      const history = editor.getByTestId("membership-history");
      await expect(history).toContainText("Mar 10, 2001 → Jul 15, 2008");
      await expect(history).toContainText("May 1, 2012 → Present");
      // No form and no save: a read/edit/save cycle cannot discard the history.
      await expect(editor.getByTestId("save-membership")).toHaveCount(0);
      await expect(editor.getByLabel("From", { exact: true })).toHaveCount(0);

      await editor.getByRole("button", { name: "Close", exact: true }).click();
      const after = itemOf(await readList(page, listId as string), QA_SYMBOL_ONE);
      expect(after.buyWindows).toEqual(periods);

      // Replacing is possible, but only after saying so.
      const reopened = await openMembership(page, QA_SYMBOL_ONE);
      await reopened.getByTestId("replace-membership-history").click();
      await expect(reopened.getByLabel("From", { exact: true })).toHaveValue("2001-03-10");
      await expect(reopened.getByTestId("save-membership")).toBeVisible();
    });

    // Scenario 6 — the same flow at desktop, tablet and phone widths.
    test("stays usable at desktop, tablet and phone widths", async ({
      page,
    }) => {
      for (const viewport of [
        { width: 1440, height: 900, label: "desktop" },
        { width: 1024, height: 800, label: "tablet" },
        { width: 390, height: 844, label: "phone" },
      ]) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.goto(`/lists/${listId}`);
        await expect(page.getByTestId("list-detail")).toBeVisible();
        await expectNoHorizontalScroll(page);

        const editor = await openMembership(page, QA_SYMBOL_ONE);
        await editor.getByRole("radio", { name: /Membership period/ }).click();

        // Both date controls and the Present toggle are reachable and usable at every width.
        const from = editor.getByLabel("From", { exact: true });
        const to = editor.getByLabel("To", { exact: true });
        const present = editor.getByLabel("Present", { exact: true });
        await expect(from, `From is hidden at ${viewport.label}`).toBeVisible();
        await expect(to, `To is hidden at ${viewport.label}`).toBeVisible();
        await expect(
          present,
          `Present is hidden at ${viewport.label}`,
        ).toBeVisible();

        for (const [name, control] of [
          ["From", from],
          ["To", to],
          ["Present", present],
        ] as const) {
          const box = await control.boundingBox();
          expect(box, `${name} has no box at ${viewport.label}`).not.toBeNull();
          expect(
            box?.height ?? 0,
            `${name} is only ${box?.height}px tall at ${viewport.label}`,
          ).toBeGreaterThanOrEqual(16);
          expect(
            (box?.x ?? 0) + (box?.width ?? 0),
            `${name} overflows the ${viewport.label} viewport`,
          ).toBeLessThanOrEqual(viewport.width);
        }

        await from.fill("2001-03-10");
        await editor.getByTestId("save-membership").click();
        await expect(editor).not.toBeVisible();
        await expect(membershipCellText(page, QA_SYMBOL_ONE)).toContainText(
          "Mar 10, 2001",
        );
        await expectNoHorizontalScroll(page);
      }
    });
  });
});
