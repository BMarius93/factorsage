import type { MonitorSignalPageResponse } from "@intrinsic/contracts";
import { expect, test } from "../fixtures";

/**
 * The Signal table pages one consistent table (`docs/decisions/monitor-eod-v2.md` §6.2). When an
 * evaluation changes it between two pages the API refuses the next page (409), and the table is
 * read again from its first page with a note — never continued with rows from two states.
 *
 * The page boundary and the refusal are injected over the hermetic API's real first page; the
 * refusal itself is covered against the database in `monitor-history.integration.test.ts`.
 */

const SIGNALS = /\/monitors\/[^/]+\/signals(\?.*)?$/;

test("reads the Signal table again from the top when it changed between pages", async ({
  page,
}) => {
  // Development renders mount twice, so a first page can be asked for twice: the boundary is
  // decided by whether the table has changed yet, not by how many reads there were.
  let changed = false;
  let readsAfterChange = 0;
  const continued: string[] = [];
  await page.route(SIGNALS, async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      continued.push(cursor);
      changed = true;
      await route.fulfill({
        status: 409,
        json: { message: "The Signal table changed since this page was read" },
      });
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as MonitorSignalPageResponse;
    if (changed) readsAfterChange += 1;
    // Before the change the first page ends on a boundary; after it, the read is the whole table.
    await route.fulfill({
      json: changed
        ? body
        : { ...body, rows: body.rows.slice(0, 1), nextCursor: "page-2" },
    });
  });

  await page.goto("/monitors");
  await page
    .getByRole("link", { name: "QA Built-in Monitor A", exact: true })
    .first()
    .click();
  await expect(page.getByTestId("monitor-detail")).toBeVisible();
  const rows = page.getByTestId("monitor-signal-row");
  await expect(rows).toHaveCount(1);

  await page.getByTestId("monitor-signals-more").click();
  await expect(page.getByTestId("monitor-signals-restarted")).toContainText(
    "read again from the top",
  );
  expect(continued).toEqual(["page-2"]);
  await expect.poll(() => readsAfterChange).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("monitor-signals")).toBeVisible();
  // Each occurrence once: the rows are the table as it now is, not the old page plus a new one.
  const ids = await rows.evaluateAll((all) =>
    all.map((row) => row.textContent ?? ""),
  );
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.getByTestId("monitor-signals-more")).toHaveCount(0);
  await expect(page.getByTestId("monitor-signals-more-failed")).toHaveCount(0);
});
