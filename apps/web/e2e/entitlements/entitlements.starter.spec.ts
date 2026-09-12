import { expect, test } from "@playwright/test";
import {
  addStockToOpenList,
  fixtureName,
  listItems,
  monitorCard,
  openFixtureList,
  readEntitlements,
  removeStockFromOpenList,
  submitBacktest,
  today,
  yearsBefore,
} from "../utils/entitlements";

/**
 * The middle tier.
 *
 * Its value is the contrast: every assertion here is something FREE is refused, which is what
 * shows a limit actually moved with the plan instead of being hard-coded somewhere. The numeric
 * edges themselves are the backend suites' job, so this file checks one boundary per capability
 * and stops.
 */
test.describe("STARTER entitlements", () => {
  test("reports the STARTER plan", async ({ page }) => {
    const payload = await readEntitlements(page);

    expect(payload.plan).toBe("STARTER");
    expect(payload.role).toBe("USER");
    expect(payload.entitlements.lists.maxSymbols).toBe(50);
  });

  test("holds a list far past every FREE limit, and still accepts more", async ({
    page,
  }) => {
    await openFixtureList(page, "Starter Wide");
    // Forty: four times what FREE allows, and inside STARTER's fifty. Read rather than asserted
    // as a literal, so the test states a *delta* and stays repeatable without a reseed.
    const before = await listItems(page).count();
    expect(before).toBeGreaterThan(10);

    const outcome = await addStockToOpenList(page, "ENTF041");
    expect(outcome.accepted).toBe(true);
    await expect(listItems(page)).toHaveCount(before + 1);

    // Put the fixture back, so this spec leaves the persona exactly as it found it.
    await removeStockFromOpenList(page, "ENTF041");
    await expect(listItems(page)).toHaveCount(before);
  });

  test("runs a fifteen-year backtest and refuses a sixteenth year", async ({
    page,
  }) => {
    const refused = await submitBacktest(page, {
      strategyName: "STARTER_USER Strategy",
      listName: "Starter Small",
      startDate: yearsBefore(today(), 16),
      endDate: today(),
    });

    expect(refused.accepted).toBe(false);
    expect(refused.message).toContain("15");
    expect(refused.message?.toLowerCase()).toContain("years");

    // And the year below the line is not refused for depth. It is still refused — a run is already
    // pinned in flight — but by the *other* limit, which is what proves fifteen years is allowed.
    const atLimit = await submitBacktest(page, {
      strategyName: "STARTER_USER Strategy",
      listName: "Starter Small",
      startDate: yearsBefore(today(), 15),
      endDate: today(),
    });

    expect(atLimit.accepted).toBe(false);
    expect(atLimit.message?.toLowerCase()).not.toContain("years");
    expect(atLimit.message?.toLowerCase()).toContain("one backtest at a time");
  });

  test("keeps three monitors active and refuses a fourth", async ({ page }) => {
    await page.goto("/monitors");
    for (const name of [
      "Starter Monitor 1",
      "Starter Monitor 2",
      "Starter Monitor 3",
    ]) {
      const card = monitorCard(page, name);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      // All three are genuinely active, not merely stored: none carries the blocked pill.
      await expect(card.getByTestId("monitor-blocked-pill")).toHaveCount(0);
    }

    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("monitor-form-dialog");
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill(`STARTER fourth monitor ${Date.now()}`);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: fixtureName("STARTER_USER Strategy") });
    await page
      .getByTestId("monitor-list")
      .selectOption({ label: fixtureName("Starter Small") });
    await page.getByTestId("submit-monitor").click();

    const error = dialog.getByRole("alert");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("3");
  });
});
