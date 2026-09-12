import { expect, test, type Page } from "@playwright/test";
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
 * The top tier, and the persona local development runs as.
 *
 * Deliberately *not* tested through the administrator. An administrator's entitlements come from
 * `ADMIN_ENTITLEMENTS` and are unbounded, so a PRO assertion made through one would pass even if
 * the PRO plan itself granted nothing — which is exactly the class of bug that would then reach
 * every paying customer.
 *
 * No run is pinned in flight for this persona: it is the account every other E2E spec signs in as,
 * and a permanently running fixture would silently consume a concurrency slot those specs need.
 */
test.describe("PRO entitlements", () => {
  test("reports the PRO plan without administrative access", async ({
    page,
  }) => {
    const payload = await readEntitlements(page);

    expect(payload.plan).toBe("PRO");
    expect(payload.role).toBe("USER");
    // The contrast that matters: top commercial tier, still not an administrator.
    expect(payload.entitlements.admin.canAccessAdminSurfaces).toBe(false);
    expect(payload.entitlements.backtests.maxConcurrentRuns).toBe(2);
    expect(payload.entitlements.monitors.maxActive).toBe(10);
  });

  test("holds a list far past every STARTER limit", async ({ page }) => {
    await openFixtureList(page, "Pro Wide");
    // Past STARTER's fifty and inside PRO's hundred. A delta rather than a literal, so the test
    // is repeatable without a reseed.
    const before = await listItems(page).count();
    expect(before).toBeGreaterThan(50);

    const outcome = await addStockToOpenList(page, "ENTF081");
    expect(outcome.accepted).toBe(true);
    await expect(listItems(page)).toHaveCount(before + 1);

    await removeStockFromOpenList(page, "ENTF081");
    await expect(listItems(page)).toHaveCount(before);
  });

  test("accepts a thirty-year backtest", async ({ page }) => {
    // The product's whole retention horizon, and a period no other plan may request.
    const outcome = await submitBacktest(page, {
      strategyName: "PRO_USER Strategy",
      listName: "Pro Wide",
      startDate: yearsBefore(today(), 30),
      endDate: today(),
    });

    expect(
      outcome.message,
      "A thirty-year period over eighty stocks is inside PRO's limits and must not be refused",
    ).toBeNull();
    expect(outcome.accepted).toBe(true);
    await expect(page).toHaveURL(/\/backtests\/[0-9a-f-]{36}$/);

    // Hand the slot back. Submitting is what this test is about, but the run it creates occupies
    // one of PRO's two slots until it settles — and leaving it there would make the next test's
    // result depend on how fast this one's run finished, which is precisely the order dependency
    // these specs are built to avoid.
    await waitForFreeSlot(page);
  });

  test("accepts a second concurrent backtest where a smaller plan is refused", async ({
    page,
  }) => {
    // One run is pinned mid-flight by the fixture, so "already running" is a state rather than a
    // race against a worker. On FREE and STARTER this same situation refuses the next submission;
    // PRO's second slot is what this asserts, and it is the only thing that differs.
    await page.goto("/backtests");
    await expect(
      page.getByText(fixtureName("In Flight")).first(),
      "The pinned in-flight run is missing. Seed it with: pnpm test:personas:seed",
    ).toBeVisible({ timeout: 20_000 });
    expect(await countInFlight(page)).toBeGreaterThanOrEqual(1);

    const second = await submitBacktest(page, {
      strategyName: "PRO_USER Strategy",
      listName: "Pro Wide",
      startDate: yearsBefore(today(), 1),
      endDate: today(),
    });

    expect(
      second.message,
      "PRO runs two backtests at once, so a second submission must not be refused",
    ).toBeNull();
    expect(second.accepted).toBe(true);

    await waitForFreeSlot(page);
  });

  test("keeps four monitors active, past what STARTER allows", async ({
    page,
  }) => {
    await page.goto("/monitors");
    for (const name of [
      "Pro Monitor 1",
      "Pro Monitor 2",
      "Pro Monitor 3",
      "Pro Monitor 4",
    ]) {
      const card = monitorCard(page, name);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      await expect(card).toContainText("Enabled");
      // None is waiting for a slot: four is inside PRO's ten and past STARTER's three.
      await expect(card.getByTestId("monitor-blocked-pill")).toHaveCount(0);
    }
  });
});

/**
 * How many of this persona's runs have not reached a terminal status.
 *
 * Read from the server's own status rather than the label, so the count does not depend on
 * wording. This is also why the concurrency test reads the count instead of assuming one: other
 * specs sign in as this persona too, and a run one of them left executing is a legitimate part of
 * the state rather than something to be surprised by.
 */
async function countInFlight(page: Page): Promise<number> {
  await page.goto("/backtests");
  // The page container renders immediately with a loading state; the runs arrive afterwards.
  // Counting before the grid exists would read zero and call it "nothing in flight".
  await expect(page.getByTestId("backtests-grid")).toBeVisible({
    timeout: 30_000,
  });
  const statuses = await page
    .getByTestId("backtest-card-status")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-status") ?? ""),
    );
  return statuses.filter((status) => !TERMINAL_STATUSES.has(status)).length;
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

/**
 * Waits until only the pinned fixture run is still in flight.
 *
 * The runs these specs submit have no market data behind them and fail within seconds, so this is
 * a short wait in practice. It exists so every test leaves the persona with a free concurrency
 * slot — the state it found — rather than handing the next one a capacity it did not expect.
 */
async function waitForFreeSlot(page: Page): Promise<void> {
  await expect
    .poll(async () => countInFlight(page), { timeout: 120_000 })
    .toBeLessThanOrEqual(1);
}
