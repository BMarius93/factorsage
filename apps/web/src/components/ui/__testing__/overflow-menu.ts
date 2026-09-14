import { screen, within } from "@testing-library/react";

/**
 * Just the part of `user-event` these helpers need, so a spec may pass either the default
 * export or an instance from `userEvent.setup()`.
 */
type Clicker = { readonly click: (element: Element) => Promise<unknown> };

/** The trigger for one record's `OverflowMenu`. */
export async function findOverflowTrigger(
  entityName: string,
  scope?: HTMLElement,
) {
  const root = scope ? within(scope) : screen;
  return root.findByRole("button", { name: `More actions for ${entityName}` });
}

export async function openOverflowMenu(
  user: Clicker,
  entityName: string,
  scope?: HTMLElement,
) {
  await user.click(await findOverflowTrigger(entityName, scope));
}

/**
 * Opens an `OverflowMenu` and picks one of its actions.
 *
 * Maintenance and destructive actions live behind a "…" trigger rather than as visible
 * buttons, so a test that used to click `Delete` directly now has to open the popup first.
 * Sharing that here keeps the two steps in one place instead of in every spec.
 *
 * The action is looked up inside the popup the trigger actually controls, so a same-named
 * button elsewhere on the page — a confirmation dialog's, another row's — can never be the
 * one that gets clicked.
 */
export async function chooseFromOverflowMenu(
  user: Clicker,
  entityName: string,
  itemName: string | RegExp,
  scope?: HTMLElement,
) {
  const trigger = await findOverflowTrigger(entityName, scope);
  await user.click(trigger);

  const popupId = trigger.getAttribute("aria-controls");
  if (!popupId) {
    throw new Error(
      `The overflow trigger for "${entityName}" did not open: it has no aria-controls.`,
    );
  }
  const popup = document.getElementById(popupId);
  if (!popup) {
    throw new Error(`The overflow popup "${popupId}" is not in the document.`);
  }

  await user.click(within(popup).getByRole("button", { name: itemName }));
}
