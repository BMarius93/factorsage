import { expect, test } from "../fixtures";

/**
 * The historical universe catalog for PRO_USER: the same universes as a visitor sees, unlocked —
 * "Requires Pro" is a plan fact and goes away with the plan, while "Historical data unavailable"
 * does not (`docs/decisions/historical-universes-v1.md` §6).
 */
test.describe("pro historical universes", () => {
  test("shows the catalog unlocked, and the unavailable universes still unavailable", async ({
    page,
  }) => {
    await page.goto("/lists");
    const universes = page.getByTestId("historical-universes");
    await expect(universes.getByTestId("historical-universe")).toHaveCount(23);
    await expect(
      universes.locator(
        '[data-testid="historical-universe"][data-locked="false"]',
      ),
    ).toHaveCount(23);
    await expect(
      universes.getByTestId("universe-pro-badge").first(),
    ).toHaveText("Pro");
    await expect(
      universes
        .locator('[data-universe-key="sp500-sector-technology"]')
        .getByTestId("universe-unavailable"),
    ).toHaveText("Historical data unavailable");
    await expect(universes.getByTestId("premium-upgrade-hint")).toHaveCount(0);
  });
});
