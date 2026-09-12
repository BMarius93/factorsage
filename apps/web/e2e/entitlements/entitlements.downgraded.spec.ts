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
 * What a downgrade looks like from the inside.
 *
 * This persona is on FREE and holds content no FREE account could have created: an eighty-three
 * symbol list, a completed twenty-year backtest, four monitors where one may be active. None of it
 * is reachable through the UI — that is precisely what makes it a downgrade — so it is seeded.
 *
 * The rule under test is the one users feel: **nothing was taken away**. The content is intact and
 * readable, the corrective actions all still work, and only genuinely new or worsening operations
 * are refused.
 */
/**
 * Ordered on purpose.
 *
 * Every case above the last one is read-only or self-restoring, so they are independent of each
 * other. The last one is not, and cannot be: it proves that an over-capacity account may switch a
 * monitor off but not back on, and the product offers no way to undo that. `describe.serial`
 * states the dependency instead of leaving it to luck, and `pnpm test:entitlements:seed` is what
 * restores the fixture — which is why the seeder reconciles rather than merely inserting.
 */
test.describe.serial("entitlements after a downgrade", () => {
  test("is on the FREE plan", async ({ page }) => {
    const payload = await readEntitlements(page);

    expect(payload.plan).toBe("FREE");
    expect(payload.role).toBe("USER");
  });

  test("keeps an oversized list whole and readable", async ({ page }) => {
    await openFixtureList(page, "Downgraded Oversized");

    // Far past the ten this plan allows: not truncated, not hidden, not emptied. Asserted as
    // "still far over the limit" rather than as the seeded literal, because the corrective-removal
    // case below legitimately takes one away and both must run in either order.
    const count = await listItems(page).count();
    expect(count).toBeGreaterThan(10);
    await expect(page.getByTestId("list-detail")).toContainText(String(count));
  });

  test("still allows renaming an oversized list", async ({ page }) => {
    await openFixtureList(page, "Downgraded Oversized");
    const before = await listItems(page).count();

    await page.getByRole("button", { name: "Edit" }).click();
    const renamed = `${fixtureName("Downgraded Oversized")} `;
    await page.getByLabel("Name").fill(renamed.trim());
    await page.getByRole("button", { name: "Save changes" }).click();

    // The rename is allowed because it changes nothing about capacity. Refusing it would make
    // grandfathered content read-only for no product reason.
    await expect(page.getByTestId("list-detail")).toBeVisible();
    await expect(listItems(page)).toHaveCount(before);
  });

  test("refuses an addition but allows the corrective removal", async ({
    page,
  }) => {
    await openFixtureList(page, "Downgraded Oversized");
    const before = await listItems(page).count();

    // Adding would make the violation worse, so it is refused — with the limit named.
    const rejected = await addStockToOpenList(page, "ENTF090");
    expect(rejected.accepted).toBe(false);
    expect(rejected.message).toContain("10");
    await expect(listItems(page)).toHaveCount(before);

    // Removing reduces it, so it is allowed. This is the one path out of an oversized list, and
    // refusing it would leave the user stuck with content they can neither use nor fix.
    //
    // The stock removed is the *last* one, so repeated runs take a different one each time and the
    // list stays comfortably over the limit; `pnpm test:entitlements:seed` restores it exactly.
    const last = await listItems(page).last().innerText();
    const symbol = last.match(/ENTF\d{3}/)?.[0];
    expect(symbol, "The oversized fixture list should hold ENTF rows").toBeTruthy();
    await removeStockFromOpenList(page, symbol as string);
    await expect(listItems(page)).toHaveCount(before - 1);
  });

  test("keeps a completed backtest readable, and refuses to rerun it", async ({
    page,
  }) => {
    await page.goto("/backtests");
    const card = page
      .getByTestId("backtest-card")
      .filter({ hasText: fixtureName("Historic Run") });
    await expect(
      card,
      "The completed historic run is missing. Seed it with: pnpm test:personas:seed",
    ).toHaveCount(1, { timeout: 20_000 });
    await expect(card.getByTestId("backtest-card-status")).toHaveAttribute(
      "data-status",
      "COMPLETED",
    );

    // The results are still there: a downgrade never deletes what finished under a higher plan.
    await card.click();
    await expect(page.getByTestId("backtest-run")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("backtest-status")).toHaveText("Completed");
    await expect(page.getByTestId("backtest-configuration")).toContainText(
      fixtureName("Downgraded Oversized"),
    );

    // Rerunning it is a *new* operation and is validated against the plan the user has now. Depth
    // is decidable from the period alone, so that is the limit it reports.
    const rerun = await submitBacktest(page, {
      strategyName: "DOWNGRADED_USER Strategy",
      listName: "Downgraded Oversized",
      startDate: yearsBefore(today(), 20),
      endDate: today(),
    });
    expect(rerun.accepted).toBe(false);
    expect(rerun.message).toContain("5");
  });

  test("keeps every monitor, its intent, and shows which are not scanning", async ({
    page,
  }) => {
    await page.goto("/monitors");

    // All four survive the downgrade. None was deleted and none was switched off.
    for (const name of [
      "Downgraded Monitor 1",
      "Downgraded Monitor 2",
      "Downgraded Monitor 3",
      "Downgraded Monitor 4 (off)",
    ]) {
      await expect(monitorCard(page, name)).toHaveCount(1, { timeout: 20_000 });
    }

    // The oldest enabled monitor holds the single FREE slot — but its list is over the limit, so
    // it is blocked for compliance rather than for capacity.
    const onOversized = monitorCard(page, "Downgraded Monitor 1");
    await expect(onOversized).toContainText("Enabled");
    await expect(onOversized.getByTestId("monitor-blocked-pill")).toHaveAttribute(
      "data-blocked-reason",
      "LIST_OVER_LIMIT",
    );

    // The rest are enabled too, and blocked for the other reason.
    for (const name of ["Downgraded Monitor 2", "Downgraded Monitor 3"]) {
      const card = monitorCard(page, name);
      await expect(card).toContainText("Enabled");
      await expect(card.getByTestId("monitor-blocked-pill")).toHaveAttribute(
        "data-blocked-reason",
        "MONITOR_CAPACITY",
      );
    }

    // The one the user turned off reads as disabled, not as blocked: intent and eligibility are
    // different facts and the card never conflates them.
    const disabled = monitorCard(page, "Downgraded Monitor 4 (off)");
    await expect(disabled).toContainText("Disabled");
    await expect(disabled.getByTestId("monitor-blocked-pill")).toHaveCount(0);
  });

  test("hands the slot to the next monitor as soon as one frees, and will not take a second", async ({
    page,
  }) => {
    await page.goto("/monitors");
    const slotHolder = monitorCard(page, "Downgraded Monitor 1");
    const next = monitorCard(page, "Downgraded Monitor 2");
    await expect(next.getByTestId("monitor-blocked-pill")).toHaveCount(1, {
      timeout: 20_000,
    });

    // Disabling is always allowed — it is how a user over capacity reduces their active set — and
    // the slot passes to the next enabled monitor. Nothing was written to that monitor: its status
    // is derived, so it simply resolves differently now.
    await slotHolder.getByTestId("toggle-monitor").click();
    await expect(slotHolder).toContainText("Disabled", { timeout: 20_000 });
    await expect(next.getByTestId("monitor-blocked-pill")).toHaveCount(0);

    // And turning it back on is refused, which is the half of this rule that is easy to miss.
    // Enabling is capacity-gated on *intent*, so a FREE account that already has two monitors
    // switched on cannot switch on a third — the downgrade leaves a one-way ratchet. Existing
    // intent is preserved; new intent is not granted.
    await slotHolder.getByTestId("toggle-monitor").click();
    const refusal = slotHolder.getByTestId("monitor-toggle-error");
    await expect(refusal).toBeVisible({ timeout: 20_000 });
    await expect(refusal).toContainText("1");
    await expect(slotHolder).toContainText("Disabled");

    // Which is exactly why this file is `describe.serial` and why the suite is re-seeded before a
    // run: the state this test leaves cannot be restored through the product, by design.
  });
});
