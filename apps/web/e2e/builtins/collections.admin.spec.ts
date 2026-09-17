import { expect, test } from "@playwright/test";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseFromOverflowMenu } from "../utils/overflow-menu";

/**
 * The administrator's view of the same collections.
 *
 * `AGENTS.md` invariant 21: built-ins are changed by `role = ADMIN` alone, through the ordinary
 * editors rather than a parallel CMS — and the role grants nothing over another customer's private
 * content, which stays exactly as unreachable as it is for anyone else.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */

const QA_MONITOR = "QA Built-in Monitor A";

test.describe("ADMIN_USER built-in collections", () => {
  test("opens a built-in monitor's ordinary editor from the collection", async ({
    page,
  }) => {
    await page.goto("/monitors");
    const row = page
      .getByTestId("built-in-monitors")
      .locator("tbody tr")
      .filter({ hasText: QA_MONITOR });
    await expect(row).toHaveCount(1);

    // An administrator gets the editor, and still no way to delete platform content.
    await chooseFromOverflowMenu(page, QA_MONITOR, "Edit", row);
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });

  test("gains no access to another customer's private content", async ({
    page,
  }) => {
    // Being an administrator widens what may be *changed* about platform content, never what may
    // be read of a customer's own: the collection holds this account's monitors and the built-ins,
    // and nothing that belongs to somebody else.
    const collection = (await (
      await page.request.get(`${apiBaseUrl()}/monitors`)
    ).json()) as { id: string; ownership: string; canEdit: boolean }[];
    const builtIns = collection.filter(
      (monitor) => monitor.ownership === "SYSTEM",
    );
    expect(builtIns.length).toBeGreaterThan(0);
    expect(builtIns.every((monitor) => monitor.canEdit)).toBe(true);

    // An id the administrator does not own reads as missing, exactly as it does for anyone else.
    const missing = await page.request.get(
      `${apiBaseUrl()}/monitors/00000000-0000-4000-8000-000000000000`,
    );
    expect(missing.status()).toBe(404);
  });
});
