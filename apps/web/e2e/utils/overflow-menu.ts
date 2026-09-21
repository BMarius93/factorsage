import type { Locator, Page } from "@playwright/test";

/** The trigger for one record's `OverflowMenu`. */
function trigger(page: Page, entityName: string, scope?: Locator): Locator {
  return (scope ?? page)
    .getByRole("button", { name: `More actions for ${entityName}` })
    .first();
}

/**
 * Opens a record's or a header's overflow popup and picks one of its actions.
 *
 * Maintenance and destructive actions live behind a "…" trigger rather than as visible
 * buttons — see `ai/architecture/v1-visual-parity.md` — so a spec asks for the action by
 * name and this handles the two clicks it now takes.
 *
 * `scope` narrows the trigger to one row. The action is then looked up inside the popup that
 * trigger controls, so a confirmation dialog's identically named button can never be the one
 * that gets clicked.
 */
export async function chooseFromOverflowMenu(
  page: Page,
  entityName: string,
  itemName: string | RegExp,
  scope?: Locator,
) {
  const control = trigger(page, entityName, scope);
  await control.click();

  const popupId = await control.getAttribute("aria-controls");
  if (!popupId) {
    throw new Error(
      `The overflow trigger for "${entityName}" did not open: it has no aria-controls.`,
    );
  }

  await page
    .locator(`[id="${popupId}"]`)
    .getByRole("button", { name: itemName })
    .click();
}

/** Opens the popup without choosing, for assertions about what it offers. */
export async function openOverflowMenu(
  page: Page,
  entityName: string,
  scope?: Locator,
) {
  await trigger(page, entityName, scope).click();
}

/** Opens a record's popup and reads the actions it offers, in order. Leaves it open. */
export async function overflowMenuActions(
  page: Page,
  entityName: string,
  scope?: Locator,
): Promise<string[]> {
  const control = trigger(page, entityName, scope);
  await control.click();
  const popupId = await control.getAttribute("aria-controls");
  if (!popupId) {
    throw new Error(
      `The overflow trigger for "${entityName}" did not open: it has no aria-controls.`,
    );
  }
  return page
    .locator(`[id="${popupId}"]`)
    .getByRole("button")
    .allTextContents();
}
