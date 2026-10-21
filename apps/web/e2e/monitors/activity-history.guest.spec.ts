import type { DashboardActivityResponse } from "@intrinsic/contracts";
import { expect, test } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * A Monitor's page shows two different things, side by side and never mixed:
 *
 * - **Signals** — where each occurrence stands now (active first, then ended);
 * - **Activity history** — what happened, session by session: the Dashboard's activity feed over
 *   this Monitor alone (`GET /monitors/:monitorId/activity`), in the Dashboard's layout, without a
 *   Monitor column.
 *
 * Against the hermetic stack's published built-in, as a Guest.
 */

const MONITOR = "QA Built-in Monitor A";
const WIDTHS = [390, 880, 1280, 1440, 1920] as const;

test("shows a Monitor's activity history apart from its Signals, as the API reads it", async ({
  page,
}) => {
  await page.goto("/monitors");
  await page.getByRole("link", { name: MONITOR, exact: true }).first().click();
  await expect(page.getByTestId("monitor-detail")).toBeVisible();
  const monitorId = page.url().split("/monitors/")[1]!;

  const api = (await (
    await page.request.get(`${apiBaseUrl()}/monitors/${monitorId}/activity`)
  ).json()) as DashboardActivityResponse;
  expect(api.events.length).toBeGreaterThan(0);

  const history = page.getByTestId("monitor-history-section");
  await expect(
    history.getByRole("heading", { name: "Activity history" }),
  ).toBeVisible();
  const rows = history.getByTestId("dashboard-activity-row");
  await expect(rows).toHaveCount(Math.min(api.events.length, 25));
  // The same events, in the API's order.
  const shown = await rows.evaluateAll((all) =>
    all.map((row) => row.getAttribute("data-event-id")),
  );
  expect(shown).toEqual(api.events.slice(0, 25).map((event) => event.id));
  // Every event is this Monitor's: no column repeats its name.
  await expect(
    history.getByRole("columnheader", { name: "Monitor" }),
  ).toHaveCount(0);

  // The Signal table is its own section, and none of the history is inside it.
  const signals = page.getByTestId("monitor-signals");
  await expect(signals).toBeVisible();
  await expect(signals.getByTestId("dashboard-activity-row")).toHaveCount(0);
  await expect(history.getByTestId("monitor-signal-row")).toHaveCount(0);

  // The Event filter narrows the history in the API.
  const ended = api.events.filter((event) => event.kind === "RESOLVED");
  await history.getByTestId("monitor-history-kind").selectOption("RESOLVED");
  if (ended.length === 0) {
    await expect(history.getByTestId("monitor-history-empty")).toBeVisible();
  } else {
    await expect(rows).toHaveCount(Math.min(ended.length, 25));
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute("data-kind", "RESOLVED");
    }
  }
});

test("keeps the Monitor's sections whole at every width", async ({ page }) => {
  await page.goto("/monitors");
  await page.getByRole("link", { name: MONITOR, exact: true }).first().click();
  await expect(page.getByTestId("monitor-detail")).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page
        .getByTestId("monitor-history-section")
        .getByTestId("dashboard-activity-row")
        .first(),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${width}px: no sideways scroll`).toBeLessThanOrEqual(0);
  }
});
