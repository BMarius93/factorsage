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
 * The FREE plan's boundaries, as a user meets them.
 *
 * The exact numbers are already proven by the backend suites; what this file adds is that the
 * limit reaches the browser as something a user can act on — a message naming the limit, next to
 * the control that hit it — rather than as a silent failure or a "try again in a moment".
 *
 * Every case starts from a seeded fixture rather than by clicking a list up to its limit. That is
 * not only speed: a spec that builds the boundary is really testing the building, and it leaves
 * the persona somewhere different depending on where it failed.
 */
test.describe("FREE entitlements", () => {
  test("reports the FREE plan and its limits", async ({ page }) => {
    const payload = await readEntitlements(page);

    expect(payload.principal).toBe("AUTHENTICATED");
    expect(payload.plan).toBe("FREE");
    expect(payload.role).toBe("USER");
    expect(payload.entitlements.admin.canAccessAdminSurfaces).toBe(false);
  });

  test("refuses an eleventh stock on a list already at ten", async ({
    page,
  }) => {
    await openFixtureList(page, "Free At Limit");
    await expect(listItems(page)).toHaveCount(10);

    const outcome = await addStockToOpenList(page, "ENTF050");

    expect(outcome.accepted).toBe(false);
    // The message has to name the limit: "could not be added right now" would be false, because
    // the next attempt fails identically.
    expect(outcome.message).toContain("10");
    expect(outcome.message?.toLowerCase()).toContain("plan");
    await expect(listItems(page)).toHaveCount(10);
  });

  test("still allows a corrective removal, and the add after it", async ({
    page,
  }) => {
    await openFixtureList(page, "Free At Limit");
    await expect(listItems(page)).toHaveCount(10);

    // Removing is never refused — a user at their limit has to be able to change their mind.
    await removeStockFromOpenList(page, "ENTF010");
    await expect(listItems(page)).toHaveCount(9);

    // And room made is room usable, so the refusal really was about capacity.
    const outcome = await addStockToOpenList(page, "ENTF010");
    expect(outcome.accepted).toBe(true);
    await expect(listItems(page)).toHaveCount(10);
  });

  test("blocks a live backtest over more stocks than the plan allows", async ({
    page,
  }) => {
    const outcome = await submitBacktest(page, {
      strategyName: "FREE_USER Strategy",
      listName: "Free Over Backtest Limit",
      startDate: yearsBefore(today(), 1),
      endDate: today(),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.message).toContain("10");
    expect(outcome.message).toContain("11");
  });

  test("blocks a backtest that reaches further back than the plan allows", async ({
    page,
  }) => {
    const accepted = await submitBacktest(page, {
      strategyName: "FREE_USER Strategy",
      listName: "Free Small",
      startDate: yearsBefore(today(), 6),
      endDate: today(),
    });

    expect(accepted.accepted).toBe(false);
    expect(accepted.message).toContain("5");
    expect(accepted.message?.toLowerCase()).toContain("years");
  });

  test("blocks a second backtest while one is already running", async ({
    page,
  }) => {
    // A run is pinned mid-flight by the fixture, so "already running" is a state rather than a
    // race against a worker that might finish first.
    await page.goto("/backtests");
    await expect(
      page.getByText(fixtureName("In Flight")).first(),
      "The pinned in-flight run is missing. Seed it with: pnpm test:personas:seed",
    ).toBeVisible({ timeout: 20_000 });

    const outcome = await submitBacktest(page, {
      strategyName: "FREE_USER Strategy",
      listName: "Free Small",
      startDate: yearsBefore(today(), 1),
      endDate: today(),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.message?.toLowerCase()).toContain("one backtest at a time");
  });

  test("refuses a second active monitor, and says why on the card", async ({
    page,
  }) => {
    await page.goto("/monitors");
    await expect(monitorCard(page, "Free Monitor")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("monitor-form-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });

    await dialog
      .getByLabel("Name", { exact: true })
      .fill(`FREE second monitor ${Date.now()}`);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: fixtureName("FREE_USER Strategy") });
    await page
      .getByTestId("monitor-list")
      .selectOption({ label: fixtureName("Free Small") });
    await page.getByTestId("submit-monitor").click();

    // Refused, and the dialog stays open holding what was typed: the user is told the limit rather
    // than losing their work to a closed dialog and a silent no-op.
    const error = dialog.getByRole("alert");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("1");
    await expect(error).toContainText(/monitor/i);
    await expect(dialog).toBeVisible();
  });
});
