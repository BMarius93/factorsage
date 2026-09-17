import { expect, test } from "@playwright/test";

/**
 * The administrator's entry point to built-in content, and the ordinary editors opening editable
 * for it. Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */
test.describe("ADMIN_USER built-in content", () => {
  test("lists built-in content and opens a built-in monitor with its operator controls", async ({
    page,
  }) => {
    await page.goto("/admin");
    const table = page.getByTestId("admin-built-ins");
    await expect(table).toBeVisible();
    const monitor = table
      .getByTestId("admin-built-in")
      .filter({ hasText: "QA Built-in Monitor A" });
    await expect(monitor).toContainText("qa-builtin-monitor-a");
    await expect(monitor).toContainText("Published");

    await monitor.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expect(page.getByTestId("edit-monitor")).toBeVisible();
    await expect(page.getByTestId("monitor-published-pill")).toHaveText(
      "Published",
    );
  });

  test("opens a built-in strategy in the ordinary Builder", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page
      .getByTestId("admin-built-in")
      .filter({ hasText: "qa-builtin-trend" })
      .getByRole("link", { name: "Edit" })
      .click();
    await expect(page.getByTestId("strategy-read-only")).toHaveCount(0);
    await expect(page.getByTestId("strategy-builder")).toBeVisible();
    await expect(page.getByTestId("save-strategy")).toBeVisible();
  });
});
