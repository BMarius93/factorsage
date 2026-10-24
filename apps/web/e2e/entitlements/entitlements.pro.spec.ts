import { expect, test, type Page } from "../fixtures";
import {
  describeRuns,
  inFlightRuns,
  RUN_SETTLE_TIMEOUT_MS,
  runIdFromUrl,
  waitForOnlyPinnedRunsInFlight,
  waitForRunsToSettle,
} from "../utils/backtests";
import {
  addStockToOpenList,
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
 * PRO, and the persona local development runs as.
 *
 * Deliberately *not* tested through the administrator. An administrator's entitlements come from
 * `ADMIN_ENTITLEMENTS` and are unbounded, so a PRO assertion made through one would pass even if
 * the PRO plan itself granted nothing — which is exactly the class of bug that would then reach
 * every paying customer.
 *
 * **No run is pinned in flight for this persona** (entitlements V2: PRO runs one backtest at a
 * time, Pro+ two). This is the persona every other spec signing in as `PRO_USER` uses, and a pinned
 * run would hold its only slot. "Already running" is shown by FREE's and STARTER's specs, which
 * pin one; the per-plan concurrency itself is proven by the API and worker suites
 * (`entitlements.integration.test.ts`, `claim-entitlements.integration.test.ts`). The submitting
 * test therefore starts by waiting until nothing is in flight, and ends by waiting until its own run
 * has settled and handed the slot back.
 *
 * **Time budget.** A test that submits a run is bounded by: the pre-submit wait for a free slot
 * (`RUN_SETTLE_TIMEOUT_MS`, only ever long if an earlier spec left a run executing), the submission
 * itself (`SUBMIT_BUDGET_MS`), and the run settling (`RUN_SETTLE_TIMEOUT_MS` again). The test's own
 * timeout is set to that sum plus the page loads around them, so a poll can never outlive the test
 * that runs it. ENTF securities are declared complete and empty (E2E-005), so a run over them
 * settles in seconds and these ceilings are rarely approached.
 */

/** Opening the form, filling it and waiting for the API to accept or refuse the submission. */
const SUBMIT_BUDGET_MS = 60_000;

/** Page loads and assertions around the waits. */
const PAGE_BUDGET_MS = 30_000;

const SUBMITTING_TEST_TIMEOUT_MS =
  RUN_SETTLE_TIMEOUT_MS +
  SUBMIT_BUDGET_MS +
  RUN_SETTLE_TIMEOUT_MS +
  PAGE_BUDGET_MS;
test.describe("PRO entitlements", () => {
  test("reports the PRO plan without administrative access", async ({
    page,
  }) => {
    const payload = await readEntitlements(page);

    expect(payload.plan).toBe("PRO");
    expect(payload.role).toBe("USER");
    // The contrast that matters: top commercial tier, still not an administrator.
    expect(payload.entitlements.admin.canAccessAdminSurfaces).toBe(false);
    expect(payload.entitlements.backtests.maxConcurrentRuns).toBe(1);
    // No advertised numerical cap (an operational fair-use ceiling is not an entitlement).
    expect(payload.entitlements.monitors.maxActive).toBeNull();
    expect(payload.entitlements.lists.maxSymbols).toBe(750);
  });

  test("holds a list far past every STARTER limit", async ({ page }) => {
    await openFixtureList(page, "Pro Wide");
    // Past STARTER's fifty and inside PRO's seven hundred and fifty. A delta rather than a literal,
    // so the test is repeatable without a reseed.
    const before = await listItems(page).count();
    expect(before).toBeGreaterThan(50);

    const outcome = await addStockToOpenList(page, "ENTF081");
    expect(outcome.accepted).toBe(true);
    await expect(listItems(page)).toHaveCount(before + 1);

    await removeStockFromOpenList(page, "ENTF081");
    await expect(listItems(page)).toHaveCount(before);
  });

  test("accepts a thirty-year backtest", async ({ page }) => {
    test.setTimeout(SUBMITTING_TEST_TIMEOUT_MS);
    // PRO's one slot must be free: nothing pinned, nothing a previous spec left executing.
    const pinned = await waitForOnlyPinnedRunsInFlight(page);
    expect(
      pinned,
      "PRO_USER has no pinned run (it would hold PRO's only slot). Reseed: pnpm test:entitlements:seed",
    ).toHaveLength(0);

    // The product's whole history horizon, over a list past STARTER's symbol limit.
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
    // PRO's only slot until it settles — and leaving it there would make the next spec's result
    // depend on how fast this one's run finished, which is precisely the order dependency these
    // specs are built to avoid.
    await waitForRunsToSettle(page, [runIdFromUrl(page.url())]);
    await expectNothingInFlight(page);
  });

  test("keeps six monitors active, past what STARTER allows", async ({
    page,
  }) => {
    await page.goto("/monitors");
    for (const name of [
      "Pro Monitor 1",
      "Pro Monitor 2",
      "Pro Monitor 3",
      "Pro Monitor 4",
      "Pro Monitor 5",
      "Pro Monitor 6",
    ]) {
      const card = monitorCard(page, name);
      await expect(card).toHaveCount(1, { timeout: 20_000 });
      await expect(card).toContainText("Enabled");
      // None is waiting for a slot: six is past STARTER's five, and PRO has no numerical cap.
      await expect(card.getByTestId("monitor-enabled-switch")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(card.getByTestId("monitor-state-pill")).toHaveCount(0);
    }
  });
});

/** The state the submitting test must leave: PRO's only slot free again. */
async function expectNothingInFlight(page: Page): Promise<void> {
  const inFlight = await inFlightRuns(page);
  expect(
    inFlight,
    `Nothing may remain in flight for PRO_USER: ${describeRuns(inFlight)}`,
  ).toHaveLength(0);
}
