import { expect, test, type Page } from "../fixtures";
import {
  describeRuns,
  inFlightRuns,
  PINNED_FIXTURE_RUN_STRATEGY,
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
 * The top tier, and the persona local development runs as.
 *
 * Deliberately *not* tested through the administrator. An administrator's entitlements come from
 * `ADMIN_ENTITLEMENTS` and are unbounded, so a PRO assertion made through one would pass even if
 * the PRO plan itself granted nothing — which is exactly the class of bug that would then reach
 * every paying customer.
 *
 * **Exactly one run is pinned in flight for this persona** by the entitlement fixtures
 * (`ENT-In Flight`, held by a worker that does not exist on a lease that ends in 2099, so no real
 * worker ever claims or recovers it). It is what makes "already running one" a state rather than a
 * race, and it leaves PRO's second slot as the only free one — which is also the slot every other
 * spec signing in as this persona uses. The concurrency tests therefore start by waiting until the
 * pinned run is the only one in flight, and end by waiting until they have handed the second slot
 * back.
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
    test.setTimeout(SUBMITTING_TEST_TIMEOUT_MS);
    await waitForOnlyPinnedRunsInFlight(page);

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
    await waitForRunsToSettle(page, [runIdFromUrl(page.url())]);
    await expectOnlyPinnedRunInFlight(page);
  });

  test("accepts a second concurrent backtest where a smaller plan is refused", async ({
    page,
  }) => {
    test.setTimeout(SUBMITTING_TEST_TIMEOUT_MS);
    // One run is pinned mid-flight by the fixture, so "already running" is a state rather than a
    // race against a worker. On FREE and STARTER this same situation refuses the next submission;
    // PRO's second slot is what this asserts, and it is the only thing that differs. Start from
    // exactly that state: the pinned run, and nothing a previous spec left executing.
    const pinned = await waitForOnlyPinnedRunsInFlight(page);
    expect(
      pinned.length,
      "Exactly one pinned in-flight run is expected. Seed it with: pnpm test:entitlements:seed",
    ).toBe(1);

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
    const secondId = runIdFromUrl(page.url());

    // Two at once, and only these two: the pinned run plus the one just accepted — unless the new
    // one has already settled, which a run over empty fixture securities may do within a second.
    const inFlight = await inFlightRuns(page);
    const inFlightIds = new Set(inFlight.map((run) => run.id));
    expect(
      [...inFlightIds].every((id) => id === secondId || id === pinned[0]?.id),
      `Unexpected runs in flight next to the pinned one: ${describeRuns(inFlight)}`,
    ).toBe(true);
    expect(inFlightIds.has(pinned[0]?.id ?? "")).toBe(true);
    expect(inFlight.length).toBeLessThanOrEqual(2);
    if (inFlightIds.has(secondId)) {
      expect(inFlight).toHaveLength(2);
    }

    // The slot comes back: once the second run settles, the pinned run is the only one left.
    await waitForRunsToSettle(page, [secondId]);
    await expectOnlyPinnedRunInFlight(page);
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

/** The state every concurrency test must leave: PRO's second slot free again. */
async function expectOnlyPinnedRunInFlight(page: Page): Promise<void> {
  const inFlight = await inFlightRuns(page);
  expect(
    inFlight.map((run) => run.strategyName),
    `Only the pinned fixture run may remain in flight: ${describeRuns(inFlight)}`,
  ).toEqual([PINNED_FIXTURE_RUN_STRATEGY]);
}
