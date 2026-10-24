import { expect, test } from "../fixtures";
import {
  addStockToOpenList,
  fixtureName,
  listItems,
  monitorCard,
  openFixtureList,
  readEntitlements,
  removeStockFromOpenList,
  submitBacktest,
  submitBacktestRefusedByForm,
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

  test("runs a thirty-year backtest and refuses a thirty-first year", async ({
    page,
  }) => {
    // Thirty years is every plan's depth and the engine's ceiling, so the form refuses the
    // thirty-first year itself.
    const refused = await submitBacktestRefusedByForm(page, {
      strategyName: "STARTER_USER Strategy",
      listName: "Starter Small",
      startDate: yearsBefore(today(), 31),
      endDate: today(),
    });

    expect(refused).toContain("30");
    expect(refused.toLowerCase()).toContain("years");

    // And the year below the line is not refused for depth. It is still refused — a run is already
    // pinned in flight — but by the *other* limit, which is what proves thirty years is allowed.
    const atLimit = await submitBacktest(page, {
      strategyName: "STARTER_USER Strategy",
      listName: "Starter Small",
      startDate: yearsBefore(today(), 30),
      endDate: today(),
    });

    expect(atLimit.accepted).toBe(false);
    expect(atLimit.message?.toLowerCase()).not.toContain("years");
    expect(atLimit.message?.toLowerCase()).toContain("one backtest at a time");
  });

  test("keeps five monitors active and refuses a sixth", async ({ page }) => {
    await page.goto("/monitors");
    for (const name of [
      "Starter Monitor 1",
      "Starter Monitor 2",
      "Starter Monitor 3",
      "Starter Monitor 4",
      "Starter Monitor 5",
    ]) {
      const card = monitorCard(page, name);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      // All five are genuinely active, not merely stored: none carries the blocked pill.
      await expect(card.getByTestId("monitor-enabled-switch")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(card.getByTestId("monitor-state-pill")).toHaveCount(0);
    }

    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("monitor-form-dialog");
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill(`STARTER sixth monitor ${Date.now()}`);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: fixtureName("STARTER_USER Strategy") });
    await page
      .getByTestId("monitor-list")
      .selectOption({ label: fixtureName("Starter Small") });
    // Offered switched off at capacity (UI-022); forcing it on is refused by the server.
    const startNow = dialog.getByLabel(/Start monitoring now/);
    await expect(startNow).not.toBeChecked();
    await startNow.check();
    await page.getByTestId("submit-monitor").click();

    const error = dialog.getByRole("alert");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("5");
  });
});
