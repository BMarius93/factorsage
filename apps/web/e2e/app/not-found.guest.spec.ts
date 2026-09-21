import { expect, test, type Page } from "../fixtures";

/**
 * An unknown URL shows FactorSage's own not-found page, not the framework's bare 404 (UX-006).
 */

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("not-found page", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`is styled, with a working Dashboard link, at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const response = await page.goto("/definitely-not-a-route");
      expect(response?.status()).toBe(404);

      const panel = page.getByTestId("not-found");
      await expect(panel).toBeVisible();
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "This page does not exist",
        }),
      ).toBeVisible();
      // Not the framework's page.
      await expect(page.getByText("This page could not be found.")).toHaveCount(
        0,
      );
      await expectNoHorizontalScroll(page);

      await page.getByRole("link", { name: "Go to the Dashboard" }).click();
      await expect(page).toHaveURL("/");
      await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    });
  }
});
