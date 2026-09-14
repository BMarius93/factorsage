import { screen, within } from "@testing-library/react";

/**
 * Just the part of `user-event` these helpers need, so a spec may pass either the default
 * export or an instance from `userEvent.setup()`.
 */
type Clicker = { readonly click: (element: Element) => Promise<unknown> };

/**
 * Opens an `OverflowMenu` and picks one of its items.
 *
 * Maintenance and destructive actions live behind a "…" trigger rather than as visible
 * buttons, so a test that used to click `Delete` directly now has to open the menu first.
 * Sharing that here keeps the two steps in one place instead of in every spec.
 */
export async function openOverflowMenu(
  user: Clicker,
  entityName: string,
  scope?: HTMLElement,
) {
  const root = scope ? within(scope) : screen;
  await user.click(
    await root.findByRole("button", { name: `More actions for ${entityName}` }),
  );
}

export async function chooseFromOverflowMenu(
  user: Clicker,
  entityName: string,
  itemName: string | RegExp,
  scope?: HTMLElement,
) {
  const root = scope ? within(scope) : screen;
  await user.click(
    await root.findByRole("button", { name: `More actions for ${entityName}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: itemName }));
}
