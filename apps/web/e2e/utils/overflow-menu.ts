import type { Locator, Page } from "@playwright/test";

/**
 * Opens a record's or a header's overflow menu and picks one of its items.
 *
 * Maintenance and destructive actions live behind a "…" trigger rather than as visible
 * buttons — see `ai/architecture/v1-visual-parity.md` — so a spec asks for the action by
 * name and this handles the two clicks it now takes.
 *
 * `scope` narrows the trigger to one row; the menu itself is looked up on the page,
 * because it is positioned relative to the trigger but read from the document.
 */
export async function chooseFromOverflowMenu(
  page: Page,
  entityName: string,
  itemName: string | RegExp,
  scope?: Locator,
) {
  const root = scope ?? page;
  await root
    .getByRole("button", { name: `More actions for ${entityName}` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: itemName }).first().click();
}

/** Opens the menu without choosing, for assertions about what it offers. */
export async function openOverflowMenu(
  page: Page,
  entityName: string,
  scope?: Locator,
) {
  const root = scope ?? page;
  await root
    .getByRole("button", { name: `More actions for ${entityName}` })
    .first()
    .click();
}
